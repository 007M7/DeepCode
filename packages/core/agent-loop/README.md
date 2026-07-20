# dsh-agent-loop

THE concrete agent plugin and loop driver. Its package-internal implementation satisfies the `Agent` interface and drives the session/turn/step lifecycle.

This is the only package in the harness that contains concrete loop logic. Everything else is an abstract service or a plugin against extension seams — new behavior goes into plugins, not here.

## Service: `AgentLoop` (ctx key: `agentLoop`)

### Public API

Creation and resume are one rollback-covered transaction: construct a private session, concrete agent, and scoped context; await optional setup; enter both registries; announce `session/created` then `agent/created`; emit `agent/session-start`; and only then start the driver. Setup receives the full scoped `Context` as trusted same-process composition code and must not drive the unpublished agent. Ordinary typed identity and option inputs are borrowed under their readonly contract, while seed events and session metadata are validated and snapshotted because they cross the durable session boundary. An optional `AbortSignal` cancels only load/setup/publication and is detached before the returned handle becomes visible.

The caller fiber and the AgentLoop provider are co-owners. `AgentFactory.createAgent(ownerCtx, options)` and `resume(ownerCtx, options)` receive caller ownership explicitly, while the factory keeps its own dependency context for `sessions`/`llm`/`tools`/`systemPrompt`; this lets a caller inject only `agents` without shrinking the new agent's service surface. Caller unload, handle disposal, or provider unload converge on one memoized quiescence boundary. Provider shutdown waits both resource teardown and the public create/resume wrapper that observed deactivation, so no continuation can publish after dependencies disappear.

Each agent and its session share one caller-chosen `SessionId`, assumed globally unique; accidental UUID collisions are outside the supported model. Two concurrent operations with the same id may both prepare, but the final `enter()` calls arbitrate publication and every loser rolls its private resources back. Each detach is bound to the exact entered object, so a stale disposer cannot remove a later same-id replacement. A detach requested during a synchronous creation notification waits for that dispatch to unwind, preserving created/disposed pairing. Teardown runs stop and drain (including outstanding idle-injection flushes) → detach agent → detach session → unwind scope; the id becomes reusable at detach even if private scope cleanup is still finishing. Ordinary non-vetoing `agent/*` notifications go through `agentEvents(ctx, agent)`, per-step assembly goes through `assembleContextFor(agent)`, and turn-end durability checkpoints go through `ctx.sessions.flush(session)`.

- `ctx.agentLoop.create(id: SessionId, options?: AgentOptions, meta?: { cwd?: string }): Agent` — synchronous no-setup create under the exact shared agent/session id, disposed with the calling fiber. Declarative config treats `agents[].id` as a stable label and normally mints `${label}-session-<uuid>` before calling this boundary. An app may instead supply a stable exact `sessionId`: first use creates it, while a remount with persistence already present resumes its materialized history. `resumeSessionId` requires and loads an existing persisted id and is mutually exclusive with `sessionId`. This keeps default fresh restarts collision-free without retaining a second live routing identity.

`AgentLoop` also implements the `AgentFactory` seam and registers itself via `ctx.agents.setFactory(this)`, so plugins create/resume agents through `ctx.agents` (the interface):

- `ctx.agents.create({ sessionId, meta?, seed?, agentOptions?, setup?, signal? }): Promise<AgentHandle>` — programmatic create under the caller-supplied shared id. It awaits the unpublished setup transaction before returning; `meta` carries cwd/lineage/seed-boundary metadata and `seed` reconstructs a forked child prefix after the session boundary validates and snapshots the durable values. `signal` applies only until this promise settles. The resolved [`AgentHandle`](../agent/README.md) owns exact teardown.
- `ctx.agents.resume({ resumeSessionId, agentOptions?, setup?, signal? }): Promise<AgentHandle>` — load a persisted session via `ctx.sessionPersistence` ([session persistence](../../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md)), register the agent under that same id, reconstruct its history, then await setup against a fresh unpublished agent scope before rollback-covered publication. Turn numbering and derived history continue from the loaded log. Requires a session-persistence backend (NOT hard-injected — non-persistent demos still work; `resume` rejects with a clear error when persistence is absent). `signal` is creation-only. Returns an `AgentHandle`.

The config-driven `ctx.agentLoop.create()` path keeps its agent owned by the loop fiber (it discards the handle). For a programmatic agent, the handle holder is the only consumer-facing teardown capability; AgentLoop provider unload is the independent structural teardown edge, not another handle exposed to application code.

### Injected services

`agents`, `sessions`, `llm`, `tools`, `systemPrompt` — all five interface services.

### Configuration (schemastery)

```ts
interface Config {
  maxParallelToolCalls?: number // default 10; 1 is serial
  agents: Array<{
    id: string                 // required
    provider?: string
    model?: string
    resumeSessionId?: string   // load this persisted session instead of creating one
    cwd?: string               // optional workspace cwd for the fresh session
  }>
}
```

Configured agents start automatically. A model call requires both `provider` and `model`; `agent/request` may supply a missing pair before dispatch. `maxParallelToolCalls` bounds every agent's rolling pool for parallel-safe calls and defaults to `10`. `cwd` applies only to fresh sessions, while `resumeSessionId` retains persisted metadata. Configured agents use the deployment persona, and programmatic setup can shadow it per agent. This plugin supplies the per-agent `provider`, `model`, and `cwd` prompt variables; harness identity and deployment persona belong to `dsh-system-prompt`.

### Internal concrete driver

The concrete `Agent` class, its `Inbox`, `runLoop`, and instance-bound publication/start controls are package-internal. The package root exports only the plugin/service/config contract, and the package exports map exposes no `./src/*` escape hatch; lifecycle owners create agents through `ctx.agents` rather than naming, constructing, or starting driver internals. One prepared session can be claimed by only one concrete driver, and everything observable happens through session events and the `agent/*` event taxonomy.

Each concrete `send()` materializes content plus resolved source once as a detached, deeply frozen lossless-JSON FIFO item. If claimed, it is the sole ordinary message in its turn; a successor waits for the preceding ordinary turn's checkpoint to settle, while cancellation, disposal, or a pre-start failure may drop it without a turn. Running `steer()` enters the steering FIFO: an open turn records it at the next steering checkpoint before a request or continuation decision, but policy can still stop before another step; steering left after turn close and its checkpoint becomes later queued input unless terminal turn policy, cancellation, or disposal discards it. Open-turn `inject()` uses the same accepted-value boundary but defers in a FIFO while the current step executes assistant tool calls; successful batches place it after all results, and interrupted batches drain it before turn close. Malformed data throws before enqueue or append.

### Loop lifecycle (`loop.ts`)

The driver owns one agent for its lifetime and runs inside `ctx.agents.withInitiator(agent, ...)`. Package-private orchestration entry points recover the exact Agent, derive `agent.session` once, and let operation-local helpers capture it instead of forwarding the concrete driver or per-operation `Session` through shallow interfaces. A helper keeps an explicit `Session` when that is its actual interface, while creation, persistence load, unpublished setup, services, workers, processes, persistence, and wire protocols retain their explicit identities. The [agent service](../agent/README.md#initiating-agent-scope) owns propagation, teardown, and detached-work rules.

Every provider call that reaches a successful finish appends exactly one `assistant/message` completion anchor, including content-less calls and `max-tokens` finishes. A successful `agent/step-result` stores its transformed content; a rejected result records empty content before the original failure continues. The anchor retains exact chunk provenance (`[]` for a stream with no chunks) and usage when available, while empty content stays out of derived message history.

Plugin failure ends the current turn, not the loop. Only final adapter dispatch/iteration failures and terminal in-band error or aborted finishes enter `agent/request-error`; middleware, result processing, tools, and `agent/post-step` remain ordinary turn failures. Recovery receives the exact live error, immutable provider facts, and immutable prior failures after the failed step closes. A retry rebuilds from the durable log in a new numbered step, success clears the consecutive history, and exhaustion records the structured failure once on `turn/end`. Cancellation clears pending work and aborts the current step without leaking to the next prompt; undispatched model tool calls receive synthetic `tool/call` and aborted result pairs. Terminal continuation stops remain authoritative through turn close and durability flush.

Within a step, exclusive calls form barriers; parallel-safe calls use a bounded rolling pool and are reclassified before start. Only dispatch/body overlaps. Policy, durable results, and result context remain model-ordered. Abort stops new calls, drains started results, then drains accepted batch context before the turn closes through the normal abort path.

### What belongs to plugins

Everything that goes beyond "call the model, run the tools, repeat" belongs to plugins listening on the event taxonomy:
- Hooks and policy: the relevant `agent/*` checkpoints plus the guarded `tools/pre-execute` → `tools/execute` → `tools/post-execute` → `tools/result` pipeline; exact signatures and modes live in the [generated event catalog](../../../docs/cordis-catalog/events.md)
- Compaction: pressure on `agent/post-step`; canonical context overflow on `agent/request-error`
- Transient model recovery: `dsh-llm-retry` on `agent/request-error`, with finite code-specific budgets and non-surface `llm/retry` status events
- Sandbox, permission, plan mode: `tools/pre-execute` for extensible deny/ask, `tools.guard()` for monotonic owner policy, `tools/post-execute` for result decisions, and `tools/result` for final observation
- Sub-agents: implemented outside the loop as `ctx.subagents` providers; in-process providers use `ctx.agents.create()` and owned `AgentHandle` teardown, while generic [`ctx.tasks`](../../tasks/tasks/) plus [`dsh-tool-subagent`](../../subagent/tool-subagent/) own background collection.
- Persistence: `session/event` + `session/flush`
- UI: `session/event` (assistant token stream, boundaries, tool activity) + `agent/*` control events (`agent/status`, `agent/created`/`agent/disposed`)

## Model Experience

### Complete conversation request

#### What the model sees

For each step, the loop sends the rendered per-agent system prompt, visible tool schemas, the frozen session prefix, and the session's derived messages. It supplies `model` and `cwd` variable values but no additional fixed prose.

#### Token effect

System text, schemas, and prefix are paid again on every step. Per-agent scoping chooses the initial contributions, while the authoritative assembly waterfall can alter the final request and makes its listener responsible for protocol coherence.

#### KV Cache effect

Append-only only while system text, schemas, session prefix, and earlier history remain byte-identical under the same provider and model route. A token-bearing assembly rewrite or composition change may invalidate reuse from the first altered request token.

### Retained message history

#### What the model sees

Accepted user messages, assistant messages, tool calls and results, injected context, and steering are logged and sent on later steps. Raw stream chunks, lifecycle boundaries, and other log-only events are excluded.

#### Token effect

Input grows with every surface message until a compaction replacement shadows older nodes; a multi-step tool turn resends the accumulated prefix and history each step.

#### KV Cache effect

Ordinary history growth is append-only and preserves reusable entries. A surface replacement or compaction invalidates reuse from the first shadowed history token.

### Undispatched calls after cancellation

#### What the model sees

If a later request replays an aborted step, each tool call that cancellation prevented from dispatching has the error result text `Error: tool call skipped because the step was aborted before execution`.

#### Token effect

One fixed error result per skipped call remains in history until compaction shadows it.

#### KV Cache effect

Append-only; each synthetic result follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Classification is unary** — calls whose safety depends on comparing siblings or resources must remain exclusive ([rationale](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md)).
- **Config labels are fresh by default** — omitting `sessionId` creates a fresh `${id}-session-<uuid>` on every startup; exact resume-or-create behavior requires an explicit stable `sessionId`, while `resumeSessionId` requires existing persisted history.
- **Config agents have no per-agent persona field or setup hook** — they use the deployment persona; scoped persona/tool composition is available only through the programmatic `ctx.agents.create()` / `resume()` factory options.
- **No built-in turn budget** — the default continuation is `continue` whenever a step had tool calls or steering; bounding a runaway turn requires an `agent/turn-continuation` force-stop plugin.
