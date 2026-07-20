/**
 * Drives one agent across queued durable turns. Turn failures are contained so
 * later work can run; the session log, not this driver, owns conversation state.
 * See .agents/notes/implemented/architecture/2026-06-18-agent-lifecycle-and-ownership-seams.md.
 * @module dsh-agent-loop/loop
 */

import type { Context } from 'cordis'
import type { ContentBlock, FinishReason, GenerateOptions, LlmCallConfig, Message } from '@deepseek-ai/dsh-llm'
import { isDeepStrictEqual } from 'node:util'
import { BlockAssembler, HarnessError, assertNever, deepFreeze, isLlmAdapterFailure } from '@deepseek-ai/dsh-llm'
import { agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { AgentEventDispatch, ContinuationDecision, HookContext, PromptDecision, RequestError, RequestErrorDecision } from '@deepseek-ai/dsh-agent'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import type { Session, TurnEndReason, TurnTrigger } from '@deepseek-ai/dsh-session'
import { createTransmissionLog, recordRequestHeader } from './request-log.ts'
import type { TransmissionLog } from './request-log.ts'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { executeToolCalls } from './tool-calls.ts'
import type { Inbox } from './inbox.ts'

/** Normalize thrown values while preserving an existing error code. */
function toError(error: unknown): RequestError {
  return error instanceof Error ? error : new HarnessError(String(error), 'UNKNOWN', { cause: error })
}

/** Distinguishes final model-request failures from failures in later step processing. */
class TerminalModelRequestFailure extends Error {
  constructor(readonly requestError: RequestError) {
    super(requestError.message, { cause: requestError })
    this.name = 'TerminalModelRequestFailure'
  }
}

/** Convert terminal failure finishes into step errors; unknown extensible finishes remain successful. */
function finishError(finish: FinishReason): RequestError | undefined {
  switch (finish.kind) {
    case 'error': {
      const error: RequestError = new Error(finish.message)
      if (finish.code !== undefined) error.code = finish.code
      return error
    }
    case 'aborted': {
      const error: RequestError = new Error('model stream aborted')
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
function errorData(err: RequestError): { message: string; code?: string } {
  return { message: err.message, ...typeof err.code === 'string' ? { code: err.code } : {} }
}

/** Map a successful max-token finish onto the turn reason; other successful finishes add nothing. */
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

/** Mutable agent controls supplied to the loop driver. */
export interface LoopHandle {
  /** Native-private agent inbox handed to the driver only at internal startup. */
  readonly inbox: Inbox
  /** Maximum parallel-safe calls allowed in one step. */
  readonly maxParallelToolCalls: number
  setStatus(status: 'idle' | 'running'): void
  setAbort(controller: AbortController | undefined): void
  /** Resolves when the agent is disposed — unblocks the idle wait. */
  disposed: Promise<void>
  isDisposed(): boolean
  /** Whether cancellation is pending for the current loop iteration. */
  isCancelled(): boolean
  /** Resolved pending-cancellation reason; meaningful only while {@link isCancelled} is true. */
  cancelReason(): string
  /** Clear the cancel marker (called once per iteration after the turn returns). */
  clearCancel(): void
  /** Settle idle waiters when pre-running cancellation skips a turn, without emitting `agent/status`. */
  settleIdle(): void
  /** Run an active tool-call batch, accepting post-tool context into the FIFO drained before settlement. */
  readonly withToolBatch: <T>(run: (acceptContext: (context: HookContext) => void) => Promise<T>) => Promise<T>
}

/**
 * Drive queued batches as durable turns until disposal. Plugin failures end the
 * current turn without terminating the driver. The caller establishes the
 * `ctx.agents.withInitiator()` boundary before entry; package-private
 * orchestration recovers that exact Agent and captures its Session locally.
 * @param ctx - the plugin context the loop reaches its initiating Agent,
 * events (agent/…, session/flush), and services (systemPrompt, llm, tools)
 * through.
 * @param handle - the bridge to the agent's mutable state: status/abort setters plus the disposal and cancel-marker reads.
 * @throws when no initiating Agent is active.
 */
export async function runLoop(ctx: Context, handle: LoopHandle): Promise<void> {
  const agent = ctx.agents.requireInitiator()
  // Per-instance prefix and request-header state; conversation history remains in the session log.
  const transmission = createTransmissionLog()

  const { session } = agent
  // Fused subject and scope carrier for every agent event below.
  const events = agentEvents(ctx, agent)

  while (!handle.isDisposed()) {
    await handle.inbox.waitForQueued(handle.disposed)
    if (handle.isDisposed()) break

    // Cancellation between wake and `running` skips only the cancelled work;
    // a replacement prompt still runs and owns the eventual idle transition.
    if (handle.isCancelled()) {
      handle.clearCancel()
      if (!handle.inbox.hasQueued) {
        handle.settleIdle()
        continue
      }
    }

    handle.setStatus('running')

    // A synchronous `running` listener can cancel before `runTurn`; balance the
    // status only when no replacement prompt was queued by that listener.
    if (handle.isCancelled()) {
      handle.clearCancel()
      if (!handle.inbox.hasQueued) {
        handle.setStatus('idle')
        continue
      }
    }

    // Idle injection can add a turn, so derive the next number from the log.
    const turn = lastTurnNumber(session) + 1
    let terminalStopped = false
    try {
      terminalStopped = await runTurn(ctx, events, handle, turn, transmission)
    } catch (error: unknown) {
      // Pre-turn failure has no durable boundary to close; report it without appending outside a turn.
      const err = toError(error)
      ctx.logger.warn(`agent "${agent.id}": turn ${turn} failed before it started: ${err.message}`)
      try {
        events.emit('agent/error', turn, 0, err)
      } catch { /* contained: a throwing agent/error listener must not kill the driver */ }
    }

    // Reset per iteration, including when a prompt arrives during the flush window.
    handle.clearCancel()

    // Late steering becomes queued input unless terminal policy stopped the turn.
    for (const message of handle.inbox.drainSteering()) {
      if (!terminalStopped) handle.inbox.enqueue(message)
    }

    if (!handle.inbox.hasQueued) handle.setStatus('idle')
  }
}

async function runTurn(
  ctx: Context, events: AgentEventDispatch, handle: LoopHandle, turn: number, transmission: TransmissionLog,
): Promise<boolean> {
  const agent = ctx.agents.requireInitiator()
  const { session } = agent
  const drainSteering = (): boolean => {
    const messages = handle.inbox.drainSteering()
    for (const message of messages) {
      session.append('steering/message', { turn, content: message.content, source: message.source }, { surfaceOp: 'append' })
    }
    return messages.length > 0
  }

  // Drain before opening the turn, but append only after `turn/start`.
  const queued = handle.inbox.drainQueued()
  const first = queued[0]
  /* v8 ignore next 3 -- invariant guard: runLoop only calls runTurn when hasQueued */
  if (!first) throw new Error('runTurn invariant violated: no queued message at turn start')
  const trigger: TurnTrigger = { kind: 'message', source: first.source }

  let reason: TurnEndReason = { kind: 'completed' }
  let step = 0
  let requestRetryAttempt = 0
  let stepOpen = false
  let errorReported = false
  let terminalStopped = false

  // Close the committed step once; pre-commit validation failure still escapes.
  const closeStep = (): void => {
    if (!stepOpen) return
    session.append('step/end', { turn, step })
    stepOpen = false
  }

  // Record the durable turn failure once and contain the live error notification.
  const failTurn = (err: RequestError): void => {
    if (errorReported) return
    errorReported = true
    reason = { kind: 'error', step, ...errorData(err) }
    try {
      events.emit('agent/error', turn, step, err)
    } catch {
      // contained: the error is already captured on `reason`; a throwing
      // agent/error listener must not prevent the turn from closing.
    }
  }

  // Pre-commit validation failure escapes rather than masquerading as a committed boundary.
  const closeTurn = (): void => {
    session.append('turn/end', { turn, reason })
  }

  try {
    // --- Turn boundary. Once turn/start is appended, a turn/end is owed no
    // matter what throws below; the catch + closeTurn guarantee it. A pre-commit
    // veto leaves no turn/start in the log and therefore owes no turn/end.
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
      const decision = await events.waterfall(
        'agent/prompt-submit', message.content, message.source,
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
      // Every `allow.additionalContexts` entry is a separate context/message the
      // next request also sees. The turn is open, so inject() appends each one
      // into THIS turn without flattening provenance or metadata.
      for (const context of decision.additionalContexts ?? []) {
        agent.inject(context.content, {
          source: context.source,
          ...context.meta !== undefined ? { meta: context.meta } : {},
        })
      }
    }

    while (true) {
      // A fully blocked batch closes its zero-step turn as rejected.
      if (!anyAllowed) {
        reason = { kind: 'rejected', reason: lastBlockReason }
        break
      }
      step += 1

      // Steering from the previous round's continuation listeners joins before
      // the request.
      drainSteering()

      // The step's AbortController exists BEFORE any async pre-step work so a
      // dispose() or cancel() — in a synchronous turn-start listener or an
      // async listener whose effect fires before we block — always has an armed
      // abort to cancel against. isDisposed below covers disposal, which does
      // NOT set the cancel marker. Cleared on every exit path below.
      const abort = new AbortController()
      handle.setAbort(abort)

      // Assemble once before pre-step so listener work and the request share one prompt value.
      const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
      const fullSystemPrompt = renderPrompt(assembly)

      // Cancellation or disposal during assembly ends the turn before any step opens.
      if (handle.isCancelled() || handle.isDisposed()) {
        handle.setAbort(undefined)
        reason = handle.isDisposed() ? { kind: 'disposed' } : { kind: 'aborted', reason: handle.cancelReason() }
        break
      }

      // Compose the request-only prefix once per loop instance before the first
      // request boundary. It precedes all derived history and is recorded only
      // in the request header, not as session history.
      if (transmission.sessionPrefix === undefined) {
        const emptyPrefix: Message[] = deepFreeze([])
        const composed = await events.waterfall(
          'agent/session-prefix', emptyPrefix, abort.signal,
          () => Promise.resolve(emptyPrefix),
        )

        // Never cache an interrupted composition; the next turn recomposes it.
        if (handle.isCancelled() || handle.isDisposed()) {
          handle.setAbort(undefined)
          reason = handle.isDisposed() ? { kind: 'disposed' } : { kind: 'aborted', reason: handle.cancelReason() }
          break
        }
        transmission.sessionPrefix = deepFreeze(structuredClone(composed))
      }

      // Await surface mutations outside the step before snapshotting history.
      await events.serial('agent/pre-step', turn, step, abort.signal)

      // Interruption landing during the pre-step seam: do not open an empty step.
      if (handle.isCancelled() || handle.isDisposed()) {
        handle.setAbort(undefined)
        reason = handle.isDisposed() ? { kind: 'disposed' } : { kind: 'aborted', reason: handle.cancelReason() }
        break
      }

      // Snapshot the exact log prefix before step/start: the reconstruction
      // boundary. Appends after this synchronous snapshot join the next request.
      const boundaryMessages = session.deriveMessages()

      session.append('step/start', { turn, step })
      // Only a committed step/start creates a balancing obligation. A
      // pre-commit veto throws before this assignment; post-commit observers
      // are contained inside Session.append().
      stepOpen = true

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

      let stepOutcome:
        | { hadToolCalls: boolean; finish: FinishReason }
        | { requestError: RequestError }
        | { error: RequestError }
      try {
        stepOutcome = await runStep(
          ctx, events, handle, turn, step, assembly, fullSystemPrompt, boundaryMessages, transmission, abort.signal)
      } catch (error: unknown) {
        if (error instanceof TerminalModelRequestFailure) {
          stepOutcome = { requestError: error.requestError }
        } else {
          stepOutcome = { error: toError(error) }
        }
      }

      if ('requestError' in stepOutcome) {
        // Recovery observes a balanced failed step and the original provider
        // error while the failed step's signal remains the active owner.
        closeStep()
        if (handle.isDisposed() || abort.signal.aborted) {
          handle.setAbort(undefined)
          reason = handle.isDisposed()
            ? { kind: 'disposed' }
            : { kind: 'aborted', reason: String(abort.signal.reason) }
          break
        }

        const defaultDecision: RequestErrorDecision = { action: 'fail' }
        let recoveryDecision: RequestErrorDecision = defaultDecision
        try {
          recoveryDecision = await events.waterfall(
            'agent/request-error', turn, step, stepOutcome.requestError,
            requestRetryAttempt, abort.signal,
            () => Promise.resolve(defaultDecision),
          )
        } catch (recoveryError: unknown) {
          ctx.logger.warn(
            `agent "${agent.id}": request recovery failed at turn ${turn}, step ${step}: ${toError(recoveryError).message}`,
          )
        }
        handle.setAbort(undefined)

        // Cancellation and disposal always win over either a recovery decision
        // or a recovery-listener failure.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (handle.isDisposed() || abort.signal.aborted) {
          reason = handle.isDisposed()
            ? { kind: 'disposed' }
            : { kind: 'aborted', reason: String(abort.signal.reason) }
          break
        }
        switch (recoveryDecision.action) {
          case 'retry':
            requestRetryAttempt += 1
            continue
          case 'fail':
            failTurn(stepOutcome.requestError)
            break
          /* v8 ignore next -- closed-union exhaustiveness guard */
          default:
            assertNever(recoveryDecision, 'agent request-error decision')
        }
        break
      }

      if ('error' in stepOutcome) {
        // Steering that arrived during the failed step stays in the inbox —
        // runLoop re-enqueues it as a queued message, so an abort-then-steer
        // starts a fresh turn instead of being silently consumed.
        closeStep()
        handle.setAbort(undefined)
        const { error } = stepOutcome
        /* v8 ignore next -- narrow race: disposal while non-request step work throws. */
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

      requestRetryAttempt = 0

      // Preserve max-token completion unless a later disposal, abort, or error wins.
      const stepReason = stepFinishReason(stepOutcome.finish)
      if (stepReason) reason = stepReason

      // Steering that arrived during streaming/tool execution.
      const steered = drainSteering()

      try {
        await events.serial('agent/post-step', turn, step, abort.signal)
      } catch (error: unknown) {
        stepOutcome = { error: toError(error) }
      }

      if ('error' in stepOutcome) {
        closeStep()
        handle.setAbort(undefined)
        /* v8 ignore next -- narrow race: disposal while a post-step listener throws. */
        if (handle.isDisposed()) {
          reason = { kind: 'disposed' }
        } else if (abort.signal.aborted) {
          /* v8 ignore next -- signal.reason always set by cancellation or disposal. */
          reason = { kind: 'aborted', reason: String(abort.signal.reason ?? 'aborted') }
        } else {
          failTurn(stepOutcome.error)
        }
        break
      }

      if (handle.isDisposed() || abort.signal.aborted) {
        reason = handle.isDisposed()
          ? { kind: 'disposed' }
          : { kind: 'aborted', reason: String(abort.signal.reason) }
        closeStep()
        handle.setAbort(undefined)
        break
      }

      closeStep()
      handle.setAbort(undefined)

      const defaultDecision: ContinuationDecision = { action: stepOutcome.hadToolCalls || steered ? 'continue' : 'stop' }
      let decision: ContinuationDecision
      try {
        decision = await events.waterfall(
          'agent/turn-continuation', turn, defaultDecision,
          () => Promise.resolve(defaultDecision),
        )
      } catch (error: unknown) {
        // A broken continuation plugin ends the turn, not the loop.
        failTurn(toError(error))
        break
      }

      // A continuation reason becomes next-step steering.
      if (decision.action === 'continue' && decision.reason) {
        handle.inbox.steer({ content: decision.reason.content, source: decision.reason.source })
      }
      let shouldContinue = decision.action === 'continue'

      // Pending steering overrides an ordinary stop.
      if (!shouldContinue && handle.inbox.hasSteering) shouldContinue = true

      // Terminal policy is monotonic and runs after ordinary continuation folding.
      let terminalStop = false
      try {
        const stop = await events.serial('agent/turn-stop', turn)
        terminalStop = stop !== undefined
      } catch (error: unknown) {
        // A broken terminal policy is an ordinary continuation failure: fail
        // this turn closed while leaving the driver alive for later turns.
        failTurn(toError(error))
        break
      }
      if (terminalStop) {
        terminalStopped = true
        // Terminal stop discards steering but preserves ordinary queued prompts.
        handle.inbox.drainSteering()
        shouldContinue = false
      }

      // The marker catches cancellation after the step controller was cleared.
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
    // Close only a turn whose start committed to the log.
    const turnStartLogged = session.events.some(e => e.type === 'turn/start' && e.data.turn === turn)
    if (!turnStartLogged) throw error
    closeStep()
    // Preserve an established disposal reason; otherwise report the failure.
    if (handle.isDisposed() && !errorReported) { // eslint-disable-line @typescript-eslint/no-unnecessary-condition
      reason = { kind: 'disposed' }
    } else {
      failTurn(toError(error))
    }
    closeTurn()
  }

  // Flush through the store-owned durability checkpoint without killing the driver on failure.
  try {
    await ctx.sessions.flush(session)
  } catch (error: unknown) {
    // The turn is closed, so report the failed flush live rather than append outside a turn.
    const err = toError(error)
    ctx.logger.warn(`agent "${agent.id}": session/flush failed at turn ${turn}: ${err.message}`)
    try {
      events.emit('agent/error', turn, step, err)
    } catch {
      // contained: a throwing agent/error listener must not escape the loop.
    }
  }
  return terminalStopped
}

/**
 * Run one committed step: transform call config, log the request header, build
 * the request from the cached prefix plus the step-boundary snapshot, stream and
 * record the response, then execute tools. The caller has already assembled the
 * prompt, run `agent/pre-step`, snapshotted history, and opened the step.
 */
async function runStep(
  ctx: Context,
  events: AgentEventDispatch,
  handle: LoopHandle,
  turn: number,
  step: number,
  assembly: PromptAssembly,
  system: string,
  boundaryMessages: Message[],
  transmission: TransmissionLog,
  signal: AbortSignal,
): Promise<{ hadToolCalls: boolean; finish: FinishReason }> {
  const agent = ctx.agents.requireInitiator()
  const { session, options } = agent

  // Seed the first request from agent options and later requests from the logged header;
  // detach and freeze so listeners must return an attributable replacement.
  const seedConfig: LlmCallConfig = deepFreeze(structuredClone(transmission.loggedHeader
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- loggedHeader ⟹ a snapshot is in the log
    ? session.requestHeader()!.config
    : { provider: options.provider ?? '', model: options.model ?? '' }))

  // Listener replacements are recorded in the request header before dispatch.
  const config = await events.waterfall('agent/request', turn, step, seedConfig, () => Promise.resolve(seedConfig))
  if (!config.provider || !config.model) {
    throw new Error(`agent "${agent.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`)
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- runTurn composes the prefix before every runStep call
  const sessionPrefix = transmission.sessionPrefix!

  // Record the canonical header, including the otherwise-unlogged prefix, before dispatch.
  const header = canonicalHeader({
    config,
    ...system ? { system } : {},
    ...assembly.tools.length > 0 ? { tools: assembly.tools } : {},
    ...sessionPrefix.length > 0 ? { messagePrefix: sessionPrefix } : {},
  })
  recordRequestHeader(session, transmission, header)

  // Freeze the logged header plus boundary snapshot; the prefix precedes derived history.
  const request: GenerateOptions = deepFreeze({
    provider: header.config.provider,
    model: header.config.model,
    messages: [...header.messagePrefix ?? [], ...boundaryMessages],
    ...header.system !== undefined ? { system: header.system } : {},
    ...header.tools !== undefined ? { tools: header.tools } : {},
    ...header.config.temperature !== undefined ? { temperature: header.config.temperature } : {},
    ...header.config.maxTokens !== undefined ? { maxTokens: header.config.maxTokens } : {},
    ...header.config.stop !== undefined ? { stop: header.config.stop } : {},
    sessionId: session.id,
    signal,
  })

  // --- Model call (streaming-first; raw chunks are the replay record) ---
  const assembler = new BlockAssembler()
  const chunkSeqs: number[] = []
  const stream = ctx.llm.stream(request)
  try {
    for await (const chunk of stream) {
      /* v8 ignore next -- signal.reason always set: cancel()/disposal provide a default */
      if (signal.aborted) throw new Error(String(signal.reason ?? 'aborted'))
      const chunkEvent = session.append('assistant/chunk', { turn, step, chunk })
      chunkSeqs.push(chunkEvent.seq)
      assembler.push(chunk)
    }
  } catch (error: unknown) {
    if (isLlmAdapterFailure(stream, error)) throw new TerminalModelRequestFailure(error)
    throw error
  }

  // Normalize failure finish chunks into the same path as thrown stream errors.
  const stepError = finishError(assembler.finish)
  if (stepError) throw new TerminalModelRequestFailure(stepError)

  const recordAssistantMessage = (
    assembledContent: ContentBlock[],
    message: Message,
    preserveReplayState = true,
  ): void => {
    session.append(
      'assistant/message',
      {
        turn,
        step,
        content: message.content,
        provenance: assistantProvenance(
          header.config,
          assembler.replayState,
          preserveReplayState && isDeepStrictEqual(message.content, assembledContent),
        ),
        ...assembler.usage === undefined ? {} : { usage: assembler.usage },
      },
      { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
    )
  }

  // A rejected result still records the successful provider call without retaining rejected output.
  const processStepResult = async (assembledContent: ContentBlock[], message: Message): Promise<Message> => {
    try {
      return await events.waterfall(
        'agent/step-result', turn, step, message, () => Promise.resolve(message),
      )
    } catch (error: unknown) {
      recordAssistantMessage(assembledContent, { ...message, content: [] }, false)
      throw error
    }
  }

  if (assembler.finish.kind === 'max-tokens') {
    const assembled = assembler.message()
    const assembledContent = structuredClone(assembled.content)
    let message: Message = withoutToolCalls(assembled)
    message = withoutToolCalls(await processStepResult(assembledContent, message))
    // Preserve usage even when max-token truncation produced no content.
    recordAssistantMessage(assembledContent, message)
    return { hadToolCalls: false, finish: assembler.finish }
  }

  // Record the post-waterfall message that tool dispatch uses.
  const assembled = assembler.message()
  const assembledContent = structuredClone(assembled.content)
  let message: Message = assembled
  message = await processStepResult(assembledContent, message)

  // Every successful call records its completion anchor, including explicit
  // empty chunk provenance for a contentless, usage-less provider response.
  recordAssistantMessage(assembledContent, message)

  // Dispatch may overlap; policy, durable results, and result context stay model-ordered.
  const toolCalls = message.content.filter(block => block.type === 'tool-call')
  if (toolCalls.length === 0) return { hadToolCalls: false, finish: assembler.finish }
  return handle.withToolBatch(async (acceptContext) => {
    await executeToolCalls(
      ctx, turn, step, toolCalls, signal, handle.maxParallelToolCalls, acceptContext,
    )
    return { hadToolCalls: true, finish: assembler.finish }
  })
}

/** Build durable assistant provenance, dropping replay state after any content rewrite. */
function assistantProvenance(config: LlmCallConfig, replayState: unknown, contentUnchanged: boolean): NonNullable<Message['provenance']> {
  return {
    provider: config.provider,
    model: config.model,
    ...contentUnchanged && replayState !== undefined ? { replayState } : {},
  }
}

function withoutToolCalls(message: Message): Message {
  return { ...message, content: message.content.filter(block => block.type !== 'tool-call') }
}

/**
 * The last turn number in a (possibly seeded) session log, or 0.
 * @param session - the session whose log is scanned for the latest `turn/start`.
 * @returns the latest `turn/start`'s turn number, or 0 when the log has none (the next turn is this plus one).
 */
export function lastTurnNumber(session: Session): number {
  const lastStart = session.events.findLast(event => event.type === 'turn/start')
  return lastStart?.data.turn ?? 0
}

/**
 * Whether the session log has an unmatched `turn/start`. Agent status is not
 * sufficient during pre-start and post-end windows.
 * @param session - the session whose log is inspected.
 * @returns true when the log's last turn boundary is a `turn/start` with no matching `turn/end` yet.
 */
export function isTurnOpen(session: Session): boolean {
  const last = session.events.findLast(e => e.type === 'turn/start' || e.type === 'turn/end')
  return last?.type === 'turn/start'
}
