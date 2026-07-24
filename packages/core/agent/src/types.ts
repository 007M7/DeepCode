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
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { ContentBlock, LlmCallConfig, LlmFailure, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
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
 * An omitted source attests direct human input as `{ kind: 'user' }` and may
 * authorize policy consumers, so non-human producers must label their content.
 */
export interface SendOptions {
  /** Queue the item joins; defaults to `next-turn`. */
  target?: SendTarget
  /**
   * Whether this item makes the model run: wake a parked driver (`next-turn`)
   * or force a continuation step (`next-step` while running). Defaults to
   * `true`. A `false` `next-turn` item queues without waking; a `false`
   * `next-step` item attaches durable context without forcing another step
   * (the injection preset).
   */
  wakeup?: boolean
  source?: MessageSource
  /**
   * Model-facing contexts captured with this inbox item. A queued prompt exposes
   * them through the default `agent/prompt-submit` allow decision, while steering
   * records them directly at its next checkpoint.
   */
  contexts?: HookContext[]
}

/** Options accepted by the fixed-preset aliases, which own `target` and `wakeup`. */
export type AliasSendOptions = Omit<SendOptions, 'target' | 'wakeup'>

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
 * applied, so these are the exact values the item was accepted with. `steering`
 * is true for a `next-step` item drained between steps; a `next-turn` item is
 * claimed at a turn boundary.
 */
export interface AgentMessage {
  /** The id `send` returned for this message. */
  id: AgentMessageId
  content: ContentBlock[]
  source: MessageSource
  contexts: HookContext[]
  /** Whether the item joined the steering FIFO (`next-step`) rather than the queued FIFO. */
  steering: boolean
  /** Whether the item is marked to wake the driver or force a continuation. */
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
 * transition leaves it, and `send`/`followup`/`steer`/`inject` throw).
 */
export type AgentStatus = 'idle' | 'running'

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
}

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
   * Detaches, validates, and freezes one lossless-JSON item, then routes it:
   *
   * - `next-turn` (default) queues an item that becomes the sole ordinary
   *   message of its own FIFO-ordered turn; `wakeup` (default `true`) wakes a
   *   parked driver, while `wakeup:false` queues without waking.
   * - `next-step` with `wakeup:true` submits steering into the active turn
   *   (idle falls back to a woken `next-turn`).
   * - `next-step` with `wakeup:false` injects durable model-facing context
   *   without running the model: an open turn joins at the current log position
   *   (deferred behind an executing tool batch until it settles), and an idle
   *   inject records a one-shot turn with its own durability checkpoint.
   *
   * Attached contexts share the same snapshot and ownership boundary. Invalid
   * input throws synchronously before any notification, enqueue, or append.
   * @param content - the model-facing content blocks to deliver.
   * @param options - target queue, wakeup decision, source, contexts, and meta.
   * @returns the accepted message's {@link AgentMessageId}, stable across its `agent/inbox/*` events.
   */
  abstract send(content: ContentBlock[], options?: SendOptions): AgentMessageId

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
   * @param options - source and attached contexts.
   * @returns the accepted message's {@link AgentMessageId}.
   */
  followup(content: ContentBlock[], options?: AliasSendOptions): AgentMessageId {
    return this.send(content, { ...options, target: 'next-turn', wakeup: true })
  }

  /**
   * Submit steering into the running turn — the `next-step`/wakeup preset of
   * {@link send}. An open turn records it at the next steering checkpoint before
   * a request or continuation decision; policy may stop before another step.
   * After turn close and its checkpoint, any remainder is queued for a later
   * turn; terminal `agent/turn-stop`, cancellation, or disposal may discard it.
   * Idle steering falls back to a woken follow-up turn.
   * @param content - the steering content blocks.
   * @param options - source and attached contexts.
   * @returns the accepted message's {@link AgentMessageId}.
   */
  steer(content: ContentBlock[], options?: AliasSendOptions): AgentMessageId {
    return this.send(content, { ...options, target: 'next-step', wakeup: true })
  }

  /**
   * Append detached model-facing context without running the model — the
   * `next-step`/no-wakeup preset of {@link send}. An open-turn injection joins
   * at the current log position unless the current tool batch is executing;
   * then it waits FIFO until that batch settles and drains before turn close
   * even when interrupted. Idle injection uses a one-shot turn and durability
   * checkpoint. Disposal awaits idle checkpoints; flush failures report through
   * `agent/error`. An omitted source defaults to `{ kind: 'plugin', plugin: '' }`.
   * @param content - the injected context content blocks.
   * @param options - source and durable model-hidden meta.
   * @returns the accepted message's {@link AgentMessageId}.
   */
  inject(content: ContentBlock[], options?: AliasSendOptions): AgentMessageId {
    return this.send(content, { ...options, target: 'next-step', wakeup: false })
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
     * A frozen item entered the queued or steering inbox.
     * @param agent - the owning agent.
     * @param message - accepted routing data and correlation identity.
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
     * `cancel()` (without `keepInbox`) dropped pending inbox items without
     * delivering them. Fires once per effective clearing call with every
     * discarded item, after `agent/cancel-requested` and before the abort.
     * @param agent - the agent whose inbox was cleared.
     * @param messages - the discarded messages in FIFO order (queued then steering); empty when nothing was pending.
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
    'agent/error'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, error: Error): void
  }
}
