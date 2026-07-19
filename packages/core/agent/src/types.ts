/**
 * Public agent types and live-runtime events. Durable transcript facts and
 * turn/step boundaries remain `@deepseek-ai/dsh-session` events.
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { Context } from 'cordis'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { ContentBlock, LlmCallConfig, Message, MessageSource } from '@deepseek-ai/dsh-llm'
import type { ContextEnvelope, JsonValue, Session, SessionId } from '@deepseek-ai/dsh-session'
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

/** Message options; an omitted source resolves to `{ kind: 'user' }`, so plugins must label their own content. */
export interface SendOptions {
  source?: MessageSource
}

/** Options specific to durable synthetic context injection. */
export interface InjectOptions extends SendOptions {
  /** Keep the canonical context tag, or send caller-owned framing verbatim. */
  envelope?: ContextEnvelope
  /** Opaque JSON state retained in the session event but hidden from the model. */
  meta?: JsonValue
}

/**
 * An agent's lifecycle state, emitted on every transition as `agent/status`:
 * `idle` (parked, waiting for queued work), `running` (a turn is in progress),
 * `disposed` (terminal — no transition leaves it, and `send`/`steer`/`inject`
 * throw).
 */
export type AgentStatus = 'idle' | 'running' | 'disposed'

/** Model-facing context injected by a listener; `source` prevents plugin text from being labeled as user input. */
export interface HookContext {
  content: ContentBlock[]
  source: MessageSource
  /** Keep the canonical context tag, or use caller-owned framing verbatim. */
  envelope?: ContextEnvelope
  /** Opaque JSON state retained in the session event but hidden from the model. */
  meta?: JsonValue
}

/**
 * Prompt interception result. `allow.content` replaces the prompt and each
 * `additionalContexts` entry becomes a separate context message. `block` records a
 * durable `prompt/blocked`; an all-blocked batch ends a zero-step rejected turn.
 */
export type PromptDecision =
  | { kind: 'allow'; content?: ContentBlock[]; additionalContexts?: HookContext[] }
  | { kind: 'block'; reason: string }

/** Turn continuation override; a continue reason is recorded as next-step steering in the same turn. */
export type ContinuationDecision =
  | { action: 'stop' }
  | { action: 'continue'; reason?: { content: ContentBlock[]; source: MessageSource } }

/**
 * The terminal subset of {@link ContinuationDecision}. A listener on
 * `agent/turn-stop` returns this to make the already-composed continuation
 * outcome terminal; `undefined` abstains.
 */
export type ContinuationStop = Extract<ContinuationDecision, { action: 'stop' }>

/** Why a session lifecycle began; seeded creates are `startup`, while persisted loads are `resume`. */
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'

/** Public agent handle; its concrete implementation is internal to `@deepseek-ai/dsh-agent-loop`. */
export interface Agent {
  /** The single identity shared with {@link session}. */
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session
  readonly status: AgentStatus
  /** Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. */
  readonly ctx: Context

  /**
   * Queue detached, frozen lossless-JSON input; starts a turn when idle.
   * Invalid input throws synchronously before notification or enqueue.
   */
  send(content: ContentBlock[], options?: SendOptions): void

  /**
   * Steer a running turn: content is injected between steps of the current
   * turn. Uses the same owned-value and synchronous-validation boundary as
   * {@link send}; when idle, behaves exactly like that method.
   */
  steer(content: ContentBlock[], options?: SendOptions): void

  /**
   * Append detached model-facing context without running the model. An open-turn
   * injection joins at the current log position unless the current tool batch is
   * executing; then it waits FIFO until that batch settles and drains before turn
   * close even when interrupted. Idle injection uses a one-shot turn and durability
   * checkpoint. Disposal awaits idle checkpoints; flush failures report through `agent/error`.
   */
  inject(content: ContentBlock[], options?: InjectOptions): void

  /**
   * Clear queued and steering work, including work waiting to start, and abort
   * the active step. The supplied reason is preserved across pre-step and active
   * cancellation windows, and `whenIdle()` resolves after cancellation reaches
   * quiescence. Idle cancellation is a no-op and does not arm a later cancel.
   */
  cancel(reason?: string): void

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
     * Agent status changed (`idle` ⇄ `running`, or → `disposed`). `send()` does
     * not enter `running` synchronously; drive lifecycle from this event.
     * @param agent - the agent whose status flipped.
     * @param status - the status just entered (the transition's destination).
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/status'(this: Scoped<Agent>, agent: Agent, status: AgentStatus): void
    /**
     * Detached, frozen content entered the agent's inbox. Source defaults have
     * already been applied, so these are the exact values retained for the log.
     * @param agent - the agent whose inbox received the message.
     * @param content - the accepted content blocks retained by the inbox.
     * @param info - the accepted source plus whether it entered as steering.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/queued'(this: Scoped<Agent>, agent: Agent, content: ContentBlock[], info: { source: MessageSource; steering: boolean }): void

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
     * Awaited serial checkpoint for session-surface mutation after prompt
     * assembly and before `step/start`; appends land outside the pending step.
     * The loop derives history once afterward, so compaction records and
     * replacements are included without rewriting an assembled request. The
     * prompt and prefix are the exact pressure inputs for that request, and
     * `signal` cancels listener work.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param agent - the agent opening the step.
     * @param turn - the open turn number.
     * @param step - the pending step number.
     * @param fullSystemPrompt - the assembled prompt.
     * @param sessionPrefix - the frozen request prefix.
     * @param signal - the turn abort signal.
     * @mode serial
     */
    // TODO: Move prompt-pressure inputs behind a compaction-specific seam if no second consumer appears.
    'agent/pre-step'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, fullSystemPrompt: string, sessionPrefix: readonly Message[], signal: AbortSignal): Promise<void> | void
    /**
     * Allow, rewrite, or block one drained prompt before it becomes a user
     * message. Call `next()` for the unchanged default.
     * @param agent - the agent draining its inbox.
     * @param content - the drained message's blocks, as queued.
     * @param source - the message's resolved source.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/prompt-submit'(this: Scoped<Agent>, agent: Agent, content: ContentBlock[], source: MessageSource, next: () => Promise<PromptDecision>): Promise<PromptDecision>
    /**
     * Replace the frozen call configuration. Model-visible content must use
     * logged channels; this seam cannot mutate messages. Injection here joins
     * the next request because the current step boundary is already fixed.
     * @param agent - the agent making the model call.
     * @param turn - the open turn number.
     * @param step - the step whose request this is.
     * @param config - the config the loop would use (frozen); return a replacement to switch.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/request'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, config: LlmCallConfig, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
    /**
     * Compose request-only messages placed before derived history. The frozen
     * result is computed once per loop instance, logged on its anchoring request
     * header, and reused so the provider prefix remains stable. Interrupted
     * composition is discarded. Composition precedes the first `agent/pre-step`
     * and request boundary, so listener appends join the current request and
     * pressure accounting sees the composed prefix. Changing context belongs in
     * history; contributors should prepend to `await next()` to preserve registration order.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param agent - the agent whose session prefix is being composed.
     * @param prefix - the frozen seed; return an extended replacement.
     * @param signal - aborts composition when the step is torn down.
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
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/step-result'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, message: Message, next: () => Promise<Message>): Promise<Message>
    /**
     * Override whether the turn continues. The default continues after tool
     * calls or steering and stops otherwise; a continue reason becomes steering.
     * @param agent - the agent deciding whether to run another step.
     * @param turn - the turn being continued or stopped.
     * @param defaultDecision - what the loop would do absent an override.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/turn-continuation'(this: Scoped<Agent>, agent: Agent, turn: number, defaultDecision: ContinuationDecision, next: () => Promise<ContinuationDecision>): Promise<ContinuationDecision>
    /**
     * Monotonic terminal-stop checkpoint after continuation and steering are
     * folded; a stop remains authoritative through turn close and flush:
     * steering queued in that window is discarded, while ordinary sends survive.
     * @param agent - the agent whose composed continuation outcome may be stopped.
     * @param turn - the turn at its terminal-stop checkpoint.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode serial
     */
    'agent/turn-stop'(this: Scoped<Agent>, agent: Agent, turn: number): ContinuationStop | undefined

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
