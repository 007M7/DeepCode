/**
 * Process-local provider for the background-task capability seam
 * (`ctx.tasks`). It keeps every record in memory and hands out fresh
 * snapshots, never live state.
 *
 * Registrations outlive producer and controller fibers. Agent or service
 * disposal cancels live work and awaits compliant producers; a throwing
 * teardown cancel force-fails only the record and reports a possible orphan.
 * @module @deepseek-ai/dsh-tasks-local
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AnonymousEntries, ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeLayer } from '@deepseek-ai/dsh-scope'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { TaskService, TaskId } from '@deepseek-ai/dsh-tasks'
import type {
  TaskDoneListener, TaskKind, TaskOutcome, TaskRead, TaskSnapshot, TaskStart, TaskStatus,
  TasksChangedListener,
} from '@deepseek-ai/dsh-tasks'

/** Timeout code that distinguishes a bounded wait from caller cancellation. */
export const TASK_WAIT_TIMEOUT = 'TASK_WAIT_TIMEOUT'

/** Default maximum number of active tasks in one exact-owner bucket. */
const DEFAULT_MAX_CONCURRENT_TASKS_PER_OWNER = 10

/** Configuration for the process-local task registry. */
export interface Config {
  /**
   * Maximum `running` plus `stopping` tasks per exact owner or in the shared unowned bucket;
   * omission defaults to 10.
   */
  maxConcurrentTasksPerOwner?: number
}

/** The registry's mutable per-task record (never handed out — see {@link LocalTaskService.snapshot}). */
interface TrackedTask {
  id: TaskId
  kind: TaskKind
  label: string
  outputLimitBytes: number | undefined
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
 * One scope's contributions: the task controllers attached from it and the
 * completion listeners registered there. Both tables are anonymous because a
 * contribution is identified by its own disposer, never by a name a second
 * registrant could shadow.
 */
class TaskLayer implements ScopeLayer {
  readonly controllers = new AnonymousEntries<symbol>()
  readonly listeners = new AnonymousEntries<TaskDoneListener>()
  readonly changed = new AnonymousEntries<TasksChangedListener>()

  isEmpty(): boolean {
    return this.controllers.isEmpty() && this.listeners.isEmpty() && this.changed.isEmpty()
  }
}

/**
 * The in-memory `tasks` registry. See the Service Definition contract in
 * `@deepseek-ai/dsh-tasks` for the ownership, isolation, and lifecycle
 * semantics this implementation honors.
 */
export class LocalTaskService extends TaskService {
  static Config: z<Config> = z.object({
    maxConcurrentTasksPerOwner: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_CONCURRENT_TASKS_PER_OWNER),
  })

  /** Schemastery-defaulted active-task limit. */
  private readonly maxConcurrentTasksPerOwner: number
  private store = new Map<TaskId, TrackedTask>()
  private counters = new Map<string, number>()
  /**
   * Surfaces and listeners layered by the scope that registered them, in the
   * tools-registry shape: a contribution files into its registering context's
   * scope, and a read unions the global layer with the reader's scope chain.
   *
   * The registry is one process-wide instance serving every composition, so a
   * flat table would answer a per-owner question process-wide: one preset's
   * task controls would hold `start()` open for an agent whose own composition
   * loads none, and one settlement would reach every preset's notice listener.
   * Layers make both reads owner-relative. Nothing derives a cache from a
   * layer, so change notification is a no-op.
   */
  private readonly layers = new ScopedLayers<TaskLayer>(() => new TaskLayer(), () => {})
  private listenersClosed = false
  /** Owner agents with attached scope cleanup, mapped to the exact disposer. */
  private ownerCleanups = new Map<Agent, () => Promise<void> | void>()
  /** Service context used by detached settlement continuations and teardown. */
  private readonly selfCtx: Context

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery validates and fills the default before constructing the service.
    this.maxConcurrentTasksPerOwner = (config as Required<Config>).maxConcurrentTasksPerOwner
    this.selfCtx = ctx
    ctx.effect(() => () => this.disposeAll(), 'tasks teardown')
  }

  start(spec: TaskStart): TaskId {
    if (!this.servesOwner(spec.owner)) {
      throw new Error('background tasks unavailable: no task controller serves this agent (load @deepseek-ai/dsh-tool-tasks in its composition)')
    }
    if (spec.kind.length === 0) throw new Error('invalid task kind: expected a non-empty string')
    if (spec.label.length === 0) throw new Error('invalid task label: expected a non-empty string')
    if (spec.outputLimitBytes !== undefined
      && (!Number.isSafeInteger(spec.outputLimitBytes) || spec.outputLimitBytes <= 0)) {
      throw new Error(`invalid outputLimitBytes: expected a positive safe integer, got ${JSON.stringify(spec.outputLimitBytes)}`)
    }
    if (spec.owner !== undefined) this.ensureOwnerCleanup(spec.owner)

    const active = this.activeTaskCount(spec.owner)
    if (active >= this.maxConcurrentTasksPerOwner) {
      throw new Error(
        `background task limit reached for this owner (limit: ${this.maxConcurrentTasksPerOwner}); use task_kill to stop an unneeded task, wait for it to finish, then retry`,
      )
    }

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
      outputLimitBytes: spec.outputLimitBytes,
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
        // Contain a producer contract violation (`done` rejected) so cleanup and waiters cannot hang.
        this.selfCtx.logger.warn(`tasks: task ${task.id} producer done promise rejected (producer contract violation): ${String(error)}`)
        this.settle(task, { status: 'failed', detail: String(error) })
      },
    )
    // Registration is complete and cannot fail from here, so the visible set
    // has genuinely changed.
    this.notifyChanged(task.owner)
    return id
  }

  list(caller?: Agent): TaskSnapshot[] {
    const session = caller?.id
    return [...this.store.values()]
      .filter(task => task.owner === undefined || task.owner.id === session)
      .map(task => this.snapshot(task))
  }

  get(id: TaskId, caller?: Agent): TaskSnapshot {
    const task = this.expect(id)
    this.assertAccess(task, caller)
    return this.snapshot(task)
  }

  read(id: TaskId, caller?: Agent): TaskRead {
    const task = this.expect(id)
    this.assertAccess(task, caller)
    const text = task.readOutput !== undefined
      ? task.readOutput()
      : isTerminal(task.status) ? task.output ?? '' : ''
    if (isTerminal(task.status)) task.reported = true
    return { text, snapshot: this.snapshot(task) }
  }

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
    this.notifyChanged(task.owner)
    return 'requested'
  }

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
            // A settled task cannot reach here: settlement releases every waiter
            // before it announces completion, and each released waiter detaches
            // this listener in the same synchronous span, so nothing that reacts
            // to a settlement can abort a wait the settlement already owed.
            if (timeoutOf(d.signal, TASK_WAIT_TIMEOUT) !== undefined) {
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

  onTaskDone(listener: TaskDoneListener): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.listeners.append(listener),
      { label: 'tasks.onTaskDone()' },
    )
  }

  onTasksChanged(listener: TasksChangedListener): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.changed.append(listener),
      { label: 'tasks.onTasksChanged()' },
    )
  }

  attachController(name: string): () => void {
    // One token per call keeps duplicate labels independently disposable.
    const token = Symbol(name)
    return this.layers.effect(
      this.ctx,
      layer => layer.controllers.append(token),
      { label: 'tasks.attachController()' },
    )
  }

  /**
   * Whether an attached task controller can collect and stop work owned by
   * `owner`. The global layer holds every controller attached from an unscoped
   * context — a host composition's own controls — and therefore serves every
   * owner; a scoped controller serves exactly the agents composed under it.
   * @param owner - the task's owner, or undefined for unowned work.
   * @returns whether some reachable controller serves the owner.
   */
  private servesOwner(owner?: Agent): boolean {
    if (!this.layers.global.controllers.isEmpty()) return true
    return this.layers.chainLayers(owner === undefined ? undefined : scopeOf(owner.ctx))
      .some(layer => !layer.controllers.isEmpty())
  }

  /** Count authoritative active records for one exact owner or the shared unowned bucket. */
  private activeTaskCount(owner: Agent | undefined): number {
    let count = 0
    for (const task of this.store.values()) {
      if (task.owner === owner && (task.status === 'running' || task.status === 'stopping')) count += 1
    }
    return count
  }

  /**
   * The completion listeners that own `owner`'s notices: the global layer's
   * first, then each scoped layer along the owner's chain. A listener outside
   * that chain belongs to another composition and must not deliver, or the
   * owner reads one notice per mounted preset.
   * @param owner - the settled task's owner, or undefined for unowned work.
   * @returns the listeners to notify, in registration order per layer.
   */
  private *listenersFor(owner?: Agent): IterableIterator<TaskDoneListener> {
    yield* this.layers.global.listeners.values()
    const scope = owner === undefined ? undefined : scopeOf(owner.ctx)
    for (const layer of this.layers.chainLayers(scope)) yield* layer.listeners.values()
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
    if (task.owner !== undefined && task.owner.id !== caller?.id) {
      throw new Error(`task ${task.id} belongs to another session`)
    }
  }

  /** Project a fresh read-only snapshot from the mutable record. */
  private snapshot(task: TrackedTask): TaskSnapshot {
    const ownerSession = task.owner?.id
    return {
      id: task.id,
      kind: task.kind,
      label: task.label,
      ...task.outputLimitBytes !== undefined ? { outputLimitBytes: task.outputLimitBytes } : {},
      ...ownerSession !== undefined ? { ownerSession } : {},
      status: task.status,
      ...task.detail !== undefined ? { detail: task.detail } : {},
      startedAt: task.startedAt,
      ...task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {},
      reported: task.reported,
    }
  }

  /**
   * The change observers that own `owner`'s updates, resolved exactly like
   * {@link listenersFor}: the global layer — a host composition's own carrier,
   * which serves every owner — then each scoped layer along the owner's chain.
   * An observer outside that chain belongs to another composition and would
   * otherwise be told about agents it does not compose.
   * @param owner - the owner whose visible set moved, or undefined for unowned work.
   * @returns the observers to notify, in registration order per layer.
   */
  private *changedFor(owner?: Agent): IterableIterator<TasksChangedListener> {
    yield* this.layers.global.changed.values()
    const scope = owner === undefined ? undefined : scopeOf(owner.ctx)
    for (const layer of this.layers.chainLayers(scope)) yield* layer.changed.values()
  }

  /**
   * Announce that one owner's visible set changed. Each listener is contained
   * so an observer cannot break a lifecycle commit that already happened.
   */
  private notifyChanged(owner: Agent | undefined): void {
    for (const listener of this.changedFor(owner)) {
      try {
        listener(owner)
      } catch (error: unknown) {
        this.selfCtx.logger.warn(`tasks: onTasksChanged listener threw: ${String(error)}`)
      }
    }
  }

  /**
   * Record the first terminal outcome, release waiters, then announce
   * completion. First-wins preserves a teardown force-failure against late
   * producer settlement. Pending waits mark the task reported before listeners
   * run. Completion is announced last because a reporter may open a model turn
   * synchronously: every other observer of this settlement must already have
   * seen the committed record.
   */
  private settle(task: TrackedTask, outcome: TaskOutcome): void {
    if (isTerminal(task.status)) return
    task.status = outcome.status
    task.detail = outcome.detail
    task.output = outcome.output
    task.finishedAt = Date.now()
    if (task.waiters > 0) task.reported = true
    const snapshot = this.snapshot(task)
    const waitResolvers = [...task.waitResolvers]
    task.waitResolvers.clear()
    for (const resolveWait of waitResolvers) resolveWait()
    task.markSettled()
    this.notifyChanged(task.owner)
    if (this.listenersClosed) return
    for (const listener of this.listenersFor(task.owner)) {
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
    // Removal is the one visible-set change no per-task record carries, so it
    // must be announced here or an observer keeps the dropped rows forever.
    if (owned.length > 0) this.notifyChanged(owner)
  }

  /**
   * Close listeners, cancel live tasks, await settlement, and detach owner
   * effects. Throwing cancels are force-failed to avoid teardown deadlock.
   */
  private async disposeAll(): Promise<void> {
    // The flag is the whole guard: each layer entry's undo belongs to the fiber
    // that registered it, so this service may not drop them on its own way out.
    this.listenersClosed = true
    const all = [...this.store.values()]
    this.cancelForTeardown(all, 'tasks service disposed')
    await Promise.all(all.map(task => task.settled))
    // Distinct owners whose records just disappeared. A change observer files
    // into the layer of the context that registered it, so a consumer mounted
    // outside this service — the api-proxy carrier registers from the mux
    // stream — is still reachable here. Without this it keeps the rows it last
    // received after a registry reload.
    const emptied = new Set(all.map(task => task.owner))
    this.store.clear()
    for (const owner of emptied) this.notifyChanged(owner)
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
      // Teardown cancellation is a kill without a caller, so it claims the
      // terminal report the same way `kill()` does. Nothing will read a notice
      // for a task whose owner or service is being destroyed, and a waking
      // reporter would spend a model request per teardown layer. This is
      // decided before the producer runs: the force-failure below settles the
      // record too, so a throwing cancel must not be the one path that
      // announces an unreported completion into a disposing owner.
      task.reported = true
      try {
        task.cancel(reason)
        task.status = 'stopping'
        // Teardown reaches settlement only after the producer releases, which a
        // slow stop can defer; announcing the transition here is what keeps an
        // observer from showing `running` for that whole window.
        this.notifyChanged(task.owner)
      } catch (error: unknown) {
        const detail = `cancel threw during teardown; work may be orphaned: ${String(error)}`
        this.selfCtx.logger.warn(`tasks: cancel of ${task.id} threw during teardown; task record forced failed and work may be orphaned: ${String(error)}`)
        this.settle(task, { status: 'failed', detail })
      }
    }
  }
}

export default LocalTaskService
