/**
 * Concrete Agent loop over two pending-input lists: queued prompts each open a
 * turn, while admitted input, steering, and injected context enter through the
 * outbox at step boundaries. Every request is derived from the session log.
 *
 * @module dsh-agent-loop/agent
 */

import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import { Agent, AgentMessageId, agentCarrier, agentInterruptReasonOf, assembleContextFor, emitAgentEvent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type {
  AgentMessageId as AgentMessageIdType,
  CancelOptions,
  AgentInterruptReason,
  AgentOptions,
  AgentStatus,
  IdleReason,
  PromptDecision,
  SendOptions,
} from '@deepseek-ai/dsh-agent'
import {
  BlockAssembler, HarnessError, LlmError, deepFreeze, errorChain, llmFailureOf, markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, GenerateOptions, LlmCallConfig, LlmFailure, Message, MessageSource,
} from '@deepseek-ai/dsh-llm'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import type { PromptMessageData, Session, SessionId, TurnEndReason, TurnTrigger } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { executeToolCalls } from './tool-calls.ts'

/** One message waiting in the queued or steering inbox. */
interface PendingMessage {
  id: AgentMessageIdType
  content: ContentBlock[]
  source: MessageSource
  wakeup: boolean
}

/** Model-facing input awaiting the next step boundary. */
interface OutboxItem extends PromptMessageData {
  /** Present only when this input is a live inbox item. */
  steering?: PendingMessage
}

/** Normalize thrown values while preserving an existing error code. */
function toError(error: unknown): Error & { code?: string } {
  return error instanceof Error ? error : new HarnessError(String(error), 'UNKNOWN', { cause: error })
}

/** Rebuild the live {@link LlmError} for serializable provider facts; `cause` keeps the foreign original. */
function llmError(facts: LlmFailure, cause?: Error): LlmError {
  return new LlmError(facts.message, facts.code, { ...facts, cause })
}

function withoutToolCalls(message: Message): Message {
  return { ...message, content: message.content.filter(block => block.type !== 'tool-call') }
}

/**
 * The concrete {@link Agent}: each `run()` owns one turn and repeats model
 * steps while tools or steering require another request.
 */
export class ReactLoopAgent extends Agent {
  /** Prompts awaiting individual turns. */
  private queued: PendingMessage[] = []
  /** Input taken into the session log at step boundaries. */
  private outbox: OutboxItem[] = []

  /** Whether observers see a running interval; consecutive turns share it. */
  private busy = false
  /** Abort owner for the current admission or turn. */
  private abort: AbortController | undefined
  /** Resolves when the current admission and turn exit. */
  done: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after {@link done}. */
  readonly scope: Scope
  /** The agent's scoped composition context ({@link Agent.ctx}). */
  readonly ctx: Context

  /** Last turn number opened by this loop or present in its seeded log. */
  private lastTurn: number
  /** Whether the session log is owed a matching turn end event. */
  private turnOpen = false
  private stepOpen = false

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    super()
    this.lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
  }

  /** Last activity state published to observers. */
  get status(): AgentStatus {
    return this.busy ? 'running' : 'idle'
  }

  /** Accept and route one unified send item. */
  send(
    content: ContentBlock[],
    options: SendOptions = { target: 'next-turn', wakeup: true, source: { kind: 'user' } },
  ): AgentMessageIdType {
    const id = AgentMessageId(randomUUID())
    const { target, wakeup, source } = options
    if (target === 'next-step' && !wakeup) {
      if (this.turnOpen) {
        this.outbox.push({ content, source })
        return id
      }
      this.session.append('user/message', { content, source }, { surfaceOp: 'append' })
      return id
    }

    const steering = target === 'next-step' && this.turnOpen
    const message: PendingMessage = {
      id,
      content,
      source,
      wakeup,
    }
    if (steering) {
      this.outbox.push({ content: message.content, source: message.source, steering: message })
    } else {
      this.queued.push(message)
    }
    emitAgentEvent(this.loopCtx, this, 'agent/inbox/enqueue', message)
    if (!steering && wakeup) this.kick()
    return id
  }

  /**
   * Clear all pending work and abort the active turn; the first cause wins.
   * The cause is signal payload for observers and the durable turn/end
   * classification — it selects no machine behavior. Teardown is just
   * `cancel({kind:'disposed'})` + await {@link done} + {@link scope} dispose,
   * all owned by the factory.
   */
  cancel(cause: AgentInterruptReason, options: CancelOptions = {}): void {
    if (this.abort !== undefined || this.queued.length > 0 || this.outbox.length > 0) {
      // Observe-only: coordination consumers update their state before the
      // inboxes clear; listener failures are contained by the dispatcher.
      if (cause.kind !== 'disposed') emitAgentEvent(this.loopCtx, this, 'agent/cancel-requested', cause)
    }
    if (!options.keepInbox) {
      const discarded = [
        ...this.queued,
        ...this.outbox.map(item => item.steering).filter(steering => steering !== undefined),
      ]
      // Clear before abort observers run: replacement work belongs to the next turn.
      this.queued.length = 0
      this.outbox.length = 0
      if (discarded.length > 0) emitAgentEvent(this.loopCtx, this, 'agent/inbox/discard', discarded)
    }
    const reason = Object.freeze({ kind: cause.kind })
    this.abort?.abort(reason)
  }

  /**
   * Re-open a turn on the current session log without a new prompt — the
   * recovery verb after an error idle (naive `retry()`): repair the history
   * (edit the log, wait out a rate limit), then run again, right now.
   * @throws while a turn is running — there is nothing to retry yet.
   */
  retry(): void {
    if (this.abort !== undefined) throw new Error(`agent "${this.id}" cannot retry while busy`)
    this.done = this.loopCtx.agents.withInitiator(this, () => this.run({ kind: 'retry' }))
  }

  /** Resolve at idle quiescence: no run driving and no waking prompt waiting. */
  async whenIdle(): Promise<void> {
    // `done` is replaced per activity, so re-reading it follows chained turns;
    // a run failure still counts as quiescence for the waiter.
    while (this.abort !== undefined || this.queued.some(message => message.wakeup)) {
      await this.done.catch(() => undefined)
    }
  }

  /** Claim and admit the next queued prompt, then start its turn. */
  private kick(): void {
    if (this.abort !== undefined || !this.queued.some(message => message.wakeup)) return
    const message = this.queued.shift()
    if (message === undefined) return

    emitAgentEvent(this.loopCtx, this, 'agent/inbox/dequeue', message)
    const admission = new AbortController()
    this.abort = admission
    this.done = this.loopCtx.agents.withInitiator(this, async () => {
      const signal = admission.signal
      const trigger: TurnTrigger = { kind: 'message', source: message.source }
      let admitted = false
      try {
        signal.throwIfAborted()
        const decision = await this.loopCtx.waterfall(
          agentCarrier(this), 'agent/prompt-submit', this, message.content, message.source, signal,
          () => Promise.resolve<PromptDecision>({ kind: 'allow' }),
        )
        signal.throwIfAborted()

        if (decision.kind === 'allow') {
          this.outbox.push({ content: decision.content ?? message.content, source: message.source })
          for (const context of decision.additionalContexts ?? []) {
            this.outbox.push({ content: context.content, source: context.source })
          }
          admitted = true
        }
      } catch (error: unknown) {
        if (agentInterruptReasonOf(signal) === undefined) {
          const failure = toError(error)
          this.loopCtx.logger.warn(`agent "${this.id}": prompt admission failed: ${errorChain(failure)}`)
        }
      }

      if (this.abort === admission) this.abort = undefined
      if (!admitted) {
        this.continueOrIdle()
        return
      }
      await this.run(trigger)
    })
  }

  /** Own one complete turn over input already admitted by {@link kick}, or retry history as-is. */
  private async run(trigger: TurnTrigger): Promise<void> {
    if (this.abort !== undefined) throw new Error(`agent "${this.id}" is already running`)
    const controller = new AbortController()
    this.abort = controller
    if (!this.busy) {
      this.busy = true
      emitAgentEvent(this.loopCtx, this, 'agent/status', 'running')
    }
    const signal = controller.signal
    const turn = ++this.lastTurn
    let step = 0
    let reason: TurnEndReason = { kind: 'completed' }
    let idle: IdleReason = { kind: 'completed' }

    try {
      signal.throwIfAborted()
      this.session.append('turn/start', { turn, trigger })
      this.turnOpen = true
      signal.throwIfAborted()

      this.drainOutbox(turn)

      while (true) {
        step += 1
        const { continueTurn, maxTokens } = await this.step(turn, step, signal)
        if (maxTokens) reason = { kind: 'max-tokens' }
        if (continueTurn || this.outbox.some(item => item.steering !== undefined)) continue
        await this.loopCtx.serial(agentCarrier(this), 'agent/stopping', this, turn, signal)
        signal.throwIfAborted()
        if (!this.drainOutbox(turn)) break
      }
    } catch (error: unknown) {
      ({ reason, idle } = this.settle(turn, step, error, signal))
    } finally {
      try {
        if (this.stepOpen) {
          this.stepOpen = false
          this.session.append('step/end', { turn, step })
        }
        if (this.turnOpen) {
          // Re-entrant turn/end listeners must route new input to a later turn.
          this.turnOpen = false
          this.session.append('turn/end', { turn, reason })
        }
      } catch (error: unknown) {
        const err = toError(error)
        this.loopCtx.logger.warn(`agent "${this.id}": closing turn ${turn} failed: ${errorChain(err)}`)
        emitAgentEvent(this.loopCtx, this, 'agent/error', turn, step, err)
      }
      if (this.abort === controller) this.abort = undefined
      emitAgentEvent(this.loopCtx, this, 'agent/idle', turn, idle)
      this.continueOrIdle()
    }
  }

  /**
   * Run the `agent/step` seam, commit pending input, derive one request, and
   * execute its tool calls inside one durable step boundary.
   */
  private async step(
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<{ continueTurn: boolean; maxTokens: boolean }> {
    const { session } = this

    // The single between-steps seam: listeners inject, steer, or edit the log
    // here; the request derives from the log after this settles.
    await this.loopCtx.serial(agentCarrier(this), 'agent/step', this, turn, step, signal)
    signal.throwIfAborted()

    // Take the outbox whole — same-boundary steering and context leave in
    // this request together.
    this.drainOutbox(turn)

    // Assemble the system prompt fresh each step (it may depend on log state).
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
    signal.throwIfAborted()
    const system = renderPrompt(assembly)

    // Snapshot the exact log prefix: the reconstruction boundary. Appends
    // after this synchronous snapshot join the next request.
    const boundaryMessages = session.deriveMessages()

    session.append('step/start', { turn, step })
    this.stepOpen = true
    signal.throwIfAborted()

    const request = await this.buildRequest(turn, step, assembly.tools, system, boundaryMessages, signal)

    const assembler = new BlockAssembler()
    const chunkSeqs: number[] = []
    const stream = this.loopCtx.llm.stream(request)
    try {
      for await (const chunk of stream) {
        signal.throwIfAborted()
        const chunkEvent = session.append('assistant/chunk', { turn, step, chunk })
        chunkSeqs.push(chunkEvent.seq)
        assembler.push(chunk)
      }
    } catch (error: unknown) {
      // Normalize a final-adapter failure into the one model-error type; the
      // foreign original stays on `cause` for the rendered chain.
      const facts = llmFailureOf(stream, error)
      if (facts !== undefined && error instanceof Error) throw llmError(facts, error)
      throw error
    }
    signal.throwIfAborted()

    // Failure finish chunks take the same path as thrown stream errors.
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') throw llmError(finish.failure)

    // Truncated (max-tokens) output cannot owe tool calls.
    const assembled = assembler.finish.kind === 'max-tokens'
      ? withoutToolCalls(assembler.message())
      : assembler.message()

    session.append(
      'assistant/message',
      {
        turn,
        step,
        content: assembled.content,
        provenance: {
          provider: request.provider,
          model: request.model,
          ...assembler.replayState !== undefined ? { replayState: assembler.replayState } : {},
        },
        ...assembler.usage === undefined ? {} : { usage: assembler.usage },
      },
      { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
    )

    const toolCalls = assembled.content.filter(block => block.type === 'tool-call')
    let concluded = false
    if (toolCalls.length > 0) {
      ({ concluded } = await executeToolCalls(
        this.loopCtx, turn, step, toolCalls, signal,
        context => this.outbox.push({ content: context.content, source: context.source }),
      ))
    }

    // Tool results stay adjacent to their calls; input accepted during the
    // request enters the log only after the complete result batch.
    const steered = this.drainOutbox(turn)
    session.append('step/end', { turn, step })
    this.stepOpen = false
    return {
      continueTurn: (toolCalls.length > 0 && !concluded) || steered,
      maxTokens: finish.kind === 'max-tokens',
    }
  }

  /**
   * Compose one frozen request: the `agent/request` config waterfall, the
   * canonical logged header, then the header plus the boundary snapshot,
   * byte-for-byte.
   */
  private async buildRequest(
    turn: number,
    step: number,
    tools: GenerateOptions['tools'] & object,
    system: string,
    boundaryMessages: Message[],
    signal: AbortSignal,
  ): Promise<GenerateOptions> {
    const { session } = this

    // Seed from the logged header when the log has one (the log is the
    // truth, across resumes too), else from agent options; freeze so
    // listeners must return a replacement.
    const seedConfig: LlmCallConfig = deepFreeze(structuredClone(
      session.requestHeader()?.config
      ?? { provider: this.options.provider ?? '', model: this.options.model ?? '' }))
    const config = await this.loopCtx.waterfall(
      agentCarrier(this), 'agent/request', this, turn, step, signal,
      () => Promise.resolve(seedConfig),
    )
    signal.throwIfAborted()
    if (!config.provider || !config.model) {
      throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`)
    }

    const header = canonicalHeader({
      config,
      ...system ? { system } : {},
      ...tools.length > 0 ? { tools } : {},
    })
    // Log the header the request will use only when it differs
    // from the folded baseline — reconstruction folds the log, so an
    // unchanged header needs no new snapshot.
    const baseline = session.requestHeader()
    if (baseline === undefined || !headerEquals(baseline, header)) {
      session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'change' })
    }

    return markAgentLoopRequest(deepFreeze({
      provider: header.config.provider,
      model: header.config.model,
      messages: boundaryMessages,
      ...header.system !== undefined ? { system: header.system } : {},
      ...header.tools !== undefined ? { tools: header.tools } : {},
      ...header.config.temperature !== undefined ? { temperature: header.config.temperature } : {},
      ...header.config.maxTokens !== undefined ? { maxTokens: header.config.maxTokens } : {},
      ...header.config.stop !== undefined ? { stop: header.config.stop } : {},
      sessionId: session.id,
      signal,
    }))
  }

  /** Commit the outbox and report whether it contained steering. */
  private drainOutbox(turn: number): boolean {
    let steered = false
    for (const item of this.outbox.splice(0)) {
      const { steering: message, ...data } = item
      if (message === undefined) {
        this.session.append('user/message', data, { surfaceOp: 'append' })
        continue
      }
      steered = true
      emitAgentEvent(this.loopCtx, this, 'agent/inbox/dequeue', message)
      this.session.append('steering/message', { turn, ...data }, { surfaceOp: 'append' })
    }
    return steered
  }

  /**
   * The single settlement funnel: classify one turn failure (interruption
   * beats error) into the durable turn/end reason and the live idle report.
   */
  private settle(turn: number, step: number, error: unknown, signal: AbortSignal): { reason: TurnEndReason; idle: IdleReason } {
    const interrupt = agentInterruptReasonOf(signal)
    if (interrupt !== undefined) {
      return { reason: { kind: interrupt.kind === 'disposed' ? 'disposed' : 'aborted' }, idle: { kind: 'aborted' } }
    }
    if (error instanceof LlmError) {
      emitAgentEvent(this.loopCtx, this, 'agent/error', turn, step, error)
      // The durable record renders the full cause chain: turn/end is the one
      // durable trace of the failure, so a wrapper message alone would lose
      // the transport detail the log exists to keep.
      const rendered = errorChain(error)
      return {
        reason: { kind: 'error', step, failure: { ...error.failure, ...rendered === '<unrenderable value>' ? {} : { message: rendered } } },
        idle: { kind: 'error', error, failure: error.failure },
      }
    }
    const err = toError(error)
    emitAgentEvent(this.loopCtx, this, 'agent/error', turn, step, err)
    return {
      reason: { kind: 'error', step, message: errorChain(err), ...typeof err.code === 'string' ? { code: err.code } : {} },
      idle: { kind: 'error', error: err },
    }
  }

  /** Continue with a waking prompt, or publish the idle status. */
  private continueOrIdle(): void {
    if (this.abort !== undefined) return
    if (this.queued.some(message => message.wakeup)) {
      this.kick()
    } else if (this.busy) {
      this.busy = false
      emitAgentEvent(this.loopCtx, this, 'agent/status', 'idle')
    }
  }
}
