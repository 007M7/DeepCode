/**
 * The background task registry (`ctx.tasks`): ONE home for the semantics every
 * long-running tool needs — branded task ids, owner-scoped isolation, status
 * snapshots, incremental/final output reads, cancellation, wait-for-terminal,
 * completion listeners, and the awaited owner-cleanup path. Producers
 * (`dsh-tool-bash` background commands, `dsh-tool-subagent` background
 * delegations, future long-running tools) hand their work to
 * {@link TaskService.start} — preflight, then the producer's starter, then an
 * atomic commit — and keep their own execution concerns; the
 * model-facing control surface (`@deepseek-ai/dsh-tool-tasks`) drives the
 * generic read/list/kill/wait operations.
 *
 * A CONCRETE service, not an interface/implementation seam pair: there is one
 * sensible in-process implementation today, and the capability-seam convention
 * says not to split preemptively (see the background-task-runtime RFC).
 *
 * Cross-session isolation lives IN the registry: task ids are runtime-global
 * and predictable (`bash-1`, `subagent-1`), so every read/kill/wait compares
 * the task's owner session against the caller and rejects a foreign one —
 * every surface gets the fence for free instead of re-implementing it.
 *
 * Task registrations are NOT effect-scoped to the registering fiber: a task
 * belongs to its owning agent and producing backend, not to the tool plugin
 * whose call started it, so an HMR reload of a producer or of the control
 * surface never orphans or kills a running task. The registry's own disposal
 * cancels every live task and awaits contract-compliant producers to
 * quiescence. If a teardown cancel throws, the registry force-fails its record
 * to avoid deadlock and logs that the underlying work may be orphaned.
 *
 * @module @deepseek-ai/dsh-tasks
 */

import { Context, Service } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { TaskId } from './types.ts'
import type { TaskDoneListener, TaskOutcome, TaskRead, TaskSnapshot, TaskStart, TaskStatus } from './types.ts'

export { TaskId } from './types.ts'
export type {
  TaskDoneListener,
  TaskHooks,
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

/**
 * The `dsh-timeout` code stamped on a {@link TaskService.wait} deadline's
 * `TimeoutReason`. A wait timeout only ends the WAIT (the task keeps running
 * and the live snapshot is returned) — scoping `timeoutOf` to this code keeps
 * a foreign (outer, nested) deadline's timeout from being misread as ours.
 */
export const TASK_WAIT_TIMEOUT = 'TASK_WAIT_TIMEOUT'

/** The registry's mutable per-task record (never handed out — see {@link TaskService.snapshot}). */
interface TrackedTask {
  id: TaskId
  kind: string
  label: string
  /** The owner's session id (`session.header.id`), or undefined for an unowned task. */
  ownerSession: SessionId | undefined
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
  /** Resolver for {@link settled} (called by the first effective {@link TaskService.settle}). */
  markSettled: () => void
  /** Live {@link TaskService.wait} calls — a settlement with waiters marks the task reported. */
  waiters: number
}

/** True for the three terminal {@link TaskStatus} values. */
function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed'
}

/**
 * The `tasks` service: the runtime-global background task registry. See the
 * module doc for the ownership, isolation, and lifecycle contracts.
 */
export class TaskService extends Service {
  private store = new Map<TaskId, TrackedTask>()
  private counters = new Map<string, number>()
  private surfaces = new Set<symbol>()
  private listeners = new Set<TaskDoneListener>()
  private listenersClosed = false
  /** Owner agents whose scope cleanup is attached, mapped to its exact disposer. */
  private ownerCleanups = new Map<Agent, () => Promise<void> | void>()
  /**
   * The service's OWN construction-time context, for work that outlives the
   * calling fiber: detached settlement continuations (logging), and the
   * service teardown. Owner cleanup itself is registered through the owning
   * agent's scope so it survives producer-plugin reloads and participates in
   * the agent's structural quiescence boundary.
   */
  private readonly selfCtx: Context

  constructor(ctx: Context) {
    super(ctx, 'tasks')
    this.selfCtx = ctx
    ctx.effect(() => () => this.disposeAll(), 'tasks teardown')
  }

  /**
   * PREFLIGHT, start, then atomically register background work; returns its
   * task id (`<kind>-N`, per-kind counter). Every check that can fail — the
   * control-surface fence ({@link attachSurface}; a task the model could
   * never read or stop must fail loud before it exists), kind/label
   * validation, exact live owner-instance identity, and the owner's awaited
   * disposal-cleanup attach (once per owner agent, through `owner.ctx`) — runs BEFORE
   * `spec.run()` starts the actual work, and nothing in the runtime can fail
   * after it returns: "work started but never got a collectable id" is
   * structurally impossible, not a producer rollback obligation. The runtime
   * attaches ONE continuation to the returned `done` that records the
   * terminal snapshot, notifies {@link onTaskDone} listeners, and releases
   * waiters. A throwing `run()` propagates with nothing registered (the
   * producer owns any partial cleanup of its own failed start).
   * @param spec - the task's identity/owner plus the `run()` starter (see {@link TaskStart}).
   * @returns the registry-issued task id.
   */
  start(spec: TaskStart): TaskId {
    // -- Preflight: everything that can throw, before any work or mutation. --
    if (this.surfaces.size === 0) {
      throw new Error('background tasks unavailable: no control surface is attached (load @deepseek-ai/dsh-tool-tasks)')
    }
    if (spec.kind.length === 0) throw new Error('invalid task kind: expected a non-empty string')
    if (spec.label.length === 0) throw new Error('invalid task label: expected a non-empty string')
    if (spec.owner !== undefined) this.ensureOwnerCleanup(spec.owner)

    // -- Start: the producer's work begins only now, preflight-clean. --
    const hooks = spec.run()

    // -- Commit: pure mutations; nothing below can throw. --
    const count = (this.counters.get(spec.kind) ?? 0) + 1
    this.counters.set(spec.kind, count)
    const id = TaskId(`${spec.kind}-${count}`)

    let markSettled!: () => void
    const settled = new Promise<void>((resolve) => { markSettled = resolve })
    const task: TrackedTask = {
      id,
      kind: spec.kind,
      label: spec.label,
      ownerSession: spec.owner?.session.header.id,
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
    }
    this.store.set(id, task)

    void hooks.done.then(
      (outcome) => { this.settle(task, outcome) },
      (error: unknown) => {
        // Producer contract violation (`done` must never reject) — contained
        // as a failed outcome so waiters, cleanup, and disposal never hang.
        this.selfCtx.logger.warn(`tasks: task ${task.id} 'done' rejected (producer contract violation): ${String(error)}`)
        this.settle(task, { status: 'failed', detail: String(error) })
      },
    )
    return id
  }

  /**
   * The caller-VISIBLE tasks (owned by the caller's session, or unowned), in
   * registration order. Never lists another session's tasks — a global
   * listing would leak their labels across the isolation fence.
   * @param caller - the reading agent; undefined (a non-agent caller) sees only unowned tasks.
   * @returns fresh snapshots; mutating them does not affect the registry.
   */
  list(caller?: Agent): TaskSnapshot[] {
    const session = caller?.session.header.id
    return [...this.store.values()]
      .filter(task => task.ownerSession === undefined || task.ownerSession === session)
      .map(task => this.snapshot(task))
  }

  /**
   * A non-consuming snapshot of one task — unlike {@link read}, never touches
   * the stream cursor or the reported flag (the kill surface uses it to
   * describe an already-terminal task WITHOUT eating a pending delta).
   * Throws for an unknown id or a task owned by another session.
   * @param id - the task to look up.
   * @param caller - the reading agent, checked against the task's owner.
   * @returns a fresh snapshot.
   */
  get(id: TaskId, caller?: Agent): TaskSnapshot {
    const task = this.expect(id)
    this.assertAccess(task, caller)
    return this.snapshot(task)
  }

  /**
   * Read a task's output. Stream kinds (registered with `readOutput`) yield
   * the CONSUMING delta since the previous read — one cursor per task, the
   * owning model is v1's single intended reader; final-output kinds yield
   * empty text while live and the terminal output idempotently once settled.
   * A read that returns the terminal state marks the task {@link TaskSnapshot.reported}.
   * Throws for an unknown id or a task owned by another session.
   * @param id - the task to read.
   * @param caller - the reading agent, checked against the task's owner.
   * @returns the read text plus the post-read snapshot.
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
   * Request cancellation of a task. A live task has its producer
   * `cancel(reason)` invoked FIRST — a throw propagates (fail loud) and
   * leaves the task untouched (still `running`, notice not suppressed) —
   * then moves to `stopping` and settles through the normal `done` path; an
   * already-terminal task is reported, not failed. Every SUCCESSFUL kill
   * marks the task {@link TaskSnapshot.reported}: the killer has seen (or
   * asked for) the end, so the completion notice is suppressed. Throws for
   * an unknown id or a task owned by another session.
   * @param id - the task to cancel.
   * @param caller - the killing agent, checked against the task's owner.
   * @param reason - the surface's logged reason, forwarded to the producer.
   * @returns 'requested' when cancellation was asked of a live task, 'already-terminal' otherwise.
   */
  kill(id: TaskId, caller?: Agent, reason?: string): 'requested' | 'already-terminal' {
    const task = this.expect(id)
    this.assertAccess(task, caller)
    if (isTerminal(task.status)) {
      task.reported = true
      return 'already-terminal'
    }
    // Producer cancel FIRST: a throw must leave the task untouched (still
    // `running`, notice not suppressed) — the killer's tool call fails loud,
    // but task_list and the eventual completion notice keep telling the
    // truth about a cancellation that never happened. Cancel is synchronous
    // and settlement lands on a later microtask, so the mutations below
    // cannot race the settle path.
    task.cancel(reason)
    task.status = 'stopping'
    task.reported = true
    return 'requested'
  }

  /**
   * Wait for a task to settle, bounded by a timeout. Resolves with the
   * terminal snapshot (marked {@link TaskSnapshot.reported} — the wait
   * response reports the end, so the completion notice is suppressed), or
   * with the still-live snapshot when the timeout expires first. An abort of
   * `signal` rejects the WAIT only (the task keeps running) — UNLESS the task
   * has already settled: settlement saw this live waiter and suppressed the
   * completion notice on its behalf, so the wait still resolves and delivers
   * the terminal snapshot it owes (an abort must never leave a finished task
   * both unreported and notice-suppressed). Throws for an unknown id, a task
   * owned by another session, or a non-positive timeout.
   * @param id - the task to wait for.
   * @param timeoutMs - max wait in milliseconds (positive, finite; the surface caps it).
   * @param caller - the waiting agent, checked against the task's owner.
   * @param signal - optional abort for the wait itself.
   * @returns the snapshot at settlement, or at timeout when the task outlives the wait.
   */
  async wait(id: TaskId, timeoutMs: number, caller?: Agent, signal?: AbortSignal): Promise<TaskSnapshot> {
    const task = this.expect(id)
    this.assertAccess(task, caller)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`invalid wait timeout: expected a positive number of milliseconds, got ${JSON.stringify(timeoutMs)}`)
    }
    if (!isTerminal(task.status)) {
      if (signal?.aborted) throw new Error('wait aborted')
      // `waiters` is the settle-path heuristic "someone WILL deliver the
      // terminal snapshot, suppress the notice". An abort breaks that promise,
      // so the un-count must happen SYNCHRONOUSLY inside onAbort — the
      // `finally` decrement alone runs a microtask later, after a same-tick
      // settlement could already have read the stale count and suppressed the
      // notice for a waiter that then rejects and delivers nothing.
      task.waiters += 1
      let counted = true
      const uncount = (): void => {
        if (!counted) return
        counted = false
        task.waiters -= 1
      }
      try {
        // The dsh-timeout deadline fits wait() exactly because both only
        // NOTIFY: a wait timeout returns the live snapshot (the task keeps
        // running — nothing is terminated), and timeoutOf scoped to our own
        // code tells that timeout apart from a caller abort, which rejects
        // the wait. `using` clears the timer on every exit path.
        using d = deadline(signal, timeoutMs, TASK_WAIT_TIMEOUT)
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            if (timeoutOf(d.signal, TASK_WAIT_TIMEOUT) !== undefined) {
              resolve()
            } else if (isTerminal(task.status)) {
              // Settlement already ran and suppressed the notice for this
              // waiter — deliver the terminal snapshot instead of rejecting.
              resolve()
            } else {
              uncount()
              reject(new Error('wait aborted'))
            }
          }
          d.signal.addEventListener('abort', onAbort, { once: true })
          void task.settled.then(() => {
            d.signal.removeEventListener('abort', onAbort)
            resolve()
          })
        })
      } finally {
        uncount()
      }
    }
    if (isTerminal(task.status)) task.reported = true
    return this.snapshot(task)
  }

  /**
   * Register a completion listener, called exactly once per terminal task
   * record with its snapshot. Effect-scoped (disposed with the calling fiber);
   * per-listener containment (one throwing listener is logged, never starves
   * the rest); never fires after this service is disposed.
   * @param listener - called with each settling task's terminal snapshot.
   * @returns the disposer that unregisters the listener.
   */
  onTaskDone(listener: TaskDoneListener): () => void {
    const dispose = this.ctx.effect(() => {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    }, 'tasks.onTaskDone()')
    return () => void dispose()
  }

  /**
   * Declare that a control surface capable of reading/stopping tasks is
   * loaded. {@link start} refuses to start a background task while NO
   * surface is attached — the loud fence against a deployment exposing
   * `run_in_background` without any way to collect or stop the work. The
   * model-facing `@deepseek-ai/dsh-tool-tasks` attaches on load; a deployment
   * with a custom (non-model) surface attaches its own. Effect-scoped:
   * detached with the calling fiber.
   * @param name - a diagnostic label for the surface (duplicate names count independently).
   * @returns the disposer that detaches the surface.
   */
  attachSurface(name: string): () => void {
    // One token per attach call: duplicate names stay independent, and the
    // single-shot effect disposer removes exactly its own attachment.
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
    if (task.ownerSession !== undefined && task.ownerSession !== caller?.session.header.id) {
      throw new Error(`task ${task.id} belongs to another session`)
    }
  }

  /** Project a fresh read-only snapshot from the mutable record. */
  private snapshot(task: TrackedTask): TaskSnapshot {
    return {
      id: task.id,
      kind: task.kind,
      label: task.label,
      ...task.ownerSession !== undefined ? { ownerSession: task.ownerSession } : {},
      status: task.status,
      ...task.detail !== undefined ? { detail: task.detail } : {},
      startedAt: task.startedAt,
      ...task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {},
      reported: task.reported,
    }
  }

  /**
   * Record the first terminal outcome, notify listeners with containment, then
   * release waiters. Normally the producer's single `done` continuation calls
   * this; teardown also force-fails the record when `cancel` throws and `done`
   * may never settle. First-wins makes a producer outcome arriving after that
   * fallback a no-op, so listeners fire once and the diagnosed terminal state
   * is never overwritten. A settlement observed by a pending {@link wait}
   * marks the task reported BEFORE listeners run, so the notice surface can
   * suppress its redundant "finished".
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
          listener(snapshot)
        } catch (error: unknown) {
          this.selfCtx.logger.warn(`tasks: onTaskDone listener threw for ${task.id}: ${String(error)}`)
        }
      }
    }
    task.markSettled()
  }

  /**
   * Attach the awaited owner-disposal cleanup for an owner agent, once. The
   * effect is registered through `owner.ctx`, so it belongs to the agent scope
   * rather than the producer or long-lived tasks fiber: it survives producer
   * reloads, runs at the structural agent quiescence boundary, and removes its
   * wrapper automatically when that scope unwinds. The tasks service retains
   * the exact disposer only so service teardown can detach cross-fiber effects
   * instead of leaving a dead service captured by still-live agents.
   * Fails loud when no agent registry is mounted or when `owner` is not the
   * exact live instance currently registered under its id — accepting a stale
   * object after id reuse would attach its session's task to another agent's
   * lifecycle.
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
    const ownerSession = owner.session.header.id
    // Attach FIRST, record after: an already-disposing scope rejects effects,
    // and marking the owner as covered before that would poison later starts.
    const detach = owner.ctx.effect(() => async () => {
      this.ownerCleanups.delete(owner)
      await this.disposeOwned(ownerSession)
    }, 'tasks.ownerCleanup()')
    this.ownerCleanups.set(owner, detach)
  }

  /** Cancel, await terminal records, and drop every task owned by one session. */
  private async disposeOwned(ownerSession: SessionId): Promise<void> {
    const owned = [...this.store.values()].filter(task => task.ownerSession === ownerSession)
    this.cancelForTeardown(owned, 'owner disposed')
    await Promise.all(owned.map(task => task.settled))
    for (const task of owned) this.store.delete(task.id)
  }

  /**
   * Service teardown: close the listener registry FIRST (late completions
   * from teardown kills stay silent), cancel every live task, and await each
   * terminal record. Contract-compliant producers settle at quiescence; a
   * producer whose cancel throws is force-failed so disposal cannot deadlock,
   * with the possible underlying orphan logged explicitly.
   */
  private async disposeAll(): Promise<void> {
    this.listenersClosed = true
    this.listeners.clear()
    const all = [...this.store.values()]
    this.cancelForTeardown(all, 'tasks service disposed')
    await Promise.all(all.map(task => task.settled))
    this.store.clear()
    // These effects belong to agent scopes, not this service's fiber. Detach
    // them after the shared store is quiescent so a tasks-service reload cannot
    // leave old callbacks retaining the dead service until each agent exits.
    const ownerCleanups = [...this.ownerCleanups.values()]
    this.ownerCleanups.clear()
    await Promise.all(ownerCleanups.map(cleanup => Promise.resolve(cleanup())))
  }

  /**
   * Teardown-path cancellation with per-task containment: unlike the
   * model-facing {@link kill} (where a throwing producer `cancel` fails the tool
   * call and leaves the record live), teardown force-fails a record whose cancel
   * throws because its `done` may depend on a request that never arrived. This
   * prevents disposal deadlock but cannot prove the underlying work stopped, so
   * the potential orphan is carried in the detail and warning. A cancel that
   * returns but never leads to `done` remains indistinguishable from a slow stop
   * and can still stall teardown; fixing that requires a separate bounded-lifetime
   * or forced-disposal design.
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
