/**
 * Public agent types and live-runtime events. Durable transcript facts and
 * turn/step boundaries remain `@deepseek-ai/dsh-session` events.
 *
 * The agent is a naive message machine over the session log: prompts queue
 * (one turn each), steering/context ride the outbox (taken whole at every
 * step boundary), and the log re-derives the request history each step — so
 * "edit history between steps" needs no dedicated seam. The extension surface
 * is deliberately small:
 *
 * - `agent/prompt-submit` (waterfall): veto/rewrite a claimed prompt.
 * - `agent/request` (waterfall): replace the call config per request.
 * - `agent/step` (serial): awaited before every request is built — inject
 *   context, steer, or edit the log here; the request derives after it.
 * - `agent/stopping` (serial): the turn is about to close — steer to object.
 * - a tool result carrying `concludesTurn` ends the turn at its step (data,
 *   not a hook): the terminal-tool pattern.
 * - `agent/idle` (emit): one per turn close, carrying why it ended. Error
 *   recovery is a consumer loop: observe an error idle, fix (edit the log,
 *   wait out a rate limit), then `agent.retry()`.
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { Context } from 'cordis'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { ContentBlock, LlmCallConfig, LlmFailure, MessageSource } from '@deepseek-ai/dsh-llm'
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

/** One queued prompt or steering item and its atomic model-facing context. */
export interface SendOptions {
  /** Explicit producer attribution; callers may not inherit human authority by omission. */
  source: MessageSource
  /** Context snapshotted with this item and admitted at the same boundary. */
  contexts?: HookContext[]
}

/** Options for synthetic context injection. */
export interface InjectOptions {
  /** Explicit producer attribution. */
  source: MessageSource
  /** Opaque durable state omitted from the model projection. */
  meta?: JsonValue
}

/**
 * An agent's ACTIVITY state, emitted on every transition as `agent/status`:
 * `idle` (parked, waiting for queued work) or `running` (the machine is
 * draining work). Lifecycle is a separate axis: an agent leaving its host is
 * announced by `agent/disposed` and observable as `ctx.agents.get(id)` no
 * longer returning it — not as a status value.
 */
export type AgentStatus = 'idle' | 'running'

/** Model-facing context injected by a listener or atomically attached to one inbox item. */
export interface HookContext {
  content: ContentBlock[]
  source: MessageSource
  /** `prompt-prefix` bakes this context into its prompt; absent/`separate` records an independent message. */
  placement?: 'separate' | 'prompt-prefix'
  /** Opaque durable state omitted from the model projection. */
  meta?: JsonValue
}

/**
 * Prompt interception result. `allow.content` replaces the prompt. Each
 * `additionalContexts` entry follows its declared placement. `block` records
 * a durable `prompt/blocked` and ends the claimed prompt's zero-step turn as
 * rejected. A listener wrapping `next()` preserves downstream fields unless
 * it intentionally replaces them.
 */
export type PromptDecision =
  | { kind: 'allow'; content?: ContentBlock[]; additionalContexts?: HookContext[] }
  | { kind: 'block'; reason: string }

/**
 * Why a turn ended, reported live on `agent/idle` right after the turn's
 * durable `turn/end` and flush. `error` carries the live Error (and, for
 * model-request failures, the adapter-normalized facts) so a recovery
 * consumer can decide to repair and {@link Agent.retry}.
 */
export type IdleReason =
  | { kind: 'completed' }
  | { kind: 'aborted' }
  | { kind: 'error'; error: Error; failure?: LlmFailure }

/** Why a session lifecycle began; seeded creates are `startup`, while persisted loads are `resume`. */
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'

/** Stable runtime cause accepted by {@link Agent.cancel}. */
export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }

/** Runtime reason carried by the signal that controls one live turn. */
export type AgentInterruptReason = AgentCancelCause | { readonly kind: 'disposed' }

/** Public live-agent handle; driving methods have no contract after disposal. */
export interface Agent {
  /** The single identity shared with {@link session}. */
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session
  readonly status: AgentStatus
  /** Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. */
  readonly ctx: Context

  /**
   * Queue one detached, frozen lossless-JSON prompt. Each claimed prompt is
   * the sole ordinary message in its FIFO-ordered turn; the next claimed
   * prompt waits for that turn's checkpoint.
   * Invalid input throws synchronously before notification or enqueue.
   */
  send(content: ContentBlock[], options: SendOptions): void

  /**
   * Submit steering while the agent is `running`: it enters the outbox and is
   * taken whole at the next step boundary, before the next request. Steering
   * left over when the turn closes queues for a turn of its own. When idle,
   * delegates to {@link send}.
   */
  steer(content: ContentBlock[], options: SendOptions): void

  /**
   * Stage detached model-facing context without running the model: it enters
   * the outbox and rides along with whatever runs next — the next step of the
   * running turn (never between a tool-call batch and its results), or the
   * next turn when idle.
   */
  inject(content: ContentBlock[], options: InjectOptions): void

  /**
   * Clear all queued and outbox work and abort the active turn. An effective
   * call first emits `agent/cancel-requested` with the resolved typed cause;
   * the first cause wins for the active turn. Omission means `{ kind: 'user' }`.
   * Idle cancellation is a no-op and does not arm later work.
   */
  cancel(cause?: AgentInterruptReason): void

  /**
   * Re-open a turn on the current session log without a new prompt — the
   * recovery verb. After an `agent/idle` error, a consumer repairs (edits the
   * log, waits out a rate limit) and calls this; the machine immediately runs
   * another turn over the repaired history. Calling it synchronously from an
   * `agent/idle` listener is legal — the machine is already idle there.
   * @throws while a turn is running because there is nothing to retry yet.
   */
  retry(): void

  /** Resolve at idle quiescence; disposal waits for machine exit rather than only the status transition. */
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
     * An agent left the registry; AgentLoop emits this after machine quiescence
     * but before session detachment and scoped-registration unwind. Custom
     * registry users own their driver-ordering contract.
     * @param agent - the exact agent removed from the registry.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/disposed'(this: Scoped<Agent>, agent: Agent): void
    /**
     * Agent activity changed (`idle` ⇄ `running`). `send()` does
     * not enter `running` synchronously; drive lifecycle from this event.
     * @param agent - the agent whose status flipped.
     * @param status - the status just entered (the transition's destination).
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/status'(this: Scoped<Agent>, agent: Agent, status: AgentStatus): void
    /**
     * Detached, frozen content entered the agent's inbox (prompt queue or
     * steering outbox). These are the exact values retained for the log.
     * @param agent - the agent whose inbox received the message.
     * @param content - the accepted content blocks retained by the inbox.
     * @param info - the accepted source, contexts, and steering classification.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/queued'(this: Scoped<Agent>, agent: Agent, content: ContentBlock[], info: { source: MessageSource; contexts: HookContext[]; steering: boolean }): void
    /**
     * Effective broad cancellation was requested, before queued/outbox work
     * is cleared or the active turn is aborted. This observe-only notification
     * cannot veto cancellation; listener failures are contained.
     * @param agent - the agent whose current work is being cancelled.
     * @param cause - resolved typed cancellation cause, including the default.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/cancel-requested'(this: Scoped<Agent>, agent: Agent, cause: AgentInterruptReason): void
    /**
     * The session lifecycle began, once before the first turn. Use
     * `agent.inject()` to seed model-facing context. This is a notification, not
     * a veto; disposal requested by a lifecycle owner is rechecked before the
     * machine starts.
     * @param agent - the agent whose session lifecycle began.
     * @param source - why the session started (fresh startup, resume, …).
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/session-start'(this: Scoped<Agent>, agent: Agent, source: SessionStartSource): void

    // ---- the machine's extension seams ----
    /**
     * Allow, rewrite, or block one claimed prompt before it becomes a user
     * message. Call `next()` for the unchanged default, including contexts
     * captured with the queued item. The signal controls only this turn;
     * listeners may cooperate with it but must not retain it for another turn.
     * @param agent - the agent whose turn claimed the message.
     * @param content - the claimed message's blocks, as queued.
     * @param source - the message's resolved source.
     * @param signal - the current turn's explicit abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/prompt-submit'(this: Scoped<Agent>, agent: Agent, content: ContentBlock[], source: MessageSource, signal: AbortSignal, next: () => Promise<PromptDecision>): Promise<PromptDecision>
    /**
     * Awaited serial checkpoint before EVERY request of a turn is built (the
     * first as well as each post-tools continuation). The single "between
     * steps" seam: inject context, steer, or edit the session log here — the
     * request's history derives from the log right after this settles.
     * @param agent - the agent about to send a request.
     * @param turn - the open turn number.
     * @param step - the step number about to open.
     * @param signal - the turn abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode serial
     */
    'agent/step'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, signal: AbortSignal): Promise<void> | void
    /**
     * Replace the frozen call configuration. `await next()` yields the config
     * the machine would use (agent options on the first request, the logged
     * header afterwards); return a replacement to switch. Model-visible
     * content must use logged channels; this seam cannot mutate messages.
     * @param agent - the agent making the model call.
     * @param turn - the open turn number.
     * @param step - the step whose request this is.
     * @param signal - the current turn's explicit abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode compose
     */
    'agent/request'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, signal: AbortSignal, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
    /**
     * The turn is about to close: the model owes no response (no live tool
     * calls, no fresh steering). Awaited before the boundary commits — a
     * listener that objects steers (`agent.steer(...)`) and the machine
     * re-reads its inbox: fresh steering runs another step, none closes the
     * turn. Data decides, so listener order cannot change the outcome. The
     * inverse control (stop a tool loop early) is data too: a tool result
     * carrying `concludesTurn` ends the turn at its step.
     * @param agent - the agent whose turn is at its stop boundary.
     * @param turn - the turn about to close.
     * @param signal - the current turn's explicit abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode serial
     */
    'agent/stopping'(this: Scoped<Agent>, agent: Agent, turn: number, signal: AbortSignal): Promise<void> | void
    /**
     * One turn closed: its `turn/end` and durability flush are already
     * committed. `reason` says why — recovery consumers observe an `error`
     * reason, repair (edit the log, wait, resummon), and call
     * {@link Agent.retry}; UI consumers key turn-done presentation off it.
     * Emitted per turn, including cancelled and failed ones.
     * @param agent - the agent whose turn closed.
     * @param turn - the closed turn number.
     * @param reason - why the turn ended, with live error facts when it failed.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/idle'(this: Scoped<Agent>, agent: Agent, turn: number, reason: IdleReason): void

    // ---- error notifications (emit) ----
    /**
     * A step or turn errored. The machine reports a failure here (plus the
     * logger) even when the error has no in-turn position for a durable record.
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
