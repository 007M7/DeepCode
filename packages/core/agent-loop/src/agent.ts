/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-agent-loop/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import { Inbox, agentCarrier, agentEvents, assembleContextFor, emitAgentEvent } from '@deepseek-ai/dsh-agent'
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
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
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
  | { kind: 'admitted'; messages: UserMessage[] }
  | { kind: 'blocked' }

/** Drives one session through turn and step boundaries. */
export class ReactLoopAgent implements Agent {
  readonly inbox: Inbox
  private phase: Phase
  private driverDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    this.inbox = new Inbox(session)
    const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
  }

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

  private send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted admission or turn, so it starts the next turn.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.scheduleKick()
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.splice('next-step', 0, this.inbox.nextStep.length, [], 'canceled')
      this.inbox.splice('next-turn', 0, this.inbox.nextTurn.length, [], 'canceled')
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
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

  private async admit(onTurnBoundary: boolean): Promise<Admission> {
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": admit outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = [...this.inbox.nextStep]
    const outboxLength = claimed.length
    const queued = onTurnBoundary ? this.inbox.nextTurn[0] : undefined
    if (queued !== undefined) claimed.push(queued)
    if (claimed.length === 0) return { kind: 'empty' }
    const decision = await agentEvents(this.loopCtx, this).waterfall(
      'agent/prompt-submit', claimed, signal,
      () => Promise.resolve({ kind: 'allow', messages: claimed }),
    )
    signal.throwIfAborted()
    if (decision.kind === 'allow') {
      this.inbox.splice('next-step', 0, outboxLength, [], 'admitted')
      if (queued !== undefined) this.inbox.splice('next-turn', 0, 1, [], 'admitted')
      return { kind: 'admitted', messages: decision.messages }
    }
    this.cancel({ kind: 'hook', reason: decision.reason }, { keepInbox: decision.keepInbox })
    return { kind: 'blocked' }
  }

  /** Admitted input stays unowned until `turn/start` commits. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind === 'idle') throw new Error(`agent "${this.id}": turn without driver reservation`)
    const abort = this.phase.kind === 'collecting' ? this.phase.abort : new AbortController()
    const { signal } = abort
    const lastTurn = this.phase.kind === 'collecting' ? this.phase.lastTurn : this.phase.turn
    const phase = { kind: 'running' as const, abort, turn: lastTurn, step: 0 }
    this.setPhase(phase)
    if (signal.aborted) return this.inbox.hasPending
    let admission: Admission
    try {
      admission = await this.admit(true)
      if (admission.kind !== 'admitted') return false
      signal.throwIfAborted()
    } catch (error: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancel may abort while admission awaits
      if (signal.aborted) return this.inbox.hasPending
      throw error
    }
    const turn = ++phase.turn
    this.session.append('turn/start', { turn })
    let turnEnds: TurnEndReason | null = null
    try {
      while (true) {
        if (admission.kind === 'admitted') {
          for (const message of admission.messages) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
        }
        signal.throwIfAborted()
        const step = ++phase.step
        this.session.append('step/start', { turn, step })
        try {
          turnEnds = await this.step()
        } finally {
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.loopCtx.serial(agentCarrier(this), 'agent/turn-stopping', this, turn, signal)
          signal.throwIfAborted()
        }
        admission = await this.admit(false)
        if (admission.kind === 'blocked') {
          turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
          return false
        }
        signal.throwIfAborted()
        if (admission.kind === 'empty' && turnEnds) break
      }
    } catch (error: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancel may abort during any awaited turn operation
      if (signal.aborted) turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
      else turnEnds = { kind: 'error', error: errorChain(error) }
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the turn is always ended in this block
      this.session.append('turn/end', { turn, reason: turnEnds! })
    }
    return this.inbox.hasPending
  }

  private async step(): Promise<TurnEndReason | null> {
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()
    await this.loopCtx.serial(agentCarrier(this), 'agent/step', this, turn, step, signal)
    signal.throwIfAborted()
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
    signal.throwIfAborted()
    const system = renderPrompt(assembly)

    while (true) {
      const { request, preparedCall } = await this.buildRequest(
        turn, step, assembly.tools, system, this.session.deriveMessages(), signal,
      )
      const assembler = new BlockAssembler()
      const chunkSeqs: number[] = []
      const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
      signal.throwIfAborted()
      for await (const chunk of stream) {
        signal.throwIfAborted()
        chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
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
        if (action?.kind !== 'retry') return { kind: 'error', error: finish.failure }
        continue
      }

      const message = createAssistantMessage({
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
      if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }

      const toolCalls = message.content.filter(block => block.type === 'tool-call')
      if (toolCalls.length === 0) return { kind: 'completed' }
      const { concluded } = await executeToolCalls(
        this.loopCtx, turn, step, toolCalls, signal,
        context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
      )
      return concluded ? { kind: 'completed' } : null
    }
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
    const persistedConfig = this.session.requestHeader()?.config
    const route = { provider: this.options.provider ?? '', model: this.options.model ?? '' }
    const reasoningEffort = persistedConfig?.provider === route.provider
      && persistedConfig.model === route.model
      ? persistedConfig.reasoningEffort
      : undefined
    const maxTokens = this.options.maxTokens
    const seedConfig = this.requestHeaderLogged
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the instance logged the frozen header it now folds
      ? persistedConfig!
      : deepFreeze({
        ...route,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
        ...maxTokens === undefined ? {} : { maxTokens },
      })
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
      // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
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
