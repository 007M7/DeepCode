/**
 * Agent interface and event taxonomy. Every plugin programs against the `Agent` handle defined
 * here; the concrete implementation lives in `@deepseek-ai/dsh-agent-loop`.
 * Scope-filtered dispatch: keyed to `agent`.
 * @module @deepseek-ai/dsh-agent/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Context } from 'cordis'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { ContentBlock, LlmCallConfig, Message, MessageSource } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Identifies one live agent in the registry. */
export type AgentId = Branded<'AgentId'>

/**
 * Brand a string as an {@link AgentId}.
 * @param id - the raw agent id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
export function AgentId(id: string): AgentId {
  return id as AgentId
}
import type { Session } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-system-prompt' {
  interface AssembleContext {
    /**
     * The agent this assembly is for. The agent loop passes it on every
     * per-step assembly (via its `assembleContextFor(agent)` helper, which
     * also sets the `scope` field to the same agent — the layer selector
     * `dsh-system-prompt` reads); variable providers project per-agent facts
     * from it (`options.model` → `{{model}}`, `session.header.cwd` →
     * `{{cwd}}`). Optional because a bare `assemble()` (tests, diagnostics)
     * has no agent — providers must tolerate its absence. Never set `agent`
     * without `scope`: the assembly would silently miss the agent's scoped
     * sections/tools (the dev invariants flag it).
     */
    agent?: Agent
  }
}

/**
 * Options an agent is created with. The persona is NOT here — it is the
 * deployment's `persona` config on the dsh-system-prompt plugin, shared by
 * every agent in the context.
 * Merge-extensible: plugins declare extra fields via declaration merging.
 */
export interface AgentOptions {
  /** Model name (must have a registered adapter at call time). */
  model?: string
}

/**
 * Options for {@link Agent.send}/{@link Agent.steer}/{@link Agent.inject}. An
 * absent `source` resolves to `{ kind: 'user' }`, so a plugin supplying content
 * must label itself here or its message is recorded as a user prompt (see
 * {@link HookContext} on why that label is load-bearing).
 */
export interface SendOptions {
  source?: MessageSource
}

/**
 * An agent's lifecycle state, emitted on every transition as `agent/status`:
 * `idle` (parked, waiting for queued work), `running` (a turn is in progress),
 * `disposed` (terminal — no transition leaves it, and `send`/`steer`/`inject`
 * throw).
 */
export type AgentStatus = 'idle' | 'running' | 'disposed'

/** Model-facing injected context with an explicit, non-defaulted source. */
export interface HookContext {
  content: ContentBlock[]
  source: MessageSource
}

/**
 * The decision an {@link Agent} `agent/prompt-submit` waterfall listener returns for one
 * drained queued message, before it becomes a `user/message`. Maps onto the Claude Code
 * `UserPromptSubmit` hook's allow/block + `additionalContext`.
 */
export type PromptDecision =
  | { kind: 'allow'; content?: ContentBlock[]; additionalContext?: HookContext }
  | { kind: 'block'; reason: string }

/** Continuation override; a continue reason is recorded as next-step steering. */
export type ContinuationDecision =
  | { action: 'stop' }
  | { action: 'continue'; reason?: HookContext }

/**
 * The terminal subset of {@link ContinuationDecision}. A listener on
 * `agent/turn-stop` returns this to make the already-composed continuation
 * outcome terminal; `undefined` abstains.
 */
export type ContinuationStop = Extract<ContinuationDecision, { action: 'stop' }>

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
  /**
   * The agent's scope context (`@deepseek-ai/dsh-scope`, key = this agent).
   * Registrations through it — tools, prompt sections/variables, event
   * listeners, restrictions — are visible to THIS agent only and unwind when
   * the agent is disposed; `agent.ctx.on('agent/…')` listeners fire only for
   * this agent's dispatches (zero self-filtering). Service resolution through
   * it flows through the loop plugin's dependency surface — handing out
   * `agent.ctx` hands out that capability. Live for exactly the agent's
   * lifetime: registrations after disposal throw Cordis's INACTIVE_EFFECT.
   */
  readonly ctx: Context

  /** Queue a user message. Starts a turn when idle; otherwise waits for the next turn. */
  send(content: ContentBlock[], options?: SendOptions): void

  /**
   * Steer a running turn: content is injected between steps of the current
   * turn. When idle, behaves like {@link send}.
   */
  steer(content: ContentBlock[], options?: SendOptions): void

  /**
   * Inject in-session context (file-change notices, skill content, cron notifications, …):
   * appends a `context/message` session event the next model request sees at its chronological
   * position, rendered as tagged synthetic context rather than a user prompt. Does not run the
   * model.
   */
  inject(content: ContentBlock[], options?: SendOptions): void

  /**
   * Cancel ALL pending work for the agent. `cancel()`.
   */
  cancel(reason?: string): void

  /**
   * Resolve once the agent has reached quiescence after settling out of `running`, or
   * immediately if it is already idle with no queued work.
   */
  whenIdle(): Promise<void>

  // Subagent backends create ordinary child Agent handles through the subagent seam.
}

declare module 'cordis' {
  interface Events {
    // ---- lifecycle (emit) ----
    /**
     * An agent's fully composed scoped world was published in the {@link AgentRegistry}.
     *
     * @param agent - the newly registered agent with its live session and completed setup.
     * @mode emit
     */
    'agent/created'(this: Scoped<Agent>, agent: Agent): void
    /**
     * An agent was removed from the registry after its driver and any in-flight turn
     * reached quiescence.
     *
     * Scope-filtered dispatch: keyed to `agent`.
     * @param agent - the deregistered agent; its driving handle is now inert.
     * @mode emit
     */
    'agent/disposed'(this: Scoped<Agent>, agent: Agent): void
    /**
     * Agent status changed (`idle` ⇄ `running`, or → `disposed`).
     *
     * Scope-filtered dispatch: keyed to `agent`.
     * @param agent - the agent whose status flipped.
     * @param status - the status just entered (the transition's destination).
     * @mode emit
     */
    'agent/status'(this: Scoped<Agent>, agent: Agent, status: AgentStatus): void
    /**
     * A message entered the agent's inbox (queued or steering). `source` is the resolved
     * source (defaults applied), not the caller's raw options.
     *
     * Scope-filtered dispatch: keyed to `agent`.
     * @param agent - the agent whose inbox received the message.
     * @param content - the enqueued content blocks, verbatim.
     * @param info - the resolved source plus whether it entered as steering.
     * @mode emit
     */
    'agent/queued'(this: Scoped<Agent>, agent: Agent, content: ContentBlock[], info: { source: MessageSource; steering: boolean }): void

    // ---- session lifecycle (emit) ----
    /**
     * The agent's session lifecycle began, fired once before its first turn. `source` says why
     * ({@link SessionStartSource}: fresh startup, a resumed persisted session, …).
     *
     * Scope-filtered dispatch: keyed to `agent`.
     * @param agent - the agent whose session lifecycle began.
     * @param source - why the session started (fresh startup, resume, …).
     * Dispatch is scoped to `agent`.
     * @mode emit
     */
    'agent/session-start'(this: Scoped<Agent>, agent: Agent, source: SessionStartSource): void

    // Turn and step boundaries are not mirrored as agent/* emits: a consumer that needs them
    // reads the durable `turn/start`/`turn/end`/`step/start`/ `step/end` session events off the
    // `session/event` feed (the session log is the live transcript feed).

    // ---- step/request extension seams (serial + waterfall) ----
    /**
     * Awaited checkpoint for surface mutation before `step/start` snapshots request history.
     * Scope-filtered dispatch: keyed to `agent`.
     * @param agent - the agent about to open the step.
     * @param turn - open turn number.
     * @param step - upcoming step number.
     * @param fullSystemPrompt - the assembled prompt, for measuring token pressure.
     * @param sessionPrefix - frozen prefix for the same measurement.
     * @param signal - aborts in-flight listener work when the turn is torn down.
     * @mode serial
     */
    // TODO: move prompt-pressure inputs behind compaction if no second consumer appears.
    'agent/pre-step'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, fullSystemPrompt: string, sessionPrefix: readonly Message[], signal: AbortSignal): Promise<void> | void
    /**
     * Waterfall: decide what happens to one drained queued message before it becomes a
     * `user/message` — allow (optionally rewriting the prompt bytes or attaching
     * `additionalContext`) or block it.
     *
     * Scope-filtered dispatch: keyed to `agent`.
     * @param agent - the agent draining its inbox.
     * @param content - the drained message's blocks, as queued.
     * @param source - the message's resolved source.
     * @mode waterfall
     */
    'agent/prompt-submit'(this: Scoped<Agent>, agent: Agent, content: ContentBlock[], source: MessageSource, next: () => Promise<PromptDecision>): Promise<PromptDecision>
    /**
     * Waterfall: shape the step's call configuration — model switching, sampling overrides
     * — by returning a replacement {@link LlmCallConfig} (the frozen seed is the config the
     * loop would otherwise use).
     *
     * Scope-filtered dispatch: keyed to `agent`.
     * @param agent - the agent making the model call.
     * @param turn - the open turn number.
     * @param step - the step whose request this is.
     * @param config - the config the loop would use (frozen); return a replacement to
     *   switch.
     * @mode waterfall
     */
    'agent/request'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, config: LlmCallConfig, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
    /**
     * Waterfall: compose the SESSION PREFIX — request-only messages placed in front of the
     * entire derived history (directly after the provider's system slot) on every request this
     * loop instance sends.
     *
     * Scope-filtered dispatch: keyed to `agent`.
     * @param agent - the agent whose session prefix is being composed.
     * @param prefix - the frozen empty seed; return an extended replacement to contribute.
     * @param signal - aborts in-flight listener work (e.g. a discovery scan) when the step is torn down.
     * @mode waterfall
     */
    'agent/session-prefix'(this: Scoped<Agent>, agent: Agent, prefix: Message[], signal: AbortSignal, next: () => Promise<Message[]>): Promise<Message[]>
    /**
     * Waterfall: post-process the assembled assistant {@link Message} before tool dispatch
     * (validation, content rewriting, …).
     *
     * Scope-filtered dispatch: keyed to `agent`.
     * @param agent - the agent that received the step's response.
     * @param turn - the open turn number.
     * @param step - the step that produced the message.
     * @param message - the assistant message as assembled from the stream.
     * @mode waterfall
     */
    'agent/step-result'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, message: Message, next: () => Promise<Message>): Promise<Message>
    /**
     * Waterfall: override the turn-continuation decision via a typed {@link
     * ContinuationDecision}.
     *
     * Scope-filtered dispatch: keyed to `agent`.
     * @param agent - the agent deciding whether to run another step.
     * @param turn - the turn being continued or stopped.
     * @param defaultDecision - what the loop would do absent an override.
     * @mode waterfall
     */
    'agent/turn-continuation'(this: Scoped<Agent>, agent: Agent, turn: number, defaultDecision: ContinuationDecision, next: () => Promise<ContinuationDecision>): Promise<ContinuationDecision>
    /**
     * Serial terminal-stop checkpoint after the ordinary `agent/turn-continuation` waterfall,
     * any `continue.reason`, and the pending-steering continuation override have been folded.
     *
     * Scope-filtered dispatch: keyed to `agent`.
     * @param agent - the agent whose composed continuation outcome may be stopped.
     * @param turn - the turn at its terminal-stop checkpoint.
     * Dispatch is scoped to `agent`.
     * @mode serial
     */
    'agent/turn-stop'(this: Scoped<Agent>, agent: Agent, turn: number): Promise<ContinuationStop | undefined> | ContinuationStop | undefined

    // ---- error notifications (emit) ----
    /**
     * A step or turn errored.
     *
     * Scope-filtered dispatch: keyed to `agent`.
     * @param agent - the agent whose turn errored.
     * @param turn - the turn in which the failure surfaced.
     * @param step - the step at which the failure surfaced.
     * @param error - the failure, verbatim.
     * @mode emit
     */
    'agent/error'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, error: Error): void
  }
}
