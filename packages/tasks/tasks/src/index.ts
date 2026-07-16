/**
 * The in-process background task registry (`ctx.tasks`). It owns task ids,
 * session-scoped access, lifecycle state, completion listeners, and owner
 * cleanup while producers retain their execution resources.
 *
 * Registrations outlive producer and control-surface fibers. Agent or service
 * disposal cancels live work and awaits compliant producers; a throwing
 * teardown cancel force-fails only the record and reports a possible orphan.
 * @module @deepseek-ai/dsh-tasks
 */

import { Context, Service } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { TaskId } from './types.ts'
import type { TaskDoneListener, TaskKind, TaskOutcome, TaskRead, TaskSnapshot, TaskStart, TaskStatus } from './types.ts'

export { TaskId } from './types.ts'
export type {
  TaskDoneListener,
  TaskHooks,
  TaskKind,
  TaskKindMap,
  TaskOutcome,
  TaskRead,
  TaskSnapshot,
  TaskStart,
  TaskStatus,
} from './types.ts'

declare module 'cordis' {
  interface Context {
    tasks: TaskService
  }
}

/** Timeout code that distinguishes a bounded wait from caller cancellation. */
export const TASK_WAIT_TIMEOUT = 'TASK_WAIT_TIMEOUT'

/** The registry's mutable per-task record (never handed out — see {@link TaskService.snapshot}). */
interface TrackedTask {
  id: TaskId
  kind: TaskKind
  label: string
  /** Exact lifecycle owner; session-id authorization is derived from it. */
  owner: Agent | undefined
  cancel: (reason?: string) => void
  readOutput: (() => string) | undefined
  status: TaskStatus
  detail: string | undefined
  output: string | undefined
  startedAt: number
  finishedAt: number | undefined
  reported: boolean
  /** Resolves once the terminal snapshot is recorded and listeners notified. */
  settled: Promise<void>
  /** Resolver for {@link settled}, called by the first effective settlement. */
  markSettled: () => void
  /** Live waits; settlement with a waiter marks the task reported. */
  waiters: number
  /** Removable resolvers for live waits; timeout/abort unregister before the task settles. */
  waitResolvers: Set<() => void>
}

/** True for the three terminal {@link TaskStatus} values. */
function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed'
}

/**
 * The `tasks` service: the runtime-global background task registry. See the
 * module doc for the ownership, isolation, and lifecycle contracts.
 */
// TODO(task-service-backend): Separate the service contract from this
// process-local implementation when a second backend defines its lifecycle.
export class TaskService extends Service {
  private store = new Map<TaskId, TrackedTask>()
  private counters = new Map<string, number>()
  private surfaces = new Set<symbol>()
  private listeners = new Set<TaskDoneListener>()
  private listenersClosed = false
  /** Owner agents with attached scope cleanup, mapped to the exact disposer. */
  private ownerCleanups = new Map<Agent, () => Promise<void> | void>()
  /** Service context used by detached settlement continuations and teardown. */
  private readonly selfCtx: Context

  constructor(ctx: Context) {
    super(ctx, 'tasks')
    this.selfCtx = ctx
    ctx.effect(() => () => this.disposeAll(), 'tasks teardown')
  }

  /**
   * Preflight access, validation, and owner cleanup before starting and
   * atomically registering work. A throwing starter leaves nothing registered;
   * after it returns, registration cannot fail. Settlement records the outcome,
   * notifies listeners, and releases waiters.
   * @param spec - task identity, owner, and synchronous starter.
   * @returns the registry-issued `<kind>-N` id.
   */
  start(spec: TaskStart): TaskId {
    if (this.surfaces.size === 0) {
      throw new Error('background tasks unavailable: no control surface is attached (load @deepseek-ai/dsh-tool-tasks)')
    }
    if (spec.kind.length === 0) throw new Error('invalid task kind: expected a non-empty string')
    if (spec.label.length === 0) throw new Error('invalid task label: expected a non-empty string')
    if (spec.owner !== undefined) this.ensureOwnerCleanup(spec.owner)

    const hooks = spec.run()
    const count = (this.counters.get(spec.kind) ?? 0) + 1
    this.counters.set(spec.kind, count)
    const id = TaskId(`${spec.kind}-${count}`)

    let markSettled!: () => void
    const settled = new Promise<void>((resolve) => { markSettled = resolve })
    const task: TrackedTask = {
      id,
      kind: spec.kind,
      label: spec.label,
      owner: spec.owner,
      cancel: hooks.cancel.bind(hooks),
      readOutput: hooks.readOutput?.bind(hooks),
      status: 'running',
      detail: undefined,
      output: undefined,
      startedAt: Date.now(),
      finishedAt: undefined,
      reported: false,
      settled,
      markSettled,
      waiters: 0,
      waitResolvers: new Set(),
    }
    this.store.set(id, task)

    void hooks.done.then(
      (outcome) => { this.settle(task, outcome) },
      (error: unknown) => {
        // Contain a producer contract violation so cleanup and waiters cannot hang.
        this.selfCtx.logger.warn(`tasks: task ${task.id} 'done' rejected (producer contract violation): ${String(error)}`)
        this.settle(task, { status: 'failed', detail: String(error) })
      },
    )
    return id
  }

  /**
   * List caller-owned and unowned tasks in registration order without exposing
   * another session's labels.
   * @param caller - reading agent; a non-agent caller sees only unowned tasks.
   * @returns fresh snapshots.
   */
  list(caller?: Agent): TaskSnapshot[] {
    const session = caller?.session.header.id
    return [...this.store.values()]
      .filter(task => task.owner === undefined || task.owner.session.header.id === session)
      .map(task => this.snapshot(task))
  }

  /**
   * Return a non-consuming snapshot without changing its read cursor or notice
   * state. Throws for an unknown or foreign task.
   * @param id - task to look up.
   * @param caller - reading agent checked against the owner.
   * @returns a fresh snapshot.
   */
  get(id: TaskId, caller?: Agent): TaskSnapshot {
    const task = this.expect(id)
    this.assertAccess(task, caller)
    return this.snapshot(task)
  }

  /**
   * Read the next stream delta, or the idempotent final output after settlement.
   * A terminal read marks the task reported. Throws for an unknown or foreign
   * task.
   * @param id - task to read.
   * @param caller - reading agent checked against the owner.
   * @returns output text and the post-read snapshot.
   */
  read(id: TaskId, caller?: Agent): TaskRead {
    const task = this.expect(id)
    this.assertAccess(task, caller)
    const text = task.readOutput !== undefined
      ? task.readOutput()
      : isTerminal(task.status) ? task.output ?? '' : ''
    if (isTerminal(task.status)) task.reported = true
    return { text, snapshot: this.snapshot(task) }
  }

  /**
   * Request cancellation, then mark the task stopping and reported. A producer
   * throw propagates without changing task state. Throws for an unknown or
   * foreign task.
   * @param id - task to cancel.
   * @param caller - killing agent checked against the owner.
   * @param reason - logged reason forwarded to the producer.
   * @returns `requested` for live work, otherwise `already-finished`.
   */
  kill(id: TaskId, caller?: Agent, reason?: string): 'requested' | 'already-finished' {
    const task = this.expect(id)
    this.assertAccess(task, caller)
    if (isTerminal(task.status)) {
      task.reported = true
      return 'already-finished'
    }
    // Cancel first so a throw leaves both lifecycle and notice state unchanged.
    task.cancel(reason)
    task.status = 'stopping'
    task.reported = true
    return 'requested'
  }

  /**
   * Wait for settlement or timeout without cancelling the task. Caller abort
   * rejects only while the task is live; after settlement it returns the
   * terminal snapshot so a notice suppressed for this waiter is still delivered.
   * Timed-out and aborted waits detach their resolvers. Throws for invalid,
   * unknown, or foreign input.
   * @param id - task to wait for.
   * @param timeoutMs - positive finite wait bound in milliseconds.
   * @param caller - waiting agent checked against the owner.
   * @param signal - optional cancellation of the wait itself.
   * @returns snapshot at settlement or timeout.
   */
  async wait(id: TaskId, timeoutMs: number, caller?: Agent, signal?: AbortSignal): Promise<TaskSnapshot> {
    const task = this.expect(id)
    this.assertAccess(task, caller)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`invalid wait timeout: expected a positive number of milliseconds, got ${JSON.stringify(timeoutMs)}`)
    }
    if (!isTerminal(task.status)) {
      if (signal?.aborted) throw new Error('wait aborted')
      // Abort removes the waiter synchronously so same-tick settlement cannot
      // suppress a notice for a wait that will reject.
      task.waiters += 1
      let counted = true
      const uncount = (): void => {
        if (!counted) return
        counted = false
        task.waiters -= 1
      }
      try {
        // The scoped deadline distinguishes a successful wait timeout from
        // caller cancellation and clears its timer on every exit.
        using d = deadline(signal, timeoutMs, TASK_WAIT_TIMEOUT)
        await new Promise<void>((resolve, reject) => {
          const onSettled = (): void => {
            task.waitResolvers.delete(onSettled)
            d.signal.removeEventListener('abort', onAbort)
            resolve()
          }
          const onAbort = (): void => {
            task.waitResolvers.delete(onSettled)
            if (timeoutOf(d.signal, TASK_WAIT_TIMEOUT) !== undefined) {
              resolve()
            } else if (isTerminal(task.status)) {
              // Settlement suppressed the notice for this waiter; deliver it.
              resolve()
            } else {
              uncount()
              reject(new Error('wait aborted'))
            }
          }
          task.waitResolvers.add(onSettled)
          d.signal.addEventListener('abort', onAbort, { once: true })
        })
      } finally {
        uncount()
      }
    }
    if (isTerminal(task.status)) task.reported = true
    return this.snapshot(task)
  }

  /**
   * Register an effect-scoped completion listener. Each listener is contained;
   * returned promises are observed but not awaited. No listener runs after
   * service disposal.
   * @param listener - receives each terminal snapshot and its exact owner.
   * @returns disposer that unregisters the listener.
   */
  onTaskDone(listener: TaskDoneListener): () => void {
    const dispose = this.ctx.effect(() => {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    }, 'tasks.onTaskDone()')
    return () => void dispose()
  }

  /**
   * Attach an effect-scoped surface that can read and stop tasks. {@link start}
   * refuses work while none is attached.
   * @param name - diagnostic label; duplicate names remain independent.
   * @returns disposer that detaches this surface.
   */
  attachSurface(name: string): () => void {
    // One token per call keeps duplicate labels independently disposable.
    const token = Symbol(name)
    const dispose = this.ctx.effect(() => {
      this.surfaces.add(token)
      return () => this.surfaces.delete(token)
    }, 'tasks.attachSurface()')
    return () => void dispose()
  }

  /** Look up a task or fail loud. */
  private expect(id: TaskId): TrackedTask {
    const task = this.store.get(id)
    if (task === undefined) throw new Error(`unknown task ${id}`)
    return task
  }

  /**
   * The isolation fence: a task with an owner is reachable only by callers
   * whose session id matches (`!== undefined` semantics — an unowned task is
   * open, and a no-agent caller can never match an owned one).
   */
  private assertAccess(task: TrackedTask, caller?: Agent): void {
    if (task.owner !== undefined && task.owner.session.header.id !== caller?.session.header.id) {
      throw new Error(`task ${task.id} belongs to another session`)
    }
  }

  /** Project a fresh read-only snapshot from the mutable record. */
  private snapshot(task: TrackedTask): TaskSnapshot {
    const ownerSession = task.owner?.session.header.id
    return {
      id: task.id,
      kind: task.kind,
      label: task.label,
      ...ownerSession !== undefined ? { ownerSession } : {},
      status: task.status,
      ...task.detail !== undefined ? { detail: task.detail } : {},
      startedAt: task.startedAt,
      ...task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {},
      reported: task.reported,
    }
  }

  /**
   * Record the first terminal outcome, notify contained listeners, and release
   * waiters. First-wins preserves a teardown force-failure against late producer
   * settlement. Pending waits mark the task reported before listeners run.
   */
  private settle(task: TrackedTask, outcome: TaskOutcome): void {
    if (isTerminal(task.status)) return
    task.status = outcome.status
    task.detail = outcome.detail
    task.output = outcome.output
    task.finishedAt = Date.now()
    if (task.waiters > 0) task.reported = true
    if (!this.listenersClosed) {
      const snapshot = this.snapshot(task)
      for (const listener of this.listeners) {
        try {
          const returned = listener(snapshot, task.owner)
          void Promise.resolve(returned).catch((error: unknown) => {
            this.selfCtx.logger.warn(`tasks: onTaskDone listener rejected for ${task.id}: ${String(error)}`)
          })
        } catch (error: unknown) {
          this.selfCtx.logger.warn(`tasks: onTaskDone listener threw for ${task.id}: ${String(error)}`)
        }
      }
    }
    const waitResolvers = [...task.waitResolvers]
    task.waitResolvers.clear()
    for (const resolveWait of waitResolvers) resolveWait()
    task.markSettled()
  }

  /**
   * Attach one awaited cleanup through the exact owner's scope. This survives
   * producer reloads and joins agent quiescence; the retained disposer lets
   * service teardown detach the cross-fiber effect. Fails when the registry is
   * absent or the owner is not its currently registered instance.
   */
  private ensureOwnerCleanup(owner: Agent): void {
    const ownerId = owner.id
    const agents = this.selfCtx.get('agents')
    if (agents === undefined) {
      throw new Error('background task ownership requires the agent registry (load @deepseek-ai/dsh-agent)')
    }
    if (agents.get(ownerId) !== owner) {
      throw new Error(`agent "${ownerId}" is not the registered agent instance (background task owner must be live)`)
    }
    if (this.ownerCleanups.has(owner)) return
    // Record only after attach succeeds; a disposing scope rejects new effects.
    const detach = owner.ctx.effect(() => async () => {
      this.ownerCleanups.delete(owner)
      await this.disposeOwned(owner)
    }, 'tasks.ownerCleanup()')
    this.ownerCleanups.set(owner, detach)
  }

  /** Cancel, await terminal records, and drop every task owned by one exact agent lifecycle. */
  private async disposeOwned(owner: Agent): Promise<void> {
    const owned = [...this.store.values()].filter(task => task.owner === owner)
    this.cancelForTeardown(owned, 'owner disposed')
    await Promise.all(owned.map(task => task.settled))
    for (const task of owned) this.store.delete(task.id)
  }

  /**
   * Close listeners, cancel live tasks, await settlement, and detach owner
   * effects. Throwing cancels are force-failed to avoid teardown deadlock.
   */
  private async disposeAll(): Promise<void> {
    this.listenersClosed = true
    this.listeners.clear()
    const all = [...this.store.values()]
    this.cancelForTeardown(all, 'tasks service disposed')
    await Promise.all(all.map(task => task.settled))
    this.store.clear()
    // Detach cross-fiber owner effects after the shared store is quiescent.
    const ownerCleanups = [...this.ownerCleanups.values()]
    this.ownerCleanups.clear()
    await Promise.all(ownerCleanups.map(cleanup => Promise.resolve(cleanup())))
  }

  /**
   * Cancel tasks during teardown with per-task containment. A throwing cancel
   * force-fails the record and reports a possible orphan; a cancel that returns
   * without settling remains indistinguishable from a slow stop and may stall.
   */
  private cancelForTeardown(tasks: TrackedTask[], reason: string): void {
    for (const task of tasks) {
      if (isTerminal(task.status)) continue
      try {
        task.cancel(reason)
        task.status = 'stopping'
      } catch (error: unknown) {
        const detail = `cancel threw during teardown; work may be orphaned: ${String(error)}`
        this.selfCtx.logger.warn(`tasks: cancel of ${task.id} threw during teardown; task record forced failed and work may be orphaned: ${String(error)}`)
        this.settle(task, { status: 'failed', detail })
      }
    }
  }
}

export default TaskService
