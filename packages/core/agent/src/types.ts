/**
 * Agent interface and event taxonomy. Every plugin programs against the
 * `Agent` handle defined here; the concrete implementation lives in
 * `@deepseek-ai/dsh-agent-loop`.
 *
 * Merge-extensible: `AgentOptions` supports declaration merging for
 * plugin-specific creation options.
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

    // ---- turn/step boundaries (emit) ----
    /**
     * A turn began. `turn` is the 1-based turn number within the session.
     * @mode emit
     */
    'agent/turn-start'(agent: Agent, turn: number): void
    /**
     * A turn ended. `reason` distinguishes a clean stop from a truncated or
     * aborted one (`completed` | `aborted` | `error` | `disposed` | `max-tokens`).
     * @mode emit
     */
    'agent/turn-end'(agent: Agent, turn: number, reason: TurnEndReason): void
    /**
     * A step (one model call plus its tool dispatch) began. `step` is 1-based
     * within the turn; a turn runs one or more steps.
     * @mode emit
     */
    'agent/step-start'(agent: Agent, turn: number, step: number): void
    /**
     * A step ended.
     * @mode emit
     */
    'agent/step-end'(agent: Agent, turn: number, step: number): void

    // ---- interception seams (waterfall) ----
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
     * Waterfall: override the turn-continuation decision. The default
     * (computed by the loop) is `hadToolCalls || steeringInjected`. Listeners
     * can force-continue (/goal, /loop) or force-stop (budget guards).
     * @mode waterfall
     */
    'agent/turn-continuation'(agent: Agent, turn: number, defaultDecision: boolean, next: () => Promise<boolean>): Promise<boolean>

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
