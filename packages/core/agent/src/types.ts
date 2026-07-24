/**
 * Public agent types and live-runtime events. Durable transcript facts and
 * turn/step boundaries remain `@deepseek-ai/dsh-session` events.
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { Context } from 'cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { ContentBlock, LlmCallConfig, LlmFailure, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId, UserMessageData } from '@deepseek-ai/dsh-session'
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
 * Which inbox queue a {@link Agent.send} item joins:
 * - `next-turn` — the item becomes its own turn, claimed at a turn boundary.
 * - `next-step` — the item joins the active turn between steps as steering,
 *   or, when no turn is active, is promoted per its `wakeup` flag.
 */
export type SendTarget = 'next-turn' | 'next-step'

/**
 * Options for the unified {@link Agent.send} primitive over the
 * (`target` × `wakeup`) matrix. Named presets: {@link Agent.followup}
 * (`next-turn`/wakeup), {@link Agent.steer} (`next-step`/wakeup), and
 * {@link Agent.inject} (`next-step`/no-wakeup).
 *
 * The object is complete so routing and provenance are explicit; callers that
 * want the ordinary user-message preset use {@link Agent.followup}.
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
  /** Producer provenance; direct human input uses `{ kind: 'user' }`. */
  source: MessageSource
}

/** Options accepted by the fixed-preset aliases, which own `target` and `wakeup`. */
export interface AliasSendOptions {
  /** Producer provenance; each alias supplies its documented default when omitted. */
  source?: MessageSource
}

/**
 * Opaque id assigned to one accepted {@link Agent.send} message; returned by
 * `send` and carried on its `agent/inbox/*` events for correlation.
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
 * One accepted {@link Agent.send} message, carried by the `agent/inbox/*` live
 * events. `id` is the value `send` returned to the caller, stable across this
 * message's enqueue, dequeue, and discard events. Source defaults are already
 * applied, so these are the exact values the item was accepted with.
 */
export interface AgentMessage extends UserMessageData {
  /** The id `send` returned for this message. */
  id: AgentMessageId
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
 * transition leaves it, and `send`/`followup`/`steer`/`inject` throw).
 */
export type AgentStatus = 'idle' | 'running'

/** Additional model-facing context produced beside a prompt or tool result. */
export type AdditionalContext = UserMessageData

/**
 * Prompt interception result. `allow.content` replaces the prompt, while
 * `additionalContexts` appends model-facing context before the turn starts.
 * An `allow` returned by a listener is authoritative: a listener wrapping
 * `next()` preserves both fields unless it intentionally replaces them.
 */
export type PromptDecision =
  | { kind: 'allow'; content?: ContentBlock[]; additionalContexts?: AdditionalContext[] }
  | { kind: 'block'; reason: string }

/**
 * Why a turn ended, reported live on `agent/idle` right after the turn's
 * durable `turn/end` and flush. `error` carries the thrown value verbatim (and, for
 * model-request failures, the adapter-normalized facts) so a recovery
 * consumer can decide to repair and {@link Agent.retry}.
 */
export type IdleReason =
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

/** Public live-agent handle with aliases over the unified delivery primitive. */
export abstract class Agent {
  /** The single identity shared with {@link session}. */
  abstract readonly id: SessionId
  /** The provider route and model this agent's requests use. */
  abstract readonly options: AgentOptions
  /** The live session this agent drives; its log is the durable source of truth. */
  abstract readonly session: Session
  /** The current lifecycle state, mirrored on every `agent/status` transition. */
  abstract readonly status: AgentStatus
  /** Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. */
  abstract readonly ctx: Context

  /**
   * The unified delivery primitive over the (`target` × `wakeup`) matrix.
   * It routes the caller's typed content and source as follows:
   *
   * - `next-turn` queues an item that becomes the sole ordinary message of its
   *   own FIFO-ordered turn; `wakeup:true` wakes a
   *   parked driver, while `wakeup:false` queues without waking.
   * - `next-step` with `wakeup:true` submits steering into the active turn
   *   (idle falls back to a woken `next-turn`).
   * - `next-step` with `wakeup:false` injects durable model-facing context
   *   without running the model: an open turn stages it for the next safe log
   *   position, while an idle injection appends it immediately without opening
   *   a turn.
   * @param content - the model-facing content blocks to deliver.
   * @param options - target queue, wakeup decision, and source.
   * @returns the accepted message's {@link AgentMessageId}, stable across its `agent/inbox/*` events.
   */
  abstract send(content: ContentBlock[], options: SendOptions): AgentMessageId

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
  abstract cancel(cause: AgentCancelCause, options?: CancelOptions): void

  /** Resolve at idle quiescence; disposal waits for driver exit rather than only the status transition. */
  abstract whenIdle(): Promise<void>

  /**
   * Queue an ordinary follow-up turn and wake the driver — the
   * `next-turn`/wakeup preset of {@link send}. The item becomes the sole
   * ordinary message of its own turn.
   * @param content - the prompt content blocks.
   * @param options - message source.
   * @returns the accepted message's {@link AgentMessageId}.
   */
  followup(content: ContentBlock[], options?: AliasSendOptions): AgentMessageId {
    return this.send(content, {
      target: 'next-turn',
      wakeup: true,
      source: options?.source ?? { kind: 'user' },
    })
  }

  /**
   * Submit steering into the running turn — the `next-step`/wakeup preset of
   * {@link send}. An open turn records it at the next steering checkpoint before
   * a request or stop decision. If the turn fails before that boundary, the
   * remainder stays staged without waking the agent; retry or a later prompt
   * takes it. Idle steering falls back to a woken follow-up turn, while
   * cancellation or disposal may discard pending steering.
   * @param content - the steering content blocks.
   * @param options - message source.
   * @returns the accepted message's {@link AgentMessageId}.
   */
  steer(content: ContentBlock[], options?: AliasSendOptions): AgentMessageId {
    return this.send(content, {
      target: 'next-step',
      wakeup: true,
      source: options?.source ?? { kind: 'user' },
    })
  }

  /**
   * Append model-facing context without running the model — the
   * `next-step`/no-wakeup preset of {@link send}. An open-turn injection stages
   * at the next safe log position; an idle injection appends immediately
   * without opening a turn. An omitted source defaults to
   * `{ kind: 'plugin', plugin: '' }`.
   * @param content - the injected context content blocks.
   * @param options - context source.
   * @returns the accepted message's {@link AgentMessageId}.
   */
  inject(content: ContentBlock[], options?: AliasSendOptions): AgentMessageId {
    return this.send(content, {
      target: 'next-step',
      wakeup: false,
      source: options?.source ?? { kind: 'plugin', plugin: '' },
    })
  }

  /**
   * Re-open a turn on the current session log without a new prompt — the
   * recovery verb. After an `agent/idle` error, a consumer repairs (edits the
   * log, waits out a rate limit) and calls this; the machine immediately runs
   * another turn over the repaired history. Calling it synchronously from an
   * `agent/idle` listener is legal — the machine is already idle there.
   * @throws while a turn is running because there is nothing to retry yet.
   */
  abstract retry(): void
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
     * An item entered the queued or steering inbox.
     * @param agent - the owning agent.
     * @param message - accepted content, source, and correlation identity.
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
     * `agent/inbox/discard`. `cancel()` without `keepInbox`, including disposal,
     * emits this after `agent/cancel-requested` when applicable and before
     * aborting the active work. Fires once per drop with every dropped item.
     * @param agent - the agent whose inbox items were dropped.
     * @param messages - the discarded messages in FIFO order (queued then steering); never empty.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/discard'(this: Scoped<Agent>, agent: Agent, messages: AgentMessage[]): void
    /**
     * Effective broad cancellation was requested, before queued/outbox work
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

    // ---- the machine's extension seams ----
    /**
     * Allow, rewrite, or block one claimed prompt before it becomes a user
     * message. Call `next()` for the unchanged default. The signal controls only this turn;
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
     * @mode waterfall
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
    'agent/error'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, error: unknown): void
  }
}
