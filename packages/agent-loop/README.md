# dsh-agent-loop

THE concrete agent plugin: `LoopAgent` and the loop driver. Implements the `Agent` interface and drives the session/turn/step lifecycle.

This is the only package in the harness that contains concrete loop logic. Everything else is an abstract service or a plugin against extension seams — new behavior goes into plugins, not here.

## Service: `AgentLoop` (ctx key: `agentLoop`)

### Public API

- `ctx.agentLoop.create(id: string, options?: AgentOptions): LoopAgent` — config-driven create: an agent on a fresh per-run session id `${id}-session-<uuid>` (no cwd). Used for `cordis.yml`-configured agents. The per-run uuid avoids colliding with the on-disk log a prior run materialized once a durable persistence backend is loaded; each run is a new session (a deliberate demo simplification — a real resume-or-create policy is a TODO). Disposed with the calling fiber.

`AgentLoop` also implements the `AgentFactory` seam and registers itself via `ctx.agents.setFactory(this)`, so plugins create/resume agents through `ctx.agents` (the interface):

- `ctx.agents.create({ agentId, sessionId, meta?, agentOptions? })` — programmatic create on a caller-supplied `sessionId` (e.g. an ACP-generated id), NOT `${id}-session`.
- `ctx.agents.resume({ agentId, resumeSessionId, agentOptions? })` — load a persisted session via `ctx.sessionPersistence` ([session persistence](../../docs/rfc/implemented/2026-06-14-session-persistence.md)) and resume an agent on it. The live session id is the resumed id; turn numbering and derived history continue from the loaded log. Requires a session-persistence backend (NOT hard-injected — non-persistent demos still work; `resume` rejects with a clear error when persistence is absent).

### Injected services

`agents`, `sessions`, `llm`, `tools`, `systemPrompt` — all five interface services.

### Configuration (schemastery)

```ts
interface Config {
  agents: Array<{
    id: string                 // required
    model?: string
    systemPrompt?: string
  }>
}
```

Agents listed in config are auto-created at startup.

### Classes

- `LoopAgent` — the concrete `Agent` implementation. Owns the inbox (`Inbox`), the per-step `AbortController`, and the loop driver. Everything observable happens through session events and the `agent/*` event taxonomy.
- `Inbox` — per-agent queued + steering FIFOs (`enqueue`, `steer`, `drainQueued`, `drainSteering`, `waitForQueued`).

### Loop lifecycle (`loop.ts`)

One invocation of `runLoop()` drives one agent for its whole lifetime:

```
forever:
  wait for queued messages (idle)
  TURN (error-contained):
    drain queued → 'turn/start' → session('user/message')
    STEP loop:
      drain steering
      assembly = systemPrompt.assemble()
      request = waterfall agent/request
      stream llm.stream(request) → session('assistant/chunk')
      message = waterfall agent/step-result
      session('assistant/message')
      each tool-call: session('tool/call') → tools.execute() → session('tool/result')
      drain steering → session('steering/message')
      cont = waterfall agent/turn-continuation
      if !cont: break
    session('turn/end')
    await session/flush
    re-enqueue leftover steering as queued
  idle unless more queued
```

Error containment: a throwing plugin ends the **turn**, never the loop. Dispose mid-turn emits `agent/status('disposed')` and ends with reason `disposed`. A step that hits the model's output-token ceiling makes the turn end `max-tokens` (the rule: any `max-tokens` step in the turn surfaces as `max-tokens`; `disposed`/`aborted`/`error` still take precedence) — distinct from a clean `completed` stop.

### What is NOT here

Everything that goes beyond "call the model, run the tools, repeat" belongs to plugins listening on the event taxonomy:
- Hooks: `agent/request`, `agent/step-result`, `tools/execute`, `agent/turn-continuation`
- Compaction: `agent/request`
- Sandbox, permission, plan mode: `tools/execute`
- Sub-agents: TODO seam on `AgentLoop.create()`
- Persistence: `session/event` + `session/flush`
- UI: `agent/stream-chunk` + `agent/*` events
