/**
 * Public agent types and live-runtime events. Durable transcript facts and
 * turn/step boundaries remain `@deepseek-ai/dsh-session` events.
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { Context } from 'cordis'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { ContentBlock, LlmCallConfig, LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { AgentCancelCause, Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
export type { AgentCancelCause } from '@deepseek-ai/dsh-session'
import type { InboxItemId } from './brand.ts'
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
  /** Maximum output tokens for each conversation-model request. */
  maxTokens?: number
}

/**
 * Which inbox queue a {@link Agent.send} item joins:
 * - `next-turn` — the item becomes its own turn, claimed at a turn boundary.
 * - `next-step` — during prompt admission or an open turn, the item stages for
 *   the next safe step boundary; otherwise it is promoted per its `wakeup`
 *   flag.
 */
export type SendTarget = 'next-turn' | 'next-step'

/** Resolved inbox placement reported when an accepted message is enqueued. */
export type InboxPlacement = 'queued' | 'steering'

/** One independently addressable accepted occurrence in an agent inbox. */
export interface InboxItem {
  /** Agent-loop-minted occurrence identity. */
  readonly id: InboxItemId
  /** Identified message delivered by the caller. */
  readonly message: UserMessage
  /** Acceptance-time FIFO classification. */
  readonly placement: InboxPlacement
}

/** A user-requested mutation of one still-pending queued occurrence. */
export type InboxAction =
  | { readonly kind: 'edit'; readonly content: ContentBlock[] }
  | { readonly kind: 'remove' }

/** Result of applying an inbox action at the synchronous ownership boundary. */
export type InboxActionResult = 'applied' | 'not-found'

/**
 * Options for the unified {@link Agent.send} primitive over the
 * (`target` × `wakeup`) matrix. Named presets: {@link Agent.followup}
 * (`next-turn`/wakeup), {@link Agent.steer} (`next-step`/wakeup), and
 * {@link Agent.inject} (`next-step`/no-wakeup).
 *
 * The object is complete so routing policy is explicit.
 */
export interface SendOptions {
  /** Queue the item joins. */
  target: SendTarget
  /**
   * Whether this item makes the model run: wake a parked driver (`next-turn`)
   * or force a continuation step (`next-step` while running). A `false`
   * `next-turn` item queues without waking; a `false`
   * `next-step` item attaches durable context without forcing another step
   * (the injection preset).
   */
  wakeup: boolean
}

/** Options for {@link Agent.cancel}. */
export interface CancelOptions {
  /**
   * Preserve queued and steering inbox items instead of discarding them. The
   * active turn is still aborted, but un-started and pending work survives for a
   * later turn and no `agent/inbox/canceled` fires.
   */
  keepInbox?: boolean | undefined
}

/**
 * An agent's lifecycle state, emitted on every transition as `agent/status`:
 * `idle` means no driver is scheduled or active; `running` begins when a
 * cancellable admission is scheduled and lasts while the driver drains,
 * closes, or checkpoints turns. Disposal removes the agent from its registry;
 * it is not a third observable status.
 */
export type AgentStatus = 'idle' | 'running'

/**
 * Prompt interception result. An allowed batch replaces the submitted
 * messages. A listener wrapping `next()` preserves the returned batch unless
 * it intentionally replaces it.
 */
export type PromptDecision =
  | { kind: 'allow'; messages: UserMessage[] }
  | { kind: 'block'; reason: string; keepInbox?: boolean }

/** One failed model-request attempt presented to recovery listeners. */
export interface RequestFailureContext {
  /** Turn containing the failed request. */
  readonly turn: number
  /** Step containing the failed request attempt. */
  readonly step: number
  /** Provider selected for the failed request. */
  readonly provider: string
  /** Serializable facts normalized at the final adapter boundary. */
  readonly failure: LlmFailure
  /** Policy of the adapter registration that served the failed request. */
  readonly retryPolicy: ResolvedRetryPolicy | undefined
}

/** Action returned by a listener that owns model-request recovery. */
export type RequestErrorAction = { kind: 'retry' } | undefined

/** Why a session lifecycle began; seeded creates are `startup`, while persisted loads are `resume`. */
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'

/** Public live-agent handle. */
export interface Agent {
  /** The single identity shared with {@link session}. */
  readonly id: SessionId
  /** The provider route and model this agent's requests use. */
  readonly options: AgentOptions
  /** The live session this agent drives; its log is the durable source of truth. */
  readonly session: Session
  /** The current lifecycle state, mirrored on every `agent/status` transition. */
  readonly status: AgentStatus
  /** Whether a next-step send currently remains in the open turn. */
  readonly acceptsNextStep: boolean
  /** Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. */
  readonly ctx: Context

  /**
   * The unified delivery primitive over the (`target` × `wakeup`) matrix.
   * @param message - identified model-facing content and its producer provenance.
   * @param options - target queue and wakeup decision.
   */
  send(message: UserMessage, options: SendOptions): void

  /**
   * Mutate one still-pending queued occurrence synchronously. Editing preserves
   * the message identity and queue position; removal publishes its terminal
   * discard. Steering occurrences and driver-claimed items return `not-found`.
   * @param id - independently addressable queued occurrence.
   * @param action - edit or remove operation.
   * @returns whether the pending occurrence was found and updated.
   */
  updateInbox(id: InboxItemId, action: InboxAction): InboxActionResult

  /**
   * Clear queued and steering work — unless `keepInbox` — and abort the active
   * turn. The first cause wins for the active turn. Idle cancellation is a
   * no-op and does not arm later work.
   * @param cause - the stable caller intent carried by the current turn signal.
   * @param options - cancellation options; `keepInbox` preserves pending work.
   */
  cancel(cause: AgentCancelCause, options?: CancelOptions): void

  /**
   * Resolve after the current whole-agent activity reaches quiescence. This
   * follows replacement work scheduled before the observed driver retires,
   * but does not identify the settlement of any particular message.
   * @returns fulfillment after no scheduled or active driver remains.
   */
  whenIdle(): Promise<void>

  /**
   * Queue an ordinary follow-up turn and wake the driver. The item becomes the
   * sole ordinary message of its own turn.
   * @param message - identified prompt content and its producer provenance.
   */
  followup(message: UserMessage): void

  /**
   * Submit steering for the nearest step. An idle driver schedules a turn;
   * collecting and running drivers consume it at their next step boundary.
   * Cancellation or disposal may discard pending steering.
   * @param message - identified steering content and its producer provenance.
   */
  steer(message: UserMessage): void

  /**
   * Append model-facing context without running the model. Admission or an
   * open turn stages it at the next safe log position; outside that window it
   * appends immediately without opening a turn. If admission closes without a
   * turn, a context-only boundary appends immediately; context staged beside
   * steering remains pending with it.
   * @param message - identified injected context and its producer provenance.
   */
  inject(message: UserMessage): void
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
     * and scoped-registration unwind, but before session detachment. Custom
     * registry users own their driver-ordering contract.
     * @param agent - the exact agent removed from the registry.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/disposed'(this: Scoped<Agent>, agent: Agent): void
    /**
     * Agent status changed (`idle` ⇄ `running`). A waking delivery enters
     * `running` synchronously after reserving cancellation; `idle` means no
     * driver remains scheduled or active.
     * @param agent - the agent whose status flipped.
     * @param status - the status just entered (the transition's destination).
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/status'(this: Scoped<Agent>, agent: Agent, status: AgentStatus): void
    /**
     * An item entered the queued or steering inbox. `placement` is the
     * acceptance-time routing result.
     * @param agent - the owning agent.
     * @param item - accepted occurrence, message, and resolved placement.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/enqueue'(this: Scoped<Agent>, agent: Agent, item: InboxItem): void
    /**
     * A still-pending queued item changed content.
     * @param agent - the owning agent.
     * @param item - the complete post-update occurrence.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/update'(this: Scoped<Agent>, agent: Agent, item: InboxItem): void
    /**
     * The driver claimed one item out of the inbox.
     * @param agent - the agent whose inbox item was claimed.
     * @param item - the exact claimed occurrence.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/dequeue'(this: Scoped<Agent>, agent: Agent, item: InboxItem): void
    /**
     * Pending inbox items were dropped without delivery.
     * @param agent - the agent whose inbox items were dropped.
     * @param items - the discarded occurrences in FIFO order.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/discard'(this: Scoped<Agent>, agent: Agent, items: InboxItem[]): void
    /**
     * Effective broad cancellation was requested before pending work clears or
     * the active turn aborts.
     * @param agent - the agent whose current work is being cancelled.
     * @param cause - the explicit typed cancellation cause.
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

    // ---- the machine's extension seams ----
    /**
     * Allow, rewrite, or block one claimed inbox batch before it becomes
     * model-visible or opens a turn. Call `next()` for the unchanged default. The
     * signal controls only this admission attempt; listeners may cooperate with
     * it but must not retain it for a later attempt or turn.
     * @param agent - the agent whose driver claimed the batch.
     * @param messages - the claimed messages.
     * @param signal - the current turn's explicit abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/prompt-submit'(this: Scoped<Agent>, agent: Agent, messages: UserMessage[], signal: AbortSignal, next: () => Promise<PromptDecision>): Promise<PromptDecision>
    /**
     * Awaited serial checkpoint before EVERY request of a turn is built (the
     * first as well as each post-tools continuation). The single "between
     * steps" extension point: inject context, steer, or edit the session log
     * here — the request's history derives from the log right after this settles.
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
     * @mode waterfall
    */
    'agent/request'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, signal: AbortSignal, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
    /**
     * Handle one failed model-request attempt before the loop retries or closes
     * its step. A listener returns `{ kind: 'retry' }` without calling `next()`
     * when it owns recovery, or calls `next()` to delegate. The default
     * `undefined` leaves the failure terminal.
     * @param agent - the agent whose request failed.
     * @param context - request coordinates, provider, normalized failure, and serving policy.
     * @param signal - the turn abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/request-error'(this: Scoped<Agent>, agent: Agent, context: RequestFailureContext, signal: AbortSignal, next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction>
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
    'agent/turn-stopping'(this: Scoped<Agent>, agent: Agent, turn: number, signal: AbortSignal): Promise<void> | void
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
    'agent/error'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, error: unknown): void
  }
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** One message was accepted into the agent inbox. */
    'agent/inbox/added': UserMessage
  }
}
