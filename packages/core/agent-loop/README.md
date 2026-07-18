# dsh-agent-loop

Concrete `ReactLoopAgent` implementation and loop driver.

This is the only package in the harness that contains concrete loop logic. Everything else is an abstract service or a plugin against extension seams — new behavior goes into plugins, not here.

## Service: `AgentLoop` (ctx key: `agentLoop`)

### Public API

Creation and resume use one caller-owned transaction: compose while unpublished, enter both registries, announce lifecycle edges, then start the driver. Failure rolls back private resources; caller, handle, and provider teardown share one quiescence boundary. The interface contract and ownership order live in [`dsh-agent`](../agent/README.md) and the [agent-scope runtime RFC](../../../docs/rfc/implemented/architecture/2026-07-12-agent-scope-runtime-design.md).

Caller-chosen ids arbitrate only at final registry entry, so concurrent contenders may prepare but every loser rolls back. Entry-bound detach capabilities cannot remove a later same-id replacement. Teardown stops and drains—including idle-injection flushes—before detaching agent, session, and scope; ids become reusable at detach.

- `ctx.agentLoop.create(id, options?, meta?)` synchronously creates a caller-fiber-owned agent with a fresh generated session id and optional cwd. Each call starts a new session rather than applying resume-or-create policy.

`AgentLoop` also implements the `AgentFactory` seam and registers itself via `ctx.agents.setFactory(this)`, so plugins create/resume agents through `ctx.agents` (the interface):

- `ctx.agents.create({ agentId, sessionId, meta?, seed?, agentOptions?, setup?, signal? })` validates and snapshots durable seed and metadata, awaits optional composition while unpublished, creates on the supplied session id, and returns an owned [`AgentHandle`](../agent/README.md). Its signal applies only until publication.
- `ctx.agents.resume({ agentId, resumeSessionId, agentOptions?, setup?, signal? })` loads through optional [session persistence](../../../docs/rfc/implemented/architecture/2026-06-14-session-persistence.md), continues stored history and turn numbering under the resumed session id, and follows the same unpublished setup and creation-only cancellation boundary. It rejects when no persistence backend is mounted.

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

### Exported concrete class

- `ReactLoopAgent` — the concrete `Agent` implementation. Its inbox is a JavaScript native-private field, and one prepared session can be claimed by only one concrete driver. Everything observable happens through session events and the `agent/*` event taxonomy.

`Inbox`, `runLoop`, and the instance-bound publication/start controls are package-internal. The package root does not export them, and the package exports map exposes no `./src/*` escape hatch; lifecycle owners create agents through `ctx.agents` rather than constructing or starting the driver internals. `ReactLoopAgent.send()`, running `steer()`, and open-turn `inject()` materialize content plus resolved source once as detached, deeply frozen lossless JSON; malformed data throws before enqueue or append. An injection that arrives while the current step executes assistant tool calls stays in a FIFO until the batch settles; successful batches place it after the complete result batch, and interrupted batches drain it before the turn closes.

### Loop lifecycle (`loop.ts`)

The driver owns one agent for its lifetime. It records turn, step, request, stream, and tool boundaries in the session log; live extension events coordinate policy around those durable facts. The [architecture turn flow](../../../docs/architecture.md#turn-flow) and generated [event catalog](../../../docs/cordis-catalog/events.md) are the authoritative sequence and signatures.

Every provider call that reaches a successful finish appends exactly one `assistant/message` completion anchor, including content-less calls and `max-tokens` finishes. A successful `agent/step-result` stores its transformed content; a rejected result records empty content before the original failure continues. The anchor retains exact chunk provenance (`[]` for a stream with no chunks) and usage when available, while empty content stays out of derived message history.

Plugin failure ends the current turn, not the loop. Cancellation clears pending work and aborts the current step without leaking to the next prompt. Terminal continuation stops remain authoritative through turn close and durability flush.

Within a step, exclusive calls form barriers; parallel-safe calls use a bounded rolling pool and are reclassified before start. Only dispatch/body overlaps. Policy, durable results, and result context remain model-ordered. Abort stops new calls, drains started results, then drains accepted batch context before the turn closes through the normal abort path.

### What belongs to plugins

Everything that goes beyond "call the model, run the tools, repeat" belongs to plugins listening on the event taxonomy:
- Hooks and policy: the relevant `agent/*` checkpoints plus the guarded `tools/pre-execute` → `tools/execute` → `tools/post-execute` → `tools/result` pipeline; exact signatures and modes live in the [generated event catalog](../../../docs/cordis-catalog/events.md)
- Compaction: `agent/pre-step`
- Sandbox, permission, plan mode: `tools/pre-execute` for extensible deny/ask, `tools.guard()` for monotonic owner policy, `tools/post-execute` for result decisions, and `tools/result` for final observation
- Sub-agents: implemented outside the loop as `ctx.subagents` providers; in-process providers use `ctx.agents.create()` and owned `AgentHandle` teardown, while generic [`ctx.tasks`](../../tasks/tasks/) plus [`dsh-tool-subagent`](../../subagent/tool-subagent/) own background collection.
- Persistence: `session/event` + `session/flush`
- UI: `session/event` (assistant token stream, boundaries, tool activity) + `agent/*` control events (`agent/status`, `agent/created`/`agent/disposed`)

## Model Experience

### Complete conversation request

**What the model sees**: For each step, the loop sends the rendered per-agent system prompt, visible tool schemas, the frozen session prefix, and the session's derived messages. It supplies `model` and `cwd` variable values but no additional fixed prose.

**Token effect**: System text, schemas, and prefix are paid again on every step. Per-agent scoping chooses the initial contributions, while the authoritative assembly waterfall can alter the final request and makes its listener responsible for protocol coherence.

### Retained message history

**What the model sees**: Accepted user messages, assistant messages, tool calls and results, injected context, and steering are logged and sent on later steps. Raw stream chunks, lifecycle boundaries, and other log-only events are excluded.

**Token effect**: Input grows with every surface message until a compaction replacement shadows older nodes; a multi-step tool turn resends the accumulated prefix and history each step.

## Known Limitations and Deferred Work

- **Classification is unary** — calls whose safety depends on comparing siblings or resources must remain exclusive ([rationale](../../../docs/rfc/implemented/feature/2026-07-10-parallel-tool-call-execution.md)).
- **No resume-or-create policy on the config path** — config-driven `create()` starts a fresh `${id}-session-<uuid>` every run (`TODO(demo)`), and a config `resumeSessionId` whose resume fails logs a warning and creates no agent.
- **Config agents have no per-agent persona field or setup hook** — they use the deployment persona; scoped persona/tool composition is available only through the programmatic `ctx.agents.create()` / `resume()` factory options.
- **No built-in turn budget** — the default continuation is `continue` whenever a step had tool calls or steering; bounding a runaway turn requires an `agent/turn-continuation` force-stop plugin.
