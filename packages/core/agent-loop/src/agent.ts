/**
 * The concrete Agent implementation: ReactLoopAgent plus its inbox. Everything
 * observable happens through session events and the agent/* event taxonomy —
 * plugins never need this class.
 *
 * @module dsh-agent-loop/agent
 */

import type { Context } from 'cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { AgentId, AgentOptions, AgentStatus, SendOptions } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { Inbox } from './inbox.ts'
import { isTurnOpen, lastTurnNumber, runLoop } from './loop.ts'

/** Agents whose rollback-covered publication enabled driving. */
const driveEnabledAgents = new WeakSet<ReactLoopAgent>()

/** Sessions already claimed by a concrete driver construction. */
const claimedDriverSessions = new WeakSet<Session>()

/** Module-private driver entry: its symbol is absent from the package surface. */
const startDriver = Symbol('dsh.agent-loop.start-driver')

/** Factory-owned controls that can operate only on the agent created with them. */
export interface PreparedReactLoopAgent {
  /** The unpublished concrete agent. */
  agent: ReactLoopAgent
  /** Open its driving verbs at the rollback-covered publication boundary. */
  enableDrive(): void
  /**
   * Start its driver after publication and session-start notification.
   * The returned disposer reaches quiescence for both the loop and every
   * fire-and-forget idle-injection flush the agent started.
   */
  startDriver(): () => Promise<void>
}

/**
 * Construct one concrete agent together with unforgeable, instance-bound
 * lifecycle controls. The package surface deliberately exposes neither source
 * subpaths nor this helper: setup code may identify the concrete class, but it
 * cannot enable or start the factory's unpublished instance.
 * @param ctx - the agent-loop service context used for driving and events.
 * @param id - the concrete agent identity.
 * @param options - loop options for the agent.
 * @param session - the prepared session the agent will own.
 * @returns the agent and closures bound only to that exact instance.
 */
export function prepareReactLoopAgent(
  ctx: Context, id: AgentId, options: AgentOptions, session: Session,
): PreparedReactLoopAgent {
  if (claimedDriverSessions.has(session)) {
    throw new Error(`session "${session.id}" already has a concrete agent driver`)
  }
  claimedDriverSessions.add(session)
  const agent = new ReactLoopAgent(ctx, id, options, session)
  return {
    agent,
    enableDrive: () => { driveEnabledAgents.add(agent) },
    startDriver: () => agent[startDriver](),
  }
}

/**
 * The concrete {@link Agent} implementation owned by the agent-loop plugin.
 *
 * Owns the inbox (queued + steering FIFOs), the per-step AbortController, and
 * the loop driver. Everything observable happens through session events and
 * the agent/* event taxonomy — plugins never need this class.
 */
export class ReactLoopAgent implements Agent {
  /** Queued + steering FIFOs; native-private so setup cannot bypass driving verbs. */
  readonly #inbox = new Inbox()

  /**
   * The agent's scope context ({@link Agent.ctx}), wired by the factory right
   * after the scope is minted — before the agent is registered, announced, or
   * driven, so no consumer can observe it unset. Definite-assignment (`!`)
   * expresses that two-phase construction: the agent object and its scope
   * context are mutually referential (the scope is keyed BY this agent), so
   * neither can exist strictly before the other.
   */
  ctx!: Context

  /**
   * The dispatch carrier for this agent's own emits (`agent/status`,
   * `agent/queued`, `agent/error`): keyed by the agent, base = the agent
   * (listener `this` is the agent). Built lazily because it is self-referential.
   */
  private get carrier(): Scoped<Agent> {
    return (this.#carrier ??= scopeTarget(this, this))
  }

  #carrier: Scoped<Agent> | undefined

  private _status: AgentStatus = 'idle'
  private currentAbort: AbortController | undefined
  /**
   * Turn-scoped cancel marker, set by {@link cancel} and read/cleared by the
   * driver loop (via the LoopHandle) at every point a turn could start or
   * continue. Armed ONLY when there is something to cancel (a running turn, an
   * in-flight step, or queued/steering work), so an idle no-op cancel cannot
   * leave it set to wrongly drop a later prompt.
   */
  private cancelRequested = false
  /**
   * The resolved reason for the pending {@link cancel} (`reason ?? 'cancelled'`),
   * read by the driver loop's marker branches so a turn dropped in a
   * marker-only window (pre-step / continuation, where no `AbortController`
   * carries the reason) ends with the SAME `{kind:'aborted', reason}` the
   * mid-step abort path produces from `abort.signal.reason`. Without this the
   * caller's `cancel(reason)` would be silently replaced by the literal
   * 'cancelled' whenever the cancel landed outside a running step — making the
   * logged reason race-dependent and the public `reason?` param half-effective.
   */
  private cancelReason = 'cancelled'
  private disposed: Promise<void>
  private resolveDisposed!: () => void
  /** Resolves when the driver loop has fully exited (tests/disposal). */
  done: Promise<void> = Promise.resolve()
  /**
   * Pending {@link whenIdle} waiters, resolved by {@link settleIdleWaiters} when
   * the agent next settles out of `running`. Kept as internal agent state (NOT
   * an effect-scoped `ctx.on` listener) so a concurrent fiber disposal — which
   * runs the agent's own listeners' disposers — cannot drop the waiter before
   * the `disposed` transition fires and leave the promise hanging.
   */
  private idleWaiters: (() => void)[] = []
  /**
   * Durability checkpoints started by idle {@link inject} calls. `inject()` is
   * synchronous, so it cannot await them itself; the driver disposer drains
   * this set before the lifecycle unregisters the agent or detaches its session.
   */
  private pendingIdleFlushes = new Set<Promise<void>>()

  constructor(
    private loopCtx: Context,
    public readonly id: AgentId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    const { promise, resolve } = Promise.withResolvers<void>()
    this.disposed = promise
    this.resolveDisposed = resolve
  }

  get status(): AgentStatus {
    return this._status
  }

  private setStatus(status: AgentStatus): void {
    if (this._status === status || this._status === 'disposed') return
    this._status = status
    // Release quiescence waiters on a transition OUT of running before emitting (the disposer
    // handles the disposed transition separately).
    if (status !== 'running') this.settleIdleWaiters()
    try {
      this.loopCtx.emit(this.carrier, 'agent/status', this, status)
    } catch (error: unknown) {
      this.loopCtx.logger.warn(`agent "${this.id}": agent/status listener threw on ${status}: ${String(error)}`)
    }
  }

  /**
   * Resolve and clear all pending {@link whenIdle} waiters. Called on a
   * running→idle transition (from {@link setStatus}) and on disposal (from the
   * internal driver disposer, which chains `done` for true loop-exit quiescence).
   */
  private settleIdleWaiters(): void {
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  private resolveSource(options?: SendOptions): MessageSource {
    return options?.source ?? { kind: 'user' }
  }

  /** Reject every driving verb while creation setup still owns the agent. */
  private assertDriveEnabled(action: string): void {
    if (driveEnabledAgents.has(this)) return
    throw new Error(`agent "${this.id}" cannot ${action} before creation setup completes`)
  }

  send(content: ContentBlock[], options?: SendOptions): void {
    this.assertDriveEnabled('send')
    if (this._status === 'disposed') throw new Error(`agent "${this.id}" is disposed`)
    const source = this.resolveSource(options)
    this.#inbox.enqueue({ content, source })
    this.loopCtx.emit(this.carrier, 'agent/queued', this, content, { source, steering: false })
  }

  steer(content: ContentBlock[], options?: SendOptions): void {
    this.assertDriveEnabled('steer')
    if (this._status === 'disposed') throw new Error(`agent "${this.id}" is disposed`)
    if (this._status !== 'running') { this.send(content, options); return }
    const source = this.resolveSource(options)
    this.#inbox.steer({ content, source })
    this.loopCtx.emit(this.carrier, 'agent/queued', this, content, { source, steering: true })
  }

  inject(content: ContentBlock[], options?: SendOptions): void {
    this.assertDriveEnabled('inject')
    if (this._status === 'disposed') throw new Error(`agent "${this.id}" is disposed`)
    const source = this.resolveSource(options)
    if (isTurnOpen(this.session)) {
      // A turn is open in the LOG (decided from the log, not agent status —
      // status can be `running` with no turn open): the context/message is
      // turn-enclosed by that turn, so append it directly.
      this.session.append('context/message', { content, source }, { surfaceOp: 'append' })
      return
    }
    // No turn open: wrap the injection in a one-shot turn so every event stays
    // turn-enclosed (the durability/replay boundary is the turn).
    const turn = lastTurnNumber(this.session) + 1
    // Once turn/start enters the log, a turn/end is OWED no matter what — even if a throwing
    // `session/event` listener escapes from the turn/start append (Session.append pushes the
    // event before notifying listeners) or the context/message append throws (non-serializable
    // content, throwing listener).
    try {
      this.session.append('turn/start', { turn, trigger: { kind: 'injection', source } })
      this.session.append('context/message', { content, source }, { surfaceOp: 'append' })
    } finally {
      // Close the turn if turn/start made it into the log.
      if (isTurnOpen(this.session)) {
        try {
          this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
        } catch {
          // turn/end is already in the log (pushed before the listener threw),
          // so the turn is balanced; the throw is the listener's bug.
        }
      }
      // Decide the durability checkpoint from the LOG, not a flag: a turn was recorded iff this
      // turn's turn/start is logged (it may have been closed by a throwing-listener turn/end
      // above, which still counts).
      const turnRecorded = this.session.events.some(e => e.type === 'turn/start' && e.data.turn === turn)
      // Checkpoint the one-shot turn for durability, exactly as the loop does at every
      // turn/end.
      if (turnRecorded) {
        // Through the store's flush (the carrier owner), never a raw parallel.
        const flush = this.loopCtx.sessions.flush(this.session).catch((error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error))
          this.loopCtx.logger.warn(`agent "${this.id}": flush after idle injection failed: ${err.message}`)
          try {
            this.loopCtx.emit(this.carrier, 'agent/error', this, turn, 0, err)
          } catch {
            // contained: the failure is already logged; a throwing agent/error
            // listener must not escape this fire-and-forget catch.
          }
        })
        this.pendingIdleFlushes.add(flush)
        // Attach the same retirement callback to both settlement arms so even a logger failure
        // in the catch above cannot become an unhandled rejection.
        const retire = (): void => { this.pendingIdleFlushes.delete(flush) }
        void flush.then(retire, retire)
      }
    }
  }

  cancel(reason?: string): void {
    this.assertDriveEnabled('cancel')
    // Arm-gate: only mark a cancellation when there is actually work to cancel — a running
    // turn, an in-flight step, or queued/steering work.
    if (this._status === 'running' || this.currentAbort !== undefined || this.#inbox.hasQueued || this.#inbox.hasSteering) {
      this.cancelRequested = true
      // Capture the resolved reason for the marker-only windows (pre-step /
      // continuation). The mid-step path reads it from abort.signal.reason
      // below; the marker path reads it via the LoopHandle's cancelReason().
      this.cancelReason = reason ?? 'cancelled'
    }
    // Drop all pending queued + steering work (un-started prompts never run; the cancelled
    // turn's steering is not re-enqueued).
    this.#inbox.clear()
    // Interrupt an in-flight step immediately (the running turn observes the
    // abort and ends `aborted`). The marker covers the windows where no step is
    // running (pre-step, continuation).
    this.currentAbort?.abort(reason ?? 'cancelled')
  }

  /**
   * Resolve once the agent has reached quiescence after settling out of `running`.
   */
  whenIdle(): Promise<void> {
    if (this._status === 'disposed') return this.done
    if (this._status !== 'running' && !this.#inbox.hasQueued) return Promise.resolve()
    // Register an internal waiter (resolved by settleIdleWaiters on the next
    // running→idle/disposed transition), not an effect-scoped `ctx.on` listener: a concurrent
    // fiber disposal runs this agent's listener disposers, which could remove a `ctx.on` waiter
    // before the `disposed` transition fires and hang the promise.
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(() => {
        resolve(this._status === 'disposed' ? this.done : undefined)
      })
    })
  }

  /**
   * Start the driver loop. Returns a disposer: calling it sets status to
   * `disposed`, emits `agent/status('disposed')`, resolves the disposed
   * promise (unblocking the idle wait), releases any `whenIdle` waiters, and
   * aborts the current request if any. Its returned promise resolves only after
   * the loop exits and every idle-injection flush started by this agent settles.
   * @returns the disposer — idempotent, synchronously marks the agent disposed,
   *   and asynchronously reaches loop + flush quiescence without rejecting (it
   *   runs inside the fiber's LIFO disposal chain, where a rejection would skip
   *   later disposers).
   */
  [startDriver](): () => Promise<void> {
    this.done = runLoop(this.loopCtx, this, {
      inbox: this.#inbox,
      setStatus: (status) => { this.setStatus(status) },
      setAbort: controller => void (this.currentAbort = controller),
      disposed: this.disposed,
      isDisposed: () => this._status === 'disposed',
      isCancelled: () => this.cancelRequested,
      cancelReason: () => this.cancelReason,
      clearCancel: () => { this.cancelRequested = false },
      // Settle whenIdle() waiters WITHOUT a status transition — the pre-step cancel-skip path
      // drops the about-to-run turn and re-parks without ever flipping running→idle, so a
      // waiter registered in the pre-step window (status idle, hasQueued was true) would
      // otherwise hang.
      settleIdle: () => { this.settleIdleWaiters() },
    })
    // The disposer must be infallible: it runs inside the fiber's LIFO
    // disposal chain, where a throw would skip later disposers (e.g. the
    // registry unregistration) and leave `done` pending forever.
    return async () => {
      if (this._status !== 'disposed') {
        this._status = 'disposed'
        this.resolveDisposed()
        // Release whenIdle waiters BEFORE the (guarded) event emit — they are
        // internal state that must settle even if a listener throws below. Each
        // waiter chains `done`, so it resolves only once the loop actually exits.
        this.settleIdleWaiters()
        this.currentAbort?.abort('disposed')
        // setStatus refuses transitions out of 'disposed', so emit directly —
        // 'disposed' is part of the agent/status contract. Guarded: a throwing
        // listener must not break the disposal chain.
        try {
          this.loopCtx.emit(this.carrier, 'agent/status', this, 'disposed')
        } catch {
          // listener error during disposal — nothing safe left to do with it
        }
      }
      // An unexpected driver rejection must not skip registry/session/scope
      // cleanup. The normal loop contains turn failures itself; allSettled is the
      // final lifecycle backstop for anything outside those boundaries.
      await Promise.allSettled([this.done])
      // No new inject() can start after the synchronous disposed transition.
      while (this.pendingIdleFlushes.size > 0) {
        await Promise.allSettled([...this.pendingIdleFlushes])
      }
    }
  }
}
