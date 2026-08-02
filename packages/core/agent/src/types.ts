/**
 * Public agent types and live-runtime events. Durable transcript facts and
 * turn/step boundaries remain `@deepseek-ai/dsh-session` events.
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { Context } from 'cordis'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { ContentBlock, LlmCallConfig, LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
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

/** Final admission outcome for one call to {@link Agent.steer}. */
export type SteeringOutcome =
  | { readonly status: 'admitted'; readonly turn: number; readonly step: number }
  | { readonly status: 'rejected' }

/**
 * Message-owned steering admission receipt. The outcome promise always
 * resolves: synchronous input validation still throws from {@link Agent.steer},
 * while lifecycle policy reports non-admission as `rejected`.
 */
export interface SteeringReceipt {
  readonly outcome: Promise<SteeringOutcome>
}

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
   * later turn and no `agent/inbox/discard` fires.
   */
  keepInbox?: boolean
}

/**
 * An agent's lifecycle state, emitted on every transition as `agent/status`:
 * `idle` (parked, waiting for queued work), `running` (the driver is draining
 * work and may be closing or checkpointing a turn). Disposal removes the
 * agent from its registry; it is not a third observable status.
 */
export type AgentStatus = 'idle' | 'running'

/**
 * Prompt interception result. `allow.content` replaces the prompt, while
 * `additionalContexts` appends model-facing context before the turn starts.
 * An `allow` returned by a listener is authoritative: a listener wrapping
 * `next()` preserves both fields unless it intentionally replaces them.
 */
export type PromptDecision =
  | { kind: 'allow'; content?: ContentBlock[]; additionalContexts?: UserMessage[] }
  | { kind: 'block'; reason: string }

/** Model-request failure with an optional machine-routable provider code. */
export type RequestError = Error & { code?: string }

/** Action returned by a listener that owns model-request recovery. */
export type RequestErrorAction = { kind: 'retry' } | undefined

/**
 * Why a turn ended, reported live on `agent/settled` right after the turn's
 * durable `turn/end`. `error` carries the thrown value verbatim for observers;
 * model-request recovery runs earlier through `agent/request-error`.
 */
export type SettleReason =
  | { kind: 'completed' }
  | { kind: 'aborted' }
  | { kind: 'error'; error: unknown; failure?: LlmFailure }

/** Why a session lifecycle began; seeded creates are `startup`, while persisted loads are `resume`. */
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'

/** Stable runtime cause accepted by {@link Agent.cancel}. */
export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }

/** Runtime reason carried by the signal that controls one live turn. */
export type AgentInterruptReason = AgentCancelCause | { readonly kind: 'disposed' }

/**
 * Public live-agent handle with aliases over the unified delivery primitive.
 * @typert object
 */
export interface Agent {
  /** The single identity shared with {@link session}. */
  readonly id: SessionId
  /** The provider route and model this agent's requests use. */
  readonly options: AgentOptions
  /** The live session this agent drives; its log is the durable source of truth. */
  readonly session: Session
  /** The current lifecycle state, mirrored on every `agent/status` transition. */
  readonly status: AgentStatus
  /**
   * Whether a `next-step` send currently stages for prompt admission or the
   * open turn. Unlike {@link status}, this excludes admission exit and turn
   * settlement, when a waking `next-step` send becomes a queued follow-up.
   */
  readonly acceptsNextStep: boolean
  /** Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. */
  readonly ctx: Context

  /**
   * The unified delivery primitive over the (`target` × `wakeup`) matrix.
   * It routes the caller's typed content and source as follows:
   *
   * - `next-turn` queues an item that becomes the sole ordinary message of its
   *   own FIFO-ordered turn; `wakeup:true` wakes a
   *   parked driver, while `wakeup:false` queues without waking.
   * - `next-step` with `wakeup:true` stages steering during prompt admission
   *   or an open turn; outside that window it falls back to a woken
   *   `next-turn`.
   * - `next-step` with `wakeup:false` injects durable model-facing context
   *   without running the model: admission or an open turn stages it for the
   *   next safe log position, while an injection outside that window appends
   *   immediately without opening a turn. If admission closes without a turn,
   *   a context-only boundary appends immediately; context staged beside
   *   steering remains pending with it.
   * The agent publishes or queues the identified frozen message as-is.
   * @param message - identified model-facing content and its producer provenance.
   * @param options - target queue and wakeup decision.
   */
  send(message: UserMessage, options: SendOptions): void

  /**
   * Reserve admission of the next ordinary turn while this agent is idle, so an
   * operation can mutate durable history before any queued prompt derives a
   * request from it. Already-accepted waking work has right of way, including a
   * send whose wake is still a pending microtask. Later sends keep their
   * ordinary placement, FIFO order, and `wakeup` facts, and
   * {@link acceptsNextStep} stays `false`, so a waking `next-step` send becomes
   * a queued follow-up rather than steering; cancellation and disposal may
   * still discard them. {@link inject} is not withheld. {@link whenIdle} treats
   * a live reservation as activity, while lifecycle teardown does not await it.
   * @returns the idempotent release, or `undefined` when the agent is running, already reserved, or already committed to waking work.
   */
  reserveTurnAdmission(): (() => void) | undefined

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
   * turn. An effective call first emits `agent/cancel-requested` with the
   * resolved typed cause. The first cause wins for the active turn, and
   * `whenIdle()` resolves after cancellation reaches quiescence. Idle
   * cancellation is a no-op and does not arm later work.
   * @param cause - the stable caller intent carried by the current turn signal.
   * @param options - cancellation options; `keepInbox` preserves pending work.
   */
  cancel(cause: AgentCancelCause, options?: CancelOptions): void

  /** Resolve at idle quiescence; disposal waits for driver exit rather than only the status transition. */
  whenIdle(): Promise<void>

  /**
   * Queue an ordinary follow-up turn and wake the driver — the
   * `next-turn`/wakeup preset of {@link send}. The item becomes the sole
   * ordinary message of its own turn.
   * @param message - identified prompt content and its producer provenance.
   */
  followup(message: UserMessage): void

  /**
   * Submit steering with a message-owned admission receipt — the
   * `next-step`/wakeup preset of {@link send}. During prompt admission or an
   * open turn, the message waits in the steering FIFO until a committed step
   * snapshots it; outside that window it enters the ordinary queued FIFO. The
   * receipt resolves `admitted` only after the message joins that step's
   * immutable request history, or `rejected` when terminal policy,
   * cancellation, or disposal discards it first. A non-terminal turn close may
   * leave it staged for a later admitted prompt without settling the receipt.
   * @param message - identified steering content and its producer provenance.
   * @returns the receipt for this exact message's eventual admission outcome.
   */
  steer(message: UserMessage): SteeringReceipt

  /**
   * Append model-facing context without running the model — the
   * `next-step`/no-wakeup preset of {@link send}. Admission or an open turn
   * stages it at the next safe log position; outside that window it appends
   * immediately without opening a turn. If admission closes without a turn,
   * a context-only boundary appends immediately; context staged beside
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
     * Agent status changed (`idle` ⇄ `running`). `send()` does not enter
     * `running` synchronously; drive lifecycle from this event.
     * @param agent - the agent whose status flipped.
     * @param status - the status just entered (the transition's destination).
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/status'(this: Scoped<Agent>, agent: Agent, status: AgentStatus): void
    /**
     * An item entered the queued or steering inbox. `placement` is the
     * acceptance-time routing result; listeners must not reconstruct it from
     * later agent or session state.
     * @param agent - the owning agent.
     * @param item - accepted occurrence, message, and resolved placement.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/enqueue'(this: Scoped<Agent>, agent: Agent, item: InboxItem): void
    /**
     * A still-pending queued item changed content. The item id, placement, and
     * position remain stable while the event carries the replacement message.
     * @param agent - the owning agent.
     * @param item - the complete post-update occurrence.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/update'(this: Scoped<Agent>, agent: Agent, item: InboxItem): void
    /**
     * The driver claimed one item out of the inbox: a queued item at a turn
     * boundary, or steering drained between steps. Fires after the item leaves
     * its FIFO and before it becomes a durable message.
     * @param agent - the agent whose inbox item was claimed.
     * @param item - the exact claimed occurrence.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/dequeue'(this: Scoped<Agent>, agent: Agent, item: InboxItem): void
    /**
     * Pending inbox items were dropped without delivering them, so every
     * enqueue occurrence receives exactly one terminal `agent/inbox/dequeue` OR
     * `agent/inbox/discard`. `cancel()` without `keepInbox`, including disposal,
     * emits this after `agent/cancel-requested` when applicable and before
     * aborting the active work. Fires once per drop with every dropped item.
     * @param agent - the agent whose inbox items were dropped.
     * @param items - the discarded occurrences in FIFO order (queued then steering); never empty.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/discard'(this: Scoped<Agent>, agent: Agent, items: InboxItem[]): void
    /**
     * Effective broad cancellation was requested, before queued/outbox work
     * is cleared or the active turn is aborted. This observe-only notification
     * cannot veto cancellation; listener failures are contained.
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
     * Allow, rewrite, or block one claimed prompt before it becomes a user
     * message or opens a turn. Call `next()` for the unchanged default. The
     * signal controls only this admission attempt; listeners may cooperate with
     * it but must not retain it for a later attempt or turn.
     * @param agent - the agent whose turn claimed the message.
     * @param message - the frozen claimed message, including identity and source.
     * @param signal - the current turn's explicit abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/prompt-submit'(this: Scoped<Agent>, agent: Agent, message: UserMessage, signal: AbortSignal, next: () => Promise<PromptDecision>): Promise<PromptDecision>
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
     * Handle a model-request failure after its failed step has closed but
     * before the failed turn closes. A listener returns `{ kind: 'retry' }`
     * without calling `next()` when it owns the error, or calls `next()` to
     * delegate. The default `undefined` leaves the failure terminal.
     * @param agent - the agent whose request failed.
     * @param turn - the open turn number.
     * @param step - the failed step number.
     * @param error - the original model-request failure.
     * @param failure - serializable facts normalized at the final adapter boundary.
     * @param priorFailures - immutable failures that already authorized another
     * retry turn in this consecutive sequence.
     * @param retryPolicy - immutable policy of the adapter registration that served
     * the failed request, or `undefined` if no final adapter served it.
     * @param signal - the turn abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/request-error'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, error: RequestError, failure: LlmFailure, priorFailures: readonly LlmFailure[], retryPolicy: ResolvedRetryPolicy | undefined, signal: AbortSignal, next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction>
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
    /**
     * One drain chain reached its terminal turn: that turn's `turn/end` is
     * already committed. Automatically recovered failed turns do not emit this
     * notification, and neither does a run that aborts or fails before its
     * `turn/start` commits — there is no durable turn to settle against.
     * `reason` says why; model-request recovery is exhausted when an error
     * reaches it.
     * @param agent - the agent whose turn closed.
     * @param turn - the terminal turn number.
     * @param reason - why the terminal turn ended, with live error facts when it failed.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/settled'(this: Scoped<Agent>, agent: Agent, turn: number, reason: SettleReason): void

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
