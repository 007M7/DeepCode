/**
 * Drives one agent across queued durable turns. Turn failures are contained so
 * later work can run; the session log, not this driver, owns conversation state.
 * See docs/rfc/implemented/architecture/2026-06-18-agent-lifecycle-and-ownership-seams.md.
 * @module dsh-agent-loop/loop
 */

import type { Context } from 'cordis'
import { isDeepStrictEqual } from 'node:util'
import type { ContentBlock, FinishReason, GenerateOptions, LlmCallConfig, Message } from '@deepseek-ai/dsh-llm'
import { assertNever, BlockAssembler, HarnessError, deepFreeze } from '@deepseek-ai/dsh-llm'
import { agentEvents, agentInterruptReasonOf, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { AgentEventDispatch, ContinuationDecision, HookContext, PromptDecision } from '@deepseek-ai/dsh-agent'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import type { Session, TurnEndReason, TurnTrigger } from '@deepseek-ai/dsh-session'
import { createTransmissionLog, recordRequestHeader } from './request-log.ts'
import type { TransmissionLog } from './request-log.ts'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { ReactLoopAgent } from './agent.ts'
import type { Inbox } from './inbox.ts'
import type { TurnCancellation } from './cancellation.ts'

/** An Error with an optional machine-readable code (e.g., from LlmError or a throwing plugin). */
type CodedError = Error & { code?: string }

/** Normalize thrown values while preserving an existing error code. */
function toError(error: unknown): CodedError {
  return error instanceof Error ? error : new HarnessError(String(error), 'UNKNOWN', { cause: error })
}

/** Convert terminal failure finishes into step errors; unknown extensible finishes remain successful. */
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

/** Internal control-flow sentinel; durable classification comes only from the turn signal. */
const TURN_INTERRUPTED = new Error('turn interrupted')

/** Stop at an explicit cooperative boundary without stringifying the runtime reason. */
function interruptionCheckpoint(signal: AbortSignal): void {
  if (signal.aborted) throw TURN_INTERRUPTED
}

/** Classify a supported turn interruption, with lifecycle disposal taking precedence. */
function interruptionTurnEndReason(handle: LoopHandle, signal: AbortSignal): TurnEndReason | undefined {
  if (handle.isDisposed()) return { kind: 'disposed' }
  const reason = agentInterruptReasonOf(signal)
  if (reason === undefined) return undefined
  switch (reason.kind) {
    case 'user':
    case 'parent':
      return { kind: 'aborted' }
    /* v8 ignore next 2 -- the private holder requests disposed only after lifecycle state flips, which returns above */
    case 'disposed':
      return { kind: 'disposed' }
    /* v8 ignore next 2 -- AgentInterruptReason is closed and the public helper filters unsupported reasons */
    default:
      return assertNever(reason, 'AgentInterruptReason')
  }
}

/** Mutable agent controls supplied to the loop driver. */
export interface LoopHandle {
  /** Native-private agent inbox handed to the driver only at internal startup. */
  readonly inbox: Inbox
  setStatus(status: 'idle' | 'running'): void
  /** Install a fresh active-turn owner before the running notification. */
  installTurnCancellation(): TurnCancellation
  /** Clear only the exact owner whose turn and durability flush settled. */
  clearTurnCancellation(cancellation: TurnCancellation): void
  /** Resolves when the agent is disposed — unblocks the idle wait. */
  disposed: Promise<void>
  isDisposed(): boolean
  /** Whether queued work was cancelled before an active turn owner existed. */
  isPreRunCancelled(): boolean
  /** Clear the cause-less pre-run marker without affecting replacement work. */
  clearPreRunCancel(): void
  /** Settle idle waiters when pre-running cancellation skips a turn, without emitting `agent/status`. */
  settleIdle(): void
}

/**
 * Drive queued batches as durable turns until disposal. Plugin failures end the
 * current turn without terminating the driver.
 * @param ctx - the plugin context the loop reaches events (agent/…, session/flush) and services (systemPrompt, llm, tools) through.
 * @param agent - the agent this invocation drives for its whole lifetime (its inbox, session, and options).
 * @param handle - the bridge to status, turn cancellation ownership, disposal, and pre-run cancellation state.
 */
export async function runLoop(ctx: Context, agent: ReactLoopAgent, handle: LoopHandle): Promise<void> {
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
    if (handle.isPreRunCancelled()) {
      handle.clearPreRunCancel()
      if (!handle.inbox.hasQueued) {
        handle.settleIdle()
        continue
      }
    }

    let cancellation = handle.installTurnCancellation()
    handle.setStatus('running')

    if (handle.isDisposed()) {
      handle.clearTurnCancellation(cancellation)
      break
    }

    // A synchronous running listener may cancel old work and enqueue a
    // replacement. The replacement receives a fresh, non-aborted turn owner.
    if (cancellation.signal.aborted) {
      handle.clearTurnCancellation(cancellation)
      if (!handle.inbox.hasQueued) {
        handle.setStatus('idle')
        continue
      }
      cancellation = handle.installTurnCancellation()
    }

    // Idle injection can add a turn, so derive the next number from the log.
    const turn = lastTurnNumber(session) + 1
    let terminalStopped = false
    try {
      terminalStopped = await runTurn(ctx, events, agent, handle, turn, transmission, cancellation.signal)
    } catch (error: unknown) {
      // Pre-turn failure has no durable boundary to close; report it without appending outside a turn.
      const err = toError(error)
      ctx.logger.warn(`agent "${agent.id}": turn ${turn} failed before it started: ${err.message}`)
      try {
        events.emit('agent/error', turn, 0, err)
      } catch { /* contained: a throwing agent/error listener must not kill the driver */ }
    } finally {
      handle.clearTurnCancellation(cancellation)
    }

    // Late steering becomes queued input unless terminal policy stopped the turn.
    for (const message of handle.inbox.drainSteering()) {
      if (!terminalStopped) handle.inbox.enqueue(message)
    }

    if (!handle.inbox.hasQueued) handle.setStatus('idle')
  }
}

async function runTurn(
  ctx: Context, events: AgentEventDispatch, agent: ReactLoopAgent, handle: LoopHandle, turn: number, transmission: TransmissionLog,
  signal: AbortSignal,
): Promise<boolean> {
  const { session } = agent

  // Drain before opening the turn, but append only after `turn/start`.
  const queued = handle.inbox.drainQueued()
  const first = queued[0]
  /* v8 ignore next 3 -- invariant guard: runLoop only calls runTurn when hasQueued */
  if (!first) throw new Error('runTurn invariant violated: no queued message at turn start')
  const trigger: TurnTrigger = { kind: 'message', source: first.source }

  let reason: TurnEndReason = { kind: 'completed' }
  let step = 0
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
  const failTurn = (err: CodedError): void => {
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
    interruptionCheckpoint(signal)
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
        'agent/prompt-submit', message.content, message.source, signal,
        () => Promise.resolve<PromptDecision>({ kind: 'allow' }),
      )
      interruptionCheckpoint(signal)
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
      // into THIS turn without flattening provenance, framing, or metadata.
      for (const context of decision.additionalContexts ?? []) {
        agent.inject(context.content, {
          source: context.source,
          ...context.envelope !== undefined ? { envelope: context.envelope } : {},
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
      drainSteering(agent, handle.inbox, turn)

      // Assemble once before pre-step so pressure checks and the request share the same prompt.
      const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
      interruptionCheckpoint(signal)
      const fullSystemPrompt = renderPrompt(assembly)

      // Compose the request-only prefix once per loop instance before pressure
      // checks. It precedes all derived history and is recorded only in the
      // request header, not as session history.
      if (transmission.sessionPrefix === undefined) {
        const emptyPrefix: Message[] = deepFreeze([])
        const composed = await events.waterfall(
          'agent/session-prefix', emptyPrefix, signal,
          () => Promise.resolve(emptyPrefix),
        )
        // Never cache an interrupted composition; the next turn recomposes it.
        interruptionCheckpoint(signal)
        transmission.sessionPrefix = deepFreeze(structuredClone(composed))
      }

      // Await surface mutations outside the step; pressure checks receive the pending prefix.
      await events.serial('agent/pre-step', turn, step, fullSystemPrompt, transmission.sessionPrefix, signal)
      interruptionCheckpoint(signal)

      // Snapshot the exact log prefix before step/start: the reconstruction
      // boundary. Appends after this synchronous snapshot join the next request.
      const boundaryMessages = session.deriveMessages()

      session.append('step/start', { turn, step })
      // Only a committed step/start creates a balancing obligation. A
      // pre-commit veto throws before this assignment; post-commit observers
      // are contained inside Session.append().
      stepOpen = true
      // A synchronous step/start observer can cancel after the step opened.
      interruptionCheckpoint(signal)

      let stepOutcome: { hadToolCalls: boolean; finish: FinishReason } | { error: Error }
      try {
        stepOutcome = await runStep(
          ctx, events, agent, turn, step, assembly, fullSystemPrompt, boundaryMessages, transmission, signal)
      } catch (error: unknown) {
        stepOutcome = { error: toError(error) }
      }

      if ('error' in stepOutcome) {
        // Steering that arrived during the failed step stays in the inbox —
        // runLoop re-enqueues it as a queued message, so an abort-then-steer
        // starts a fresh turn instead of being silently consumed.
        closeStep()
        const { error } = stepOutcome
        const interruption = interruptionTurnEndReason(handle, signal)
        if (interruption === undefined) failTurn(error)
        else reason = interruption
        break
      }

      // Preserve max-token completion unless a later disposal, abort, or error wins.
      const stepReason = stepFinishReason(stepOutcome.finish)
      if (stepReason) reason = stepReason

      // Steering that arrived during streaming/tool execution.
      const steered = drainSteering(agent, handle.inbox, turn)

      closeStep()
      interruptionCheckpoint(signal)

      const defaultDecision: ContinuationDecision = { action: stepOutcome.hadToolCalls || steered ? 'continue' : 'stop' }
      let decision: ContinuationDecision
      try {
        decision = await events.waterfall(
          'agent/turn-continuation', turn, defaultDecision, signal,
          () => Promise.resolve(defaultDecision),
        )
        interruptionCheckpoint(signal)
      } catch (error: unknown) {
        const interruption = interruptionTurnEndReason(handle, signal)
        if (interruption === undefined) failTurn(toError(error))
        else reason = interruption
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
        const stop = await events.serial('agent/turn-stop', turn, signal)
        interruptionCheckpoint(signal)
        terminalStop = stop !== undefined
      } catch (error: unknown) {
        const interruption = interruptionTurnEndReason(handle, signal)
        if (interruption === undefined) failTurn(toError(error))
        else reason = interruption
        break
      }
      if (terminalStop) {
        terminalStopped = true
        // Terminal stop discards steering but preserves ordinary queued prompts.
        handle.inbox.drainSteering()
        shouldContinue = false
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
    const interruption = interruptionTurnEndReason(handle, signal)
    if (interruption === undefined) failTurn(toError(error))
    else reason = interruption
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

/** Drain the steering queue into the session. Returns whether any arrived. */
function drainSteering(agent: ReactLoopAgent, inbox: Inbox, turn: number): boolean {
  const messages = inbox.drainSteering()
  for (const message of messages) {
    agent.session.append('steering/message', { turn, content: message.content, source: message.source }, { surfaceOp: 'append' })
  }
  return messages.length > 0
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
  agent: ReactLoopAgent,
  turn: number,
  step: number,
  assembly: PromptAssembly,
  system: string,
  boundaryMessages: Message[],
  transmission: TransmissionLog,
  signal: AbortSignal,
): Promise<{ hadToolCalls: boolean; finish: FinishReason }> {
  const { session, options } = agent

  // Seed the first request from agent options and later requests from the logged header;
  // detach and freeze so listeners must return an attributable replacement.
  const seedConfig: LlmCallConfig = deepFreeze(structuredClone(transmission.loggedHeader
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- loggedHeader ⟹ a snapshot is in the log
    ? session.requestHeader()!.config
    : { provider: options.provider ?? '', model: options.model ?? '' }))

  // Listener replacements are recorded in the request header before dispatch.
  const config = await events.waterfall('agent/request', turn, step, seedConfig, signal, () => Promise.resolve(seedConfig))
  interruptionCheckpoint(signal)
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
  for await (const chunk of ctx.llm.stream(request)) {
    interruptionCheckpoint(signal)
    const chunkEvent = session.append('assistant/chunk', { turn, step, chunk })
    chunkSeqs.push(chunkEvent.seq)
    assembler.push(chunk)
  }
  interruptionCheckpoint(signal)

  // Normalize failure finish chunks into the same path as thrown stream errors.
  const stepError = finishError(assembler.finish)
  if (stepError) throw stepError

  if (assembler.finish.kind === 'max-tokens') {
    const assembled = assembler.message()
    const assembledContent = structuredClone(assembled.content)
    let message: Message = withoutToolCalls(assembled)
    message = withoutToolCalls(await processStepResult(
      events, session, turn, step, header.config, assembledContent, message, assembler, chunkSeqs, signal,
    ))
    // Preserve usage even when max-token truncation produced no content.
    recordAssistantMessage(session, turn, step, header.config, assembledContent, message, assembler, chunkSeqs)
    return { hadToolCalls: false, finish: assembler.finish }
  }

  // Record the post-waterfall message that tool dispatch uses.
  const assembled = assembler.message()
  const assembledContent = structuredClone(assembled.content)
  let message: Message = assembled
  message = await processStepResult(
    events, session, turn, step, header.config, assembledContent, message, assembler, chunkSeqs, signal,
  )

  // Every successful call records its completion anchor, including explicit
  // empty chunk provenance for a contentless, usage-less provider response.
  recordAssistantMessage(session, turn, step, header.config, assembledContent, message, assembler, chunkSeqs)

  // Tool execution stays sequential; recheck abort around each normalized result.
  const toolCalls = message.content.filter(block => block.type === 'tool-call')
  // Buffer context until all results are appended to preserve call/result adjacency.
  const pendingContext: HookContext[] = []
  for (const call of toolCalls) {
    interruptionCheckpoint(signal)
    const callEvent = session.append('tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments })
    let parsedArguments: unknown
    try {
      parsedArguments = call.arguments ? JSON.parse(call.arguments) : {}
    } catch {
      parsedArguments = call.arguments
    }
    // TODO(pre-tool-input-rewrite): Keep logged history and live presentation aligned;
    // see docs/rfc/proposed/feature/2026-06-30-pre-tool-input-rewrite.md.
    const result = await ctx.tools.execute({
      callId: call.id,
      name: call.name,
      arguments: parsedArguments,
      agent,
      signal,
    })
    session.append('tool/result', {
      turn, step,
      // Correlation comes from the immutable execution input; the result does
      // not duplicate this authoritative transcript identity.
      callId: call.id,
      content: result.content,
      isError: result.isError,
      ...result.error ? { error: result.error } : {},
      // Persist tool-owned presentation data for replay.
      ...result.meta !== undefined ? { meta: result.meta } : {},
    }, { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] })
    pendingContext.push(...result.additionalContexts ?? [])
    interruptionCheckpoint(signal)
  }

  // Append buffered context after the complete result batch.
  for (const context of pendingContext) {
    agent.inject(context.content, {
      source: context.source,
      ...context.envelope !== undefined ? { envelope: context.envelope } : {},
      ...context.meta !== undefined ? { meta: context.meta } : {},
    })
  }

  return { hadToolCalls: toolCalls.length > 0, finish: assembler.finish }
}

/** Preserve successful-call accounting without retaining output that result processing rejected. */
async function processStepResult(
  events: AgentEventDispatch,
  session: Session,
  turn: number,
  step: number,
  config: LlmCallConfig,
  assembledContent: ContentBlock[],
  message: Message,
  assembler: BlockAssembler,
  chunkSeqs: number[],
  signal: AbortSignal,
): Promise<Message> {
  try {
    const processed = await events.waterfall(
      'agent/step-result', turn, step, message, signal, () => Promise.resolve(message),
    )
    interruptionCheckpoint(signal)
    return processed
  } catch (error: unknown) {
    recordAssistantMessage(
      session,
      turn,
      step,
      config,
      assembledContent,
      { ...message, content: [] },
      assembler,
      chunkSeqs,
      false,
    )
    throw error
  }
}

/** Record one content-or-usage assistant message with replay-safe provenance. */
function recordAssistantMessage(
  session: Session,
  turn: number,
  step: number,
  config: LlmCallConfig,
  assembledContent: ContentBlock[],
  message: Message,
  assembler: BlockAssembler,
  chunkSeqs: number[],
  preserveReplayState = true,
): void {
  session.append(
    'assistant/message',
    {
      turn,
      step,
      content: message.content,
      provenance: assistantProvenance(
        config,
        assembler.replayState,
        preserveReplayState && isDeepStrictEqual(message.content, assembledContent),
      ),
      ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    },
    { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
  )
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
