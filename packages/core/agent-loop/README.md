# dsh-agent-loop

THE concrete agent plugin: `ReactLoopAgent` and the loop driver. Implements the `Agent` interface and drives the session/turn/step lifecycle.

This is the only package in the harness that contains concrete loop logic. Everything else is an abstract service or a plugin against extension seams — new behavior goes into plugins, not here.

## Service: `AgentLoop` (ctx key: `agentLoop`)

### Public API

Lifecycle (scoped): programmatic creation and resume snapshot caller-owned identity/configuration data, reserve both IDs, mint `agent.ctx`, and install the ordered teardown skeleton before awaiting optional `setup`. A create hands one-read raw seed and metadata references synchronously to the session boundary, which rejects exotic shells and materializes accepted values in a single recursive pass; pre-cloning either value could incorrectly sanitize prototypes. Resume installs an owner-liveness sentinel before persistence load, captures each loaded metadata field once, then hands ownership directly to the full lifecycle. After setup resolves, the factory checks its lifecycle flag, owner-fiber state, and owning agent status around one microtask checkpoint so a same-turn Cordis unload wins before publication. Successful setup inserts both session and agent before announcing either, enables driving immediately before `agent/session-start`, then starts the loop. Setup calls to `send`/`steer`/`inject`/`cancel` reject structurally; load/setup rejection or owner unload publishes nothing. Teardown runs stop/drain (including outstanding idle-injection flushes) → unregister → detach session → unwind scope. All `agent/*` dispatches go through `agentEvents(ctx, agent)`; per-step assembly through `assembleContextFor(agent)`; the turn-end durability checkpoint through `ctx.sessions.flush(session)`.

- `ctx.agentLoop.create(id: string, options?: AgentOptions, meta?: { cwd?: string }): ReactLoopAgent` — config-driven create: an agent on a fresh per-run session id `${id}-session-<uuid>` with optional session metadata. Used for `cordis.yml`-configured agents. The per-run uuid avoids colliding with the on-disk log a prior run materialized once a durable persistence backend is loaded; each run is a new session (a deliberate demo simplification — a real resume-or-create policy is a TODO). Disposed with the calling fiber.

`AgentLoop` also implements the `AgentFactory` seam and registers itself via `ctx.agents.setFactory(this)`, so plugins create/resume agents through `ctx.agents` (the interface):

- `ctx.agents.create({ agentId, sessionId, meta?, seed?, agentOptions?, setup? }): Promise<AgentHandle>` — programmatic create on a caller-supplied `sessionId`, NOT `${id}-session`. It awaits the unpublished setup transaction before returning; `meta` carries cwd/lineage/seed-boundary metadata and `seed` reconstructs a forked child prefix after the session boundary validates and detaches each raw value in one pass. The resolved [`AgentHandle`](../agent/README.md) owns exact teardown.
- `ctx.agents.resume({ agentId, resumeSessionId, agentOptions?, setup? }): Promise<AgentHandle>` — load a persisted session via `ctx.sessionPersistence` ([session persistence](../../../docs/rfc/implemented/architecture/2026-06-14-session-persistence.md)), reconstruct its history, then await setup against a fresh unpublished agent scope before rollback-covered publication. The live session id is the resumed id; turn numbering and derived history continue from the loaded log. Requires a session-persistence backend (NOT hard-injected — non-persistent demos still work; `resume` rejects with a clear error when persistence is absent). Returns an `AgentHandle`.

The config-driven `ctx.agentLoop.create()` path keeps its agent owned by the loop fiber (it discards the handle) — only the programmatic factory callers (the ACP bridge and in-process subagent backends) hold a handle and own per-agent teardown.

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

Agents listed in config are auto-created at startup. `cwd` applies only to fresh config-created sessions; `resumeSessionId` keeps the persisted session header. There is no per-agent persona: the deployment persona is `dsh-system-prompt`'s own `persona` config, shared by every agent in the context. The plugin registers the built-in `model`/`cwd` prompt variables on `ctx.systemPrompt`, resolved per step from the `assemble({ agent })` context — runtime facts of the agents THIS loop drives, unlike the `harness:identity`/`deployment:persona` sections, which live on `dsh-system-prompt` so they survive a swapped loop plugin.

### Exported concrete class

- `ReactLoopAgent` — the concrete `Agent` implementation. Its inbox is a JavaScript native-private field, and one prepared session can be claimed by only one concrete driver. Everything observable happens through session events and the `agent/*` event taxonomy.

`Inbox`, `runLoop`, and the instance-bound enable/start controls are package-internal. The package root does not export them, and the package exports map exposes no `./src/*` escape hatch; lifecycle owners create agents through `ctx.agents` rather than constructing or starting the driver internals.

### Loop lifecycle (`loop.ts`)

The internal loop driver runs one agent for its whole lifetime:

```
create agent → emit agent/session-start(source)   ⟵ once, before turn 1
forever:
  wait for queued messages (idle)
  TURN (error-contained):
    'turn/start'
    each queued: waterfall agent/prompt-submit → allow (→ session('user/message'),
      inject additionalContext) | block (→ session('prompt/blocked'), drop)
    if every prompt blocked: 'turn/end'(rejected), no step  ⟵ zero-step turn
    STEP loop:
      drain steering
      assembly = systemPrompt.assemble({agent})  ⟵ renderPrompt(assembly) IS the full prompt
      prefix ??= waterfall agent/session-prefix   ⟵ once per instance (first step): frozen
                                                session prefix; on the header, never history
      await serial agent/pre-step(…, prefix)  ⟵ surface mutation (compaction) outside the step;
                                                pressure gates see the prefix the request carries
      boundary = session.deriveMessages()   ⟵ reconstruction boundary: same sync frame,
      session('step/start')                     strictly before step/start
      config = waterfall agent/request       ⟵ frozen seed; return a replacement to switch
      session('request/header'[-delta])      ⟵ the header event this request owes the log
      stream llm.stream(freeze({header..., messages: prefix+boundary})) → session('assistant/chunk')
      message = waterfall agent/step-result
      session('assistant/message')
      each tool-call: session('tool/call')
        → tools.execute() [pre waterfall → monotonic guards → around dispatch → post waterfall → final notification]
        → session('tool/result')
      append buffered post-execute additionalContext as session('context/message')(s)
      drain steering → session('steering/message')
      cont = waterfall agent/turn-continuation → ContinuationDecision
        ({action:'continue', reason?} records reason as next-step steering)
      pending steering can override an ordinary stop
      terminal = serial agent/turn-stop → ContinuationStop | undefined
        (after ordinary decision/reason/steering folding)
      if terminal stop, or ordinary action==stop with no pending steering: break
    session('turn/end')
    await session/flush
    terminal turn: discard steering added before/during close and flush; keep ordinary queued sends
    ordinary turn: re-enqueue leftover steering as queued
  idle unless more queued
```

Error containment: a throwing plugin ends the **turn**, never the loop. A malformed or throwing `agent/turn-stop` policy likewise fails the turn closed. A successful terminal stop stays authoritative through `turn/end` and `session/flush`, preventing their listeners from resurrecting steering through the late fallback. Dispose mid-turn emits `agent/status('disposed')` and ends with reason `disposed`. A step that hits the model's output-token ceiling makes the turn end `max-tokens` (the rule: any `max-tokens` step in the turn surfaces as `max-tokens`; `disposed`/`aborted`/`error` still take precedence) — distinct from a clean `completed` stop.

Cancellation: `agent.cancel()` is the single public stop primitive — it clears the queued + steering FIFOs, aborts the in-flight step, and drives a turn-scoped marker the driver checks at every point a turn could start or continue (right after the idle wait, after the `running` flip, before each step, and at the continuation gate) so a turn about to start is dropped. A cancelled turn ends `aborted`; a queued-but-not-started prompt never runs and cannot be batched into the cancelled turn. The marker is reset once per loop iteration, so a cancel governs exactly one turn and never leaks onto a later prompt. (The loop still aborts its own per-step `AbortController` directly on disposal and from `cancel()`; that controller is loop-internal, not a public verb.)

### What is NOT here

Everything that goes beyond "call the model, run the tools, repeat" belongs to plugins listening on the event taxonomy:
- Hooks and policy: the relevant `agent/*` checkpoints plus the guarded `tools/pre-execute` → `tools/execute` → `tools/post-execute` → `tools/result` pipeline; exact signatures and modes live in the [generated event catalog](../../../docs/cordis-catalog/events.md)
- Compaction: `agent/pre-step`
- Sandbox, permission, plan mode: `tools/pre-execute` for extensible deny/ask, `tools.guard()` for monotonic owner policy, `tools/post-execute` for result decisions, and `tools/result` for final observation
- Sub-agents: implemented outside the loop as `ctx.subagents` providers; in-process providers use `ctx.agents.create()` and owned `AgentHandle` teardown, while child streaming/progress and background/poll collection remain deferred.
- Persistence: `session/event` + `session/flush`
- UI: `session/event` (assistant token stream, boundaries, tool activity) + `agent/*` control events (`agent/status`, `agent/created`/`agent/disposed`)
