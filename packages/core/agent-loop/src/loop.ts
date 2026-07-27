/**
 * Drives one agent across queued durable turns. Turn failures are contained so
 * later work can run; the session log, not this driver, owns conversation state.
 * See .agents/notes/implemented/architecture/2026-06-18-agent-lifecycle-and-ownership-seams.md.
 * @module dsh-agent-loop/loop
 */

import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import type { ContentBlock, FinishReason, GenerateOptions, LlmCallConfig, LlmFailure, Message } from '@deepseek-ai/dsh-llm'
import { isDeepStrictEqual } from 'node:util'
import { BlockAssembler, HarnessError, LlmError, assertNever, deepFreeze, errorChain, llmFailureOf, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { agentEvents, agentInterruptReasonOf, assembleContextFor, AgentMessageId } from '@deepseek-ai/dsh-agent'
import type { AgentEventDispatch, ContinuationDecision, HookContext, PromptDecision, RequestError, RequestErrorDecision } from '@deepseek-ai/dsh-agent'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import type { PromptMessageData, Session, TurnEndReason, TurnTrigger } from '@deepseek-ai/dsh-session'
import { createTransmissionLog, recordRequestHeader } from './request-log.ts'
import type { TransmissionLog } from './request-log.ts'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { executeToolCalls } from './tool-calls.ts'
import { agentMessage, type Inbox, type InboxMessage } from './inbox.ts'
import type { TurnCancellation } from './cancellation.ts'

/** Normalize thrown values while preserving an existing error code. */
function toError(error: unknown): RequestError {
  return error instanceof Error ? error : new HarnessError(String(error), 'UNKNOWN', { cause: error })
}

/** Distinguishes final model-request failures from failures in later step processing. */
class TerminalModelRequestFailure extends Error {
  constructor(
    readonly requestError: RequestError,
    readonly failure: LlmFailure,
  ) {
    super(failure.message, { cause: requestError })
    this.name = 'TerminalModelRequestFailure'
  }
}

/** Convert terminal failure finishes into step errors; unknown extensible finishes remain successful. */
function finishError(finish: FinishReason): { error: RequestError; failure: LlmFailure } | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const facts = finish.failure
      const error = new LlmError(facts.message, facts.code, {
        ...facts.status === undefined ? {} : { status: facts.status },
        ...facts.providerRetryAfterMs === undefined
          ? {}
          : { providerRetryAfterMs: facts.providerRetryAfterMs },
        ...facts.requestId === undefined ? {} : { requestId: facts.requestId },
      })
      return { error, failure: error.failure }
    }
    // stop / tool-calls / max-tokens / plugin-added kinds → not a failure.
    default:
      return undefined
  }
}

/**
 * Build the `{ message, code? }` part of an error payload, omitting the
 * `code` key entirely when absent (exactOptionalPropertyTypes-correct).
 * The durable message renders the full cause chain: `turn/end` is the single
 * durable record of an in-turn failure, so a wrapper message alone (e.g.
 * `fetch failed`) would lose the diagnosis the session log exists to keep.
 */
function errorData(err: RequestError): { message: string; code?: string } {
  return { message: errorChain(err), ...typeof err.code === 'string' ? { code: err.code } : {} }
}

/** Preserve cause diagnostics, falling back to adapter-normalized prose for a hostile Error. */
function durableFailure(err: RequestError, failure: LlmFailure): LlmFailure {
  const message = errorChain(err)
  return { ...failure, message: message === '<unrenderable value>' ? failure.message : message }
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

const PROMPT_PREFIX_REQUEST_DELIMITER: ContentBlock = {
  type: 'text',
  text: '\n\n## My request:\n',
}

interface PreparedPromptMessage {
  data: PromptMessageData
  separateContexts: HookContext[]
}

/** Bake declared prefix contexts into one reconstructable prompt message. */
function preparePromptMessage(
  content: ContentBlock[],
  source: PromptMessageData['source'],
  contexts: readonly HookContext[],
): PreparedPromptMessage {
  const prefixContexts = contexts.filter(context => context.placement === 'prompt-prefix')
  const separateContexts = contexts.filter(context => context.placement !== 'prompt-prefix')
  if (prefixContexts.length === 0) return { data: { content, source }, separateContexts }
  return {
    data: {
      content: [
        ...prefixContexts.flatMap(context => context.content),
        PROMPT_PREFIX_REQUEST_DELIMITER,
        ...content,
      ],
      source,
      envelope: {
        displayContent: content,
        prefixContexts: prefixContexts.map(context => ({
          source: context.source,
          ...context.meta === undefined ? {} : { meta: context.meta },
        })),
      },
    },
    separateContexts,
  }
}

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
    /* v8 ignore next 2 -- the private holder requests disposed only after lifecycle state flips, which returns above. */
    case 'disposed':
      return { kind: 'disposed' }
    /* v8 ignore next 2 -- AgentInterruptReason is closed and the public helper filters unsupported reasons. */
    default:
      return assertNever(reason, 'AgentInterruptReason')
  }
}

/** Mutable agent controls supplied to the loop driver. */
export interface LoopHandle {
  /** Native-private agent inbox handed to the driver only at internal startup. */
  readonly inbox: Inbox
  /** Maximum parallel-safe calls allowed in one step. */
  readonly maxParallelToolCalls: number
  setStatus(status: 'idle' | 'running'): void
  /** Install a fresh active-turn owner before the running notification. */
  installTurnCancellation(): TurnCancellation
  /** Clear only the exact owner whose turn reached its terminal event boundary. */
  clearTurnCancellation(cancellation: TurnCancellation): void
  /** Resolves when the agent is disposed — unblocks the idle wait. */
  disposed: Promise<void>
  isDisposed(): boolean
  /** Whether queued work was cancelled before an active turn owner existed. */
  isPreRunCancelled(): boolean
  /** Clear the cause-less pre-run marker without affecting replacement work. */
  clearPreRunCancel(): void
  /** Settle idle waiters before pre-running cancellation publishes idle. */
  settleIdle(): void
  /** Run an active tool-call batch, accepting post-tool context into the FIFO drained before settlement. */
  readonly withToolBatch: <T>(run: (acceptContext: (context: HookContext) => void) => Promise<T>) => Promise<T>
}

/**
 * Drive queued messages as independent durable turns until disposal. Plugin
 * failures end the current turn without terminating the driver. The caller
 * establishes the `ctx.agents.withInitiator()` boundary before entry; package-private
 * orchestration recovers that exact Agent and captures its Session locally.
 * @param ctx - the plugin context the loop reaches its initiating Agent,
 * events (agent/…, session/flush), and services (systemPrompt, llm, tools)
 * through.
 * @param handle - the bridge to status, turn cancellation ownership, disposal, and pre-run cancellation state.
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
    // An idle listener can enqueue and cancel replacement work before the next
    // wait is installed. Consume that empty marker before parking the driver.
    // A quiet (`wakeup:false`) item alone must not un-park the loop, so gate on
    // hasWakingQueued, not hasQueued.
    if (handle.isPreRunCancelled()) {
      handle.clearPreRunCancel()
      if (!handle.inbox.hasWakingQueued) {
        handle.settleIdle()
        handle.setStatus('idle')
        continue
      }
    }

    await handle.inbox.waitForQueued(handle.disposed)
    if (handle.isDisposed()) break

    // Cancellation between wake and `running` skips only the cancelled work;
    // a replacement prompt still runs before the eventual idle transition.
    if (handle.isPreRunCancelled()) {
      handle.clearPreRunCancel()
      if (!handle.inbox.hasWakingQueued) {
        // Settle before publishing idle: the already-idle path has no status
        // transition, while an idle listener can register waiters for new work.
        handle.settleIdle()
        handle.setStatus('idle')
        continue
      }
    }

    let cancellation = handle.installTurnCancellation()
    handle.setStatus('running')
    if (handle.isDisposed()) {
      handle.clearTurnCancellation(cancellation)
      break
    }

    // A synchronous `running` listener can cancel before `runTurn`; balance the
    // status only when no waking replacement prompt was queued by that listener
    // (a lone quiet item parks at idle rather than driving a turn).
    if (cancellation.signal.aborted) {
      handle.clearTurnCancellation(cancellation)
      if (!handle.inbox.hasWakingQueued) {
        handle.setStatus('idle')
        continue
      }
      cancellation = handle.installTurnCancellation()
    }

    // Idle injection can add a turn, so derive the next number from the log.
    const turn = lastTurnNumber(session) + 1
    let terminalStopped = false
    try {
      terminalStopped = await runTurn(ctx, events, handle, turn, transmission, cancellation)
    } catch (error: unknown) {
      // Pre-turn failure has no durable boundary to close; report it without appending outside a turn.
      const err = toError(error)
      ctx.logger.warn(`agent "${agent.id}": turn ${turn} failed before it started: ${errorChain(err)}`)
      try {
        events.emit('agent/error', turn, 0, err)
      } catch { /* contained: a throwing agent/error listener must not kill the driver */ }
    } finally {
      handle.clearTurnCancellation(cancellation)
    }

    // Late steering (arriving after runTurn returns, e.g. during the post-turn
    // flush) becomes queued input — unless terminal policy stopped the turn, in
    // which case it is dropped and must publish a discard so its enqueue is
    // still matched (the invariant only catches a NEGATIVE count, not a leak).
    const lateSteering = handle.inbox.drainSteering()
    if (terminalStopped) {
      if (lateSteering.length > 0) {
        events.emit('agent/inbox/discard', lateSteering.map(message => agentMessage(message, true)))
      }
    } else {
      for (const message of lateSteering) handle.inbox.enqueue(message)
    }

    // Park at idle unless a waking item still wants the model to run; a lone
    // quiet (`wakeup:false`) item stays queued but does not keep the loop busy.
    if (!handle.inbox.hasWakingQueued) handle.setStatus('idle')
  }
}

async function runTurn(
  ctx: Context, events: AgentEventDispatch, handle: LoopHandle, turn: number, transmission: TransmissionLog,
  cancellation: TurnCancellation,
): Promise<boolean> {
  const agent = ctx.agents.requireInitiator()
  const { session } = agent
  const { signal } = cancellation
  const drainSteering = (): boolean => {
    const messages = handle.inbox.drainSteering()
    for (const message of messages) {
      events.emit('agent/inbox/dequeue', agentMessage(message, true))
      const prepared = preparePromptMessage(message.content, message.source, message.contexts)
      session.append('steering/message', {
        turn, ...prepared.data,
        ...message.meta === undefined ? {} : { meta: message.meta },
      }, { surfaceOp: 'append' })
      for (const context of prepared.separateContexts) {
        session.append('user/message', {
          content: context.content,
          source: context.source,
          ...context.meta === undefined ? {} : { meta: context.meta },
        }, { surfaceOp: 'append' })
      }
    }
    return messages.length > 0
  }

  // Claim one queued message before opening its turn, but append it only after `turn/start`.
  const message = handle.inbox.dequeueQueued()
  /* v8 ignore next 3 -- invariant guard: runLoop only calls runTurn when hasQueued */
  if (!message) throw new Error('runTurn invariant violated: no queued message at turn start')
  events.emit('agent/inbox/dequeue', agentMessage(message, false))
  const trigger: TurnTrigger = { kind: 'message', source: message.source }

  let reason: TurnEndReason = { kind: 'completed' }
  let step = 0
  let requestFailureHistory: readonly LlmFailure[] = Object.freeze([])
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
  const failTurn = (err: RequestError, failure?: LlmFailure): void => {
    if (errorReported) return
    errorReported = true
    reason = failure === undefined
      ? { kind: 'error', step, ...errorData(err) }
      : { kind: 'error', step, failure: durableFailure(err, failure) }
    try {
      events.emit('agent/error', turn, step, err)
    } catch {
      // contained: the error is already captured on `reason`; a throwing
      // agent/error listener must not prevent the turn from closing.
    }
  }

  // Retire cancellation authority before publishing the terminal event. The
  // following durability flush is quiescent turn work, but no longer part of
  // the cancellable turn lifetime.
  const closeTurn = (): void => {
    handle.clearTurnCancellation(cancellation)
    session.append('turn/end', { turn, reason })
  }

  try {
    // --- Turn boundary. Once turn/start is appended, a turn/end is owed no
    // matter what throws below; the catch + closeTurn guarantee it. A pre-commit
    // veto leaves no turn/start in the log and therefore owes no turn/end.
    session.append('turn/start', { turn, trigger })
    interruptionCheckpoint(signal)
    // The claimed message runs the `agent/prompt-submit` waterfall before it
    // becomes a `user/message` — a hook can rewrite the prompt or block it.
    // Recorded INSIDE the turn (after turn/start) so every event is turn-enclosed;
    // turn/end is now owed, so a throwing prompt-submit listener (the waterfall
    // throws) is caught below and the turn still closes.
    const promptDecision = await events.waterfall(
      'agent/prompt-submit', message.content, message.source, signal,
      () => Promise.resolve<PromptDecision>({
        kind: 'allow',
        ...message.contexts.length === 0 ? {} : { additionalContexts: message.contexts },
      }),
    )
    interruptionCheckpoint(signal)
    if (promptDecision.kind === 'block') {
      session.append('prompt/blocked', { content: message.content, source: message.source, reason: promptDecision.reason })
      reason = { kind: 'rejected', reason: promptDecision.reason }
    } else {
      // `allow.content` REPLACES the prompt bytes (a rewrite); absent keeps them.
      const content = promptDecision.content ?? message.content
      const prepared = preparePromptMessage(content, message.source, promptDecision.additionalContexts ?? [])
      session.append('user/message', {
        ...prepared.data,
        ...message.meta === undefined ? {} : { meta: message.meta },
      }, { surfaceOp: 'append' })
      // Separate contexts still enter THIS turn through inject(). Prefix
      // contexts are already baked into the user/message with their durable
      // display envelope, so appending them again would duplicate model input.
      for (const context of prepared.separateContexts) {
        agent.inject(context.content, {
          source: context.source,
          ...context.meta !== undefined ? { meta: context.meta } : {},
        })
      }
    }

    while (true) {
      // A blocked prompt closes its zero-step turn as rejected.
      if (promptDecision.kind === 'block') break
      step += 1

      // Steering from the previous round's continuation listeners joins before
      // the request.
      drainSteering()

      // Assemble once before pre-step so listener work and the request share one prompt value.
      const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
      interruptionCheckpoint(signal)
      const fullSystemPrompt = renderPrompt(assembly)

      // Compose the request-only prefix once per loop instance before the first
      // request boundary. It precedes all derived history and is recorded only
      // in the request header, not as session history.
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

      // Await surface mutations outside the step before snapshotting history.
      await events.serial('agent/pre-step', turn, step, signal)
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

      let stepOutcome:
        | { hadToolCalls: boolean; finish: FinishReason }
        | { requestError: RequestError; failure: LlmFailure }
        | { error: RequestError }
      try {
        stepOutcome = await runStep(
          ctx, events, handle, turn, step, assembly, fullSystemPrompt, boundaryMessages, transmission, signal)
      } catch (error: unknown) {
        if (error instanceof TerminalModelRequestFailure) {
          stepOutcome = { requestError: error.requestError, failure: error.failure }
        } else {
          stepOutcome = { error: toError(error) }
        }
      }

      if ('requestError' in stepOutcome) {
        // Recovery observes a balanced failed step and the original provider
        // error while the failed step's signal remains the active owner.
        closeStep()
        const interrupted = interruptionTurnEndReason(handle, signal)
        if (interrupted !== undefined) {
          reason = interrupted
          break
        }

        const defaultDecision: RequestErrorDecision = { action: 'fail' }
        let recoveryDecision: RequestErrorDecision = defaultDecision
        try {
          recoveryDecision = await events.waterfall(
            'agent/request-error', turn, step, stepOutcome.requestError,
            stepOutcome.failure, requestFailureHistory, signal,
            () => Promise.resolve(defaultDecision),
          )
        } catch (recoveryError: unknown) {
          ctx.logger.warn(
            `agent "${agent.id}": request recovery failed at turn ${turn}, step ${step}: ${errorChain(recoveryError)}`,
          )
        }
        // Cancellation and disposal always win over either a recovery decision
        // or a recovery-listener failure.
        const recoveryInterrupted = interruptionTurnEndReason(handle, signal)
        if (recoveryInterrupted !== undefined) {
          reason = recoveryInterrupted
          break
        }
        switch (recoveryDecision.action) {
          case 'retry':
            requestFailureHistory = Object.freeze([...requestFailureHistory, stepOutcome.failure])
            continue
          case 'fail':
            failTurn(stepOutcome.requestError, stepOutcome.failure)
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
        const { error } = stepOutcome
        const interrupted = interruptionTurnEndReason(handle, signal)
        if (interrupted === undefined) failTurn(error)
        else reason = interrupted
        break
      }

      requestFailureHistory = Object.freeze([])

      // Preserve max-token completion unless a later disposal, abort, or error wins.
      const stepReason = stepFinishReason(stepOutcome.finish)
      if (stepReason) reason = stepReason

      // Steering that arrived during streaming/tool execution.
      const steered = drainSteering()

      try {
        await events.serial('agent/post-step', turn, step, signal)
      } catch (error: unknown) {
        stepOutcome = { error: toError(error) }
      }

      if ('error' in stepOutcome) {
        closeStep()
        const interrupted = interruptionTurnEndReason(handle, signal)
        if (interrupted === undefined) failTurn(stepOutcome.error)
        else reason = interrupted
        break
      }

      const postStepInterrupted = interruptionTurnEndReason(handle, signal)
      if (postStepInterrupted !== undefined) {
        reason = postStepInterrupted
        closeStep()
        break
      }

      closeStep()

      const defaultDecision: ContinuationDecision = { action: stepOutcome.hadToolCalls || steered ? 'continue' : 'stop' }
      let decision: ContinuationDecision
      try {
        decision = await events.waterfall(
          'agent/turn-continuation', turn, defaultDecision, signal,
          () => Promise.resolve(defaultDecision),
        )
        interruptionCheckpoint(signal)
      } catch (error: unknown) {
        const interrupted = interruptionTurnEndReason(handle, signal)
        if (interrupted === undefined) failTurn(toError(error))
        else reason = interrupted
        break
      }

      // A continuation reason becomes next-step steering. Publish the same
      // enqueue event a public steer would, so the inbox ledger stays balanced
      // (every FIFO entry has a matching enqueue before its dequeue/discard).
      if (decision.action === 'continue' && decision.reason) {
        // Detach and freeze the listener-owned reason like a public steer, so an
        // enqueue listener or the producer cannot mutate the durable/model-visible
        // steering message before it drains.
        const item: InboxMessage = deepFreeze({
          id: AgentMessageId(randomUUID()),
          content: structuredClone(decision.reason.content),
          source: structuredClone(decision.reason.source),
          contexts: [], wakeup: true,
        })
        handle.inbox.steer(item)
        events.emit('agent/inbox/enqueue', agentMessage(item, true))
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
        // A broken terminal policy is an ordinary continuation failure: fail
        // this turn closed while leaving the driver alive for later turns.
        const interrupted = interruptionTurnEndReason(handle, signal)
        if (interrupted === undefined) failTurn(toError(error))
        else reason = interrupted
        break
      }
      if (terminalStop) {
        terminalStopped = true
        // Terminal stop discards steering but preserves ordinary queued prompts.
        // Publish a discard for every dropped steering item so the enqueue ⇒
        // dequeue-or-discard ledger stays balanced (the outstanding-count
        // invariant and correlation consumers must not be left with dangling ids).
        const dropped = handle.inbox.drainSteering()
        if (dropped.length > 0) {
          events.emit('agent/inbox/discard', dropped.map(item => agentMessage(item, true)))
        }
        shouldContinue = false
      }

      if (!shouldContinue) break
    }

    // Normal / inline-error loop exit: close the turn.
    closeTurn()
  } catch (error: unknown) {
    // Close only a turn whose start committed to the log.
    const turnStartLogged = session.events.some(e => e.type === 'turn/start' && e.data.turn === turn)
    if (!turnStartLogged) throw error
    closeStep()
    const interrupted = interruptionTurnEndReason(handle, signal)
    if (interrupted === undefined) failTurn(toError(error))
    else reason = interrupted
    closeTurn()
  }

  // Flush through the store-owned durability checkpoint without killing the driver on failure.
  try {
    await ctx.sessions.flush(session)
  } catch (error: unknown) {
    // The turn is closed, so report the failed flush live rather than append outside a turn.
    const err = toError(error)
    ctx.logger.warn(`agent "${agent.id}": session/flush failed at turn ${turn}: ${errorChain(err)}`)
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
  const config = await events.waterfall(
    'agent/request', turn, step, seedConfig, signal, () => Promise.resolve(seedConfig),
  )
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
  const request: GenerateOptions = markAgentLoopRequest(deepFreeze({
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
  }))

  // --- Model call (streaming-first; raw chunks are the replay record) ---
  const assembler = new BlockAssembler()
  const chunkSeqs: number[] = []
  const stream = ctx.llm.stream(request)
  try {
    for await (const chunk of stream) {
      interruptionCheckpoint(signal)
      const chunkEvent = session.append('assistant/chunk', { turn, step, chunk })
      chunkSeqs.push(chunkEvent.seq)
      assembler.push(chunk)
    }
  } catch (error: unknown) {
    const failure = llmFailureOf(stream, error)
    if (failure !== undefined && error instanceof Error) throw new TerminalModelRequestFailure(error, failure)
    throw error
  }
  interruptionCheckpoint(signal)

  // Normalize failure finish chunks into the same path as thrown stream errors.
  const stepError = finishError(assembler.finish)
  if (stepError) throw new TerminalModelRequestFailure(stepError.error, stepError.failure)

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
      const processed = await events.waterfall(
        'agent/step-result', turn, step, message, signal, () => Promise.resolve(message),
      )
      interruptionCheckpoint(signal)
      return processed
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
