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

import type { ContentBlock, GenerateOptions, Message, MessageSource, StreamChunk } from '@deepseek-ai/dsh-llm'
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
 * `@deepseek-ai/dsh-agent-loop` (class `LoopAgent`); nothing outside the loop
 * package should depend on the implementation.
 */
export interface Agent {
  readonly id: string
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
   * notifications, …): appends a `context/message` session event without
   * triggering a turn — the next model request sees it at its chronological
   * position, rendered as tagged synthetic context rather than a user prompt.
   *
   * TODO(review): exact envelope/rendering rules live in dsh-session and need
   * review once a real adapter exists.
   */
  inject(content: ContentBlock[], options?: SendOptions): void

  /** Abort the in-flight step (if any); the turn ends with reason 'aborted'. */
  abort(reason?: string): void

  // TODO(sub-agents): spawn/fork seams — semantics deliberately deferred.
  // The intended shape: a creation option referencing a parent agent
  // (fork = seed the child Session with the parent's event log; spawn =
  // fresh Session), with the child returned as an Agent handle so steer()
  // and event subscription work uniformly. See docs/architecture.md.
}

declare module 'cordis' {
  interface Events {
    // ---- lifecycle (emit) ----
    /** An agent was registered. */
    'agent/created'(agent: Agent): void
    /** An agent was disposed. */
    'agent/disposed'(agent: Agent): void
    /** Agent status changed (idle/running/disposed). */
    'agent/status'(agent: Agent, status: AgentStatus): void
    /**
     * A message entered the agent's inbox (queued or steering). `source` is
     * the resolved source (defaults applied), not the caller's raw options.
     */
    'agent/queued'(agent: Agent, content: ContentBlock[], info: { source: MessageSource; steering: boolean }): void

    // ---- turn/step boundaries (emit) ----
    'agent/turn-start'(agent: Agent, turn: number): void
    'agent/turn-end'(agent: Agent, turn: number, reason: TurnEndReason): void
    'agent/step-start'(agent: Agent, turn: number, step: number): void
    'agent/step-end'(agent: Agent, turn: number, step: number): void

    // ---- interception seams (waterfall) ----
    /**
     * Waterfall: mutate the fully-assembled GenerateOptions before the model
     * call (hooks, compaction, model switching, tool filtering, …).
     */
    'agent/request'(agent: Agent, turn: number, step: number, options: GenerateOptions, next: () => Promise<GenerateOptions>): Promise<GenerateOptions>
    /**
     * Waterfall: post-process the assembled assistant message before tool
     * dispatch (validation, content rewriting, …).
     */
    'agent/step-result'(agent: Agent, turn: number, step: number, message: Message, next: () => Promise<Message>): Promise<Message>
    /**
     * Waterfall: override the turn-continuation decision. The default
     * (computed by the loop) is `hadToolCalls || steeringInjected`. Listeners
     * can force-continue (/goal, /loop) or force-stop (budget guards).
     */
    'agent/turn-continuation'(agent: Agent, turn: number, defaultDecision: boolean, next: () => Promise<boolean>): Promise<boolean>

    // ---- streaming + tool notifications (emit) ----
    /** A raw stream chunk arrived (token-level UI/log feed). */
    'agent/stream-chunk'(agent: Agent, turn: number, step: number, chunk: StreamChunk): void
    /** Steering content was injected into a running turn. */
    'agent/steering'(agent: Agent, turn: number, content: ContentBlock[], source: MessageSource): void
    /** A step or turn errored. */
    'agent/error'(agent: Agent, turn: number, step: number, error: Error): void
  }
}
