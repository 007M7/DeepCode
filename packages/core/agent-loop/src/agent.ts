/**
 * The concrete Agent implementation: ReactLoopAgent plus its inbox. Everything
 * observable happens through session events and the agent/* event taxonomy —
 * plugins never need this class.
 *
 * @module dsh-agent-loop/agent
 */

import type { Context } from 'cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { AgentId, AgentOptions, AgentStatus, InjectOptions, SendOptions } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { deepFreeze } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue, type Session } from '@deepseek-ai/dsh-session'
import { Inbox, type InboxMessage } from './inbox.ts'
import { isTurnOpen, lastTurnNumber, runLoop } from './loop.ts'

/** Sessions already claimed by a concrete driver construction. */
const claimedDriverSessions = new WeakSet<Session>()

/** Module-private driver entry: its symbol is absent from the package surface. */
const startDriver = Symbol('dsh.agent-loop.start-driver')

/** Module-private quiescent stop, valid both before and after driver start. */
const stopDriver = Symbol('dsh.agent-loop.stop-driver')

/** Module-private context binding for the mutually referential agent scope. */
const bindContext = Symbol('dsh.agent-loop.bind-context')

/** Module-private publication marker. */
const publishAgent = Symbol('dsh.agent-loop.publish-agent')

/** Factory-owned controls that can operate only on the agent created with them. */
export interface PreparedReactLoopAgent {
  /** The unpublished concrete agent. */
  agent: ReactLoopAgent
  /** Mark the agent public so teardown emits its status lifecycle. */
  markPublished(): void
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
 * Construct an unpublished concrete agent with instance-bound lifecycle
 * controls. Only those paired controls can publish or start this instance.
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
  claimedDriverSessions.add(session)
  const dispose = () => agent[stopDriver]()
  return {
    agent,
    markPublished: () => { agent[publishAgent]() },
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
 * the unpublished agent. The module-private binding rejects a second bind.
 * @param agent - the unpublished concrete agent to bind.
 * @param ctx - its fully extended agent scope context.
 */
export function bindReactLoopAgentContext(agent: ReactLoopAgent, ctx: Context): void {
  agent[bindContext](ctx)
}

/**
 * The concrete {@link Agent} implementation owned by the agent-loop plugin.
 *
 * Owns the inbox (queued + steering FIFOs), the per-step AbortController, and
 * the loop driver. Everything observable happens through session events and
 * the agent/* event taxonomy — plugins never need this class.
 */
export class ReactLoopAgent implements Agent {
  /** Queued + steering FIFOs; native-private so callers cannot bypass the public driving verbs. */
  readonly #inbox = new Inbox()

  /**
   * The agent's scope context ({@link Agent.ctx}), wired by the factory right
   * after the scope is minted — before the agent is registered, announced, or
   * driven, so no consumer can observe it unset. Definite-assignment (`!`)
   * expresses that two-phase construction: the agent object and its scope
   * context are mutually referential (the scope is keyed BY this agent), so
   * neither can exist strictly before the other.
   */
  private boundContext: Context | undefined

  /** The agent's scoped composition context, bound once by its factory. */
  get ctx(): Context {
    if (this.boundContext === undefined) throw new Error(`agent "${this.id}" context is not bound`)
    return this.boundContext
  }

  private _status: AgentStatus = 'idle'
  private currentAbort: AbortController | undefined
  /** Whether runLoop has been installed into {@link done}. */
  private driverStarted = false
  /** Whether registry publication began and status disposal is externally visible. */
  private published = false
  /**
   * Turn-scoped cancel marker, set by {@link cancel} and read/cleared by the
   * driver loop (via the LoopHandle) at every point a turn could start or
   * continue. Armed ONLY when there is something to cancel (a running turn, an
   * in-flight step, or queued/steering work), so an idle no-op cancel cannot
   * leave it set to wrongly drop a later prompt.
   */
  private cancelRequested = false
  /** Pending cancellation reason, preserved even outside an active step signal. */
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
    // Settle first so a throwing status listener cannot starve quiescence waiters.
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

  /**
   * Accept one public send/steer payload as the exact detached record shared by
   * the live notification and inbox. Lossless-JSON materialization reads every
   * nested field once; deep freeze prevents an observer from rewriting queued
   * work before the loop drains it.
   */
  private acceptInboxMessage(content: ContentBlock[], options?: SendOptions): InboxMessage {
    const source = this.resolveSource(options)
    const accepted = snapshotJsonValue({ content, source })
    if (accepted === undefined) {
      throw new TypeError('agent message content and source must be losslessly JSON-serializable')
    }
    return deepFreeze(accepted)
  }

  /** Reject a driving operation once teardown has synchronously closed the agent. */
  private assertNotDisposed(): void {
    if (this._status === 'disposed') throw new Error(`agent "${this.id}" is disposed`)
  }

  send(content: ContentBlock[], options?: SendOptions): void {
    this.assertNotDisposed()
    const accepted = this.acceptInboxMessage(content, options)
    this.#inbox.enqueue(accepted)
    const info = { source: accepted.source, steering: false } as const
    agentEvents(this.loopCtx, this).emit('agent/queued', accepted.content, info)
  }

  steer(content: ContentBlock[], options?: SendOptions): void {
    this.assertNotDisposed()
    if (this._status !== 'running') { this.send(content, options); return }
    const accepted = this.acceptInboxMessage(content, options)
    this.#inbox.steer(accepted)
    const info = { source: accepted.source, steering: true } as const
    agentEvents(this.loopCtx, this).emit('agent/queued', accepted.content, info)
  }

  inject(content: ContentBlock[], options?: InjectOptions): void {
    this.assertNotDisposed()
    const source = this.resolveSource(options)
    const context = {
      content,
      source,
      ...options?.envelope !== undefined ? { envelope: options.envelope } : {},
      ...options?.meta !== undefined ? { meta: options.meta } : {},
    }
    if (isTurnOpen(this.session)) {
      // A turn is open in the LOG (decided from the log, not agent status —
      // status can be `running` with no turn open): the context/message is
      // turn-enclosed by that turn, so append it directly.
      this.session.append('context/message', context, { surfaceOp: 'append' })
      return
    }
    // No turn open: wrap the injection in a one-shot turn so every event stays
    // turn-enclosed (the durability/replay boundary is the turn).
    const turn = lastTurnNumber(this.session) + 1
    // Once turn/start enters the log, a turn/end is owed even if the message
    // append fails acceptance or pre-commit validation. The finally re-checks
    // the log and closes only a turn that actually opened; post-commit observers
    // are contained by Session and cannot create a false append failure.
    try {
      this.session.append('turn/start', { turn, trigger: { kind: 'injection', source } })
      this.session.append('context/message', context, { surfaceOp: 'append' })
    } finally {
      // Close the turn if turn/start made it into the log. A pre-commit veto
      // must escape rather than being mistaken for a committed turn/end.
      if (isTurnOpen(this.session)) {
        this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
      // Decide the durability checkpoint from the log: an accepted one-shot
      // turn must be flushed even when its message append was the failing step.
      const turnRecorded = this.session.events.some(e => e.type === 'turn/start' && e.data.turn === turn)
      // Keep inject() synchronous: report checkpoint failures live instead of
      // rejecting the caller, and track the task so disposal still drains it.
      if (turnRecorded) {
        // Through the store's flush (the carrier owner), never a raw parallel.
        const flush = this.loopCtx.sessions.flush(this.session).catch((error: unknown) => {
          const rendered = renderThrown(error)
          const err = error instanceof Error ? error : new Error(rendered)
          this.loopCtx.logger.warn(`agent "${this.id}": flush after idle injection failed: ${rendered}`)
          agentEvents(this.loopCtx, this).emit('agent/error', turn, 0, err)
        })
        this.pendingIdleFlushes.add(flush)
        // Retire on either settlement path.
        const retire = (): void => { this.pendingIdleFlushes.delete(flush) }
        void flush.then(retire, retire)
      }
    }
  }

  cancel(reason?: string): void {
    // Arm only for current work; an idle marker would cancel the next prompt.
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
   * Resolve immediately when idle with no queued work, on the next quiescent
   * idle transition otherwise, or after driver exit when already disposed.
   * This observes quiescence; it does not own teardown.
   */
  whenIdle(): Promise<void> {
    if (this._status === 'disposed') return this.done
    if (this._status !== 'running' && !this.#inbox.hasQueued) return Promise.resolve()
    // Agent-owned waiters survive concurrent fiber disposal.
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(() => {
        resolve(this._status === 'disposed' ? this.done : undefined)
      })
    })
  }

  /** Bind the mutually referential scope context once. */
  private [bindContext](ctx: Context): void {
    if (this.boundContext !== undefined) throw new Error(`agent "${this.id}" context is already bound`)
    this.boundContext = ctx
  }

  /** Mark that public lifecycle publication began. */
  private [publishAgent](): void {
    this.published = true
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
      // Pre-step cancellation re-parks without emitting a status transition.
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
      // Once publication begins, disposed is part of the agent/status contract.
      if (this.published) {
        agentEvents(this.loopCtx, this).emit('agent/status', 'disposed')
      }
    }
    // Before runLoop starts there is normally nothing asynchronous to drain;
    // keep publication rollback synchronous so create() cannot throw while its
    // session/agent entries are still briefly live. A session-start listener
    // may have called inject(), however, so preserve
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
    // Repeat because settled flushes retire in adjacent promise reactions;
    // allSettled keeps reporting failures from skipping ownership teardown.
    while (this.pendingIdleFlushes.size > 0) {
      await Promise.allSettled([...this.pendingIdleFlushes])
    }
  }
}

/** Render an ordinary thrown value for the error event and log. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
