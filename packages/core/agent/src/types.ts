/**
 * Agent interface and event taxonomy. Every plugin programs against the
 * `Agent` handle defined here; the concrete implementation lives in
 * `@deepseek-ai/dsh-agent-loop`.
 *
 * Merge-extensible: `AgentOptions` supports declaration merging for
 * plugin-specific creation options.
 *
 * ## Event-domain semantics (the boundary rule)
 *
 * The harness has three event domains, each with one job:
 *
 * - **`session/*`** (`@deepseek-ai/dsh-session`) — the DURABLE, replayable FACT
 *   log. Owns `SessionEventMap`; every entry is JSON-only (no live objects).
 *   One `session/event` emit per append, plus the `session/flush` parallel
 *   durability checkpoint. Answers "what happened, durably/replayably." A
 *   consumer that wants the live transcript subscribes here.
 * - **`agent/*`** (this module) — the LIVE runtime surface. Always carries the
 *   live `Agent`. Two shapes: INTERCEPTION waterfalls (`agent/request`,
 *   `agent/step-result`, `agent/turn-continuation`) that mutate/veto, and
 *   TRANSIENT emits (`agent/status`, `agent/stream-chunk`, `agent/error`,
 *   `agent/created`/`agent/disposed`, `agent/queued`, `agent/steering`, and the
 *   turn boundaries) that notify with the `Agent` in hand. Answers "right now,
 *   with the agent object — intercept or observe."
 * - **`tools/*`** (`@deepseek-ai/dsh-tools`) — the tool registry + execution.
 *
 * **The rule:** a durable, replayable fact is a SessionEvent; a live
 * interception or a transient/live-object signal is an `agent`/`tools` Cordis
 * event. A datum that is BOTH (a turn/step boundary) lives in the session log,
 * and is mirrored as an `agent/*` emit ONLY where a live consumer provably
 * needs the `Agent` handle at that instant. Turn boundaries are so mirrored
 * (the stdio UI labels output by `agent.id`); step boundaries are NOT (no live
 * consumer needs them — read `step/start`/`step/end` from the session log).
 * See `docs/rfc/implemented/architecture/2026-06-11-microkernel-event-taxonomy.md`
 * and the related `docs/rfc/proposed/simplification/2026-06-20-remove-agent-boundary-mirror-events.md`.
 *
 * The interception waterfalls here (`agent/prompt-submit`, `agent/request`,
 * `agent/step-result`, `agent/turn-continuation`) each return a typed Decision —
 * the convention pinned by
 * `docs/rfc/implemented/feature/2026-06-30-interception-seams.md`.
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, GenerateOptions, Message, MessageSource, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Identifies one live agent in the registry. */
export type AgentId = Branded<'AgentId'>

/** Brand a string as an {@link AgentId}. */
export function AgentId(id: string): AgentId {
  return id as AgentId
}
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'

/**
 * Options an agent is created with.
 * Merge-extensible: plugins declare extra fields via declaration merging.
 */
export interface AgentOptions {
  /** Model name (must have a registered adapter at call time). */
  model?: string
  /** Per-agent system prompt appended after the assembled sections. */
  systemPrompt?: string
}

export interface SendOptions {
  source?: MessageSource
}

export type AgentStatus = 'idle' | 'running' | 'disposed'

/**
 * Model-facing context an interception listener wants the agent to SEE on the
 * next request — the canonical shape behind every "inject extra context"
 * decision ({@link PromptDecision}, {@link PostToolDecision},
 * {@link ContinuationDecision}). It is `agent.inject()`ed as a
 * `context/message`, so it carries a REQUIRED {@link MessageSource}: `inject()`
 * defaults a missing source to `{kind:'user'}`, which would MISLABEL plugin
 * context as a user prompt and corrupt derived history. A bridge sets
 * `{kind:'plugin', plugin:'…'}`; a native plugin names itself. Required, not
 * optional — the label is load-bearing, never defaulted here.
 */
export interface HookContext {
  content: ContentBlock[]
  source: MessageSource
}

/**
 * The decision an {@link Agent} `agent/prompt-submit` waterfall listener returns
 * for ONE drained queued message, before it becomes a `user/message`. Maps onto
 * the Claude Code `UserPromptSubmit` hook's allow/block + `additionalContext`.
 *
 * - `allow` proceeds with the prompt; optional `content` REPLACES the prompt
 *   bytes (a rewrite), and optional `additionalContext` is `inject()`ed as a
 *   separate `context/message` the next request also sees.
 * - `block` drops the prompt entirely; `reason` is the durable record of why.
 *   A batch whose every prompt is blocked still opens a zero-step turn that ends
 *   with {@link TurnEndReason} `rejected` (so the boundary stays balanced and a
 *   UI can render "blocked by hook").
 */
export type PromptDecision =
  | { kind: 'allow'; content?: ContentBlock[]; additionalContext?: HookContext }
  | { kind: 'block'; reason: string }

/**
 * The decision an {@link Agent} `agent/turn-continuation` waterfall listener
 * returns. The loop computes the default (`continue` when the step had tool
 * calls or steering was injected, else `stop`); listeners override it to
 * force-continue (`/goal`, `/loop`) or force-stop (budget guards).
 *
 * A `continue` may carry a `reason`: model-facing context recorded as next-STEP
 * steering within the SAME turn (the loop enqueues it through the steering
 * channel, so the continued turn's next step sees it). This is the typed twin of
 * the existing "steer from a step/end listener" `/goal` pattern.
 */
export type ContinuationDecision =
  | { action: 'stop' }
  | { action: 'continue'; reason?: HookContext }

/**
 * Why an agent's session lifecycle began, carried by `agent/session-start`. A
 * bridge keys its SessionStart hook's matcher on this (Claude Code's
 * `startup`/`resume`/`clear`/`compact` source set). `startup` = a fresh create
 * (including a seeded/forked create — a seed is NOT a resume); `resume` = a
 * persisted session reloaded via `ctx.agents.resume()`. `clear`/`compact` are
 * driven by those subsystems (compact = `TODO(compaction)`).
 */
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'

/**
 * The agent handle — the surface every plugin (UI, hooks, orchestrators)
 * programs against. The concrete implementation lives in
 * `@deepseek-ai/dsh-agent-loop` (class `ReactLoopAgent`); nothing outside the loop
 * package should depend on the implementation.
 */
export interface Agent {
  readonly id: AgentId
  readonly options: AgentOptions
  readonly session: Session
  readonly status: AgentStatus

  /** Queue a user message. Starts a turn when idle; otherwise waits for the next turn. */
  send(content: ContentBlock[], options?: SendOptions): void

  /**
   * Steer a running turn: content is injected between steps of the current
   * turn. When idle, behaves like {@link send}.
   */
  steer(content: ContentBlock[], options?: SendOptions): void

  /**
   * Inject in-session context (file-change notices, skill content, cron
   * notifications, …): appends a `context/message` session event the next model
   * request sees at its chronological position, rendered as tagged synthetic
   * context rather than a user prompt. Does not run the model.
   *
   * Turn-enclosure (the turn-enclosure RFC): an inject while a turn is open joins that turn;
   * an inject while idle wraps its `context/message` in a one-shot `injection`
   * turn (`turn/start` → `context/message` → `turn/end`) and checkpoints it for
   * durability, so every event stays inside a turn and a persistence backend
   * never loses a between-turn notice. The idle checkpoint is fire-and-forget
   * (inject is synchronous): a failing flush is reported via `agent/error`
   * (step `0`) and the logger, never thrown into the caller.
   *
   * Live-adapter review has validated the tagged-envelope rendering against
   * current DeepSeek behavior; provider-specific mismatches belong in that
   * adapter, not in the canonical session vocabulary.
   */
  inject(content: ContentBlock[], options?: SendOptions): void

  /**
   * Cancel ALL pending work for the agent. `cancel()`:
   *
   * - clears the queued FIFO (un-started prompts never run) and the steering
   *   FIFO (steering for the cancelled turn is dropped, not re-enqueued);
   * - aborts the in-flight step if one is running (the turn ends `aborted`);
   * - drops a turn that is about to start (a `cancel()` landing in the
   *   pre-step window — after a `send()` queued but before the loop flips to
   *   `running`, or after `running` is emitted but before the first step) so
   *   that queued prompt does not run and cannot be batched into the cancelled
   *   turn.
   *
   * After `cancel()`, `whenIdle()` resolves on the post-cancel quiescent state.
   * `cancel()` on an idle agent with nothing queued or running is a safe no-op
   * — it does NOT arm anything that would drop a later legitimate prompt.
   */
  cancel(reason?: string): void

  /**
   * Resolve once the agent has reached quiescence after settling out of
   * `running`, or immediately if it is already idle with no queued work. A
   * non-owner's quiescence-observation hook: a consumer that does NOT own the
   * agent's lifecycle awaits this to proceed only after queued/running work has
   * fully stopped, rather than returning while the driver is still streaming or
   * about to start a queued turn — without itself tearing the agent down. (A
   * lifecycle OWNER does not need it: `AgentHandle.dispose()` already awaits the
   * loop-exit promise directly as part of stopping and unregistering. So this is
   * for a non-owning observer — e.g. a test awaiting a turn to settle, or a
   * monitor — that wants the settle signal but must not dispose the agent.)
   *
   * "Quiescence", not merely "status changed": a disposed agent emits
   * `agent/status('disposed')` from inside its disposer, BEFORE the driver loop
   * has unwound — so `whenIdle()` resolving on `disposed` must wait for the loop
   * to actually exit (the implementation chains the loop-exit promise), not just
   * observe the status flip. A mid-step disposal that never reaches `idle` still
   * unblocks the await this way.
   */
  whenIdle(): Promise<void>

  // Subagent delegation is realized on top of this interface by the
  // `@deepseek-ai/dsh-subagent` seam, not by a method here: a backend creates
  // the child through `ctx.agents.create` (fork seeds the child Session with a
  // balanced prefix of the parent's log via `CreateAgentOptions.seed`; spawn
  // starts fresh) and drives it as an ordinary Agent handle, so steer() and
  // event subscription work uniformly. See docs/core-data-structures/subagent.md.
}

declare module 'cordis' {
  interface Events {
    // ---- lifecycle (emit) ----
    /**
     * An agent was registered in the {@link AgentRegistry} and is ready to
     * receive messages.
     * @mode emit
     */
    'agent/created'(agent: Agent): void
    /**
     * An agent was disposed and removed from the registry; its fiber and any
     * in-flight turn have been torn down.
     * @mode emit
     */
    'agent/disposed'(agent: Agent): void
    /**
     * Agent status changed (`idle` ⇄ `running`, or → `disposed`). Drive
     * lifecycle off this transition, never off a status you just requested —
     * `send()` does not flip status to `running` before it returns.
     * @mode emit
     */
    'agent/status'(agent: Agent, status: AgentStatus): void
    /**
     * A message entered the agent's inbox (queued or steering). `source` is
     * the resolved source (defaults applied), not the caller's raw options.
     * @mode emit
     */
    'agent/queued'(agent: Agent, content: ContentBlock[], info: { source: MessageSource; steering: boolean }): void

    // ---- session lifecycle (emit) ----
    /**
     * The agent's session lifecycle began, fired once before its first turn.
     * `source` says why ({@link SessionStartSource}: fresh startup, a resumed
     * persisted session, …). A pure NOTIFICATION (emit, not waterfall): it
     * carries no veto — a session-start listener that wants to seed context does
     * so via `agent.inject()` (a `context/message` the first request sees), not
     * by returning a decision. Cannot block the session from starting; that gap
     * is deliberate (a bridge logs/injects, it does not gate startup).
     * @mode emit
     */
    'agent/session-start'(agent: Agent, source: SessionStartSource): void

    // ---- turn boundaries (emit) — the live boundary surface ----
    // Step boundaries are NOT mirrored here: a consumer that needs per-step
    // boundaries reads the durable `step/start`/`step/end` session events (the
    // session log is the live transcript feed). The TURN boundaries stay as
    // agent/* emits because the only live consumer (the stdio UI) needs the
    // `Agent` handle at the boundary to label output, which the session event
    // does not carry. See the module doc's three-domain rule.
    /**
     * A turn began. `turn` is the 1-based turn number within the session.
     * @mode emit
     */
    'agent/turn-start'(agent: Agent, turn: number): void
    /**
     * A turn ended. `reason` distinguishes a clean stop from a truncated,
     * aborted, failed, disposed, or crash-interrupted one (`completed` |
     * `aborted` | `error` | `disposed` | `max-tokens` | `interrupted`); the
     * reason union is merge-extensible, so a plugin can add further variants.
     * @mode emit
     */
    'agent/turn-end'(agent: Agent, turn: number, reason: TurnEndReason): void

    // ---- interception seams (waterfall) ----
    /**
     * Waterfall: decide what happens to ONE drained queued message before it
     * becomes a `user/message` — allow (optionally rewriting the prompt bytes or
     * attaching `additionalContext`) or block it. Fires inside the already-open
     * turn, per drained message. Maps onto Claude Code's `UserPromptSubmit` hook.
     * Call `next()` to delegate to the default (allow unchanged), or return a
     * {@link PromptDecision} without calling `next()` to short-circuit.
     * @mode waterfall
     */
    'agent/prompt-submit'(agent: Agent, content: ContentBlock[], source: MessageSource, next: () => Promise<PromptDecision>): Promise<PromptDecision>
    /**
     * Waterfall: mutate the fully-assembled {@link GenerateOptions} before the
     * model call (hooks, compaction, model switching, tool filtering, …). Call
     * `next()` to delegate, or return without it to short-circuit.
     * @mode waterfall
     */
    'agent/request'(agent: Agent, turn: number, step: number, options: GenerateOptions, next: () => Promise<GenerateOptions>): Promise<GenerateOptions>
    /**
     * Waterfall: post-process the assembled assistant {@link Message} before
     * tool dispatch (validation, content rewriting, …).
     * @mode waterfall
     */
    'agent/step-result'(agent: Agent, turn: number, step: number, message: Message, next: () => Promise<Message>): Promise<Message>
    /**
     * Waterfall: override the turn-continuation decision via a typed
     * {@link ContinuationDecision}. The loop's `defaultDecision` is `continue`
     * when the step had tool calls or steering was injected, else `stop`.
     * Listeners force-continue (`/goal`, `/loop` — optionally attaching a
     * `reason` recorded as next-step steering) or force-stop (budget guards).
     * Call `next()` to delegate to the default, or return a decision to override.
     * @mode waterfall
     */
    'agent/turn-continuation'(agent: Agent, turn: number, defaultDecision: ContinuationDecision, next: () => Promise<ContinuationDecision>): Promise<ContinuationDecision>

    // ---- streaming + tool notifications (emit) ----
    /**
     * A raw {@link StreamChunk} arrived from the model (token-level UI/log feed).
     * @mode emit
     */
    'agent/stream-chunk'(agent: Agent, turn: number, step: number, chunk: StreamChunk): void
    /**
     * Steering content was injected into a running turn.
     * @mode emit
     */
    'agent/steering'(agent: Agent, turn: number, content: ContentBlock[], source: MessageSource): void
    /**
     * A step or turn errored. The loop reports a failure here (plus the logger)
     * even when the error has no in-turn position for a session `error` event.
     * @mode emit
     */
    'agent/error'(agent: Agent, turn: number, step: number, error: Error): void
  }
}
