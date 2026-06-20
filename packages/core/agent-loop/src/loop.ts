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
import type { Session, TurnEndReason, TurnTrigger } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
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
 * so the turn ends error/aborted with a logged `error` event, never as a
 * normal `completed` assistant message.
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
 * forever:
 *   wait for queued messages (idle)
 *   TURN (error-contained — a throwing plugin ends the turn, never the loop):
 *     drain queued → 'turn/start' → session('user/message'…) → emit agent/turn-start
 *     STEP loop:
 *       drain steering → session('steering/message')  ⟵ catches late steering
 *       session('step/start'); emit agent/step-start    ⟵ append before emit (the event-sourcing RFC)
 *       assembly = ctx.systemPrompt.assemble()        ⟵ waterfall system-prompt/assemble
 *       req = {model, system, tools, messages: session.deriveMessages(), signal}
 *       req = waterfall agent/request                 ⟵ hooks/compaction/model-switch
 *       stream ctx.llm.stream(req)                    ⟵ waterfall llm/stream (raw chunks)
 *         session('assistant/chunk'); emit agent/stream-chunk
 *       msg = waterfall agent/step-result             ⟵ BEFORE the log append, so the
 *       session('assistant/message','usage')             session records what actually ran
 *       each tool-call in msg (sequential, abort-checked):
 *         session('tool/call'); ctx.tools.execute()   ⟵ waterfall tools/execute
 *         session('tool/result')
 *       drain steering → session('steering/message'); emit agent/steering
 *       emit agent/step-end
 *       cont = waterfall agent/turn-continuation(default = hadToolCalls || steered)
 *       if !cont && steering arrived from step-end/continuation listeners: cont = true
 *       if !cont: break
 *     session('turn/end'); emit agent/turn-end
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
  let turnEnded = false
  let stepOpen = false
  let errorReported = false

  // Close the open step exactly once (idempotent via stepOpen). The
  // agent/step-end emit is contained: a throwing step-end listener must not
  // abort finalization and strand the turn open (turn/end balance > notifying
  // one bad listener). Appended before the emit (the event-sourcing RFC append-before-emit).
  const closeStep = (): boolean => {
    if (!stepOpen) return false
    stepOpen = false
    // Session.append pushes step/end BEFORE notifying session/event listeners,
    // so a throwing listener leaves step/end in the log (balance holds) but
    // would otherwise abort finalization. Contain it and surface it as a turn
    // error below — the same outcome as a throwing agent/step-end listener.
    let failure: unknown
    try {
      session.append('step/end', { turn, step })
    } catch (error: unknown) {
      failure = error
    }
    try {
      ctx.emit('agent/step-end', agent, turn, step)
    } catch (error: unknown) {
      failure ??= error
    }
    // A throwing step/end session-event listener OR a throwing agent/step-end
    // listener surfaces as a turn error via failTurn (idempotent). This prevents
    // a throwing listener from producing a silent "completed" turn when the step
    // itself succeeded, AND keeps finalization going when closeStep runs from
    // the outer catch.
    if (failure !== undefined) {
      failTurn(toError(failure))
      return true
    }
    return false
  }

  // Record a step/turn failure exactly once: append the single `error` event
  // (only while the turn is still open — see below), set the error reason, and
  // emit agent/error (contained — trap: a throwing agent/error listener must not
  // re-escape and strand the turn). Disposal and abort set `reason` directly
  // without calling this (no `error` event for those — they are not failures).
  const failTurn = (err: CodedError): void => {
    if (errorReported) return
    errorReported = true
    // Only append the session `error` INSIDE the turn (before turn/end). If the
    // turn has already ended — the only way here is a throwing agent/turn-end
    // listener after closeTurn(true) already appended turn/end — appending now
    // would land the error AFTER the last turn/end, where the persistence
    // backend treats it as a crash tail and drops it on resume (the turn-enclosure RFC). In
    // that case report via agent/error + the logger only; the turn is balanced.
    if (!turnEnded) {
      // Set `reason` BEFORE the append: Session.append pushes the error event
      // before notifying session/event listeners, so a throwing listener would
      // otherwise leave `reason` unset (and closeTurn would record the wrong
      // reason / the outer catch would skip closeTurn). The append is contained
      // — the error event is already in the log either way; a throwing listener
      // must not abort finalization.
      reason = { kind: 'error', ...errorData(err) }
      try {
        session.append('error', { turn, step, ...errorData(err) })
      } catch (appendError: unknown) {
        ctx.logger.warn(`agent "${agent.id}": session/event listener threw on the error event at turn ${turn}: ${toError(appendError).message}`)
      }
    } else {
      ctx.logger.warn(`agent "${agent.id}": agent/turn-end listener threw after turn ${turn} closed: ${err.message}`)
    }
    try {
      ctx.emit('agent/error', agent, turn, step, err)
    } catch {
      // contained: the error is already logged; a throwing agent/error
      // listener must not prevent the turn from closing.
    }
  }

  // Close the turn exactly once (idempotent via turnEnded). `emit` is false on
  // the error path (the failure was already surfaced via agent/error) and true
  // on the normal/inline-error path. A throwing agent/turn-end listener on the
  // normal path escapes to the outer catch, which surfaces it via failTurn —
  // turn/end is already appended, so balance holds either way.
  const closeTurn = (emit: boolean): void => {
    if (turnEnded) return
    turnEnded = true
    // Session.append pushes turn/end BEFORE notifying session/event listeners,
    // so a throwing listener leaves turn/end in the log (the turn is balanced)
    // but would otherwise escape — from the outer catch's closeTurn(false) it
    // would propagate to the runLoop backstop, and from the normal-path
    // closeTurn(true) it would skip the agent/turn-end emit. Contain it: the
    // boundary is durable either way, and finalization must not abort on a bad
    // listener. (On the normal path the outer catch also re-runs closeTurn,
    // which is an idempotent no-op once turnEnded is set.)
    try {
      session.append('turn/end', { turn, reason })
    } catch (error: unknown) {
      ctx.logger.warn(`agent "${agent.id}": session/event listener threw on turn/end at turn ${turn}: ${toError(error).message}`)
    }
    if (emit) ctx.emit('agent/turn-end', agent, turn, reason)
  }

  try {
    // --- Turn boundary. Once turn/start is appended, a turn/end is owed no
    // matter what throws below; the catch + closeTurn guarantee it (the catch
    // decides "owed" from the log via isTurnOpen, so even a throwing turn/start
    // listener — append pushes before notifying — still gets its turn/end).
    session.append('turn/start', { turn, trigger })
    // Record the queued user messages INSIDE the turn (after turn/start), so
    // every event in the log is turn-enclosed. turn/end is now owed, so a throw
    // while appending these is caught below and the turn is still closed.
    for (const message of queued) {
      session.append('user/message', { content: message.content, source: message.source })
    }
    ctx.emit('agent/turn-start', agent, turn)

    while (true) {
      step += 1

      // Steering from the previous round's step-end/continuation listeners
      // (or turn-start listeners on the first step) joins before the request.
      drainSteering(ctx, agent, turn)

      session.append('step/start', { turn, step })
      stepOpen = true
      ctx.emit('agent/step-start', agent, turn, step)

      const abort = new AbortController()
      handle.setAbort(abort)

      // Cancel landing in the step-start window: a synchronous `agent/turn-start`
      // or `agent/step-start` listener (both fire before this point) can have
      // called `cancel()`, and `runStep` would otherwise run a full extra step
      // with no AbortController having observed it. Check the marker AFTER
      // setAbort (so the next-iteration drain sees a clean controller) and before
      // `runStep`: drop the step, end the turn `aborted`. closeStep balances the
      // already-appended step/start.
      if (handle.isCancelled()) {
        handle.setAbort(undefined)
        reason = { kind: 'aborted', reason: handle.cancelReason() }
        closeStep()
        break
      }

      let stepOutcome: { hadToolCalls: boolean; finish: FinishReason } | { error: Error }
      try {
        stepOutcome = await runStep(ctx, agent, turn, step, abort.signal)
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
      const steered = drainSteering(ctx, agent, turn)

      if (closeStep()) break

      const defaultDecision = stepOutcome.hadToolCalls || steered
      let shouldContinue: boolean
      try {
        shouldContinue = await ctx.waterfall(
          'agent/turn-continuation', agent, turn, defaultDecision,
          () => Promise.resolve(defaultDecision),
        )
      } catch (error: unknown) {
        // A broken continuation plugin ends the turn, not the loop.
        failTurn(toError(error))
        break
      }

      // Steering from step-end/continuation listeners (the /goal pattern)
      // demands the model see it — it overrides a negative decision; the
      // next iteration's drain records it.
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

    // Normal / inline-error loop exit: close the turn and notify.
    closeTurn(true)
  } catch (error: unknown) {
    // Decide whether this turn was ever opened from the LOG, not a flag.
    // Session.append pushes the event BEFORE notifying session/event listeners,
    // so a throwing listener on the `turn/start` append leaves turn/start in the
    // log even though execution never reached the lines after that append.
    // Gating on a "turn started" boolean would skip turn/end and leave a
    // permanently OPEN turn that poisons the next turn/replay (the turn-enclosure RFC). We
    // check the log for THIS turn's turn/start: present means a turn/end is owed
    // (or was already appended — closeTurn/failTurn are idempotent, so running
    // them again is a safe no-op that still preserves the disposed/error reason
    // chosen below). Absent means the turn/start append threw BEFORE its push (a
    // non-serializable trigger — impossible for our fixed trigger); nothing was
    // opened, so rethrow to the runLoop backstop.
    const turnStartLogged = session.events.some(e => e.type === 'turn/start' && e.data.turn === turn)
    if (!turnStartLogged) throw error
    closeStep()
    // Choose the close reason. Disposal wins only if no error was already
    // reported: a turn disposed mid-step sets reason=disposed in the step-error
    // branch (without reporting an error), and if closeTurn(true)'s turn-end
    // emit then throws, we land here and must PRESERVE disposed rather than
    // overwrite it with the listener's throw. Otherwise a boundary-emit throw
    // on a live agent is a real failure → failTurn. (errorReported is mutated
    // only inside the failTurn closure, which the analyzer can't follow, hence
    // the inline lint-disable.)
    if (handle.isDisposed() && !errorReported) { // eslint-disable-line @typescript-eslint/no-unnecessary-condition
      reason = { kind: 'disposed' }
    } else {
      failTurn(toError(error))
    }
    closeTurn(false)
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
function drainSteering(ctx: Context, agent: ReactLoopAgent, turn: number): boolean {
  const messages = agent.inbox.drainSteering()
  for (const message of messages) {
    agent.session.append('steering/message', { turn, content: message.content, source: message.source })
    ctx.emit('agent/steering', agent, turn, message.content, message.source)
  }
  return messages.length > 0
}

/** One step: assemble request → stream model → record → execute tools. */
async function runStep(
  ctx: Context,
  agent: ReactLoopAgent,
  turn: number,
  step: number,
  signal: AbortSignal,
): Promise<{ hadToolCalls: boolean; finish: FinishReason }> {
  const { session, options } = agent

  // --- Request assembly ---
  const assembly = await ctx.systemPrompt.assemble()
  const system = [renderPrompt(assembly), options.systemPrompt ?? '']
    .filter(text => text.length > 0)
    .join('\n\n')

  let request: GenerateOptions = {
    model: options.model ?? '',
    messages: session.deriveMessages(),
    ...system ? { system } : {},
    ...assembly.tools.length > 0 ? { tools: assembly.tools } : {},
    signal,
  }
  request = await ctx.waterfall('agent/request', agent, turn, step, request, () => Promise.resolve(request))
  if (!request.model) {
    throw new Error(`agent "${agent.id}" has no model: set AgentOptions.model or supply one via the agent/request waterfall`)
  }

  // --- Model call (streaming-first; raw chunks are the replay record) ---
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(request)) {
    /* v8 ignore next -- signal.reason always set: cancel()/disposal provide a default */
    if (signal.aborted) throw new Error(String(signal.reason ?? 'aborted'))
    session.append('assistant/chunk', { turn, step, chunk })
    ctx.emit('agent/stream-chunk', agent, turn, step, chunk)
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
    if (message.content.length > 0) {
      session.append('assistant/message', { turn, step, content: message.content })
    }
    if (assembler.usage) {
      session.append('usage', { turn, step, usage: assembler.usage })
    }
    return { hadToolCalls: false, finish: assembler.finish }
  }

  // The step-result waterfall runs BEFORE the session append so the log (the
  // source of truth for derived history and replay) records the message that
  // tool dispatch actually uses.
  let message: Message = assembler.message()
  message = await ctx.waterfall('agent/step-result', agent, turn, step, message, () => Promise.resolve(message))

  session.append('assistant/message', { turn, step, content: message.content })
  if (assembler.usage) {
    session.append('usage', { turn, step, usage: assembler.usage })
  }

  // --- Tool execution (sequential; parallel execution is a TODO) ---
  // ToolRegistry.execute converts tool failures (including aborts) into
  // isError results, so abort is re-checked around every call here.
  const toolCalls = message.content.filter(block => block.type === 'tool-call')
  for (const call of toolCalls) {
    /* v8 ignore next -- signal.reason always set: cancel()/disposal provide a default */
    if (signal.aborted) throw new Error(String(signal.reason ?? 'aborted'))
    session.append('tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments })
    let parsedArguments: unknown
    try {
      parsedArguments = call.arguments ? JSON.parse(call.arguments) : {}
    } catch {
      parsedArguments = call.arguments
    }
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
      // result.callId — a tools/execute waterfall listener returning a
      // mismatched id would otherwise orphan the call↔result pairing in the
      // next model request. A listener-internal id, if ever needed, belongs in
      // a separate diagnostic field, never overloaded onto callId.
      callId: call.id,
      content: result.content,
      isError: result.isError,
      ...result.error ? { error: result.error } : {},
    })
    // signal CAN flip during the await above (abort() inside a tool);
    // the analyzer can't see through the await boundary.
    /* v8 ignore start -- signal.reason default unreachable: cancel()/disposal always set it */
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (signal.aborted) throw new Error(String(signal.reason ?? 'aborted'))
    /* v8 ignore stop */
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
