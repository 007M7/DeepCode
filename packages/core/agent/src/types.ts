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
 *   live `Agent`. Two shapes: INTERCEPTION seams (the `agent/prompt-submit`/
 *   `agent/request`/`agent/session-prefix`/`agent/step-result`/
 *   `agent/turn-continuation` waterfalls and the serial `agent/pre-step` /
 *   `agent/turn-stop` checkpoints) that mutate/veto, and TRANSIENT emits
 *   (`agent/status`, `agent/error`, `agent/created`/
 *   `agent/disposed`, `agent/queued`, `agent/session-start`)
 *   that notify with the `Agent` in hand. Turn/step boundaries are NOT here —
 *   they are durable `session/event` records. Answers "right now, with the agent
 *   object — intercept or observe."
 * - **`tools/*`** (`@deepseek-ai/dsh-tools`) — the tool registry + execution.
 *
 * **The rule:** a durable, replayable fact is a SessionEvent; a live
 * interception or a transient/live-object signal is an `agent`/`tools` Cordis
 * event. A turn/step boundary is a durable fact: it lives in the session log
 * and is read off the `session/event` feed — it is NOT mirrored as an `agent/*`
 * emit. A consumer that needs the `Agent` handle (or its short id) at a boundary
 * keeps a session-id→agent map from `agent/created`/`agent/disposed`.
 * See `docs/rfc/implemented/architecture/2026-06-11-microkernel-event-taxonomy.md`
 * and `docs/rfc/implemented/simplification/2026-06-20-remove-agent-boundary-mirror-events.md`.
 *
 * The interception waterfalls here (`agent/prompt-submit`, `agent/request`,
 * `agent/step-result`, `agent/turn-continuation`) each return a typed Decision;
 * the terminal serial `agent/turn-stop` returns the stop-only subset. The
 * convention is pinned by
 * `docs/rfc/implemented/feature/2026-06-30-interception-seams.md`.
 *
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
 * Options an agent is created with. The persona is NOT here: the
 * dsh-system-prompt config supplies the global default, and a scoped
 * `deployment:persona` section may override it for one agent.
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
 * - `block` drops the prompt (it never becomes a `user/message`); `reason` is
 *   the durable record of why. The loop appends a `prompt/blocked` session event
 *   (carrying the original content, source, and `reason`) in place of the
 *   dropped `user/message`, so the veto survives replay even in a MIXED batch
 *   where a sibling prompt is allowed. A batch whose EVERY prompt is blocked
 *   additionally opens a zero-step turn that ends with {@link TurnEndReason}
 *   `rejected` (so the boundary stays balanced and a UI can render "blocked by
 *   hook").
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

  /**
   * Queue a user message. Starts a turn when idle; otherwise waits for the next
   * turn. Content and the resolved source are accepted as one detached,
   * deeply-frozen lossless-JSON record before notification or enqueue, so
   * caller or `agent/queued` listener in-place mutation cannot change later
   * log/model input. Throws synchronously when either value is not losslessly
   * JSON-serializable; `agent/prompt-submit` may still return an explicit
   * replacement.
   */
  send(content: ContentBlock[], options?: SendOptions): void

  /**
   * Steer a running turn: content is injected between steps of the current
   * turn. Uses the same owned-value and synchronous-validation boundary as
   * {@link send}; when idle, behaves exactly like that method.
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
   * from this synchronous method, but lifecycle disposal awaits it before
   * unregistering the agent or detaching its session. A failing flush is
   * reported via `agent/error` (step `0`) and the logger, never thrown into the
   * caller.
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
     * An agent's fully composed scoped world was published in the
     * {@link AgentRegistry}. Its session is already live in the session store.
     * Setup is composition-only by contract; the subsequent
     * `agent/session-start` boundary is the first supported place to inject or
     * queue startup work. A synchronous listener throw
     * vetoes publication and rollback emits the matching disposal edges;
     * returned-promise rejection is observed and logged but cannot
     * retroactively veto this synchronous boundary. A synchronous listener
     * that requests the advanced registry detach does not remove the entry
     * immediately: removal and the paired `agent/disposed` edge wait until the
     * creation dispatch unwinds, so no later creation listener observes a
     * disposal that preceded its own creation callback.
     * @param agent - the newly registered agent with its live session and completed setup.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): a listener registered
     * through `agent.ctx` fires only for that agent's dispatches; a listener on a
     * plain plugin context fires for every agent. The dispatch `this` is the
     * scope carrier (`Scoped<Agent>`), built by the emitting side via
     * `scopeTarget`/`agentEvents`.
     * @mode emit
     */
    'agent/created'(this: Scoped<Agent>, agent: Agent): void
    /**
     * An agent was removed from the registry. The concrete AgentLoop lifecycle
     * emits this only after its driver and any in-flight turn reach quiescence;
     * a custom agent registered through the public registry owns its own driver
     * contract, which the registry cannot infer. Ordered teardown may still be
     * detaching the session and unwinding scoped registrations when this runs.
     * @param agent - the exact agent removed from the registry.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): a listener registered
     * through `agent.ctx` fires only for that agent's dispatches; a listener on a
     * plain plugin context fires for every agent. The dispatch `this` is the
     * scope carrier (`Scoped<Agent>`), built by the emitting side via
     * `scopeTarget`/`agentEvents`.
     * @mode emit
     */
    'agent/disposed'(this: Scoped<Agent>, agent: Agent): void
    /**
     * Agent status changed (`idle` ⇄ `running`, or → `disposed`). Drive
     * lifecycle off this transition, never off a status you just requested —
     * `send()` does not flip status to `running` before it returns.
     * @param agent - the agent whose status flipped.
     * @param status - the status just entered (the transition's destination).
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): a listener registered
     * through `agent.ctx` fires only for that agent's dispatches; a listener on a
     * plain plugin context fires for every agent. The dispatch `this` is the
     * scope carrier (`Scoped<Agent>`), built by the emitting side via
     * `scopeTarget`/`agentEvents`.
     * @mode emit
     */
    'agent/status'(this: Scoped<Agent>, agent: Agent, status: AgentStatus): void
    /**
     * A message entered the agent's inbox (queued or steering). Content and the
     * resolved source are the detached, deeply-frozen values retained by the
     * inbox. `source` has defaults applied and is not the caller's raw options.
     * @param agent - the agent whose inbox received the message.
     * @param content - the accepted content blocks retained by the inbox.
     * @param info - the accepted source plus whether it entered as steering.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): a listener registered
     * through `agent.ctx` fires only for that agent's dispatches; a listener on a
     * plain plugin context fires for every agent. The dispatch `this` is the
     * scope carrier (`Scoped<Agent>`), built by the emitting side via
     * `scopeTarget`/`agentEvents`.
     * @mode emit
     */
    'agent/queued'(this: Scoped<Agent>, agent: Agent, content: ContentBlock[], info: { source: MessageSource; steering: boolean }): void

    // ---- session lifecycle (emit) ----
    /**
     * The agent's session lifecycle began, fired once before its first turn.
     * `source` says why ({@link SessionStartSource}: fresh startup, a resumed
     * persisted session, …). A pure NOTIFICATION (emit, not waterfall): a
     * listener cannot veto by returning a decision or throwing. A listener that
     * wants to seed context does so via `agent.inject()` (a `context/message` the
     * first request sees). A lifecycle owner can still dispose its structural
     * ownership edge during this notification; publication rechecks liveness and
     * then aborts before the driver starts.
     * @param agent - the agent whose session lifecycle began.
     * @param source - why the session started (fresh startup, resume, …).
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): a listener registered
     * through `agent.ctx` fires only for that agent's dispatches; a listener on a
     * plain plugin context fires for every agent. The dispatch `this` is the
     * scope carrier (`Scoped<Agent>`), built by the emitting side via
     * `scopeTarget`/`agentEvents`.
     * @mode emit
     */
    'agent/session-start'(this: Scoped<Agent>, agent: Agent, source: SessionStartSource): void

    // Turn and step boundaries are NOT mirrored as agent/* emits: a consumer
    // that needs them reads the durable `turn/start`/`turn/end`/`step/start`/
    // `step/end` session events off the `session/event` feed (the session log is
    // the live transcript feed). See the module doc's three-domain rule and the
    // "remove agent boundary mirror events" RFC.

    // ---- step/request extension seams (serial + waterfall) ----
    /**
     * Awaited pre-step surface-mutation checkpoint, fired once per step AFTER
     * `turn/start` (and after the prior step closed) but BEFORE this step's
     * `step/start` — so anything a listener appends lands OUTSIDE the step,
     * between `turn/start`/`step/end` and the upcoming `step/start`. `step` is
     * the number of the step about to start. The loop awaits
     * `ctx.serial('agent/pre-step', …)` after assembling the system prompt, then
     * opens the step and derives the request history ONCE from whatever the
     * surface now holds. This is where compaction belongs: it mutates the session
     * surface in place (shadowing an older range with a summary node) with its
     * log-only `compact/*` records cleanly outside any step, and the single
     * subsequent derive reflects the mutation — so there is no double-derive and
     * no listener can see (or be expected to act on) an assembled `messages`
     * array that does not exist yet.
     *
     * Serial (awaited in registration order), not a waterfall: a listener
     * mutates the surface as a side effect; there is nothing to transform, but
     * the loop must wait for the mutation to complete before opening the step
     * and deriving. Cordis `serial` bails early if a listener returns a bail
     * value; this event is typed and documented as `void`, so listeners must not
     * return a semantic veto value. `fullSystemPrompt` is the assembled prompt a
     * listener needs to measure pressure (the system prompt counts toward the
     * budget), and `sessionPrefix` is the instance's composed
     * {@link agent/session-prefix} product for the same reason — every request
     * carries it in front of the derived history, and it is composed BEFORE
     * this seam fires precisely so a pressure gate counts the prefix the
     * request will actually send (never a stale logged one). `signal` cancels
     * any in-flight work a listener starts (e.g. a
     * summarization model call).
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): a listener registered
     * through `agent.ctx` fires only for that agent's dispatches; a listener on a
     * plain plugin context fires for every agent. The dispatch `this` is the
     * scope carrier (`Scoped<Agent>`), built by the emitting side via
     * `scopeTarget`/`agentEvents`.
     * @param agent - the agent about to open the step.
     * @param turn - the already-open turn this step belongs to.
     * @param step - the number of the step about to start.
     * @param fullSystemPrompt - the assembled prompt, for measuring token pressure.
     * @param sessionPrefix - the instance's frozen session prefix, for the same measurement.
     * @param signal - aborts in-flight listener work when the turn is torn down.
     * @mode serial
     */
    // TODO: `fullSystemPrompt`/`sessionPrefix` are a smell on a generic
    // per-step seam — compaction
    // is their only consumer, so a wide event carries payloads just one listener
    // reads. Revisit if no second consumer appears: e.g. hand listeners a lazy
    // prompt provider, or move token-pressure measurement behind a
    // compaction-specific seam instead of the shared pre-step checkpoint.
    'agent/pre-step'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, fullSystemPrompt: string, sessionPrefix: readonly Message[], signal: AbortSignal): Promise<void> | void
    /**
     * Waterfall: decide what happens to ONE drained queued message before it
     * becomes a `user/message` — allow (optionally rewriting the prompt bytes or
     * attaching `additionalContext`) or block it. Fires inside the already-open
     * turn, per drained message. Maps onto Claude Code's `UserPromptSubmit` hook.
     * Call `next()` to delegate to the default (allow unchanged), or return a
     * {@link PromptDecision} without calling `next()` to short-circuit.
     * @param agent - the agent draining its inbox.
     * @param content - the drained message's blocks, as queued.
     * @param source - the message's resolved source.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): a listener registered
     * through `agent.ctx` fires only for that agent's dispatches; a listener on a
     * plain plugin context fires for every agent. The dispatch `this` is the
     * scope carrier (`Scoped<Agent>`), built by the emitting side via
     * `scopeTarget`/`agentEvents`.
     * @mode waterfall
     */
    'agent/prompt-submit'(this: Scoped<Agent>, agent: Agent, content: ContentBlock[], source: MessageSource, next: () => Promise<PromptDecision>): Promise<PromptDecision>
    /**
     * Waterfall: shape the step's call configuration — model switching,
     * sampling overrides — by returning a replacement {@link LlmCallConfig}
     * (the frozen seed is the config the loop would otherwise use). Config is
     * ALL a listener shapes here: every request is a pure function of the
     * session log (the reconstructability RFC), so model-visible content
     * flows through the log channels — `inject()`, steering, prompt-submit
     * `additionalContext`, prompt sections via `system-prompt/assemble`, or
     * the header-logged session prefix via {@link agent/session-prefix}
     * — never through request mutation, and the loop records whatever config
     * the request actually uses as a `request/header*` event before dispatch.
     * The step's messages are already snapshotted when this fires (the
     * `step/start` boundary): an `inject()` from a listener here lands in the
     * log but joins the NEXT request. For surface mutation that must precede
     * the snapshot (compaction), use {@link agent/pre-step}. Call `next()` to
     * delegate, or return an {@link LlmCallConfig} without it to
     * short-circuit.
     * @param agent - the agent making the model call.
     * @param turn - the open turn number.
     * @param step - the step whose request this is.
     * @param config - the config the loop would use (frozen); return a replacement to switch.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): a listener registered
     * through `agent.ctx` fires only for that agent's dispatches; a listener on a
     * plain plugin context fires for every agent. The dispatch `this` is the
     * scope carrier (`Scoped<Agent>`), built by the emitting side via
     * `scopeTarget`/`agentEvents`.
     * @mode waterfall
     */
    'agent/request'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, config: LlmCallConfig, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
    /**
     * Waterfall: compose the SESSION PREFIX — request-only messages placed in
     * front of the ENTIRE derived history (directly after the provider's
     * system slot) on every request this loop instance sends. Fired ONCE per
     * loop instance, lazily before its first step's {@link agent/pre-step}
     * seam — BEFORE the pre-step so a token-pressure gate (compaction) counts
     * the prefix this instance will actually send, never a previous
     * instance's logged one. The composed
     * result is deep-frozen, recorded as `EpochHeader.messagePrefix` on the
     * instance's anchoring `'initial'`/`'resume'` header snapshot, and reused
     * verbatim for every subsequent request — never recomputed mid-session,
     * so the provider prefix cache holds by construction (a process restart
     * or `ctx.agents.resume()` is a new instance: it recomposes, and any
     * drift lands attributably on the `'resume'` snapshot). Composition runs
     * outside the step, before the boundary snapshot: a composing listener's
     * session append joins the CURRENT request's derived history. A
     * composition interrupted by a cancel/dispose landing inside the
     * waterfall is discarded — never cached, logged, or sent — and the next
     * turn recomposes under a live signal, so an abort-aware listener's
     * degraded fallback cannot leak into later requests.
     *
     * This is the home for session-stable openers the model must always see
     * but that must NOT become durable history — a skills catalog, an
     * AGENTS.md digest, a workspace baseline: `Session.deriveMessages()`
     * never returns the prefix, and the header events are its only durable
     * record, so the request stays reconstructable from the log. Content
     * that CHANGES mid-session belongs in the append-only history channels
     * instead — `agent.inject()`, a `tools/post-execute` decision's
     * `additionalContext`, prompt-submit `additionalContext` — each a
     * durable `context/message` paid once and prefix-cached thereafter.
     *
     * The seed is a frozen empty list; a contributing listener returns a NEW
     * array — never an in-place push. The canonical contribution is a
     * PREPEND, `[mine, ...await next()]`: the waterfall unwinds
     * innermost-first (the LAST-registered listener's `next()` resolves
     * first), so prepending yields registration order on the wire, and every
     * plugin using it composes deterministically. The append form
     * `[...await next(), mine]` is legal but places a contribution AFTER
     * every later-registered plugin's — reverse registration order when all
     * contributors append. Call `next()` to
     * delegate, or return a list without it to short-circuit.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): a listener registered
     * through `agent.ctx` fires only for that agent's dispatches; a listener on a
     * plain plugin context fires for every agent. The dispatch `this` is the
     * scope carrier (`Scoped<Agent>`), built by the emitting side via
     * `scopeTarget`/`agentEvents`.
     * @param agent - the agent whose session prefix is being composed.
     * @param prefix - the frozen empty seed; return an extended replacement to contribute.
     * @param signal - aborts in-flight listener work (e.g. a discovery scan) when the step is torn down.
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
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): a listener registered
     * through `agent.ctx` fires only for that agent's dispatches; a listener on a
     * plain plugin context fires for every agent. The dispatch `this` is the
     * scope carrier (`Scoped<Agent>`), built by the emitting side via
     * `scopeTarget`/`agentEvents`.
     * @mode waterfall
     */
    'agent/step-result'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, message: Message, next: () => Promise<Message>): Promise<Message>
    /**
     * Waterfall: override the turn-continuation decision via a typed
     * {@link ContinuationDecision}. The loop's `defaultDecision` is `continue`
     * when the step had tool calls or steering was injected, else `stop`.
     * Listeners force-continue (`/goal`, `/loop` — optionally attaching a
     * `reason` recorded as next-step steering) or force-stop (budget guards).
     * Call `next()` to delegate to the default, or return a decision to override.
     * @param agent - the agent deciding whether to run another step.
     * @param turn - the turn being continued or stopped.
     * @param defaultDecision - what the loop would do absent an override.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): a listener registered
     * through `agent.ctx` fires only for that agent's dispatches; a listener on a
     * plain plugin context fires for every agent. The dispatch `this` is the
     * scope carrier (`Scoped<Agent>`), built by the emitting side via
     * `scopeTarget`/`agentEvents`.
     * @mode waterfall
     */
    'agent/turn-continuation'(this: Scoped<Agent>, agent: Agent, turn: number, defaultDecision: ContinuationDecision, next: () => Promise<ContinuationDecision>): Promise<ContinuationDecision>
    /**
     * Serial terminal-stop checkpoint after the ordinary
     * `agent/turn-continuation` waterfall, any `continue.reason`, and the
     * pending-steering continuation override have been folded. A listener
     * returns `{ action: 'stop' }` to make this turn terminal, or `undefined`
     * to abstain. Terminal stop is monotonic: listener order and steering
     * cannot resume the turn, and pending steering is discarded rather than
     * becoming another step or turn.
     * @param agent - the agent whose composed continuation outcome may be stopped.
     * @param turn - the turn at its terminal-stop checkpoint.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): a listener registered
     * through `agent.ctx` fires only for that agent's dispatches; a listener on a
     * plain plugin context fires for every agent. The dispatch `this` is the
     * scope carrier (`Scoped<Agent>`), built by the emitting side via
     * `scopeTarget`/`agentEvents`.
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
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): a listener registered
     * through `agent.ctx` fires only for that agent's dispatches; a listener on a
     * plain plugin context fires for every agent. The dispatch `this` is the
     * scope carrier (`Scoped<Agent>`), built by the emitting side via
     * `scopeTarget`/`agentEvents`.
     * @mode emit
     */
    'agent/error'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, error: Error): void
  }
}
