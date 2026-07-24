/**
 * The concrete Agent, in the naive-agent shape: the agent IS the machine.
 * Two inboxes — `queued` (prompts, one turn each) and `outbox` (steering +
 * injected context, taken whole at every step boundary) — and one `run()`
 * per turn: intake the prompt, then step until the model owes no response.
 *
 * The session log IS the transcript: every take appends, every step re-derives
 * (`session.deriveMessages()`), so editing history between steps is naturally
 * legal — recovery is "observe the error idle, repair the log, retry()".
 * Because the outbox is only ever taken at a step boundary, nothing can land
 * between an assistant tool-call batch and its results; wire adjacency needs
 * no dedicated machinery.
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
  AgentMessageId as AgentMessageIdType,
  CancelOptions,
  AgentInterruptReason,
  AgentOptions,
  AgentStatus,
  HookContext,
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
import { canonicalHeader, headerEquals, snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { JsonValue, PromptMessageData, Session, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { executeToolCalls } from './tool-calls.ts'

/** A prompt waiting for a turn of its own. */
interface QueuedMessage {
  id: AgentMessageIdType
  content: ContentBlock[]
  source: MessageSource
  contexts: HookContext[]
  wakeup: boolean
  meta?: JsonValue
}

/** Input awaiting the next step boundary. */
type OutboxItem =
  | ({ kind: 'steering' } & QueuedMessage)
  | { kind: 'context'; context: HookContext }

/** Build one live inbox event payload from an accepted message. */
function inboxMessage(message: QueuedMessage, steering: boolean): AgentMessage {
  return {
    id: message.id,
    content: message.content,
    source: message.source,
    contexts: message.contexts,
    steering,
    wakeup: message.wakeup,
  }
}

const PROMPT_PREFIX_REQUEST_DELIMITER: ContentBlock = {
  type: 'text',
  text: '\n\n## My request:\n',
}

/** Bake prompt-prefix contexts into one reconstructable prompt event. */
function preparePromptMessage(
  content: ContentBlock[],
  source: MessageSource,
  contexts: readonly HookContext[],
): { data: PromptMessageData; separateContexts: HookContext[] } {
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

/** Stable runtime-only reason used when lifecycle teardown interrupts a turn. */
export const DISPOSED_INTERRUPT_REASON = Object.freeze({ kind: 'disposed' } as const)

/** Normalize thrown values while preserving an existing error code. */
function toError(error: unknown): Error & { code?: string } {
  return error instanceof Error ? error : new HarnessError(String(error), 'UNKNOWN', { cause: error })
}

/** Rebuild the live {@link LlmError} for serializable provider facts; `cause` keeps the foreign original. */
function llmError(facts: LlmFailure, cause?: Error): LlmError {
  return new LlmError(facts.message, facts.code, {
    ...facts.status === undefined ? {} : { status: facts.status },
    ...facts.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: facts.providerRetryAfterMs },
    ...facts.requestId === undefined ? {} : { requestId: facts.requestId },
    ...cause === undefined ? {} : { cause },
  })
}

function withoutToolCalls(message: Message): Message {
  return { ...message, content: message.content.filter(block => block.type !== 'tool-call') }
}

// ---------------------------------------------------------------------------
// The agent.
// ---------------------------------------------------------------------------

/**
 * The concrete {@link Agent}: the classic naive agent loop — whole derived
 * history in, one assistant message out, loop until a reply owes no tool call.
 * One `run()` drains the work queue, one turn per unit.
 */
export class ReactLoopAgent extends Agent {
  /** Prompts awaiting a turn of their own: one dequeued per turn, FIFO. */
  private queued: QueuedMessage[] = []
  /** Taken whole at every step boundary; caller-editable until taken (taken = entered the log). */
  private outbox: OutboxItem[] = []

  /** Whether observers see one running drain interval; queued turns share it. */
  private busy = false
  /** The active turn's abort owner; rotated per turn, aborted by {@link cancel}. */
  private turnAbort: AbortController | undefined
  /** Resolves when the current `run()` has fully exited (quiescence for waiters and teardown). */
  done: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after {@link done}. */
  readonly scope: Scope
  /** The agent's scoped composition context ({@link Agent.ctx}). */
  readonly ctx: Context

  /**
   * The last turn number this machine (or the seeded log) opened. The machine
   * is the session's only turn author, so after the one seed scan below it
   * simply counts.
   */
  private lastTurn: number
  /** Whether the machine owes the log a `turn/end` / `step/end` right now. */
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
    // The scope is keyed by this agent — an opaque identity, fine mid-construction.
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
  }

  /** Last activity state published to observers. */
  get status(): AgentStatus {
    return this.busy ? 'running' : 'idle'
  }

  /** Detach and freeze one public payload; rejects non-lossless-JSON input synchronously. */
  private accept<T>(value: T): T {
    const accepted = snapshotJsonValue(value)
    if (accepted === undefined) {
      throw new TypeError('agent message content, source, and contexts must be losslessly JSON-serializable')
    }
    return deepFreeze(accepted)
  }

  // -------------------------------------------------------------------------
  // Public driving verbs.
  // -------------------------------------------------------------------------

  /** Accept and route one unified send item. */
  send(content: ContentBlock[], options: SendOptions = {}): AgentMessageIdType {
    const id = AgentMessageId(randomUUID())
    const target = options.target ?? 'next-turn'
    const wakeup = options.wakeup ?? true
    if (target === 'next-step' && !wakeup) {
      this.injectContext(content, options)
      return id
    }

    const steering = target === 'next-step' && this.turnAbort !== undefined
    const accepted = this.accept({
      id,
      content,
      source: options.source ?? { kind: 'user' },
      contexts: options.contexts ?? [],
      wakeup,
      ...options.meta === undefined ? {} : { meta: options.meta },
    })
    if (steering) this.outbox.push({ kind: 'steering', ...accepted })
    else this.queued.push(accepted)
    emitAgentEvent(this.loopCtx, this, 'agent/inbox/enqueue', inboxMessage(accepted, steering))
    if (!steering && wakeup) this.kick()
    return id
  }

  /** Stage non-waking context at the next step boundary, or in an idle one-shot turn. */
  private injectContext(content: ContentBlock[], options: SendOptions): void {
    const context = this.accept({
      content,
      source: options.source ?? { kind: 'plugin', plugin: '' },
      ...options.meta === undefined ? {} : { meta: options.meta },
    })
    if (this.turnAbort !== undefined) {
      this.outbox.push({ kind: 'context', context })
      return
    }
    // Idle: wrap the injection in a one-shot turn so every event stays
    // turn-enclosed (the durability/replay boundary is the turn).
    const turn = ++this.lastTurn
    let opened = false
    try {
      this.session.append('turn/start', { turn, trigger: { kind: 'injection', source: context.source } })
      opened = true
      this.session.append('user/message', context, { surfaceOp: 'append' })
    } finally {
      // Close only a turn whose start committed; a pre-commit veto escapes.
      if (opened) this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
  }

  /**
   * Clear all pending work and abort the active turn; the first cause wins.
   * The cause is signal payload for observers and the durable turn/end
   * classification — it selects no machine behavior. Teardown is just
   * `cancel({kind:'disposed'})` + await {@link done} + {@link scope} dispose,
   * all owned by the factory.
   */
  cancel(cause: AgentInterruptReason, options: CancelOptions = {}): void {
    if (this.turnAbort !== undefined || this.queued.length > 0 || this.outbox.length > 0) {
      // Observe-only: coordination consumers update their state before the
      // inboxes clear; listener failures are contained by the dispatcher.
      if (cause.kind !== 'disposed') emitAgentEvent(this.loopCtx, this, 'agent/cancel-requested', cause)
    }
    if (!options.keepInbox) {
      const steering = this.outbox.flatMap(item => item.kind === 'steering' ? [item] : [])
      const discarded = [
        ...this.queued.map(message => inboxMessage(message, false)),
        ...steering.map(message => inboxMessage(message, true)),
      ]
      // Clear before abort observers run: replacement work belongs to the next turn.
      this.queued.length = 0
      this.outbox.length = 0
      if (discarded.length > 0) emitAgentEvent(this.loopCtx, this, 'agent/inbox/discard', discarded)
    }
    this.turnAbort?.abort(Object.freeze({ kind: cause.kind }))
  }

  /**
   * Re-open a turn on the current session log without a new prompt — the
   * recovery verb after an error idle (naive `retry()`): repair the history
   * (edit the log, wait out a rate limit), then run again, right now.
   * @throws while a turn is running — there is nothing to retry yet.
   */
  retry(): void {
    if (this.turnAbort !== undefined) throw new Error(`agent "${this.id}" cannot retry while busy`)
    this.start()
  }

  /** Resolve at idle quiescence: no run driving and no waking prompt waiting. */
  async whenIdle(): Promise<void> {
    // `done` is replaced per run, so re-reading it each lap follows chained
    // turns; a run failure still counts as quiescence for the waiter.
    while (this.turnAbort !== undefined || this.queued.some(message => message.wakeup)) await this.done.catch(() => undefined)
  }

  // -------------------------------------------------------------------------
  // The machine.
  // -------------------------------------------------------------------------

  /** Claim the next queued prompt and open a run on it, when nothing is driving. */
  private kick(): void {
    if (this.turnAbort !== undefined || !this.queued.some(message => message.wakeup)) return
    const message = this.queued.shift()
    if (message !== undefined) {
      emitAgentEvent(this.loopCtx, this, 'agent/inbox/dequeue', inboxMessage(message, false))
      this.start(message)
    }
  }

  /** Open one `run()` — on a claimed prompt, or promptless for a retry. */
  private start(prompt?: QueuedMessage): void {
    const controller = new AbortController()
    this.turnAbort = controller
    if (!this.busy) {
      this.busy = true
      emitAgentEvent(this.loopCtx, this, 'agent/status', 'running')
    }
    // The whole run inherits this agent as its process-local initiator so
    // tools, the llm service, and nested factories can attribute their work.
    this.done = this.loopCtx.agents.withInitiator(this, () => this.run(prompt, controller))
  }

  /**
   * One `run()` is one turn: prompt intake (submit waterfall), the durable
   * turn boundary, then the naive step loop until the model owes no response.
   * Every failure funnels to the single catch — {@link settle} classifies it
   * once (interruption beats error) — and the finally always closes the owed
   * boundaries and runs the idle tail, which opens the next run while work
   * remains.
   */
  private async run(prompt: QueuedMessage | undefined, controller: AbortController): Promise<void> {
    const signal = controller.signal
    const turn = ++this.lastTurn
    let idle: IdleReason = { kind: 'completed' }
    let reason: TurnEndReason = { kind: 'completed' }
    let step = 0

    try {
      // Intake precedes the turn: the submit decision belongs to the prompt,
      // not the turn (a retry opens a turn with no prompt at all). A failed
      // intake leaves no durable trace — nothing entered the conversation.
      const decision = prompt === undefined
        ? undefined
        : await this.loopCtx.waterfall(
          agentCarrier(this), 'agent/prompt-submit', this, prompt.content, prompt.source, signal,
          () => Promise.resolve<PromptDecision>({
            kind: 'allow',
            ...prompt.contexts.length === 0 ? {} : { additionalContexts: prompt.contexts },
          }),
        )
      signal.throwIfAborted()

      this.session.append('turn/start', {
        turn,
        trigger: prompt === undefined ? { kind: 'retry' } : { kind: 'message', source: prompt.source },
      })
      this.turnOpen = true
      signal.throwIfAborted()

      if (prompt !== undefined && decision?.kind === 'block') {
        // The audit record stays turn-enclosed: a zero-step rejected turn.
        this.session.append('prompt/blocked', { content: prompt.content, source: prompt.source, reason: decision.reason })
        reason = { kind: 'rejected', reason: decision.reason }
      } else {
        if (prompt !== undefined && decision?.kind === 'allow') {
          const prepared = preparePromptMessage(
            decision.content ?? prompt.content,
            prompt.source,
            decision.additionalContexts ?? [],
          )
          this.session.append('user/message', {
            ...prepared.data,
            ...prompt.meta === undefined ? {} : { meta: prompt.meta },
          }, { surfaceOp: 'append' })
          for (const context of prepared.separateContexts) {
            this.outbox.push({ kind: 'context', context: this.accept(context) })
          }
        }
        while (true) {
          step += 1
          const { owes, maxTokens } = await this.step(turn, step, signal)
          if (maxTokens) reason = { kind: 'max-tokens' }
          // The naive rule, data-driven: run another step while the model is
          // owed a response. On a would-stop boundary, `agent/stopping` gives
          // listeners one chance to object — by steering, not by voting — and
          // the outbox is re-read: data decides, so listener order cannot.
          if (owes || this.outbox.some(item => item.kind === 'steering')) continue
          await this.loopCtx.serial(agentCarrier(this), 'agent/stopping', this, turn, signal)
          signal.throwIfAborted()
          if (!this.outbox.some(item => item.kind === 'steering')) break
        }
      }
    } catch (error: unknown) {
      ({ reason, idle } = this.settle(turn, step, error, signal))
    } finally {
      if (this.turnAbort === controller) this.turnAbort = undefined
      try {
        this.closeTurn(turn, step, reason)
      } catch (error: unknown) {
        // A rejected boundary append (a pre-commit validation veto) must not
        // kill the machine or strand its running interval: report and move on — the
        // idle tail below still runs and the next turn still opens.
        const err = toError(error)
        this.loopCtx.logger.warn(`agent "${this.id}": closing turn ${turn} failed: ${errorChain(err)}`)
        emitAgentEvent(this.loopCtx, this, 'agent/error', turn, step, err)
      }
      this.idle(turn, idle)
    }
  }

  /**
   * One whole step: the `agent/step` seam, take the outbox, derive the
   * history, one request, its tool calls — bracketed by the durable
   * step/start / step/end pair. The naive core: whole history in, one
   * assistant message out.
   */
  private async step(turn: number, step: number, signal: AbortSignal): Promise<{ owes: boolean; maxTokens: boolean }> {
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

    // --- Model call (streaming-first; raw chunks are the replay record) ---
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

    // Dispatch may overlap; policy, durable results, and result context stay
    // model-ordered. Tool-produced context rides the outbox like any other
    // injection, so it lands after the batch's results — adjacency-safe.
    const toolCalls = assembled.content.filter(block => block.type === 'tool-call')
    let concluded = false
    if (toolCalls.length > 0) {
      ({ concluded } = await executeToolCalls(
        this.loopCtx, turn, step, toolCalls, signal,
        context => this.outbox.push({ kind: 'context', context: this.accept(context) }),
      ))
    }

    // Steering/context that arrived during streaming or tool execution lands
    // inside the step (after the batch's results — adjacency-safe).
    const steered = this.drainOutbox(turn)
    session.append('step/end', { turn, step })
    this.stepOpen = false
    // Owed: live tool calls none of which concluded the turn, or steering.
    return {
      owes: (toolCalls.length > 0 && !concluded) || steered,
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
    // Log the header the request will ACTUALLY use, only when it differs
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

  /** Take the outbox whole into the log: committed from here. Returns whether steering was taken. */
  private drainOutbox(turn: number): boolean {
    let steered = false
    for (const item of this.outbox.splice(0)) {
      if (item.kind === 'context') {
        const { content, source, meta } = item.context
        this.session.append('user/message', {
          content,
          source,
          ...meta === undefined ? {} : { meta },
        }, { surfaceOp: 'append' })
        continue
      }
      steered = true
      emitAgentEvent(this.loopCtx, this, 'agent/inbox/dequeue', inboxMessage(item, true))
      const prepared = preparePromptMessage(item.content, item.source, item.contexts)
      this.session.append('steering/message', {
        turn,
        ...prepared.data,
        ...item.meta === undefined ? {} : { meta: item.meta },
      }, { surfaceOp: 'append' })
      for (const context of prepared.separateContexts) {
        const { content, source, meta } = context
        this.session.append('user/message', {
          content,
          source,
          ...meta === undefined ? {} : { meta },
        }, { surfaceOp: 'append' })
      }
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

  /** Close the owed boundaries, exactly once per turn. Durability is persistence's own eager concern. */
  private closeTurn(turn: number, step: number, reason: TurnEndReason): void {
    if (this.stepOpen) {
      this.stepOpen = false
      this.session.append('step/end', { turn, step })
    }
    if (this.turnOpen) {
      this.turnOpen = false
      this.session.append('turn/end', { turn, reason })
    }
  }

  /**
   * The turn boundary's tail (naive `idle()`): no turn owner remains,
   * the idle report fires (a listener may synchronously `retry()` or `send()`
   * here — both are legal now), leftover steering becomes queued prompts, and
   * the next run opens while the queue is non-empty; otherwise the machine
   * parks.
   */
  private idle(turn: number, idle: IdleReason): void {
    // Requeue BEFORE the idle report so earlier-arrived steering keeps its
    // FIFO position ahead of anything a listener send()s synchronously.
    for (const item of this.outbox.splice(0)) {
      if (item.kind === 'context') {
        this.outbox.push(item)
        continue
      }
      const { kind: _kind, ...message } = item
      this.queued.push(message)
    }
    emitAgentEvent(this.loopCtx, this, 'agent/idle', turn, idle)
    // A synchronous idle listener may retry()/send(), installing a new owner.
    if (this.turnAbort !== undefined) return // a listener already re-opened
    if (this.queued.some(message => message.wakeup)) this.kick()
    else {
      this.busy = false
      emitAgentEvent(this.loopCtx, this, 'agent/status', 'idle')
    }
  }
}
