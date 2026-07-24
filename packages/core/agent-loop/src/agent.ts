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
  AgentMessage,
  CancelOptions,
  AgentInterruptReason,
  AgentOptions,
  AgentStatus,
  IdleReason,
  PromptDecision,
  RequestError,
  SendOptions,
} from '@deepseek-ai/dsh-agent'
import {
  BlockAssembler, LlmError, deepFreeze, errorChain, isHarnessError, llmFailureOf, markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, GenerateOptions, LlmCallConfig, LlmFailure, Message,
} from '@deepseek-ai/dsh-llm'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import type { Session, SessionId, TurnEndReason, TurnTrigger, UserMessageData } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { executeToolCalls } from './tool-calls.ts'


/** A final-adapter or terminal in-band failure eligible for request recovery. */
class ModelRequestFailure extends Error {
  constructor(
    readonly requestError: RequestError,
    readonly failure: LlmFailure,
  ) {
    super(requestError.message, { cause: requestError })
  }
}

/**
 * The concrete {@link Agent}: each `run()` owns one turn and repeats model
 * steps while tools or steering require another request.
 */
export class ReactLoopAgent extends Agent {
  /** Prompts awaiting individual turns. */
  private queued: { message: AgentMessage; wakeup: boolean }[] = []
  /** Input taken into the session log at step boundaries. */
  private outbox: (UserMessageData | AgentMessage)[] = []

  /** Whether observers see a running interval; consecutive turns share it. */
  private busy = false
  /** Abort owner for the current admission or turn. */
  private abort: AbortController | undefined
  /** Coalesced retry capability scoped to the active request-error waterfall. */
  private retryWindow: { requested: boolean } | undefined
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
    options: SendOptions,
  ): AgentMessageId {
    const { target, wakeup, source } = options
    const id = AgentMessageId(randomUUID())
    if (target === 'next-step' && !wakeup) {
      if (this.turnOpen) {
        this.outbox.push({ content, source })
        return id
      }
      this.session.append('user/message', { content, source }, { surfaceOp: 'append' })
      return id
    }

    const steering = target === 'next-step' && this.turnOpen
    const message: AgentMessage = {
      id,
      content,
      source,
    }
    if (steering) {
      this.outbox.push(message)
    } else {
      this.queued.push({ message, wakeup })
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
      const discarded = this.queued.map(item => item.message)
      for (const message of this.outbox) {
        if ('id' in message) discarded.push(message)
      }
      // Clear before abort observers run: replacement work belongs to the next turn.
      this.queued.length = 0
      this.outbox.length = 0
      if (discarded.length > 0) emitAgentEvent(this.loopCtx, this, 'agent/inbox/discard', discarded)
    }
    if (this.retryWindow !== undefined) this.retryWindow.requested = false
    const reason = Object.freeze({ kind: cause.kind })
    this.abort?.abort(reason)
  }

  /**
   * Re-open a turn on the current session log without a new prompt — the
   * recovery verb. A request-error listener schedules the retry that follows
   * its failed turn; an idle caller starts one immediately.
   */
  retry(): void {
    if (this.abort !== undefined) {
      if (this.retryWindow === undefined) throw new Error(`agent "${this.id}" cannot retry while busy`)
      if (!this.abort.signal.aborted) this.retryWindow.requested = true
      return
    }
    this.done = this.loopCtx.agents.withInitiator(this, () => this.run({ kind: 'retry' }))
  }

  /** Resolve at idle quiescence: no run driving and no waking prompt waiting. */
  async whenIdle(): Promise<void> {
    // `done` is replaced per activity, so re-reading it follows chained turns;
    // a run failure still counts as quiescence for the waiter.
    while (this.abort !== undefined || this.queued.some(item => item.wakeup)) {
      await this.done.catch(() => undefined)
    }
  }

  /** Claim and admit the next queued prompt, then start its turn. */
  private kick(): void {
    if (this.abort !== undefined || !this.queued.some(item => item.wakeup)) return
    const item = this.queued.shift()
    if (item === undefined) return
    const { message } = item

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
          this.loopCtx.logger.warn(`agent "${this.id}": prompt admission failed: ${errorChain(error)}`)
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

  /** Run one turn and any request-error retry over input already admitted by {@link kick}. */
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
    let retry = false
    const cancelRetry = (): void => { retry = false }
    signal.addEventListener('abort', cancelRetry, { once: true })

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
        if (continueTurn || this.outbox.some(item => 'id' in item)) continue
        await this.loopCtx.serial(agentCarrier(this), 'agent/stopping', this, turn, signal)
        signal.throwIfAborted()
        if (!this.drainOutbox(turn)) break
      }
    } catch (caught: unknown) {
      const requestFailure = caught instanceof ModelRequestFailure ? caught : undefined
      const error = requestFailure?.requestError ?? caught
      if (this.stepOpen) {
        this.stepOpen = false
        this.session.append('step/end', { turn, step })
      }
      if (requestFailure !== undefined && agentInterruptReasonOf(signal) === undefined) {
        const retryWindow = { requested: false }
        this.retryWindow = retryWindow
        let recoveryCompleted = false
        try {
          await this.loopCtx.waterfall(
            agentCarrier(this), 'agent/request-error', this, turn, step, requestFailure.requestError,
            requestFailure.failure, signal,
            () => Promise.resolve(),
          )
          recoveryCompleted = true
        } catch (recoveryError: unknown) {
          this.loopCtx.logger.warn(
            `agent "${this.id}": request recovery failed at turn ${turn}, step ${step}: ${errorChain(recoveryError)}`,
          )
        } finally {
          if (this.retryWindow === retryWindow) this.retryWindow = undefined
        }
        retry = recoveryCompleted
          && agentInterruptReasonOf(signal) === undefined
          && retryWindow.requested
      }
      ({ reason, idle } = this.settle(turn, step, error, signal, requestFailure?.failure))
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
        retry = false
        this.loopCtx.logger.warn(`agent "${this.id}": closing turn ${turn} failed: ${errorChain(error)}`)
        emitAgentEvent(this.loopCtx, this, 'agent/error', turn, step, error)
      }
      this.retryWindow = undefined
      if (this.abort === controller) this.abort = undefined
      signal.removeEventListener('abort', cancelRetry)
    }

    if (retry) {
      await this.run({ kind: 'retry' })
    } else {
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
      const facts = llmFailureOf(stream, error)
      if (facts !== undefined && error instanceof Error) {
        throw new ModelRequestFailure(error, facts)
      }
      throw error
    }
    signal.throwIfAborted()

    // Failure finish chunks take the same path as thrown stream errors.
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      const error = new LlmError(finish.failure.message, finish.failure.code, finish.failure)
      throw new ModelRequestFailure(error, finish.failure)
    }

    // Truncated (max-tokens) output cannot owe tool calls.
    const assembled = assembler.message()
    const content = finish.kind === 'max-tokens'
      ? assembled.content.filter(block => block.type !== 'tool-call')
      : assembled.content

    session.append(
      'assistant/message',
      {
        turn,
        step,
        content,
        provenance: {
          provider: request.provider,
          model: request.model,
          ...assembler.replayState !== undefined ? { replayState: assembler.replayState } : {},
        },
        ...assembler.usage === undefined ? {} : { usage: assembler.usage },
      },
      { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
    )

    const toolCalls = content.filter(block => block.type === 'tool-call')
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
    for (const message of this.outbox.splice(0)) {
      if ('id' in message) {
        steered = true
        emitAgentEvent(this.loopCtx, this, 'agent/inbox/dequeue', message)
        this.session.append(
          'steering/message',
          { turn, content: message.content, source: message.source },
          { surfaceOp: 'append' },
        )
      } else {
        this.session.append('user/message', message, { surfaceOp: 'append' })
      }
    }
    return steered
  }

  /**
   * The single settlement funnel: classify one turn failure (interruption
   * beats error) into the durable turn/end reason and the live idle report.
   */
  private settle(
    turn: number,
    step: number,
    error: unknown,
    signal: AbortSignal,
    failure?: LlmFailure,
  ): { reason: TurnEndReason; idle: IdleReason } {
    const interrupt = agentInterruptReasonOf(signal)
    if (interrupt !== undefined) {
      return { reason: { kind: interrupt.kind === 'disposed' ? 'disposed' : 'aborted' }, idle: { kind: 'aborted' } }
    }
    if (failure !== undefined) {
      emitAgentEvent(this.loopCtx, this, 'agent/error', turn, step, error)
      // The durable record renders the full cause chain: turn/end is the one
      // durable trace of the failure, so a wrapper message alone would lose
      // the transport detail the log exists to keep.
      const rendered = errorChain(error)
      return {
        reason: { kind: 'error', step, failure: { ...failure, ...rendered === '<unrenderable value>' ? {} : { message: rendered } } },
        idle: { kind: 'error', error, failure },
      }
    }
    emitAgentEvent(this.loopCtx, this, 'agent/error', turn, step, error)
    return {
      reason: { kind: 'error', step, message: errorChain(error), ...isHarnessError(error) ? { code: error.code } : {} },
      idle: { kind: 'error', error },
    }
  }

  /** Continue with a waking prompt, or publish the idle status. */
  private continueOrIdle(): void {
    if (this.abort !== undefined) return
    if (this.queued.some(item => item.wakeup)) {
      this.kick()
    } else if (this.busy) {
      this.busy = false
      emitAgentEvent(this.loopCtx, this, 'agent/status', 'idle')
    }
  }
}
