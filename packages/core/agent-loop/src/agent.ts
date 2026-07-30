/**
 * Concrete Agent loop over two pending-input lists: queued prompts each open a
 * turn that logs its admitted input after `turn/start` commits, while steering
 * and injected context enter through the outbox at step boundaries. Every
 * request is derived from the session log.
 *
 * @module dsh-agent-loop/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import { agentCarrier, agentEvents, assembleContextFor, emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmCallConfig, Message, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import {
  BlockAssembler,
  LlmError,
  createAssistantMessage,
  deepFreeze,
  errorChain,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { AssistantMessage, Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { Context } from 'cordis'
import { executeToolCalls } from './tool-calls.ts'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'collecting'; abort: AbortController; lastTurn: number }
  | { kind: 'running'; abort: AbortController; turn: number; step: number }

type Admission =
  | { kind: 'empty' }
  | { kind: 'admitted'; claimed: UserMessage[]; messages: UserMessage[] }
  | { kind: 'blocked' }

/**
 * The concrete {@link Agent}: each `run()` owns one turn and repeats model
 * steps while tools or steering require another request.
 */
export class ReactLoopAgent implements Agent {
  /** Prompts awaiting individual turns. */
  private queued: UserMessage[] = []
  /** Input taken into the session log at step boundaries. */
  private outbox: UserMessage[] = []

  private phase: Phase
  private driverDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  /** The agent's scoped composition context ({@link Agent.ctx}). */
  readonly ctx: Context

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
  }

  /** Last activity state published to observers. */
  get status(): AgentStatus {
    return this.phase.kind === 'idle' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      emitAgentEvent(this.loopCtx, this, 'agent/status', status)
    }
  }

  /** Accept and route one unified send item. */
  private send(message: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean): void {
    this.session.append('agent/inbox/added', message)
    // Waking input cannot join an aborted admission or turn, so it starts the next turn.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const inbox = target === 'next-turn' || wakingAfterAbort ? this.queued : this.outbox
    inbox.push(message)
    if (wakeup) {
      this.scheduleKick()
    }
  }

  /** Queue one ordinary prompt turn and wake the driver. */
  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  /** Steer the open turn, falling back to a waking prompt while idle. */
  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  /** Append model-facing context without waking the driver. */
  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  /**
   * Clear all pending work and abort the active turn; the first cause wins.
   * The cause is signal payload for observers and the durable turn/end
   * classification — it selects no machine behavior. Teardown is just
   * `cancel({kind:'disposed'})` + driver join + {@link scope} dispose, all
   * owned by the factory.
   */
  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      for (const message of [...this.outbox.splice(0), ...this.queued.splice(0)]) {
        emitAgentEvent(this.loopCtx, this, 'agent/inbox/canceled', message)
      }
    }
    if (this.phase.kind !== 'idle') {
      this.phase.abort.abort(cause)
    }
  }

  /** Reserve a driver before deferring idle admission. */
  private scheduleKick(): void {
    if (this.phase.kind !== 'idle') return
    const driver = Promise.withResolvers<void>()
    this.driverDone = driver.promise
    this.setPhase({ kind: 'collecting', abort: new AbortController(), lastTurn: this.phase.lastTurn })
    queueMicrotask(() => {
      this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
    })
  }

  /** Resolve after the current driver and synchronous replacement chain exits. */
  async whenIdle(): Promise<void> {
    let driver: Promise<void>
    do {
      await (driver = this.driverDone)
    } while (driver !== this.driverDone)
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (error: unknown) {
      if (this.phase.kind !== 'idle') {
        const turn = this.phase.kind === 'collecting' ? this.phase.lastTurn : this.phase.turn
        this.setPhase({ kind: 'idle', lastTurn: turn })
        emitAgentEvent(this.loopCtx, this, 'agent/error', turn, 0, error)
      }
    } finally {
      if (this.phase.kind === 'running') {
        this.setPhase({ kind: 'idle', lastTurn: this.phase.turn })
      }
    }
  }

  /** Claim and admit the next queued prompt, then start its turn. */
  private async admit(onTurnBoundary: boolean): Promise<Admission> {
    if (this.phase.kind !== 'running') throw new Error()
    const signal = this.phase.abort.signal
    const claimed = this.outbox.slice()
    const outboxLength = this.outbox.length
    const queued = onTurnBoundary ? this.queued[0] : undefined
    if (queued !== undefined) claimed.push(queued)
    if (claimed.length === 0) return { kind: 'empty' }
    const decision = await agentEvents(this.loopCtx, this).waterfall(
      'agent/prompt-submit', claimed, signal,
      () => Promise.resolve({ kind: 'allow', messages: claimed }),
    )
    signal.throwIfAborted()
    if (decision.kind === 'allow') {
      this.outbox.splice(0, outboxLength)
      if (queued !== undefined) this.queued.shift()
      return { kind: 'admitted', claimed, messages: decision.messages }
    } else {
      this.cancel({ kind: 'hook', reason: decision.reason }, { keepInbox: decision.keepInbox })
      return { kind: 'blocked' }
    }
  }

  /**
   * Run one turn and any request-error retry. `admitted` input enters the log
   * only after `turn/start` commits; until then it has no owner state to unwind.
   */
  private async turn(): Promise<boolean> {
    if (this.phase.kind === 'idle') throw new Error()
    const abort = this.phase.kind === 'collecting' ? this.phase.abort : new AbortController()
    const lastTurn = this.phase.kind === 'collecting' ? this.phase.lastTurn : this.phase.turn
    const phase = { kind: 'running' as const, abort, turn: lastTurn, step: 0 }
    this.setPhase(phase)
    if (abort.signal.aborted) return this.outbox.length > 0 || this.queued.length > 0
    let admission: Admission
    try {
      admission = await this.admit(true)
      if (admission.kind !== 'admitted') return false
      abort.signal.throwIfAborted()
    } catch (error: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancel may abort while admission awaits
      if (abort.signal.aborted) return this.outbox.length > 0 || this.queued.length > 0
      throw error
    }
    const turn = ++phase.turn
    this.session.append('turn/start', { turn })
    let turnEnds: TurnEndReason | null = null
    try {
      while (true) {
        if (admission.kind === 'admitted') {
          for (const message of admission.claimed) {
            emitAgentEvent(this.loopCtx, this, 'agent/inbox/admitted', message)
          }
          for (const message of admission.messages) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
        }
        abort.signal.throwIfAborted()
        const step = ++phase.step
        this.session.append('step/start', { turn, step })
        try {
          turnEnds = await this.step()
        } finally {
          this.session.append('step/end', { turn, step })
        }
        abort.signal.throwIfAborted()
        if (turnEnds && this.outbox.length === 0) {
          await this.loopCtx.serial(agentCarrier(this), 'agent/turn-stopping', this, turn, abort.signal)
          abort.signal.throwIfAborted()
        }
        admission = await this.admit(false)
        if (admission.kind === 'blocked') {
          turnEnds = { kind: 'aborted', reason: abort.signal.reason as AgentCancelCause }
          return false
        }
        abort.signal.throwIfAborted()
        if (admission.kind === 'empty' && turnEnds) break
      }
    } catch (error: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancel may abort during any awaited turn operation
      if (abort.signal.aborted) turnEnds = { kind: 'aborted', reason: abort.signal.reason as AgentCancelCause }
      else turnEnds = { kind: 'error', error: errorChain(error) }
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the turn is always ended in this block
      this.session.append('turn/end', { turn, reason: turnEnds! })
    }
    return this.outbox.length > 0 || this.queued.length > 0
  }

  /**
   * Run the `agent/step` extension point, commit pending input, derive one
   * request, and execute its tool calls inside one durable step boundary.
   */
  private async step(): Promise<TurnEndReason | null> {
    if (this.phase.kind !== 'running') throw new Error()
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()
    await this.loopCtx.serial(agentCarrier(this), 'agent/step', this, turn, step, signal)
    signal.throwIfAborted()
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
    signal.throwIfAborted()
    const system = renderPrompt(assembly)

    let message: AssistantMessage
    while (true) {
      const boundaryMessages = this.session.deriveMessages()
      const { request, preparedCall } = await this.buildRequest(
        turn, step, assembly.tools, system, boundaryMessages, signal,
      )
      const assembler = new BlockAssembler()
      const chunkSeqs: number[] = []
      const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
      signal.throwIfAborted()
      for await (const chunk of stream) {
        signal.throwIfAborted()
        const chunkEvent = this.session.append('assistant/chunk', { turn, step, chunk })
        chunkSeqs.push(chunkEvent.seq)
        assembler.push(chunk)
      }
      signal.throwIfAborted()
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        const action = await this.loopCtx.waterfall(
          agentCarrier(this), 'agent/request-error', this, {
            turn,
            step,
            provider: request.provider,
            failure: finish.failure,
            retryPolicy: preparedCall?.retryPolicy,
          }, signal,
          () => Promise.resolve<RequestErrorAction>(undefined),
        )
        signal.throwIfAborted()
        if (action?.kind !== 'retry') {
          return { kind: 'error', error: finish.failure }
        }
      } else {
        message = createAssistantMessage({
          content: assembler.blocks(),
          source: {
            provider: request.provider,
            model: request.model,
            ...assembler.replayState !== undefined ? { replayState: assembler.replayState } : {},
          },
        })
        this.session.append(
          'assistant/message',
          {
            turn,
            step,
            message,
            ...assembler.usage === undefined ? {} : { usage: assembler.usage },
          },
          { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
        )
        if (finish.kind === 'max-tokens') {
          return { kind: 'max-tokens' }
        }
        break
      }
    }

    const toolCalls = message.content.filter(block => block.type === 'tool-call')
    let result: TurnEndReason | null
    if (toolCalls.length > 0) {
      const { concluded } = await executeToolCalls(
        this.loopCtx, turn, step, toolCalls, signal,
        context => this.outbox.push(context),
      )
      result = concluded ? { kind: 'completed' } : null
    } else {
      result = { kind: 'completed' }
    }
    return result
  }

  /**
   * Compose one frozen request and bind it to the adapter registration that
   * resolved its exact-model defaults.
   */
  private async buildRequest(
    turn: number,
    step: number,
    tools: GenerateOptions['tools'] & object,
    system: string,
    boundaryMessages: Message[],
    signal: AbortSignal,
  ): Promise<{ request: GenerateOptions; preparedCall?: PreparedLlmCall }> {
    // A loop instance starts from its declared route, restoring only an opaque
    // effort owned by that exact model. Later steps fold the config it logged.
    const persistedConfig = this.session.requestHeader()?.config
    const route = { provider: this.options.provider ?? '', model: this.options.model ?? '' }
    const reasoningEffort = persistedConfig?.provider === route.provider
      && persistedConfig.model === route.model
      ? persistedConfig.reasoningEffort
      : undefined
    const maxTokens = this.options.maxTokens
    const seedConfig = deepFreeze(structuredClone(
      this.requestHeaderLogged
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the instance logged the header it now folds
        ? persistedConfig!
        : {
          ...route,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
          ...maxTokens === undefined ? {} : { maxTokens },
        },
    ))
    const proposedConfig = await this.loopCtx.waterfall(
      agentCarrier(this), 'agent/request', this, turn, step, signal,
      () => Promise.resolve(seedConfig),
    )
    signal.throwIfAborted()
    if (!proposedConfig.provider || !proposedConfig.model) {
      throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`)
    }
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    try {
      preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
      config = preparedCall.config
    } catch (error: unknown) {
      // A llm/stream listener may own and short-circuit a route with no
      // adapter. Terminal dispatch still raises NO_ADAPTER when none does.
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      config = proposedConfig
    }
    signal.throwIfAborted()

    const header = canonicalHeader({
      config,
      ...system ? { system } : {},
      ...tools.length > 0 ? { tools } : {},
    })
    const baseline = this.session.requestHeader()
    if (!this.requestHeaderLogged) {
      this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      this.session.append('request/header', { header, reason: 'change' })
    }
    signal.throwIfAborted()

    const request = markAgentLoopRequest(deepFreeze({
      ...header.config,
      messages: boundaryMessages,
      ...header.system !== undefined ? { system: header.system } : {},
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.session.id,
      signal,
    }))
    return { request, ...preparedCall === undefined ? {} : { preparedCall } }
  }
}
