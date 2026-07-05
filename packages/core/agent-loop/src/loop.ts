/**
 * The agent loop driver: one `runLoop()` invocation drives one agent for its
 * whole lifetime. Error-contained at the turn level — a throwing plugin ends
 * the turn, never kills the loop. See the JSDoc on `runLoop()` for the full
 * lifecycle pseudo-code.
 *
 * @module dsh-agent-loop/loop
 */

import type { Context } from 'cordis'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { BlockAssembler, HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContinuationDecision, HookContext, PromptDecision } from '@deepseek-ai/dsh-agent'
import type { Session, TurnEndReason, TurnTrigger } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { ReactLoopAgent } from './agent.ts'

/** An Error with an optional machine-readable code (e.g., from LlmError or a throwing plugin). */
type CodedError = Error & { code?: string }

/**
 * Normalize an arbitrary thrown value into a coded Error. A real Error passes
 * through (its `code`, if any, is preserved by {@link errorData}); a non-Error
 * throw is wrapped in a {@link HarnessError} with code `UNKNOWN` and the
 * original value chained as `cause`, so a bad throw still carries a routable
 * code instead of degrading to a bare message.
 */
function toError(error: unknown): CodedError {
  return error instanceof Error ? error : new HarnessError(String(error), 'UNKNOWN', { cause: error })
}

/**
 * Map a model-call {@link FinishReason} to the step error it should raise, or
 * `undefined` when the step completed normally.
 *
 * Adapters report provider/transport failures one of two sanctioned ways (see
 * the StreamChunk contract in dsh-llm): throw from `stream()` (handled by the
 * caller's try/catch), OR end the stream with a finish-error/aborted chunk
 * (the only option for adapters that can't throw mid-stream, e.g.
 * library-backed ones). This translates the latter into a thrown step error
 * so the turn ends error/aborted (the failure recorded on `turn/end.reason`),
 * never as a normal `completed` assistant message.
 *
 * `FinishReason` is merge-extensible (plugins/adapters can add `kind`s), so
 * the switch handles the known terminal-failure kinds and treats every other
 * kind — `stop`, `tool-calls`, `max-tokens`, future additions — as success.
 */
function finishError(finish: FinishReason): CodedError | undefined {
  switch (finish.kind) {
    case 'error': {
      const error: CodedError = new Error(finish.message)
      if (finish.code !== undefined) error.code = finish.code
      return error
    }
    case 'aborted': {
      const error: CodedError = new Error('model stream aborted')
      error.code = 'ABORTED'
      return error
    }
    // stop / tool-calls / max-tokens / plugin-added kinds → not a failure.
    default:
      return undefined
  }
}

/**
 * Build the `{ message, code? }` part of an error payload, omitting the
 * `code` key entirely when absent (exactOptionalPropertyTypes-correct).
 */
function errorData(err: CodedError): { message: string; code?: string } {
  return { message: err.message, ...typeof err.code === 'string' ? { code: err.code } : {} }
}

/**
 * The turn-end contribution of a step's *successful* finish, or `undefined`
 * when the step finished ordinarily (a plain `completed`).
 *
 * {@link finishError} has already converted `error`/`aborted` finishes into
 * thrown step errors, so the finishes that reach here are `stop`,
 * `tool-calls`, `max-tokens`, or a future merge-extensible kind. Only
 * `max-tokens` carries forward as a distinct {@link TurnEndReason}: a step that
 * hit the output-token ceiling ended the turn cut-short rather than by the
 * model's choice. `stop`/`tool-calls`/unknown kinds contribute nothing beyond
 * the default `completed`. {@link runTurn} applies this with the rule "any
 * `max-tokens` step in the turn makes the turn end `max-tokens`".
 */
function stepFinishReason(finish: FinishReason): TurnEndReason | undefined {
  switch (finish.kind) {
    case 'max-tokens':
      return { kind: 'max-tokens' }
    // stop / tool-calls / plugin-added kinds → no turn-end contribution
    // beyond the default `completed`. FinishReason is merge-extensible, so a
    // default (not assertNever) handles unknown kinds as ordinary success.
    default:
      return undefined
  }
}

/**
 * Ambient handles the loop driver receives from the agent. Decouples the
 * pure function `runLoop` from the mutable ReactLoopAgent fields, making the
 * loop testable without a real agent.
 */
export interface LoopHandle {
  setStatus(status: 'idle' | 'running'): void
  setAbort(controller: AbortController | undefined): void
  /** Resolves when the agent is disposed — unblocks the idle wait. */
  disposed: Promise<void>
  isDisposed(): boolean
  /**
   * Whether a `cancel()` is pending for the current turn. The driver checks this
   * at every decision point where a turn could start or continue (right after
   * the idle wait, after the `running` flip, before each step, and at the
   * continuation gate) and drops the about-to-run / continuing turn. Reset once
   * per loop iteration via {@link clearCancel} after the turn returns, so the
   * marker governs exactly one cancellation and never leaks to a later prompt.
   */
  isCancelled(): boolean
  /**
   * The resolved reason for the pending cancel (`reason ?? 'cancelled'`), read
   * by the marker branches (pre-step / continuation) so a turn dropped where no
   * `AbortController` carries the reason still records the caller's
   * `cancel(reason)` value — matching the mid-step abort path. Only meaningful
   * when {@link isCancelled} is true.
   */
  cancelReason(): string
  /** Clear the cancel marker (called once per iteration after the turn returns). */
  clearCancel(): void
  /**
   * Settle pending `whenIdle()` waiters WITHOUT a status transition. Used by the
   * pre-step cancel-skip path: it drops the about-to-run turn and re-parks at the
   * idle wait, so no `running→idle` transition fires to settle a `whenIdle()`
   * waiter that was registered in the pre-step window — this settles it directly
   * (it emits no `agent/status`, so an ACP `agent/status` listener never sees a
   * spurious idle that would resolve a freshly-queued prompt as cancelled).
   */
  settleIdle(): void
}

/**
 * The agent loop. One invocation drives one agent for its whole lifetime:
 *
 * ```
 * create agent → emit agent/session-start(source)    ⟵ once, before turn 1
 * forever:
 *   wait for queued messages (idle)
 *   TURN (error-contained — a throwing plugin ends the turn, never the loop):
 *     'turn/start'; each queued msg: waterfall agent/prompt-submit    ⟵ durable turn boundary (no agent/* mirror)
 *       allow → session('user/message'…) (+ inject additionalContext) | block → drop
 *     every prompt blocked → 'turn/end'(rejected), 0 steps
 *     STEP loop:
 *       drain steering → session('steering/message')  ⟵ catches late steering
 *       assembly = ctx.systemPrompt.assemble({agent}) ⟵ waterfall system-prompt/assemble; renderPrompt
 *                                                        (persona section + {{variables}}) IS the full prompt
 *       await ctx.serial('agent/pre-step')            ⟵ surface mutation (compaction) OUTSIDE the step
 *       session('step/start')                         ⟵ durable step boundary (no agent/* mirror)
 *       req = {model, system, tools, messages: session.deriveMessages(), signal}
 *       req = waterfall agent/request                 ⟵ hooks/model-switch
 *       stream ctx.llm.stream(req)                    ⟵ waterfall llm/stream (raw chunks)
 *         session('assistant/chunk')
 *       msg = waterfall agent/step-result             ⟵ BEFORE the log append, so the
 *       session('assistant/message' {content, usage?})   session records what actually ran
 *       each tool-call in msg (sequential, abort-checked):
 *         session('tool/call'); ctx.tools.execute()   ⟵ tools/pre-execute (allow/deny/ask)
 *                                                        → dispatch → tools/post-execute
 *         session('tool/result')
 *       append buffered post-execute additionalContext → session('context/message')(s)
 *       drain steering → session('steering/message')
 *       session('step/end')                           ⟵ durable step boundary (no agent/* mirror)
 *       cont = waterfall agent/turn-continuation       ⟵ ContinuationDecision; default
 *         {action: hadToolCalls||steered ? 'continue':'stop'}; a continue.reason is
 *         recorded as next-step steering
 *       if action==stop && steering arrived (step/end/continuation listeners): continue anyway
 *       if action==stop: break
 *     session('turn/end')                             ⟵ durable turn boundary (no agent/* mirror)
 *     await ctx.parallel('session/flush', session)    ⟵ durability checkpoint
 *     re-enqueue leftover steering as queued          ⟵ steering is never stranded
 *   idle (emit agent/status) unless more queued
 * ```
 */
export async function runLoop(ctx: Context, agent: ReactLoopAgent, handle: LoopHandle): Promise<void> {
  const { session } = agent

  while (!handle.isDisposed()) {
    await agent.inbox.waitForQueued(handle.disposed)
    if (handle.isDisposed()) break

    // Pre-step cancel (window 1): a `cancel()` landed after a `send()` woke the
    // idle wait but before we flip to `running`. The cancelled queued/steering
    // work is already cleared by `cancel()`. Clear the marker, then:
    //   - if NOTHING new is queued, drop the about-to-run turn and re-park,
    //     settling any `whenIdle()` waiter DIRECTLY (no running→idle transition
    //     fires here to settle it) and WITHOUT emitting `agent/status` (an ACP
    //     listener must not see a spurious idle that resolves a freshly-queued
    //     prompt as cancelled);
    //   - if a NEW prompt was queued AFTER the cancel (a send() that raced in
    //     before the loop resumed), the marker was for the cancelled work only —
    //     fall through and run the new prompt's turn. Do NOT settle waiters here:
    //     a whenIdle() waiter must wait for that new turn's running→idle, not
    //     resolve before it runs (the quiescence contract).
    if (handle.isCancelled()) {
      handle.clearCancel()
      if (!agent.inbox.hasQueued) {
        handle.settleIdle()
        continue
      }
    }

    handle.setStatus('running')

    // Pre-step cancel (window 2): `setStatus('running')` emits `agent/status`
    // SYNCHRONOUSLY, so a `running` listener can `cancel()` in the gap between the
    // check above and `runTurn`. Mirror window 1: clear the marker, then
    //   - if NOTHING new is queued, drop the about-to-run turn and transition
    //     back to `idle` (`running` was already emitted, so a real idle
    //     transition balances the status AND settles `whenIdle()` waiters);
    //   - if a NEW prompt was queued AFTER the cancel (a `running` listener that
    //     cancels then sends), the marker was for the cancelled work only — fall
    //     through and run the new prompt's turn (status is already `running`), so
    //     a `whenIdle()` waiter resolves on THAT turn's running→idle, not before
    //     it runs. Settling here would resolve quiescence while the replacement
    //     is still queued and unrun (the same early-resolve race window 1 fixes).
    if (handle.isCancelled()) {
      handle.clearCancel()
      if (!agent.inbox.hasQueued) {
        handle.setStatus('idle')
        continue
      }
    }

    // Re-derive the turn number from the log each iteration (do NOT keep a local
    // counter): an idle `agent.inject()` can append its own one-shot turn while
    // the loop waits above, so the next real turn must continue from whatever
    // turn number is actually last in the log — a stale counter would collide.
    const turn = lastTurnNumber(session) + 1
    try {
      await runTurn(ctx, agent, handle, turn)
    } catch (error: unknown) {
      // Backstop: runTurn rethrows only a PRE-turn throw (the invariant guard
      // before turn/start) — no turn/start was appended, so no turn is open and
      // none is owed. A session `error` here would land outside any turn (after
      // the previous turn/end), where the persistence backend drops it as a
      // crash tail (the turn-enclosure RFC). Report via agent/error + the logger only; the
      // driver survives and moves on.
      const err = toError(error)
      ctx.logger.warn(`agent "${agent.id}": turn ${turn} failed before it started: ${err.message}`)
      try {
        ctx.emit('agent/error', agent, turn, 0, err)
      } catch { /* contained: a throwing agent/error listener must not kill the driver */ }
    }

    // Reset the cancel marker UNCONDITIONALLY here, after the turn returns and
    // before the next iteration's idle wait. NOT gated on the idle transition
    // below: a `send()` that lands during the cancelled turn's flush window makes
    // `hasQueued` true at the `setStatus('idle')` guard, so an idle-gated reset
    // would never fire and the stale marker would wrongly drop that next prompt's
    // turn. Resetting per iteration scopes the marker to exactly the turn that was
    // cancelled.
    handle.clearCancel()

    // Steering that arrived too late to join this turn (turn-end listeners,
    // flush) becomes a queued message — it must never be stranded. (A cancelled
    // turn already cleared its steering, so there is nothing to re-enqueue.)
    for (const message of agent.inbox.drainSteering()) {
      agent.inbox.enqueue(message)
    }

    if (!agent.inbox.hasQueued) handle.setStatus('idle')
  }
}

async function runTurn(ctx: Context, agent: ReactLoopAgent, handle: LoopHandle, turn: number): Promise<void> {
  const { session } = agent

  // --- Pre-turn. A throw here (the invariant guard) is owed NO turn/end —
  // turn/start has not been appended — so it propagates to runLoop's backstop
  // untouched. The queued messages are drained here but appended AFTER
  // turn/start (below), so every event in the log lives inside a turn.
  const queued = agent.inbox.drainQueued()
  const first = queued[0]
  /* v8 ignore next 3 -- invariant guard: runLoop only calls runTurn when hasQueued */
  if (!first) throw new Error('runTurn invariant violated: no queued message at turn start')
  const trigger: TurnTrigger = { kind: 'message', source: first.source }

  let reason: TurnEndReason = { kind: 'completed' }
  let step = 0
  let stepOpen = false
  let errorReported = false

  // Close the open step exactly once (idempotent via stepOpen). Step boundaries
  // are durable session events only — there is no agent/* step emit to mirror
  // them (see the agent event-domain rule). A throwing step/end session-event
  // listener must not abort finalization and strand the turn open (turn/end
  // balance > notifying one bad listener); it is contained and surfaced as a
  // turn error below.
  const closeStep = (): boolean => {
    if (!stepOpen) return false
    stepOpen = false
    // Session.append pushes step/end BEFORE notifying session/event listeners,
    // so a throwing listener leaves step/end in the log (balance holds) but
    // would otherwise abort finalization. Contain it and surface it as a turn
    // error below.
    let failure: unknown
    try {
      session.append('step/end', { turn, step })
    } catch (error: unknown) {
      failure = error
    }
    // A throwing step/end session-event listener surfaces as a turn error via
    // failTurn (idempotent). This prevents a throwing listener from producing a
    // silent "completed" turn when the step itself succeeded, AND keeps
    // finalization going when closeStep runs from the outer catch.
    if (failure !== undefined) {
      failTurn(toError(failure))
      return true
    }
    return false
  }

  // Record a step/turn failure exactly once: set the error reason (carrying the
  // failing `step` — the durable failure lives entirely on turn/end.reason, there
  // is no separate session error event) and emit agent/error (contained — trap: a
  // throwing agent/error listener must not re-escape and strand the turn).
  // Disposal and abort set `reason` directly without calling this (they are not
  // failures).
  const failTurn = (err: CodedError): void => {
    if (errorReported) return
    errorReported = true
    // The turn is always still open here: the only failure that can reach
    // failTurn once turn/end is appended would be a throwing turn-boundary
    // listener, and turn boundaries are durable session events with no agent/*
    // mirror to throw. A throwing `turn/end` session-event listener is already
    // contained inside closeTurn (append pushes before notifying, so the
    // boundary is durable). So set the error reason for closeTurn to append.
    reason = { kind: 'error', step, ...errorData(err) }
    try {
      ctx.emit('agent/error', agent, turn, step, err)
    } catch {
      // contained: the error is already captured on `reason`; a throwing
      // agent/error listener must not prevent the turn from closing.
    }
  }

  // Close the turn. Called exactly once per turn — the normal loop exit and the
  // outer catch are mutually exclusive paths, and this never throws (the append
  // is contained below), so there is no re-entry to guard against (unlike
  // closeStep, which the cancel branches and the outer catch can both reach).
  // Turn boundaries are durable session events only — there is no agent/* turn
  // emit to mirror them (see the agent event-domain rule).
  const closeTurn = (): void => {
    // Session.append pushes turn/end BEFORE notifying session/event listeners,
    // so a throwing listener leaves turn/end in the log (the turn is balanced)
    // but would otherwise escape — from the outer catch it would propagate to
    // the runLoop backstop. Contain it: the boundary is durable either way, and
    // finalization must not abort on a bad listener.
    try {
      session.append('turn/end', { turn, reason })
    } catch (error: unknown) {
      ctx.logger.warn(`agent "${agent.id}": session/event listener threw on turn/end at turn ${turn}: ${toError(error).message}`)
    }
  }

  try {
    // --- Turn boundary. Once turn/start is appended, a turn/end is owed no
    // matter what throws below; the catch + closeTurn guarantee it (the catch
    // decides "owed" from the log via isTurnOpen, so even a throwing turn/start
    // listener — append pushes before notifying — still gets its turn/end).
    session.append('turn/start', { turn, trigger })
    // Each drained queued message runs the `agent/prompt-submit` waterfall before
    // it becomes a `user/message` — a hook can rewrite the prompt or block it.
    // Recorded INSIDE the turn (after turn/start) so every event is turn-enclosed;
    // turn/end is now owed, so a throwing prompt-submit listener (the waterfall
    // throws) is caught below and the turn still closes.
    let anyAllowed = false
    // Seeded with a floor (only observable if the batch were empty, which
    // runTurn never allows — it is called with ≥1 queued message); each `block`
    // decision carries a required `reason` and overwrites it, so a fully-blocked
    // batch always reports the last vetoing reason.
    let lastBlockReason = 'prompt blocked by hook'
    for (const message of queued) {
      const decision = await ctx.waterfall(
        'agent/prompt-submit', agent, message.content, message.source,
        () => Promise.resolve<PromptDecision>({ kind: 'allow' }),
      )
      if (decision.kind === 'block') {
        lastBlockReason = decision.reason
        // Record the veto durably: `PromptDecision.reason` is the durable record
        // of why a prompt was blocked, but a fully-blocked batch's `rejected`
        // turn/end only preserves the LAST reason, and a MIXED batch (this prompt
        // blocked, another allowed) does not end `rejected` at all — so without
        // this append a blocked prompt would vanish from the log whenever any
        // sibling prompt is allowed. `prompt/blocked` sits in the open turn in
        // place of the `user/message` this prompt would have become.
        session.append('prompt/blocked', { content: message.content, source: message.source, reason: decision.reason })
        continue
      }
      anyAllowed = true
      // `allow.content` REPLACES the prompt bytes (a rewrite); absent keeps them.
      const content = decision.content ?? message.content
      session.append('user/message', { content, source: message.source }, { surfaceOp: 'append' })
      // `allow.additionalContext` is a SEPARATE context/message the next request
      // also sees. The turn is open, so inject() appends it into THIS turn.
      if (decision.additionalContext) {
        agent.inject(decision.additionalContext.content, { source: decision.additionalContext.source })
      }
    }

    while (true) {
      // A fully-blocked batch (every prompt vetoed by prompt-submit) opens a
      // zero-step turn that ends `rejected`: break BEFORE the first step so the
      // boundary stays balanced (turn/start → turn/end) and the block is a
      // durable in-turn fact. `anyAllowed` never changes inside the loop, so this
      // only ever fires on the first iteration.
      if (!anyAllowed) {
        reason = { kind: 'rejected', reason: lastBlockReason }
        break
      }
      step += 1

      // Steering from the previous round's continuation listeners joins before
      // the request.
      drainSteering(agent, turn)

      // The step's AbortController exists BEFORE any async pre-step work so a
      // dispose() or cancel() — in a synchronous turn-start listener or an
      // async listener whose effect fires before we block — always has an armed
      // abort to cancel against. isDisposed below covers disposal, which does
      // NOT set the cancel marker. Cleared on every exit path below.
      const abort = new AbortController()
      handle.setAbort(abort)

      // Assemble the system prompt for this step. Done HERE (before step/start)
      // because the pre-step seam needs it: compaction measures token pressure
      // against the system prompt (it counts toward the budget). runStep reuses
      // this same assembly for the request, so the prompt is assembled once per
      // step. renderPrompt IS the full prompt — the persona is the order-0
      // section (registered by the AgentLoop plugin) and `{{variable}}`
      // interpolation happens in the render, so there is no separate join.
      const assembly = await ctx.systemPrompt.assemble({ agent })
      const fullSystemPrompt = renderPrompt(assembly)

      // Interruption landing after assembly: dispose() or cancel() in a
      // turn-start listener (or a listener whose promise resolved before the
      // await above) arms either handle.isDisposed() or handle.isCancelled().
      // The Abort was created first, so any concurrent abort also lands on it.
      // Drop the about-to-start step WITHOUT running the seam — no step is open
      // yet, so end the turn accordingly (disposed wins for an unambiguous
      // reason).
      if (handle.isCancelled() || handle.isDisposed()) {
        handle.setAbort(undefined)
        reason = handle.isDisposed() ? { kind: 'disposed' } : { kind: 'aborted', reason: handle.cancelReason() }
        break
      }

      // Pre-step surface-mutation checkpoint (compaction), fired OUTSIDE the
      // step: after `turn/start` (and the prior step's close) but before
      // `step/start`, so a compaction's log-only `compact/*` records and its
      // replacement node land cleanly outside any step (honest structure that
      // crash-safety relies on — a dangling `compact/start` sits before the
      // synthetic `turn/end` repair appends). Serial (awaited, in order, no
      // veto): each listener completes its surface mutation before the next, so
      // concurrent listeners cannot interleave their `session.append`s. A
      // throwing listener escapes to the outer catch, which closes the (not-yet-
      // open) step as a no-op and ends the turn via failTurn — a broken
      // pre-step plugin ends the turn, not the loop.
      await ctx.serial('agent/pre-step', agent, turn, step, fullSystemPrompt, abort.signal)

      // Interruption landing during the pre-step seam: do not open an empty step.
      if (handle.isCancelled() || handle.isDisposed()) {
        handle.setAbort(undefined)
        reason = handle.isDisposed() ? { kind: 'disposed' } : { kind: 'aborted', reason: handle.cancelReason() }
        break
      }

      // Mark the step open BEFORE the append: Session.append pushes the event
      // to the log before notifying session/event listeners, so a THROWING
      // step/start listener leaves step/start in the log. Setting stepOpen first
      // means the outer catch's closeStep() then appends the balancing step/end
      // (turn stays enclosed) instead of stranding an open step under turn/end.
      stepOpen = true
      session.append('step/start', { turn, step })

      // Cancel landing in the step-start window: a synchronous `session/event`
      // step/start listener can cancel after the step is already open. Check
      // AFTER the step/start append and before `runStep`: drop the step, end the
      // turn accordingly. closeStep balances the already-appended step/start.
      if (handle.isCancelled() || handle.isDisposed()) {
        handle.setAbort(undefined)
        reason = handle.isDisposed() ? { kind: 'disposed' } : { kind: 'aborted', reason: handle.cancelReason() }
        closeStep()
        break
      }

      let stepOutcome: { hadToolCalls: boolean; finish: FinishReason } | { error: Error }
      try {
        stepOutcome = await runStep(ctx, agent, turn, step, assembly, fullSystemPrompt, abort.signal)
      } catch (error: unknown) {
        stepOutcome = { error: toError(error) }
      } finally {
        handle.setAbort(undefined)
      }

      if ('error' in stepOutcome) {
        // Steering that arrived during the failed step stays in the inbox —
        // runLoop re-enqueues it as a queued message, so an abort-then-steer
        // starts a fresh turn instead of being silently consumed.
        closeStep()
        const { error } = stepOutcome
        if (handle.isDisposed()) {
          reason = { kind: 'disposed' }
        } else if (abort.signal.aborted) {
          /* v8 ignore next -- signal.reason always set: cancel()/disposal provide a default */
          reason = { kind: 'aborted', reason: String(abort.signal.reason ?? 'aborted') }
        } else {
          failTurn(error)
        }
        break
      }

      // The successful step's finish reason carries forward: a `max-tokens`
      // step makes the whole turn end `max-tokens` (the ACP RFC's rule "any
      // max-tokens step surfaces as max-tokens"). `stepFinishReason` returns
      // `max-tokens` or `undefined`, so a later ordinary step never resets a
      // max-tokens turn back to completed, and a never-truncated turn keeps the
      // default `completed`. The disposal/abort/error branches above and the
      // continuation-window disposal check below override this — they win.
      const stepReason = stepFinishReason(stepOutcome.finish)
      if (stepReason) reason = stepReason

      // Steering that arrived during streaming/tool execution.
      const steered = drainSteering(agent, turn)

      if (closeStep()) break

      const defaultDecision: ContinuationDecision = { action: stepOutcome.hadToolCalls || steered ? 'continue' : 'stop' }
      let decision: ContinuationDecision
      try {
        decision = await ctx.waterfall(
          'agent/turn-continuation', agent, turn, defaultDecision,
          () => Promise.resolve(defaultDecision),
        )
      } catch (error: unknown) {
        // A broken continuation plugin ends the turn, not the loop.
        failTurn(toError(error))
        break
      }

      // A forced `continue` may carry model-facing context: record it as
      // next-STEP steering (the steering channel), so the continued turn's next
      // iteration drains it before its request — the typed twin of the /goal
      // step/end-steer pattern.
      if (decision.action === 'continue' && decision.reason) {
        agent.inbox.steer({ content: decision.reason.content, source: decision.reason.source })
      }
      let shouldContinue = decision.action === 'continue'

      // Steering from step/end session-event or continuation listeners (the
      // /goal pattern) demands the model see it — it overrides a stop decision;
      // the next iteration's drain records it.
      if (!shouldContinue && agent.inbox.hasSteering) shouldContinue = true

      // A cancel that landed during the continuation window — after the step's
      // AbortController was cleared (setAbort(undefined)) but before the next
      // step starts — has no controller to observe it, so the turn-scoped marker
      // ends the turn here. cancel() also cleared the steering FIFO, so the
      // override above did not re-arm continuation.
      if (handle.isCancelled()) {
        reason = { kind: 'aborted', reason: handle.cancelReason() }
        break
      }

      if (!shouldContinue || handle.isDisposed()) {
        /* v8 ignore next -- disposal during continuation-decision window is a narrow race; error-path disposal is covered elsewhere */
        if (handle.isDisposed()) reason = { kind: 'disposed' }
        break
      }
    }

    // Normal / inline-error loop exit: close the turn.
    closeTurn()
  } catch (error: unknown) {
    // Decide whether this turn was ever opened from the LOG, not a flag.
    // Session.append pushes the event BEFORE notifying session/event listeners,
    // so a throwing listener on the `turn/start` append leaves turn/start in the
    // log even though execution never reached the lines after that append.
    // Gating on a "turn started" boolean would skip turn/end and leave a
    // permanently OPEN turn that poisons the next turn/replay (the turn-enclosure RFC). We
    // check the log for THIS turn's turn/start: present means a turn/end is owed
    // and the normal-exit `closeTurn()` did NOT run (we are here because a throw
    // preceded it — the two `closeTurn()` sites are on mutually exclusive paths),
    // so this catch appends turn/end with the disposed/error reason chosen below.
    // `closeStep()` IS idempotent (guarded by `stepOpen`) — it may have run
    // already in a step branch, so running it again is a safe no-op. Absent
    // turn/start means the append threw BEFORE its push (a non-serializable
    // trigger — impossible for our fixed trigger); nothing was opened, so rethrow
    // to the runLoop backstop.
    const turnStartLogged = session.events.some(e => e.type === 'turn/start' && e.data.turn === turn)
    if (!turnStartLogged) throw error
    closeStep()
    // Choose the close reason. Disposal wins only if no error was already
    // reported: a turn disposed mid-step sets reason=disposed in the step-error
    // branch (without reporting an error), so preserve disposed rather than
    // overwrite it. Otherwise a mid-step throw on a live agent is a real
    // failure → failTurn. (errorReported is mutated only inside the failTurn
    // closure, which the analyzer can't follow, hence the inline lint-disable.)
    if (handle.isDisposed() && !errorReported) { // eslint-disable-line @typescript-eslint/no-unnecessary-condition
      reason = { kind: 'disposed' }
    } else {
      failTurn(toError(error))
    }
    closeTurn()
  }

  // Durability checkpoint: persistence plugins drain write-behind buffers.
  // A failing persistence plugin is reported but doesn't kill the agent.
  try {
    await ctx.parallel('session/flush', session)
  } catch (error: unknown) {
    // The turn is already closed (turn/end appended above) and flush must run
    // AFTER turn/end to be a checkpoint — so there is no in-turn position left
    // for a session `error` event. Appending one here would land it after the
    // last turn/end, where the persistence backend treats it as a crash tail
    // and drops it on resume (the turn-enclosure RFC: every event is turn-enclosed). Report
    // the failure via agent/error + the logger only; persistence keeps the
    // buffered events for the next flush/dispose, so nothing is lost.
    const err = toError(error)
    ctx.logger.warn(`agent "${agent.id}": session/flush failed at turn ${turn}: ${err.message}`)
    try {
      ctx.emit('agent/error', agent, turn, step, err)
    } catch {
      // contained: a throwing agent/error listener must not escape the loop.
    }
  }
}

/** Drain the steering queue into the session. Returns whether any arrived. */
function drainSteering(agent: ReactLoopAgent, turn: number): boolean {
  const messages = agent.inbox.drainSteering()
  for (const message of messages) {
    agent.session.append('steering/message', { turn, content: message.content, source: message.source }, { surfaceOp: 'append' })
  }
  return messages.length > 0
}

/** One step: derive request from the (already pre-step-mutated) surface →
 * stream model → record → execute tools. The caller assembles the system prompt
 * and fires the `agent/pre-step` seam BEFORE opening the step, then passes the
 * resulting `assembly`/`system` here, so the surface this step derives from
 * already reflects any compaction. */
async function runStep(
  ctx: Context,
  agent: ReactLoopAgent,
  turn: number,
  step: number,
  assembly: PromptAssembly,
  system: string,
  signal: AbortSignal,
): Promise<{ hadToolCalls: boolean; finish: FinishReason }> {
  const { session, options } = agent

  let request: GenerateOptions = {
    model: options.model ?? '',
    messages: session.deriveMessages(),
    ...system ? { system } : {},
    ...assembly.tools.length > 0 ? { tools: assembly.tools } : {},
    sessionId: session.id,
    signal,
  }
  request = await ctx.waterfall('agent/request', agent, turn, step, request, () => Promise.resolve(request))
  if (!request.model) {
    throw new Error(`agent "${agent.id}" has no model: set AgentOptions.model or supply one via the agent/request waterfall`)
  }

  // --- Model call (streaming-first; raw chunks are the replay record) ---
  const assembler = new BlockAssembler()
  const chunkSeqs: number[] = []
  for await (const chunk of ctx.llm.stream(request)) {
    /* v8 ignore next -- signal.reason always set: cancel()/disposal provide a default */
    if (signal.aborted) throw new Error(String(signal.reason ?? 'aborted'))
    const chunkEvent = session.append('assistant/chunk', { turn, step, chunk })
    chunkSeqs.push(chunkEvent.seq)
    assembler.push(chunk)
  }

  // Adapters report provider/transport failures one of two sanctioned ways
  // (see the StreamChunk contract in dsh-llm): throw from stream() — already
  // handled by the caller's try/catch — OR end the stream with a
  // finish-error/aborted chunk. finishError() maps the latter to the step
  // error to raise (turn ends error/aborted, not a normal completed message).
  const stepError = finishError(assembler.finish)
  if (stepError) throw stepError

  if (assembler.finish.kind === 'max-tokens') {
    let message: Message = withoutToolCalls(assembler.message())
    message = withoutToolCalls(await ctx.waterfall('agent/step-result', agent, turn, step, message, () => Promise.resolve(message)))
    // Fire the assistant/message when there is content OR usage: a max-tokens
    // step can be cut off with empty content but still carry token accounting,
    // and assistant/message is the only host for usage (there is no standalone
    // usage event). An empty-content assistant/message is skipped by
    // deriveMessages(), so hosting usage on it never injects a spurious assistant
    // turn into derived history.
    if (message.content.length > 0 || assembler.usage) {
      // A max-tokens finish is itself a streamed `finish` chunk, so chunkSeqs is
      // never empty here — pass the provenance unconditionally.
      session.append(
        'assistant/message',
        { turn, step, content: message.content, ...(assembler.usage ? { usage: assembler.usage } : {}) },
        { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
      )
    }
    return { hadToolCalls: false, finish: assembler.finish }
  }

  // The step-result waterfall runs BEFORE the session append so the log (the
  // source of truth for derived history and replay) records the message that
  // tool dispatch actually uses.
  let message: Message = assembler.message()
  message = await ctx.waterfall('agent/step-result', agent, turn, step, message, () => Promise.resolve(message))

  // Same content-or-usage guard as the max-tokens branch: a step that finishes
  // with neither assembled content nor usage (e.g. a bare `stop` finish that
  // streamed nothing) records no assistant/message — an empty-content message
  // exists only to host usage, and deriveMessages() skips it either way, so
  // appending one with no usage would be a pure trace-only row.
  //
  // sourceEventSeqs records the assistant/chunk provenance, but is omitted when
  // no chunks streamed (the surface invariant rejects an empty sourceEventSeqs).
  if (message.content.length > 0 || assembler.usage) {
    session.append(
      'assistant/message',
      { turn, step, content: message.content, ...(assembler.usage ? { usage: assembler.usage } : {}) },
      { surfaceOp: 'append', ...(chunkSeqs.length > 0 ? { sourceEventSeqs: chunkSeqs } : {}) },
    )
  }

  // --- Tool execution (sequential; parallel execution is a TODO) ---
  // ToolRegistry.execute converts tool failures (including aborts) into
  // isError results, so abort is re-checked around every call here.
  const toolCalls = message.content.filter(block => block.type === 'tool-call')
  // Per-step buffer of `additionalContext` attached by tools/post-execute
  // listeners. Appended as context/message(s) only AFTER every tool/result for
  // the step, so a multi-call step keeps tool-call/result adjacency
  // (interleaving context between a call's result and the next call's would
  // break the pairing the next model request relies on).
  const pendingContext: HookContext[] = []
  for (const call of toolCalls) {
    /* v8 ignore next -- signal.reason always set: cancel()/disposal provide a default */
    if (signal.aborted) throw new Error(String(signal.reason ?? 'aborted'))
    const callEvent = session.append('tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments })
    let parsedArguments: unknown
    try {
      parsedArguments = call.arguments ? JSON.parse(call.arguments) : {}
    } catch {
      parsedArguments = call.arguments
    }
    // TODO(pre-tool-input-rewrite): tools/pre-execute deliberately cannot rewrite
    // `arguments` — tool/call (the audit record) and assistant/message (the
    // model-history source) are logged BEFORE execute, and live consumers (ACP,
    // tool-bash presentation) read the pre-execution args, so an execution-only
    // rewrite would desync the UI from what ran. Designing that consistently is
    // its own proposed RFC (docs/rfc/proposed/feature/…-pre-tool-input-rewrite.md).
    const result = await ctx.tools.execute({
      callId: call.id,
      name: call.name,
      arguments: parsedArguments,
      agent,
      signal,
    })
    session.append('tool/result', {
      turn, step,
      // The correlation id MUST be the loop's authoritative call.id (the
      // model-transcript id that deriveMessages turns into toolCallId), NOT
      // result.callId — a post-execute waterfall listener returning a
      // mismatched id would otherwise orphan the call↔result pairing in the
      // next model request. A listener-internal id, if ever needed, belongs in
      // a separate diagnostic field, never overloaded onto callId.
      callId: call.id,
      content: result.content,
      isError: result.isError,
      ...result.error ? { error: result.error } : {},
      // The tool's private presentation payload (e.g. a result-time diff),
      // persisted so a UI bridge reproduces the card on replay.
      ...result.meta !== undefined ? { meta: result.meta } : {},
    }, { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] })
    // Buffer (don't append yet) any post-execute additionalContext for this call.
    if (result.additionalContext) pendingContext.push(result.additionalContext)
    // signal CAN flip during the await above (abort() inside a tool);
    // the analyzer can't see through the await boundary.
    /* v8 ignore start -- signal.reason default unreachable: cancel()/disposal always set it */
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (signal.aborted) throw new Error(String(signal.reason ?? 'aborted'))
    /* v8 ignore stop */
  }

  // Append buffered post-execute context AFTER every tool/result, preserving
  // tool-call/result adjacency across the whole batch. inject() appends into the
  // open turn (a context/message at its chronological position).
  for (const context of pendingContext) {
    agent.inject(context.content, { source: context.source })
  }

  return { hadToolCalls: toolCalls.length > 0, finish: assembler.finish }
}

function withoutToolCalls(message: Message): Message {
  return { ...message, content: message.content.filter(block => block.type !== 'tool-call') }
}

/** The last turn number in a (possibly seeded) session log, or 0. */
export function lastTurnNumber(session: Session): number {
  const lastStart = session.events.findLast(event => event.type === 'turn/start')
  return lastStart?.data.turn ?? 0
}

/**
 * Whether a turn is currently open in the session log (a `turn/start` with no
 * matching later `turn/end`). Decided from the LOG, not agent status: status
 * can be `running` while no turn is open (an `agent/status` listener firing
 * before `turn/start`, or the post-`turn/end` flush window before status
 * returns to idle), so status is not a reliable open-turn signal. Used by
 * `inject()` to choose between appending into an open turn vs. wrapping the
 * injection in its own one-shot turn (the turn-enclosure RFC).
 */
export function isTurnOpen(session: Session): boolean {
  const last = session.events.findLast(e => e.type === 'turn/start' || e.type === 'turn/end')
  return last?.type === 'turn/start'
}
