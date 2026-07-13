# dsh-agent-loop

Concrete `ReactLoopAgent` implementation and loop driver.

This is the only package in the harness that contains concrete loop logic. Everything else is an abstract service or a plugin against extension seams — new behavior goes into plugins, not here.

## Service: `AgentLoop` (ctx key: `agentLoop`)

### Public API

Creation and resume use one caller-owned transaction: compose while unpublished, enter both registries, announce lifecycle edges, then start the driver. Failure rolls back private resources; caller, handle, and provider teardown share one quiescence boundary. The interface contract and ownership order live in [`dsh-agent`](../agent/README.md) and the [agent-scope runtime RFC](../../../docs/rfc/implemented/architecture/2026-07-12-agent-scope-runtime-design.md).

- `ctx.agentLoop.create(id, options?, meta?)` synchronously creates a caller-fiber-owned agent with a fresh generated session id.

`AgentLoop` also implements the `AgentFactory` seam and registers itself via `ctx.agents.setFactory(this)`, so plugins create/resume agents through `ctx.agents` (the interface):

- `ctx.agents.create(options)` creates on the supplied session id and returns an owned [`AgentHandle`](../agent/README.md).
- `ctx.agents.resume(options)` loads through optional [session persistence](../../../docs/rfc/implemented/architecture/2026-06-14-session-persistence.md), continues the stored history, and returns the same handle shape.

The config-driven `ctx.agentLoop.create()` path keeps its agent owned by the loop fiber (it discards the handle). For a programmatic agent, the handle holder is the only consumer-facing teardown capability; AgentLoop provider unload is the independent structural teardown edge, not another handle exposed to application code.

### Injected services

`agents`, `sessions`, `llm`, `tools`, `systemPrompt` — all five interface services.

### Configuration (schemastery)

```ts
interface Config {
  agents: Array<{
    id: string                 // required
    model?: string
    resumeSessionId?: string   // load this persisted session instead of creating one
    cwd?: string               // optional workspace cwd for the fresh session
  }>
}
```

Configured agents start automatically. `cwd` applies only to fresh sessions; `resumeSessionId` retains persisted metadata. They use the deployment persona. Programmatic setup can shadow it per agent. This plugin supplies the per-agent `model` and `cwd` prompt variables; harness identity and deployment persona belong to `dsh-system-prompt`.

### Exported concrete class

- `ReactLoopAgent` — the concrete `Agent` implementation. Its inbox is a JavaScript native-private field, and one prepared session can be claimed by only one concrete driver. Everything observable happens through session events and the `agent/*` event taxonomy.

`Inbox`, `runLoop`, and the instance-bound publication/start controls are package-internal. The package root does not export them, and the package exports map exposes no `./src/*` escape hatch; lifecycle owners create agents through `ctx.agents` rather than constructing or starting the driver internals. `ReactLoopAgent.send()` and running `steer()` materialize content plus resolved source once as detached, deeply frozen lossless JSON, then share that accepted record between `agent/queued` and the inbox; malformed data throws before either boundary.

### Loop lifecycle (`loop.ts`)

The driver owns one agent for its lifetime. It records turn, step, request, stream, and tool boundaries in the session log; live extension events coordinate policy around those durable facts. The [architecture turn flow](../../../docs/architecture.md#turn-flow) and generated [event catalog](../../../docs/cordis-catalog/events.md) are the authoritative sequence and signatures.

Plugin failure ends the current turn, not the loop. Cancellation clears pending work and aborts the current step without leaking to the next prompt. Terminal continuation stops remain authoritative through turn close and durability flush.

### What is NOT here

Everything that goes beyond "call the model, run the tools, repeat" belongs to plugins listening on the event taxonomy:
- Hooks and policy: the relevant `agent/*` checkpoints plus the guarded `tools/pre-execute` → `tools/execute` → `tools/post-execute` → `tools/result` pipeline; exact signatures and modes live in the [generated event catalog](../../../docs/cordis-catalog/events.md)
- Compaction: `agent/pre-step`
- Sandbox, permission, plan mode: `tools/pre-execute` for extensible deny/ask, `tools.guard()` for monotonic owner policy, `tools/post-execute` for result decisions, and `tools/result` for final observation
- Sub-agents: implemented outside the loop as `ctx.subagents` providers; in-process providers use `ctx.agents.create()` and owned `AgentHandle` teardown, while child streaming/progress and background/poll collection remain deferred.
- Persistence: `session/event` + `session/flush`
- UI: `session/event` (assistant token stream, boundaries, tool activity) + `agent/*` control events (`agent/status`, `agent/created`/`agent/disposed`)
