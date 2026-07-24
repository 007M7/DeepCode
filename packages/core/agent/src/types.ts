/**
 * Public agent types and live-runtime events. Durable transcript facts and
 * turn/step boundaries remain `@deepseek-ai/dsh-session` events.
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { Context } from 'cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { ContentBlock, LlmCallConfig, LlmFailure, Message, MessageSource } from '@deepseek-ai/dsh-llm'
import type { JsonValue, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
declare module '@deepseek-ai/dsh-system-prompt' {
  interface AssembleContext {
    /** Agent for this assembly; absent on diagnostics. When present, `scope` must identify the same agent. */
    agent?: Agent
  }
}

/** Merge-extensible agent creation options. Persona belongs to system-prompt sections. */
export interface AgentOptions {
  /** Provider route (must have a registered adapter at call time). */
  provider?: string
  /** Model id interpreted by the selected provider adapter. */
  model?: string
}

/**
 * Options for {@link Agent.followup}, {@link Agent.queue}, and {@link Agent.steer}.
 * An omitted source attests direct human input as `{ kind: 'user' }` and may
 * authorize policy consumers, so non-human producers must label their content.
 */
export interface SendOptions {
  source?: MessageSource
  /**
   * Model-facing contexts captured with this inbox item. A queued prompt exposes
   * them through the default `agent/prompt-submit` allow decision, while steering
   * records them directly at its next checkpoint.
   */
  contexts?: HookContext[]
  /** Opaque JSON state retained on the durable message but hidden from the model. */
  meta?: JsonValue
}

/** Options specific to durable synthetic context injection. */
export interface InjectOptions {
  /** Defaults to `{ kind: 'plugin', plugin: '' }`; non-human producers should identify themselves. */
  source?: MessageSource
  /** Opaque JSON state retained on the durable message but hidden from the model. */
  meta?: JsonValue
}

/**
 * Opaque id assigned to one accepted agent input. FIFO inputs carry the same id
 * on their `agent/inbox/*` events; injection bypasses those events.
 */
export type AgentMessageId = Branded<'AgentMessageId'>

/**
 * Brand a string as an {@link AgentMessageId}.
 * @param id - the generated message id.
 * @returns the same string, branded; no validation is performed.
 */
export function AgentMessageId(id: string): AgentMessageId {
  return id as AgentMessageId
}

/**
 * One accepted FIFO message, carried by the `agent/inbox/*` live events. `id`
 * is the value returned by the accepting helper or {@link Agent.send},
 * stable across this message's enqueue, dequeue, and discard events. Source
 * defaults, when applicable, are already applied, so these are the exact values
 * the item was accepted with.
 * `steering` is true for an item drained between steps; otherwise it is claimed
 * at a turn boundary. `SendOptions.meta` is intentionally omitted: it is durable
 * model-hidden state that lands on the eventual `user/message`/
 * `steering/message`, not live-event routing data.
 */
export interface AgentMessage {
  /** The id returned by the accepting helper or {@link Agent.send}. */
  id: AgentMessageId
  content: ContentBlock[]
  source: MessageSource
  contexts: HookContext[]
  /** Whether the item joined the steering FIFO rather than the queued FIFO. */
  steering: boolean
  /** Whether the item wakes the driver or requests another step. */
  wakeup: boolean
}

/** Options for {@link Agent.cancel}. */
export interface CancelOptions {
  /**
   * Preserve queued and steering inbox items instead of discarding them. The
   * active turn is still aborted, but un-started and pending work survives for a
   * later turn and no `agent/inbox/discard` fires.
   */
  keepInbox?: boolean
}

/**
 * An agent's lifecycle state, emitted on every transition as `agent/status`:
 * `idle` (parked, waiting for queued work), `running` (the driver is draining
 * work and may be closing or checkpointing a turn), `disposed` (terminal — no
 * transition leaves it, and every delivery method throws).
 */
export type AgentStatus = 'idle' | 'running' | 'disposed'

/** Model-facing context injected by a listener or atomically attached to one inbox message. */
export interface HookContext {
  content: ContentBlock[]
  source: MessageSource
  /**
   * Model placement. Absent or `separate` records an independent injected
   * `user/message`; `prompt-prefix` prepends this context and a stable
   * request delimiter to the same user-role message as its attached prompt.
   */
  placement?: 'separate' | 'prompt-prefix'
  /** Opaque JSON state retained in the session event but hidden from the model. */
  meta?: JsonValue
}

/**
 * Fully specified input for {@link Agent.send}. Unlike the intent-named
 * helpers, this form applies no defaults: callers provide content, source,
 * contexts, metadata (including explicit `undefined`), target, and wakeup.
 * The union excludes attached contexts from non-waking next-step injection.
 */
export type ResolvedAgentInput = {
  content: ContentBlock[]
  source: MessageSource
  meta: JsonValue | undefined
} & (
  | { target: 'next-turn'; wakeup: boolean; contexts: HookContext[] }
  | { target: 'next-step'; wakeup: true; contexts: HookContext[] }
  | { target: 'next-step'; wakeup: false; contexts: [] }
)

/**
 * Prompt interception result. `allow.content` replaces the prompt. Each
 * `additionalContexts` entry follows its declared placement: separate context
 * message by default, or a prefix inside the prompt's user-role message.
 * `block` records a durable `prompt/blocked` and ends the claimed prompt's
 * zero-step turn as rejected. An `allow` returned by a listener is
 * authoritative: a listener wrapping `next()` preserves downstream `content`
 * and `additionalContexts` unless it intentionally replaces them.
 */
export type PromptDecision =
  | { kind: 'allow'; content?: ContentBlock[]; additionalContexts?: HookContext[] }
  | { kind: 'block'; reason: string }

/** Turn continuation override; a continue reason is recorded as next-step steering in the same turn. */
export type ContinuationDecision =
  | { action: 'stop' }
  | { action: 'continue'; reason?: { content: ContentBlock[]; source: MessageSource } }

/** Failed-request recovery decision; `retry` opens another numbered step while listeners delegate by calling `next()`. */
export type RequestErrorDecision = { action: 'fail' } | { action: 'retry' }

/** Model-request failure with an optional machine-routable provider code. */
export type RequestError = Error & { code?: string }

/**
 * The terminal subset of {@link ContinuationDecision}. A listener on
 * `agent/turn-stop` returns this to make the already-composed continuation
 * outcome terminal; `undefined` abstains.
 */
export type ContinuationStop = Extract<ContinuationDecision, { action: 'stop' }>

/** Why a session lifecycle began; seeded creates are `startup`, while persisted loads are `resume`. */
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'

/** Stable runtime cause accepted by {@link Agent.cancel}. */
export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }

/** Runtime reason carried by the signal that controls one live turn. */
export type AgentInterruptReason = AgentCancelCause | { readonly kind: 'disposed' }

/** Public agent handle; its concrete implementation is internal to `@deepseek-ai/dsh-agent-loop`. */
export interface Agent {
  /** The single identity shared with {@link session}. */
  readonly id: SessionId
  /** The provider route and model this agent's requests use. */
  readonly options: AgentOptions
  /** The live session this agent drives; its log is the durable source of truth. */
  readonly session: Session
  /** The current lifecycle state, mirrored on every `agent/status` transition. */
  readonly status: AgentStatus
  /** Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. */
  readonly ctx: Context

  /**
   * Queue an ordinary message as its own FIFO-ordered turn and wake the driver.
   * Content, resolved source, and attached contexts are detached, validated,
   * and frozen together; invalid input throws synchronously before notification
   * or enqueue.
   * @param content - the prompt content blocks.
   * @param options - source, attached contexts, and durable model-hidden meta.
   * @returns the accepted message's {@link AgentMessageId}, stable across its `agent/inbox/*` events.
   */
  followup(content: ContentBlock[], options?: SendOptions): AgentMessageId

  /**
   * Queue an ordinary message without waking an idle driver. The item retains
   * FIFO order and is claimed only after another input wakes the driver. A lone
   * queued item leaves `whenIdle()` resolved.
   * @param content - the prompt content blocks.
   * @param options - source, attached contexts, and durable model-hidden meta.
   * @returns the accepted message's {@link AgentMessageId}, stable across its `agent/inbox/*` events.
   */
  queue(content: ContentBlock[], options?: SendOptions): AgentMessageId

  /**
   * Submit steering into the running turn and request another step. An open turn
   * records it at the next steering checkpoint before a request or continuation
   * decision; policy may stop before another step. After turn close and its
   * checkpoint, any remainder is queued for a later turn; terminal
   * `agent/turn-stop`, cancellation, or disposal may discard it. Idle steering
   * becomes a waking ordinary turn.
   * @param content - the steering content blocks.
   * @param options - source, attached contexts, and durable model-hidden meta.
   * @returns the accepted message's {@link AgentMessageId}, stable across its `agent/inbox/*` events.
   */
  steer(content: ContentBlock[], options?: SendOptions): AgentMessageId

  /**
   * Append detached model-facing context without running the model. An open-turn
   * injection joins at the current log position unless the current tool batch is
   * executing; then it waits FIFO until that batch settles and drains before
   * turn close even when interrupted. Idle injection uses a one-shot turn and
   * durability checkpoint. Disposal awaits idle checkpoints; flush failures
   * report through `agent/error`. An omitted source defaults to
   * `{ kind: 'plugin', plugin: '' }`.
   * @param content - the injected context content blocks.
   * @param options - source and durable model-hidden meta.
   * @returns the accepted injection's {@link AgentMessageId}; injection emits no `agent/inbox/*` events.
   */
  inject(content: ContentBlock[], options?: InjectOptions): AgentMessageId

  /**
   * Accept one fully specified input through the same snapshot and routing path
   * as the four intent-named helpers. `next-turn` targets the ordinary FIFO;
   * `next-step`/wakeup targets steering (falling back to an ordinary waking turn
   * while idle); and `next-step` without wakeup injects durable context without
   * running the model. Every field is mandatory and no source or routing default
   * is applied. Invalid input throws synchronously before notification, enqueue,
   * or append.
   * @param input - the resolved content, attribution, context, metadata, and routing facts.
   * @returns the accepted input's {@link AgentMessageId}, carried by FIFO lifecycle events when applicable.
   */
  send(input: ResolvedAgentInput): AgentMessageId

  /**
   * Clear queued and steering work — unless `keepInbox` — and abort the active
   * turn. An effective call first emits `agent/cancel-requested` with the
   * resolved typed cause. The first cause wins for the active turn, and
   * `whenIdle()` resolves after cancellation reaches quiescence. Omitted cause
   * means `{ kind: 'user' }`. Idle cancellation is a no-op and does not arm
   * later work. The active turn snapshots and freezes the cause.
   * @param cause - the stable caller intent carried by the current turn signal.
   * @param options - cancellation options; `keepInbox` preserves pending work.
   */
  cancel(cause?: AgentCancelCause, options?: CancelOptions): void

  /** Resolve at idle quiescence; disposal waits for driver exit rather than only the status transition. */
  whenIdle(): Promise<void>
}

declare module 'cordis' {
  interface Events {
    // ---- lifecycle (emit) ----
    /**
     * A fully configured agent and live session were published. Setup is
     * composition-only; `agent/session-start` is the first startup-driving seam.
     * Synchronous listener failure vetoes publication, while returned-promise
     * rejection is reported. Detach requested during dispatch waits until every
     * creation listener has observed the stable entry.
     * @param agent - the newly registered agent with its live session and completed setup.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/created'(this: Scoped<Agent>, agent: Agent): void
    /**
     * An agent left the registry; AgentLoop emits this after driver quiescence
     * but before session detachment and scoped-registration unwind. Custom
     * registry users own their driver-ordering contract.
     * @param agent - the exact agent removed from the registry.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/disposed'(this: Scoped<Agent>, agent: Agent): void
    /**
     * Agent status changed (`idle` ⇄ `running`, or → `disposed`). A waking
     * delivery does not enter `running` synchronously; drive lifecycle from this event.
     * @param agent - the agent whose status flipped.
     * @param status - the status just entered (the transition's destination).
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/status'(this: Scoped<Agent>, agent: Agent, status: AgentStatus): void
    /**
     * A detached, frozen item entered the agent's inbox (queued or steering
     * FIFO). Source defaults are already applied, so `message` holds the exact
     * accepted values. This is the enqueue-time live signal; the durable record
     * is the eventual `user/message`/`steering/message`. Injection through
     * `agent.inject()` or equivalent `send()` routing bypasses the FIFOs
     * and does not emit this.
     * @param agent - the agent whose inbox received the item.
     * @param message - the accepted message (its returned `id`, content, source, contexts, steering, and wakeup facts).
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/enqueue'(this: Scoped<Agent>, agent: Agent, message: AgentMessage): void
    /**
     * The driver claimed one item out of the inbox: a queued item at a turn
     * boundary, or steering drained between steps. Fires after the item leaves
     * its FIFO and before it becomes a durable message.
     * @param agent - the agent whose inbox item was claimed.
     * @param message - the claimed message (matching the `id` from its `agent/inbox/enqueue`).
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/dequeue'(this: Scoped<Agent>, agent: Agent, message: AgentMessage): void
    /**
     * Pending inbox items were dropped without delivering them, so every
     * enqueued id receives exactly one terminal `agent/inbox/dequeue` OR
     * `agent/inbox/discard`. Emitters: `cancel()` without `keepInbox` (after
     * `agent/cancel-requested`, before the abort); a terminal `agent/turn-stop`
     * dropping pending steering (in-turn and on the post-turn late-steering
     * drain); and disposal of any still-pending items (before
     * `agent/status('disposed')`). Fires once per drop with every dropped item.
     * @param agent - the agent whose inbox items were dropped.
     * @param messages - the discarded messages in FIFO order (queued then steering); never empty.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/discard'(this: Scoped<Agent>, agent: Agent, messages: AgentMessage[]): void
    /**
     * Effective broad cancellation was requested, before queued/steering work
     * is cleared or the active turn is aborted. This observe-only notification
     * cannot veto cancellation; listener failures are contained.
     * @param agent - the agent whose current work is being cancelled.
     * @param cause - resolved typed cancellation cause, including the default.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/cancel-requested'(this: Scoped<Agent>, agent: Agent, cause: AgentCancelCause): void

    // ---- session lifecycle (emit) ----
    /**
     * The session lifecycle began, once before the first turn. Use
     * `agent.inject()` to seed model-facing context. This is a notification, not
     * a veto; disposal requested by a lifecycle owner is rechecked before the
     * driver starts.
     * @param agent - the agent whose session lifecycle began.
     * @param source - why the session started (fresh startup, resume, …).
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/session-start'(this: Scoped<Agent>, agent: Agent, source: SessionStartSource): void

    // Turn and step boundaries are durable session events, not agent events.

    // ---- step/request extension seams (serial + waterfall) ----
    /**
     * Awaited serial checkpoint before `step/start`; appends land outside the
     * pending step and are included when the loop derives request history.
     * `signal` cancels listener work.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param agent - the agent opening the step.
     * @param turn - the open turn number.
     * @param step - the pending step number.
     * @param signal - the turn abort signal.
     * @mode serial
     */
    'agent/pre-step'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, signal: AbortSignal): Promise<void> | void
    /**
     * Allow, rewrite, or block one claimed prompt before it becomes a user
     * message. Call `next()` for the unchanged default. A listener wrapping a
     * downstream `allow` must preserve its `content` and `additionalContexts`
     * unless it intentionally replaces them. The signal controls only this turn;
     * listeners may cooperate with it but must not retain it to control another
     * turn. Steering messages do not dispatch this event; they join an open turn
     * at a steering checkpoint.
     * @param agent - the agent whose turn claimed the message.
     * @param content - the claimed message's blocks, as queued.
     * @param source - the message's resolved source.
     * @param signal - the current turn's explicit abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/prompt-submit'(this: Scoped<Agent>, agent: Agent, content: ContentBlock[], source: MessageSource, signal: AbortSignal, next: () => Promise<PromptDecision>): Promise<PromptDecision>
    /**
     * Replace the frozen call configuration. Model-visible content must use
     * logged channels; this seam cannot mutate messages. Injection here joins
     * the next request because the current step boundary is already fixed.
     * @param agent - the agent making the model call.
     * @param turn - the open turn number.
     * @param step - the step whose request this is.
     * @param config - the config the loop would use (frozen); return a replacement to switch.
     * @param signal - the current turn's explicit abort signal; ambient
     * initiator identity does not imply liveness or cancellation authority.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/request'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, config: LlmCallConfig, signal: AbortSignal, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
    /**
     * Compose request-only messages placed before derived history. The frozen
     * result is computed once per loop instance, logged on its anchoring request
     * header, and reused so the provider prefix remains stable. Interrupted
     * composition is discarded. Composition precedes the first `agent/pre-step`
     * and request boundary, so listener appends join the current request.
     * Changing context belongs in history; contributors should prepend to
     * `await next()` to preserve registration order.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param agent - the agent whose session prefix is being composed.
     * @param prefix - the frozen seed; return an extended replacement.
     * @param signal - the current turn's explicit abort signal.
     * @mode waterfall
     */
    'agent/session-prefix'(this: Scoped<Agent>, agent: Agent, prefix: Message[], signal: AbortSignal, next: () => Promise<Message[]>): Promise<Message[]>
    /**
     * Waterfall: post-process the assembled assistant {@link Message} before
     * tool dispatch (validation, content rewriting, …).
     * @param agent - the agent that received the step's response.
     * @param turn - the open turn number.
     * @param step - the step that produced the message.
     * @param message - the assistant message as assembled from the stream.
     * @param signal - the current turn's explicit abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/step-result'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, message: Message, signal: AbortSignal, next: () => Promise<Message>): Promise<Message>
    /**
     * Awaited serial checkpoint after the response, real or synthetic tool
     * results, injected context, and steering are durable but before `step/end`.
     * A cancelled tool batch reaches this checkpoint with an aborted signal.
     * @param agent - the agent whose step is settling.
     * @param turn - the open turn number.
     * @param step - the open step number.
     * @param signal - the turn abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode serial
     */
    'agent/post-step'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, signal: AbortSignal): Promise<void> | void
    /**
     * Recover a model-request failure after its failed step has closed. `retry`
     * opens a new numbered step; `fail` preserves the original request error.
     * Call `next()` to delegate to the next recovery listener or the default.
     * @param agent - the agent whose request failed.
     * @param turn - the open turn number.
     * @param step - the failed step number.
     * @param error - the original model-request failure.
     * @param failure - serializable facts normalized at the final adapter boundary.
     * @param priorFailures - immutable failures that already authorized another request in this consecutive sequence.
     * @param signal - the turn abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/request-error'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, error: RequestError, failure: LlmFailure, priorFailures: readonly LlmFailure[], signal: AbortSignal, next: () => Promise<RequestErrorDecision>): Promise<RequestErrorDecision>
    /**
     * Override whether the turn continues. The default continues after tool
     * calls or steering and stops otherwise; a continue reason becomes steering.
     * @param agent - the agent deciding whether to run another step.
     * @param turn - the turn being continued or stopped.
     * @param defaultDecision - what the loop would do absent an override.
     * @param signal - the current turn's explicit abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/turn-continuation'(this: Scoped<Agent>, agent: Agent, turn: number, defaultDecision: ContinuationDecision, signal: AbortSignal, next: () => Promise<ContinuationDecision>): Promise<ContinuationDecision>
    /**
     * Monotonic terminal-stop checkpoint after continuation and steering are
     * folded; a stop remains authoritative through turn close and flush:
     * steering queued in that window is discarded, while ordinary sends survive.
     * @param agent - the agent whose composed continuation outcome may be stopped.
     * @param turn - the turn at its terminal-stop checkpoint.
     * @param signal - the current turn's explicit abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode serial
     */
    'agent/turn-stop'(this: Scoped<Agent>, agent: Agent, turn: number, signal: AbortSignal): Promise<ContinuationStop | undefined> | ContinuationStop | undefined

    // ---- error notifications (emit) ----
    /**
     * A step or turn errored. The loop reports a failure here (plus the logger)
     * even when the error has no in-turn position for a session `error` event.
     * @param agent - the agent whose turn errored.
     * @param turn - the turn in which the failure surfaced.
     * @param step - the step at which the failure surfaced.
     * @param error - the failure, verbatim.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/error'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, error: Error): void
  }
}
