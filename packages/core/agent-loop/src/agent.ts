/**
 * The concrete Agent implementation: ReactLoopAgent plus its inbox. Everything
 * observable happens through session events and the agent/* event taxonomy —
 * plugins never need this class.
 *
 * @module dsh-agent-loop/agent
 */

import type { Context } from 'cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { AgentId, AgentOptions, AgentStatus, SendOptions } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { deepFreeze } from '@deepseek-ai/dsh-llm'
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

/** Module-private quiescent stop, valid both before and after driver start. */
const stopDriver = Symbol('dsh.agent-loop.stop-driver')

/** Factory-owned controls that can operate only on the agent created with them. */
export interface PreparedReactLoopAgent {
  /** The unpublished concrete agent. */
  agent: ReactLoopAgent
  /** Open its driving verbs at the rollback-covered publication boundary. */
  enableDrive(): void
  /** Stop the prepared instance even when publication has not started its loop. */
  dispose(): Promise<void> | void
  /**
   * Start its driver after publication and session-start notification.
   * The returned disposer reaches quiescence for both the loop and every
   * fire-and-forget idle-injection flush the agent started.
   */
  startDriver(): () => Promise<void> | void
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
  const agent = new ReactLoopAgent(ctx, id, options, session)
  // Construction snapshots caller options and can throw. Claim only the fully
  // initialized driver so the same prepared session remains retryable after a
  // rejected caller value.
  claimedDriverSessions.add(session)
  const dispose = () => agent[stopDriver]()
  return {
    agent,
    enableDrive: () => { driveEnabledAgents.add(agent) },
    dispose,
    startDriver: () => {
      agent[startDriver]()
      return dispose
    },
  }
}

/**
 * Install the concrete agent's scope context exactly once. Construction and
 * scope minting are mutually referential (the scope key is the agent), so the
 * factory performs this one post-construction binding before setup receives
 * the unpublished agent. The runtime slot is non-writable/non-configurable;
 * TypeScript `readonly` alone would still let JavaScript redirect later
 * registrations to another context.
 * @param agent - the unpublished concrete agent to bind.
 * @param ctx - its fully extended agent scope context.
 */
export function bindReactLoopAgentContext(agent: ReactLoopAgent, ctx: Context): void {
  if (Object.hasOwn(agent, 'ctx')) throw new Error(`agent "${agent.id}" context is already bound`)
  Object.defineProperty(agent, 'ctx', {
    value: ctx,
    enumerable: true,
    writable: false,
    configurable: false,
  })
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
  declare readonly ctx: Context

  private _status: AgentStatus = 'idle'
  private currentAbort: AbortController | undefined
  /** Whether runLoop has been installed into {@link done}. */
  private driverStarted = false
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
    const acceptedOptions = deepFreeze(structuredClone(options))
    // Pin the public ownership/identity bindings in the runtime object. A
    // JavaScript caller can otherwise replace TS-readonly parameter properties
    // after publication and split the registry, driver, session, and model
    // configuration into different worlds.
    Object.defineProperties(this, {
      id: { value: id, enumerable: true, writable: false, configurable: false },
      options: { value: acceptedOptions, enumerable: true, writable: false, configurable: false },
      session: { value: session, enumerable: true, writable: false, configurable: false },
    })
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
    // Release quiescence waiters on a transition OUT of running BEFORE emitting
    // (the disposer handles the disposed transition separately). Settling first
    // means a throwing `agent/status` subscriber cannot starve a `whenIdle()`
    // waiter (docs/defensive-patterns.md "contain callback exceptions" — a lifecycle await must
    // not hang on one bad listener).
    if (status !== 'running') this.settleIdleWaiters()
    agentEvents(this.loopCtx, this).emit('agent/status', status)
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
    agentEvents(this.loopCtx, this).emit('agent/queued', content, { source, steering: false })
  }

  steer(content: ContentBlock[], options?: SendOptions): void {
    this.assertDriveEnabled('steer')
    if (this._status === 'disposed') throw new Error(`agent "${this.id}" is disposed`)
    if (this._status !== 'running') { this.send(content, options); return }
    const source = this.resolveSource(options)
    this.#inbox.steer({ content, source })
    agentEvents(this.loopCtx, this).emit('agent/queued', content, { source, steering: true })
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
    // Once turn/start enters the log, a turn/end is OWED no matter what — even
    // if a throwing `session/event` listener escapes from the turn/start append
    // (Session.append pushes the event BEFORE notifying listeners) or the
    // context/message append throws (non-serializable content, throwing
    // listener). The finally re-checks the log via isTurnOpen() and closes the
    // turn if one was actually opened, so the log never carries a permanently
    // open injection turn that would corrupt later turns/replay. (If the
    // turn/start append throws BEFORE pushing — non-serializable trigger, which
    // can't happen for our fixed trigger — no turn was opened and none is owed.)
    try {
      this.session.append('turn/start', { turn, trigger: { kind: 'injection', source } })
      this.session.append('context/message', { content, source }, { surfaceOp: 'append' })
    } finally {
      // Close the turn if turn/start made it into the log. Contain a throwing
      // turn/end listener: Session.append pushes before notifying, so a throw
      // here still leaves turn/end in the log (the turn is balanced) — swallow
      // it so it neither replaces the original exception nor skips the flush
      // decision below. (It surfaces through the flush path is not needed; the
      // turn-balance contract is what matters and it holds.)
      if (isTurnOpen(this.session)) {
        try {
          this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
        } catch {
          // turn/end is already in the log (pushed before the listener threw),
          // so the turn is balanced; the throw is the listener's bug.
        }
      }
      // Decide the durability checkpoint from the LOG, not a flag: a turn was
      // recorded iff this turn's turn/start is logged (it may have been closed
      // by a throwing-listener turn/end above, which still counts). A
      // `turnRecorded` boolean set after append('turn/end') would be skipped by
      // a throwing turn/end listener, losing the flush for a balanced in-memory
      // turn (crash before the next turn/dispose would drop the idle injection).
      const turnRecorded = this.session.events.some(e => e.type === 'turn/start' && e.data.turn === turn)
      // Checkpoint the one-shot turn for durability, exactly as the loop does at
      // every turn/end. The loop is NOT running (we are idle), so nothing else
      // will flush this turn. Fire-and-forget with error containment: inject()
      // is synchronous, and a persistence backend failing must not throw into
      // the caller (e.g. a tool-bash task-done callback). Disposal still drains
      // independently, so a slow flush is safe. The task is tracked until it
      // settles: driver disposal awaits every pending idle-injection checkpoint
      // before unregistering the agent or detaching the session. A flush failure
      // is reported via agent/error (step 0 — the idle-injection convention,
      // there is no real step) AND the logger, mirroring the loop's post-turn/end
      // flush path so plugins monitoring agent/error see idle-injection
      // persistence failures too. A throwing agent/error listener is contained.
      if (turnRecorded) {
        // Through the store's flush (the carrier owner), never a raw parallel.
        const flush = this.loopCtx.sessions.flush(this.session).catch((error: unknown) => {
          const rendered = renderThrown(error)
          const err = error instanceof Error ? error : new Error(rendered)
          this.loopCtx.logger.warn(`agent "${this.id}": flush after idle injection failed: ${rendered}`)
          agentEvents(this.loopCtx, this).emit('agent/error', turn, 0, err)
        })
        this.pendingIdleFlushes.add(flush)
        // Attach the same retirement callback to both settlement arms so even a
        // logger failure in the catch above cannot become an unhandled rejection.
        // Teardown uses allSettled for the same reason: a reporting failure must
        // not strand ownership.
        const retire = (): void => { this.pendingIdleFlushes.delete(flush) }
        void flush.then(retire, retire)
      }
    }
  }

  cancel(reason?: string): void {
    this.assertDriveEnabled('cancel')
    // Arm-gate: only mark a cancellation when there is actually work to cancel —
    // a running turn, an in-flight step, or queued/steering work. An idle cancel
    // with nothing pending is a true no-op; arming the marker then would wrongly
    // drop the NEXT legitimate prompt (the marker is consumed only at the loop's
    // turn-decision points, which an idle parked loop does not reach until woken
    // by a real send()). Note the gate canNOT be `status === 'running'` alone:
    // the pre-step window (a send() queued but the loop not yet flipped to
    // running) has status `idle` with `hasQueued` true, and the marker exists
    // precisely to cover it.
    if (this._status === 'running' || this.currentAbort !== undefined || this.#inbox.hasQueued || this.#inbox.hasSteering) {
      this.cancelRequested = true
      // Capture the resolved reason for the marker-only windows (pre-step /
      // continuation). The mid-step path reads it from abort.signal.reason
      // below; the marker path reads it via the LoopHandle's cancelReason().
      this.cancelReason = reason ?? 'cancelled'
    }
    // Drop all pending queued + steering work (un-started prompts never run; the
    // cancelled turn's steering is not re-enqueued). Cleared directly even when
    // the loop is parked in waitForQueued — there is no turn to stop and nothing
    // left for the parked loop to run, so no wake is needed.
    this.#inbox.clear()
    // Interrupt an in-flight step immediately (the running turn observes the
    // abort and ends `aborted`). The marker covers the windows where no step is
    // running (pre-step, continuation).
    this.currentAbort?.abort(reason ?? 'cancelled')
  }

  /**
   * Resolve once the agent has reached quiescence after settling out of
   * `running`. If it is already disposed, awaits {@link done} (the loop-exit
   * promise) — `agent/status('disposed')` fires in the disposer BEFORE the
   * driver loop has unwound, so it is NOT itself a quiescence signal. If it is
   * idle AND has no queued work, resolves immediately. Otherwise queues an
   * internal waiter (see {@link idleWaiters}) released on the next
   * running→idle/disposed transition, resolving on `idle` directly (the turn
   * fully ended) or chaining {@link done} on `disposed` (wait for the loop to
   * actually exit). Implements the {@link Agent.whenIdle} contract: a non-owner
   * quiescence-observation hook, distinct from teardown (a lifecycle owner stops
   * and unregisters via `AgentHandle.dispose()`, whose driver boundary awaits
   * both {@link done} and outstanding idle-injection flushes, not through this).
   */
  whenIdle(): Promise<void> {
    if (this._status === 'disposed') return this.done
    if (this._status !== 'running' && !this.#inbox.hasQueued) return Promise.resolve()
    // Register an internal waiter (resolved by settleIdleWaiters on the next
    // running→idle/disposed transition), NOT an effect-scoped `ctx.on` listener:
    // a concurrent fiber disposal runs this agent's listener disposers, which
    // could remove a `ctx.on` waiter before the `disposed` transition fires and
    // hang the promise. On disposal the disposer settles the waiter AND we chain
    // `done` here for true loop-exit quiescence (status flips to disposed before
    // the loop unwinds); a plain idle transition resolves directly.
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(() => {
        resolve(this._status === 'disposed' ? this.done : undefined)
      })
    })
  }

  /**
   * Start the driver loop. The prepared controller already owns its stable
   * disposer, so teardown can mark the agent disposed even in the narrow
   * publication window before this method runs.
   */
  [startDriver](): void {
    if (this._status === 'disposed') return
    this.driverStarted = true
    this.done = runLoop(this.loopCtx, this, {
      inbox: this.#inbox,
      setStatus: (status) => { this.setStatus(status) },
      setAbort: controller => void (this.currentAbort = controller),
      disposed: this.disposed,
      isDisposed: () => this._status === 'disposed',
      isCancelled: () => this.cancelRequested,
      cancelReason: () => this.cancelReason,
      clearCancel: () => { this.cancelRequested = false },
      // Settle whenIdle() waiters WITHOUT a status transition — the pre-step
      // cancel-skip path drops the about-to-run turn and re-parks without ever
      // flipping running→idle, so a waiter registered in the pre-step window
      // (status idle, hasQueued was true) would otherwise hang. This emits no
      // agent/status, so an ACP agent/status listener never sees a spurious idle
      // that would resolve a freshly-queued prompt as cancelled.
      settleIdle: () => { this.settleIdleWaiters() },
    })
  }

  /**
   * Quiescent stop shared by pre-start rollback and live teardown. It marks the
   * agent disposed synchronously, contains an unexpected loop rejection, and
   * drains every idle-injection flush before resolving.
   */
  private [stopDriver](): Promise<void> | void {
    if (this._status !== 'disposed') {
      this._status = 'disposed'
      this.resolveDisposed()
      // Release whenIdle waiters BEFORE the (guarded) event emit — they are
      // internal state that must settle even if a listener throws below. Each
      // waiter chains `done`, so it resolves only once the loop actually exits.
      this.settleIdleWaiters()
      this.currentAbort?.abort('disposed')
      // An unpublished rollback has no public status lifecycle to announce.
      // Once driving is enabled, disposed is part of the agent/status contract.
      if (driveEnabledAgents.has(this)) {
        agentEvents(this.loopCtx, this).emit('agent/status', 'disposed')
      }
    }
    // Before runLoop starts there is normally nothing asynchronous to drain;
    // keep publication rollback synchronous so create() cannot throw while its
    // session/agent entries are still briefly live. A session-start listener
    // may have used the newly enabled inject() surface, however, so preserve
    // its durability checkpoint as a real quiescence boundary.
    if (!this.driverStarted && this.pendingIdleFlushes.size === 0) return
    return this.drainDriver()
  }

  /** Await the loop (when started) and every outstanding idle flush. */
  private async drainDriver(): Promise<void> {
    // An unexpected driver rejection must not skip registry/session/scope
    // cleanup. The normal loop contains turn failures itself; allSettled is the
    // final lifecycle backstop for anything outside those boundaries.
    await Promise.allSettled([this.done])
    // No new inject() can start after the synchronous disposed transition.
    // Loop because settled tasks retire themselves in promise reactions that
    // may run beside this continuation; either the set is empty or this waits
    // the exact remaining quiescence boundary. allSettled keeps a failure in
    // error reporting from skipping registry/session/scope disposers.
    while (this.pendingIdleFlushes.size > 0) {
      await Promise.allSettled([...this.pendingIdleFlushes])
    }
  }
}

/** Render an arbitrary thrown value without allowing coercion to throw again. */
function renderThrown(value: unknown): string {
  try {
    return value instanceof Error ? value.message : String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}
