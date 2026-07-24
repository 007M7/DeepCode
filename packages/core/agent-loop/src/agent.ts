/**
 * The concrete Agent implementation: ReactLoopAgent plus its inbox. Everything
 * observable happens through session events and the agent/* event taxonomy —
 * plugins never need this class.
 *
 * @module dsh-agent-loop/agent
 */

import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import { agentEvents, AgentMessageId } from '@deepseek-ai/dsh-agent'
import { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentCancelCause, AgentOptions, AgentStatus, CancelOptions, HookContext, SendOptions } from '@deepseek-ai/dsh-agent'
import { deepFreeze, errorChain } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue, type Session, type SessionId } from '@deepseek-ai/dsh-session'
import { DISPOSED_INTERRUPT_REASON, TurnCancellation } from './cancellation.ts'
import { Inbox, agentMessage, type InboxMessage } from './inbox.ts'
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
 * @param maxParallelToolCalls - resolved in-flight cap for this agent.
 * @returns the agent and closures bound only to that exact instance.
 */
export function prepareReactLoopAgent(
  ctx: Context,
  id: SessionId,
  options: AgentOptions,
  session: Session,
  maxParallelToolCalls: number,
): PreparedReactLoopAgent {
  if (claimedDriverSessions.has(session)) {
    throw new Error(`session "${session.id}" already has a concrete agent driver`)
  }
  const agent = new ReactLoopAgent(ctx, id, options, session, maxParallelToolCalls)
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
 * Owns the inbox (queued + steering FIFOs), turn cancellation, and
 * the loop driver. Everything observable happens through session events and
 * the agent/* event taxonomy — plugins never need this class.
 */
export class ReactLoopAgent extends Agent {
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
  /** Active turn owner from pre-running publication through durability settlement. */
  private turnCancellation: TurnCancellation | undefined
  /** Whether runLoop has been installed into {@link done}. */
  private driverStarted = false
  /** Whether registry publication began and status disposal is externally visible. */
  private published = false
  /** Cause-less marker for queued work cancelled before the driver installs a turn owner. */
  private preRunCancelled = false
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
  /** Maximum parallel-safe calls allowed in one step. */
  private readonly maxParallelToolCalls: number
  /**
   * Durability checkpoints started by idle {@link inject} calls. `inject()` is
   * synchronous, so it cannot await them itself; the driver disposer drains
   * this set before the lifecycle unregisters the agent or detaches its session.
   */
  private pendingIdleFlushes = new Set<Promise<void>>()
  /** Whether the current step is executing an assistant tool-call batch. */
  private toolBatchActive = false
  /** Open-turn injections waiting for the active assistant tool-call batch to close. */
  private deferredInjections: HookContext[] = []

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    maxParallelToolCalls: number,
  ) {
    super()
    this.maxParallelToolCalls = maxParallelToolCalls
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

  /**
   * Accept one public message payload as a detached record. Lossless-JSON
   * materialization reads every nested field once; deep freeze prevents later
   * caller mutation before an inbox or deferred-injection queue drains it.
   */
  private acceptMessage(
    id: AgentMessageId, content: ContentBlock[], source: MessageSource, wakeup: boolean, options?: SendOptions,
  ): InboxMessage {
    const contexts = options?.contexts ?? []
    const accepted = snapshotJsonValue({
      id, content, source, contexts, wakeup,
      ...options?.meta !== undefined ? { meta: options.meta } : {},
    })
    if (accepted === undefined) {
      throw new TypeError('agent message content, source, and contexts must be losslessly JSON-serializable')
    }
    return deepFreeze(accepted)
  }

  /** Detach one context before it can outlive its caller in the active-batch FIFO. */
  private acceptContext(context: HookContext): HookContext {
    const accepted = snapshotJsonValue(context)
    if (accepted === undefined) {
      throw new TypeError('agent context must be losslessly JSON-serializable')
    }
    return deepFreeze(accepted)
  }

  /** Reject a driving operation once teardown has synchronously closed the agent. */
  private assertNotDisposed(): void {
    if (this._status === 'disposed') throw new Error(`agent "${this.id}" is disposed`)
  }

  send(content: ContentBlock[], options?: SendOptions): AgentMessageId {
    this.assertNotDisposed()
    const id = AgentMessageId(randomUUID())
    const target = options?.target ?? 'next-turn'
    const wakeup = options?.wakeup ?? true
    // next-step/no-wakeup is injection: durable context without running the model.
    if (target === 'next-step' && !wakeup) { this.injectContext(content, options); return id }
    // next-step/wakeup is steering into the running turn; idle falls back to a
    // woken follow-up turn (there is no active turn to attach to).
    const steering = target === 'next-step' && this._status === 'running'
    const source = options?.source ?? { kind: 'user' }
    const accepted = this.acceptMessage(id, content, source, wakeup, options)
    if (steering) {
      this.#inbox.steer(accepted)
    } else {
      this.#inbox.enqueue(accepted, wakeup)
    }
    agentEvents(this.loopCtx, this).emit('agent/inbox/enqueue', agentMessage(accepted, steering))
    return id
  }

  /** The `next-step`/no-wakeup injection path: durable context, no FIFO, no run. */
  private injectContext(content: ContentBlock[], options?: SendOptions): void {
    // Injection is synthetic durable context, not an inbox message: attached
    // contexts belong only to queued/steering sends, so reject them rather than
    // silently dropping a value the option type structurally permits.
    if (options?.contexts !== undefined && options.contexts.length > 0) {
      throw new TypeError('agent inject (next-step/no-wakeup) does not accept attached contexts')
    }
    const source = options?.source ?? { kind: 'plugin', plugin: '' }
    // Detach and validate the payload BEFORE any append, so malformed input
    // throws without opening a one-shot turn or mutating the session (the
    // unified send contract: invalid input throws before any append).
    const accepted = this.acceptContext({
      content,
      source,
      ...options?.meta !== undefined ? { meta: options.meta } : {},
    })
    if (isTurnOpen(this.session)) {
      // Provider protocols require every assistant tool-call batch to be
      // followed only by its tool results. Historical interrupted batches do
      // not own new context; only the currently executing batch may defer it.
      if (this.toolBatchActive) {
        this.deferredInjections.push(accepted)
        return
      }
      this.session.append('user/message', accepted, { surfaceOp: 'append' })
      return
    }
    // No turn open: wrap the injection in a one-shot turn so every event stays
    // turn-enclosed (the durability/replay boundary is the turn). The payload is
    // validated above, so both appends commit together; the finally still owes
    // a turn/end (the turn-enclosure invariant) even if a post-commit observer
    // throws after turn/start.
    const turn = lastTurnNumber(this.session) + 1
    try {
      this.session.append('turn/start', { turn, trigger: { kind: 'injection', source } })
      this.session.append('user/message', accepted, { surfaceOp: 'append' })
    } finally {
      // Close the turn if turn/start committed. With the payload validated up
      // front both appends commit together, so the turn is always open here;
      // the guard remains the turn-enclosure backstop.
      /* v8 ignore next -- unopened turn is unreachable after up-front validation; kept as the enclosure backstop. */
      if (isTurnOpen(this.session)) {
        this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
      // Flush the one-shot turn through the store (the carrier owner), never a
      // raw parallel. Keep inject() synchronous: report checkpoint failures live
      // instead of rejecting the caller, and track the task so disposal drains it.
      const flush = this.loopCtx.sessions.flush(this.session).catch((error: unknown) => {
        const rendered = errorChain(error)
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

  /** Append deferred open-turn injections after the loop closes a tool-result batch. */
  private drainDeferredInjections(): void {
    const pending = this.deferredInjections.splice(0)
    for (const accepted of pending) {
      this.session.append('user/message', accepted, { surfaceOp: 'append' })
    }
  }

  /**
   * Run one tool-call batch and drain its deferred context before settlement.
   * The loop-owned acceptor remains valid after public disposal begins because
   * the interrupted turn stays open until this batch settles.
   */
  private async withToolBatch<T>(
    run: (acceptContext: (context: HookContext) => void) => Promise<T>,
  ): Promise<T> {
    this.toolBatchActive = true
    const acceptContext = (context: HookContext): void => {
      this.deferredInjections.push(this.acceptContext(context))
    }
    try {
      return await run(acceptContext)
    } finally {
      this.toolBatchActive = false
      this.drainDeferredInjections()
    }
  }

  cancel(cause?: AgentCancelCause, options?: CancelOptions): void {
    const resolvedCause = cause ?? { kind: 'user' }
    const keepInbox = options?.keepInbox ?? false
    const cancellation = this.turnCancellation
    // keepInbox preserves pending work, so un-started items must not arm the
    // pre-run cancel path that would otherwise drop the next queued turn.
    const preRun = !keepInbox && cancellation === undefined
      && (this.#inbox.hasQueued || this.#inbox.hasSteering)
    if (cancellation !== undefined || preRun) {
      if (preRun) this.preRunCancelled = true
      // Coordination consumers must update their own state before this call
      // clears the inbox or aborts the turn. Notification failures are
      // contained by the fused dispatcher and cannot veto cancellation.
      agentEvents(this.loopCtx, this).emit('agent/cancel-requested', resolvedCause)
    }
    if (!keepInbox) {
      // Snapshot before clearing so the discard notification carries the exact
      // dropped items; a replacement synchronously enqueued by an
      // `agent/cancel-requested` observer belongs to the next turn, not here.
      const discarded = this.#inbox.pending()
      // Clear work already present before abort observers run.
      this.#inbox.clear()
      if (discarded.length > 0) {
        const items = discarded.map(({ message, steering }) => agentMessage(message, steering))
        agentEvents(this.loopCtx, this).emit('agent/inbox/discard', items)
      }
      // No idle-waiter settle here: a `whenIdle` waiter exists only while the
      // agent is `running` or a waking item is queued, and neither is left
      // quiescent by clearing the inbox — a lone quiet item takes `whenIdle`'s
      // fast path (no waiter), a waking item keeps the woken driver running,
      // and a running agent owns its own idle transition (including the
      // post-turn flush window).
    }
    cancellation?.request(resolvedCause)
  }

  /**
   * Resolve immediately when idle with no queued work, on the next quiescent
   * idle transition otherwise, or after driver exit when already disposed.
   * This observes quiescence; it does not own teardown.
   */
  whenIdle(): Promise<void> {
    if (this._status === 'disposed') return this.done
    // A lone quiet (`wakeup:false`) queued item leaves the agent quiescent — the
    // driver stays parked — so gate on hasWakingQueued, not hasQueued.
    if (this._status !== 'running' && !this.#inbox.hasWakingQueued) return Promise.resolve()
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
    this.done = this.loopCtx.agents.withInitiator(this, () => runLoop(this.loopCtx, {
      inbox: this.#inbox,
      maxParallelToolCalls: this.maxParallelToolCalls,
      setStatus: (status) => { this.setStatus(status) },
      installTurnCancellation: () => {
        const cancellation = new TurnCancellation()
        this.turnCancellation = cancellation
        return cancellation
      },
      clearTurnCancellation: (cancellation) => {
        /* v8 ignore else -- the driver clears only the exact owner returned by its latest install. */
        if (this.turnCancellation === cancellation) this.turnCancellation = undefined
      },
      disposed: this.disposed,
      isDisposed: () => this._status === 'disposed',
      isPreRunCancelled: () => this.preRunCancelled,
      clearPreRunCancel: () => { this.preRunCancelled = false },
      withToolBatch: run => this.withToolBatch(run),
      // Pre-run cancellation settles queued-work waiters before publishing idle.
      settleIdle: () => { this.settleIdleWaiters() },
    }))
  }

  /**
   * Quiescent stop shared by pre-start rollback and live teardown. It marks the
   * agent disposed synchronously, contains an unexpected loop rejection, and
   * drains every idle-injection flush before resolving.
   */
  private [stopDriver](): Promise<void> | void {
    if (this._status !== 'disposed') {
      // Discard any still-pending inbox items before disposal so every enqueued
      // id gets a terminal lifecycle event; a disposed agent never dequeues
      // them. Emitted while still published (before the status flip below), and
      // only when there is a public lifecycle to observe it.
      if (this.published) {
        const discarded = this.#inbox.pending()
        if (discarded.length > 0) {
          const items = discarded.map(({ message, steering }) => agentMessage(message, steering))
          agentEvents(this.loopCtx, this).emit('agent/inbox/discard', items)
        }
      }
      this.#inbox.clear()
      this._status = 'disposed'
      this.resolveDisposed()
      // Release whenIdle waiters BEFORE the (guarded) event emit — they are
      // internal state that must settle even if a listener throws below. Each
      // waiter chains `done`, so it resolves only once the loop actually exits.
      this.settleIdleWaiters()
      this.turnCancellation?.request(DISPOSED_INTERRUPT_REASON)
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
