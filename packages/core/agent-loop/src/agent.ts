/**
 * Concrete Agent loop over two pending-input lists: queued prompts each open a
 * turn that logs its admitted input after `turn/start` commits, while steering
 * and injected context enter through the outbox at step boundaries. Every
 * request is derived from the session log.
 *
 * @module dsh-agent-loop/agent
 */

import type { Context } from 'cordis'
import { agentCarrier, assembleContextFor, emitAgentEvent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type {
  Agent,
  CancelOptions,
  AgentInterruptReason,
  InboxPlacement,
  AgentOptions,
  AgentStatus,
  SettleReason,
  PromptDecision,
  RequestError,
  RequestErrorAction,
  SendOptions,
} from '@deepseek-ai/dsh-agent'
import {
  BlockAssembler,
  LlmError,
  assertNever,
  createAssistantMessage,
  deepFreeze,
  errorChain,
  freezeMessage,
  isHarnessError,
  llmFailureOf,
  llmRetryPolicyOf,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallConfig, LlmFailure, Message, PreparedLlmCall, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import type { AssistantMessage, Session, SessionId, TurnEndReason, TurnTrigger, UserMessage } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { executeToolCalls } from './tool-calls.ts'

/** One completed step or a final-adapter failure eligible for recovery. */
type StepOutcome =
  | { kind: 'completed'; continueTurn: boolean; concluded: boolean; maxTokens: boolean }
  | { kind: 'request-failed'; error: RequestError; failure: LlmFailure; retryPolicy: ResolvedRetryPolicy | undefined }

/**
 * The concrete {@link Agent}: each `run()` owns one turn and repeats model
 * steps while tools or steering require another request.
 */
export class ReactLoopAgent implements Agent {
  /** Prompts awaiting individual turns. */
  private queued: { message: UserMessage; wakeup: boolean }[] = []
  /** Input taken into the session log at step boundaries. */
  private outbox: { message: UserMessage; steering: boolean }[] = []

  /** Whether observers see a running interval; consecutive turns share it. */
  private busy = false
  /** Whether an idle waking send has deferred driver admission. */
  private wakeScheduled = false
  /** Whether next-step input belongs to the current admission or open turn. */
  acceptsNextStep = false
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
  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
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
    message: UserMessage,
    options: SendOptions,
  ): void {
    const { target, wakeup } = options
    if (target === 'next-step' && !wakeup) {
      if (this.acceptsNextStep) {
        this.outbox.push({ message, steering: false })
        return
      }
      this.session.append('user/message', message, { surfaceOp: 'append' })
      return
    }

    const placement: InboxPlacement = target === 'next-step' && this.acceptsNextStep ? 'steering' : 'queued'
    if (placement === 'steering') {
      this.outbox.push({ message, steering: true })
    } else {
      this.queued.push({ message, wakeup })
    }
    // Preserve the routing decision for every send in this synchronous caller
    // stack, while installing quiescence ownership before enqueue observers
    // can cancel or dispose.
    if (placement === 'queued' && wakeup) this.scheduleKick()
    emitAgentEvent(this.loopCtx, this, 'agent/inbox/enqueue', message, placement)
  }

  /** Queue one ordinary prompt turn and wake the driver. */
  followup(input: UserMessage): void {
    this.send(input, {
      target: 'next-turn',
      wakeup: true,
    })
  }

  /** Steer the open turn, falling back to a waking prompt while idle. */
  steer(input: UserMessage): void {
    this.send(input, {
      target: 'next-step',
      wakeup: true,
    })
  }

  /** Append model-facing context without waking the driver. */
  inject(input: UserMessage): void {
    this.send(input, {
      target: 'next-step',
      wakeup: false,
    })
  }

  /**
   * Clear all pending work and abort the active turn; the first cause wins.
   * The cause is signal payload for observers and the durable turn/end
   * classification — it selects no machine behavior. Teardown is just
   * `cancel({kind:'disposed'})` + await {@link done} + {@link scope} dispose,
   * all owned by the factory.
   */
  cancel(cause: AgentInterruptReason, options: CancelOptions = {}): void {
    // Effective only when it aborts the active turn or actually discards
    // pending work: a keepInbox call with no active turn is a documented
    // no-op, so it must not emit cancel-requested for consumers to misread.
    const discards = !options.keepInbox && (this.queued.length > 0 || this.outbox.length > 0)
    if (this.abort !== undefined || discards) {
      // Observe-only: coordination consumers update their state before the
      // inboxes clear; listener failures are contained by the dispatcher.
      if (cause.kind !== 'disposed') emitAgentEvent(this.loopCtx, this, 'agent/cancel-requested', cause)
    }
    if (!options.keepInbox) {
      const discarded = this.queued.map(item => item.message)
      for (const item of this.outbox) {
        if (item.steering) discarded.push(item.message)
      }
      // Clear before abort observers run: replacement work belongs to the next turn.
      this.queued.length = 0
      this.outbox.length = 0
      if (discarded.length > 0) emitAgentEvent(this.loopCtx, this, 'agent/inbox/discard', discarded)
    }
    const reason = Object.freeze({ kind: cause.kind })
    this.abort?.abort(reason)
  }

  /** Resolve at idle quiescence: no run driving and no waking prompt waiting. */
  async whenIdle(): Promise<void> {
    // `done` is replaced per activity, so re-reading it follows chained turns.
    // Every driver failure today is contained before it can reject `done`,
    // but the waiter must not gamble quiescence on that: a future escape
    // still counts as settled activity.
    /* v8 ignore next 3 -- the catch arm backstops rejection paths that are all currently contained */
    while (this.busy || this.wakeScheduled || this.abort !== undefined || this.queued.some(item => item.wakeup)) {
      await this.done.catch(() => undefined)
    }
  }

  /** Defer idle admission while keeping {@link done} as its quiescence owner. */
  private scheduleKick(): void {
    if (this.abort !== undefined || this.wakeScheduled) return
    this.wakeScheduled = true
    const pending = Promise.withResolvers<void>()
    const scheduled = pending.promise
    queueMicrotask(() => {
      this.wakeScheduled = false
      this.kick()
      const activity = this.done
      if (activity === scheduled) {
        pending.resolve()
      } else {
        void activity.then(
          () => { pending.resolve() },
          () => { pending.resolve() },
        )
      }
    })
    this.done = scheduled
  }

  /** Claim and admit the next queued prompt, then start its turn. */
  private kick(): void {
    if (this.abort !== undefined || !this.queued.some(item => item.wakeup)) return
    // The some() guard above proves the queue is non-empty; the non-null
    // assertion expresses that invariant.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const { message } = this.queued.shift()!
    const inheritedOutboxLength = this.outbox.length

    const admission = new AbortController()
    this.abort = admission
    this.acceptsNextStep = true
    // Claimed admission is part of the running interval: it is cancellable
    // activity, so observers (and their cancel routing) must see it.
    if (!this.busy) {
      this.busy = true
      emitAgentEvent(this.loopCtx, this, 'agent/status', 'running')
    }
    // The admission body runs synchronously up to the prompt-submit
    // waterfall's first await, so the waterfall snapshots its listeners
    // before a disposal initiated by the running-status emit above can
    // unregister a vetoing plugin.
    this.done = this.loopCtx.agents.withInitiator(this, async () => {
      const signal = admission.signal
      const trigger: TurnTrigger = { kind: 'message', source: message.source }
      // Admitted input stays on the stack until its turn/start commits: the
      // turn owns it only once the turn exists in the log.
      let admitted: UserMessage[] | undefined
      try {
        signal.throwIfAborted()
        const decision = await this.loopCtx.waterfall(
          agentCarrier(this), 'agent/prompt-submit', this, message, signal,
          () => Promise.resolve<PromptDecision>({ kind: 'allow' }),
        )
        signal.throwIfAborted()

        if (decision.kind === 'allow') {
          admitted = [decision.content === undefined
            ? message
            : freezeMessage({ ...message, content: decision.content })]
          for (const context of decision.additionalContexts ?? []) {
            admitted.push(freezeMessage(context))
          }
        }
      } catch (error: unknown) {
        if (!signal.aborted) {
          this.loopCtx.logger.warn(`agent "${this.id}": prompt admission failed: ${errorChain(error)}`)
        }
      }

      // cancel() aborts but never clears the slot, and kick()/run()
      // all refuse to install a new owner while one exists, so the admission
      // still owns the slot here and releasing it unconditionally is exact.
      this.abort = undefined
      if (admitted === undefined) {
        this.acceptsNextStep = false
        try {
          this.flushRejectedAdmissionContexts()
        } catch (error: unknown) {
          // No turn exists for agent/error coordinates. Preserve the
          // uncommitted suffix for a later boundary and report locally.
          this.loopCtx.logger.warn(
            `agent "${this.id}": committing rejected-admission context failed: ${errorChain(error)}`,
          )
        }
        // A synchronously aborted admission would otherwise publish idle
        // inside send()'s own synchronous extent, before any post-send
        // subscriber could observe the transition.
        await Promise.resolve()
        this.continueOrIdle()
        return
      }
      await this.run(trigger, admitted, inheritedOutboxLength)
    })
    // Published only after the abort owner and pending done are installed: a
    // dequeue listener that cancels or disposes must find live cancellation
    // and quiescence ownership, not the previous activity's settled state.
    emitAgentEvent(this.loopCtx, this, 'agent/inbox/dequeue', message, 'queued')
  }

  /**
   * Run one turn and any request-error retry. `admitted` input enters the log
   * only after `turn/start` commits; until then it has no owner state to unwind.
   */
  private async run(
    trigger: TurnTrigger,
    admitted: UserMessage[] = [],
    inheritedOutboxLength = 0,
    priorFailures: readonly LlmFailure[] = Object.freeze([]),
  ): Promise<void> {
    // Both entries hold the invariant: kick() clears the admission slot before
    // awaiting run(), and a retry is entered only after the prior run clears it.
    /* v8 ignore next -- unreachable guard: every caller clears or checks the abort slot first */
    if (this.abort !== undefined) throw new Error(`agent "${this.id}" is already running`)
    const controller = new AbortController()
    this.abort = controller
    this.acceptsNextStep = true
    const signal = controller.signal
    const turn = this.lastTurn + 1
    let step = 0
    let opened = false
    let reason: TurnEndReason = { kind: 'completed' }
    let settleReason: SettleReason = { kind: 'completed' }
    let requestFailureHistory = priorFailures
    let retryFailures: readonly LlmFailure[] | undefined
    const cancelRetry = (): void => { retryFailures = undefined }
    signal.addEventListener('abort', cancelRetry, { once: true })

    try {
      signal.throwIfAborted()
      this.session.append('turn/start', { turn, trigger })
      // Committed: publish the turn to the machine's own bookkeeping and let
      // the admitted input enter the log it now belongs to.
      this.turnOpen = true
      opened = true
      this.lastTurn = turn
      // Context or steering retained by an earlier rejected admission happened
      // before this prompt and must occupy the same order in durable history.
      this.drainOutbox(turn, inheritedOutboxLength)
      for (const input of admitted) {
        this.session.append('user/message', input, { surfaceOp: 'append' })
      }
      signal.throwIfAborted()

      this.drainOutbox(turn)

      steps: while (true) {
        step += 1
        const outcome = await this.step(turn, step, signal)
        switch (outcome.kind) {
          case 'completed':
            requestFailureHistory = Object.freeze([])
            if (outcome.maxTokens) reason = { kind: 'max-tokens' }
            // A concluding tool result is terminal: steering already in the
            // log waits for the next turn's request instead of reopening this
            // one, and the agent/turn-stopping drain below is skipped for the same
            // reason.
            if (outcome.concluded) break steps
            if (outcome.continueTurn || this.outbox.some(item => item.steering)) continue
            break
          case 'request-failed': {
            // step() reports request failures only after step/start commits
            // and before its own step/end, so the step is always open here.
            this.stepOpen = false
            this.session.append('step/end', { turn, step })
            if (!signal.aborted) {
              try {
                const action = await this.loopCtx.waterfall(
                  agentCarrier(this), 'agent/request-error', this, turn, step, outcome.error,
                  outcome.failure, requestFailureHistory, outcome.retryPolicy, signal,
                  () => Promise.resolve<RequestErrorAction>(undefined),
                )
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- signal can abort while recovery is awaited.
                if (action?.kind === 'retry' && !signal.aborted) {
                  retryFailures = Object.freeze([...requestFailureHistory, outcome.failure])
                }
              } catch (recoveryError: unknown) {
                this.loopCtx.logger.warn(
                  `agent "${this.id}": request recovery failed at turn ${turn}, step ${step}: ${errorChain(recoveryError)}`,
                )
              }
            }
            const settlement = this.settle(turn, step, outcome.error, signal, outcome.failure)
            reason = settlement.reason
            settleReason = settlement.settleReason
            break steps
          }
          /* v8 ignore next 2 -- closed-union exhaustiveness guard */
          default:
            assertNever(outcome)
        }
        await this.loopCtx.serial(agentCarrier(this), 'agent/turn-stopping', this, turn, signal)
        signal.throwIfAborted()
        if (!this.drainOutbox(turn)) break
      }
    } catch (caught: unknown) {
      try {
        if (this.stepOpen) {
          this.stepOpen = false
          this.session.append('step/end', { turn, step })
        }
      } catch (closeError: unknown) {
        // Contained like the finally's turn close: a persistently rejecting
        // step boundary must not escape run(), or the post-finally tail would
        // never publish the terminal status and observers would see a
        // permanently running agent whose whenIdle() already resolved.
        this.loopCtx.logger.warn(`agent "${this.id}": closing step ${turn}/${step} failed: ${errorChain(closeError)}`)
        emitAgentEvent(this.loopCtx, this, 'agent/error', turn, step, closeError)
      }
      ({ reason, settleReason } = this.settle(turn, step, caught, signal))
    } finally {
      // Every step-close happens before this point on both success and
      // failure paths (step(), the request-failed branch, the catch), so the
      // finally owes only the turn boundary.
      this.acceptsNextStep = false
      try {
        if (this.turnOpen) {
          // Re-entrant turn/end listeners must route new input to a later turn.
          this.turnOpen = false
          this.session.append('turn/end', { turn, reason })
        }
      } catch (error: unknown) {
        retryFailures = undefined
        this.loopCtx.logger.warn(`agent "${this.id}": closing turn ${turn} failed: ${errorChain(error)}`)
        emitAgentEvent(this.loopCtx, this, 'agent/error', turn, step, error)
      }
      // cancel() aborts but never clears the slot, and no second run can
      // install a controller while this one is still unwinding, so the slot
      // is still this run's controller here.
      this.abort = undefined
      signal.removeEventListener('abort', cancelRetry)
    }

    if (opened) {
      try {
        await this.loopCtx.sessions.flush(this.session)
      } catch (error: unknown) {
        this.loopCtx.logger.warn(`agent "${this.id}": session/flush failed at turn ${turn}: ${errorChain(error)}`)
        emitAgentEvent(this.loopCtx, this, 'agent/error', turn, step, error)
      }
    }

    if (retryFailures !== undefined) {
      await this.run({ kind: 'retry' }, [], 0, retryFailures)
    } else {
      // agent/settled names only committed turns: a run aborted or rejected
      // before turn/start has no durable turn/end for consumers to settle
      // against, so it exits without the notification.
      if (opened) emitAgentEvent(this.loopCtx, this, 'agent/settled', turn, settleReason)
      this.continueOrIdle()
    }
  }

  /**
   * Run the `agent/step` extension point, commit pending input, derive one
   * request, and execute its tool calls inside one durable step boundary.
   */
  private async step(
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<StepOutcome> {
    const { session } = this

    // The single between-steps extension point: listeners inject, steer, or
    // edit the log here; the request derives from the log after this settles.
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

    const { request, preparedCall } = await this.buildRequest(
      turn, step, assembly.tools, system, boundaryMessages, signal,
    )

    const assembler = new BlockAssembler()
    const chunkSeqs: number[] = []
    const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
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
        return { kind: 'request-failed', error, failure: facts, retryPolicy: llmRetryPolicyOf(stream) }
      }
      throw error
    }
    signal.throwIfAborted()

    // Failure finish chunks take the same path as thrown stream errors.
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      const error = new LlmError(finish.failure.message, finish.failure.code, finish.failure)
      return { kind: 'request-failed', error, failure: finish.failure, retryPolicy: llmRetryPolicyOf(stream) }
    }

    // Truncated (max-tokens) output cannot owe tool calls.
    const assembled = assembler.blocks()
    const content = finish.kind === 'max-tokens'
      ? assembled.filter(block => block.type !== 'tool-call')
      : assembled
    const message: AssistantMessage = createAssistantMessage({
      content,
      source: {
        provider: request.provider,
        model: request.model,
        ...assembler.replayState !== undefined ? { replayState: assembler.replayState } : {},
      },
    })

    session.append(
      'assistant/message',
      {
        turn,
        step,
        message,
        ...assembler.usage === undefined ? {} : { usage: assembler.usage },
      },
      { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
    )

    const toolCalls = content.filter(block => block.type === 'tool-call')
    let concluded = false
    if (toolCalls.length > 0) {
      ({ concluded } = await executeToolCalls(
        this.loopCtx, turn, step, toolCalls, signal,
        context => this.outbox.push({ message: freezeMessage(context), steering: false }),
      ))
    }

    // Tool results stay adjacent to their calls; input accepted during the
    // request enters the log only after the complete result batch.
    const steered = this.drainOutbox(turn)
    session.append('step/end', { turn, step })
    this.stepOpen = false
    return {
      kind: 'completed',
      continueTurn: (toolCalls.length > 0 && !concluded) || steered,
      concluded,
      maxTokens: finish.kind === 'max-tokens',
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
    const { session } = this

    // A loop instance starts from its declared route, restoring only an opaque
    // effort owned by that exact model. Later steps fold the config it logged.
    const persistedConfig = session.requestHeader()?.config
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
    const baseline = session.requestHeader()
    if (!this.requestHeaderLogged) {
      session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      session.append('request/header', { header, reason: 'change' })
    }

    const request = markAgentLoopRequest(deepFreeze({
      ...header.config,
      messages: boundaryMessages,
      ...header.system !== undefined ? { system: header.system } : {},
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: session.id,
      signal,
    }))
    return { request, ...preparedCall === undefined ? {} : { preparedCall } }
  }

  /** Commit the outbox and report whether it contained steering. */
  private drainOutbox(turn: number, limit = this.outbox.length): boolean {
    let steered = false
    for (const item of this.outbox.splice(0, limit)) {
      if (item.steering) {
        steered = true
        emitAgentEvent(this.loopCtx, this, 'agent/inbox/dequeue', item.message, 'steering')
        this.session.append(
          'steering/message',
          { turn, message: item.message },
          { surfaceOp: 'append' },
        )
      } else {
        this.session.append('user/message', item.message, { surfaceOp: 'append' })
      }
    }
    return steered
  }

  /**
   * Give context-only input its ordinary idle placement when admission
   * produces no turn. Steering keeps the whole boundary staged so context
   * accepted beside it cannot split from the request it accompanies.
   */
  private flushRejectedAdmissionContexts(): void {
    if (this.outbox.some(item => item.steering)) return
    const contexts = this.outbox.splice(0)
    for (let index = 0; index < contexts.length; index += 1) {
      const item = contexts[index]
      /* v8 ignore next 2 -- the steering precheck proves this batch is context-only */
      if (item === undefined || item.steering) throw new Error('rejected-admission context batch changed')
      try {
        this.session.append('user/message', item.message, { surfaceOp: 'append' })
      } catch (error: unknown) {
        this.outbox.unshift(...contexts.slice(index))
        throw error
      }
    }
  }

  /**
   * The single settlement funnel: classify one turn failure (interruption
   * beats error) into the durable turn/end reason and live settlement report.
   */
  private settle(
    turn: number,
    step: number,
    error: unknown,
    signal: AbortSignal,
    failure?: LlmFailure,
  ): { reason: TurnEndReason; settleReason: SettleReason } {
    if (signal.aborted) {
      // Slot invariant, stated rather than re-validated: the turn controller
      // is machine-private and cancel() is its only aborter, always with one
      // frozen canonical cause as the reason.
      const interrupt = signal.reason as AgentInterruptReason
      return {
        reason: { kind: interrupt.kind === 'disposed' ? 'disposed' : 'aborted' },
        settleReason: { kind: 'aborted' },
      }
    }
    if (failure !== undefined) {
      emitAgentEvent(this.loopCtx, this, 'agent/error', turn, step, error)
      // The durable record renders the full cause chain: turn/end is the one
      // durable trace of the failure, so a wrapper message alone would lose
      // the transport detail the log exists to keep.
      const rendered = errorChain(error)
      return {
        reason: { kind: 'error', step, failure: { ...failure, ...rendered === '<unrenderable value>' ? {} : { message: rendered } } },
        settleReason: { kind: 'error', error, failure },
      }
    }
    emitAgentEvent(this.loopCtx, this, 'agent/error', turn, step, error)
    return {
      reason: { kind: 'error', step, message: errorChain(error), ...isHarnessError(error) ? { code: error.code } : {} },
      settleReason: { kind: 'error', error },
    }
  }

  /** Continue with a waking prompt, or publish the idle status. */
  private continueOrIdle(): void {
    if (this.queued.some(item => item.wakeup)) {
      this.kick()
    } else {
      // Every caller sits inside an admission or run whose install marked the
      // interval busy, so the flag is still set here.
      this.busy = false
      emitAgentEvent(this.loopCtx, this, 'agent/status', 'idle')
    }
  }
}
