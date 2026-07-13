# dsh-agent-loop

THE concrete agent plugin: `ReactLoopAgent` and the loop driver. Implements the `Agent` interface and drives the session/turn/step lifecycle.

This is the only package in the harness that contains concrete loop logic. Everything else is an abstract service or a plugin against extension seams — new behavior goes into plugins, not here.

## Service: `AgentLoop` (ctx key: `agentLoop`)

### Public API

Creation and resume are one rollback-covered transaction: construct a private session, concrete agent, and scoped context; await optional setup; enter both registries; announce `session/created` then `agent/created`; emit `agent/session-start`; and only then start the driver. Setup receives the full scoped `Context` as trusted same-process composition code and must not drive the unpublished agent. Ordinary typed identity and option inputs are borrowed under their readonly contract, while seed events and session metadata are validated and snapshotted because they cross the durable session boundary. An optional `AbortSignal` cancels only load/setup/publication and is detached before the returned handle becomes visible.

The caller fiber and the AgentLoop provider are co-owners. `AgentFactory.createAgent(ownerCtx, options)` and `resume(ownerCtx, options)` receive caller ownership explicitly, while the factory keeps its own dependency context for `sessions`/`llm`/`tools`/`systemPrompt`; this lets a caller inject only `agents` without shrinking the new agent's service surface. Caller unload, handle disposal, or provider unload converge on one memoized quiescence boundary. Provider shutdown waits both resource teardown and the public create/resume wrapper that observed deactivation, so no continuation can publish after dependencies disappear.

IDs are caller-chosen and assumed globally unique; accidental UUID collisions are outside the supported model. Two concurrent operations with the same agent or session id may both prepare, but the final `enter()` calls arbitrate publication and every loser rolls its private resources back. Each detach is bound to the exact entered object, so a stale disposer cannot remove a later same-id replacement. A detach requested during a synchronous creation notification waits for that dispatch to unwind, preserving created/disposed pairing. Teardown runs stop and drain (including outstanding idle-injection flushes) → detach agent → detach session → unwind scope; IDs become reusable at detach even if private scope cleanup is still finishing. Ordinary non-vetoing `agent/*` notifications go through `agentEvents(ctx, agent)`, per-step assembly goes through `assembleContextFor(agent)`, and turn-end durability checkpoints go through `ctx.sessions.flush(session)`.

- `ctx.agentLoop.create(id: string, options?: AgentOptions, meta?: { cwd?: string }): ReactLoopAgent` — synchronous no-setup create, used directly by programs and by `cordis.yml`-configured agents. It creates a fresh per-run session id `${id}-session-<uuid>` with optional metadata; the uuid avoids colliding with a prior durable log. Each call is a new session (a deliberate demo simplification — a real resume-or-create policy is a TODO). Disposed with the calling fiber.

`AgentLoop` also implements the `AgentFactory` seam and registers itself via `ctx.agents.setFactory(this)`, so plugins create/resume agents through `ctx.agents` (the interface):

- `ctx.agents.create({ agentId, sessionId, meta?, seed?, agentOptions?, setup?, signal? }): Promise<AgentHandle>` — programmatic create on a caller-supplied `sessionId`, NOT `${id}-session`. It awaits the unpublished setup transaction before returning; `meta` carries cwd/lineage/seed-boundary metadata and `seed` reconstructs a forked child prefix after the session boundary validates and snapshots the durable values. `signal` applies only until this promise settles. The resolved [`AgentHandle`](../agent/README.md) owns exact teardown.
- `ctx.agents.resume({ agentId, resumeSessionId, agentOptions?, setup?, signal? }): Promise<AgentHandle>` — load a persisted session via `ctx.sessionPersistence` ([session persistence](../../../docs/rfc/implemented/architecture/2026-06-14-session-persistence.md)), reconstruct its history, then await setup against a fresh unpublished agent scope before rollback-covered publication. The live session id is the resumed id; turn numbering and derived history continue from the loaded log. Requires a session-persistence backend (NOT hard-injected — non-persistent demos still work; `resume` rejects with a clear error when persistence is absent). `signal` is creation-only. Returns an `AgentHandle`.

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

Agents listed in config are auto-created at startup. `cwd` applies only to fresh config-created sessions; `resumeSessionId` keeps the persisted session header. Config agents have no per-agent persona field: they use `dsh-system-prompt`'s deployment default, while programmatic factory callers can register an agent-scoped `deployment:persona` shadow in `setup`. The plugin registers the built-in `model`/`cwd` prompt variables on `ctx.systemPrompt`, resolved per step from `assembleContextFor(agent)` — the helper couples the typed agent with its matching scope selector. These are runtime facts of the agents THIS loop drives, unlike the `harness:identity` and default `deployment:persona` sections, which live on `dsh-system-prompt` so they survive a swapped loop plugin.

### Exported concrete class

- `ReactLoopAgent` — the concrete `Agent` implementation. Its inbox is a JavaScript native-private field, and one prepared session can be claimed by only one concrete driver. Everything observable happens through session events and the `agent/*` event taxonomy.

`Inbox`, `runLoop`, and the instance-bound publication/start controls are package-internal. The package root does not export them, and the package exports map exposes no `./src/*` escape hatch; lifecycle owners create agents through `ctx.agents` rather than constructing or starting the driver internals. `ReactLoopAgent.send()` and running `steer()` materialize content plus resolved source once as detached, deeply frozen lossless JSON, then share that accepted record between `agent/queued` and the inbox; malformed data throws before either boundary.

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
      assembly = await systemPrompt.assemble(assembleContextFor(agent))
                                                ⟵ renderPrompt(assembly) IS the full prompt
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

Error containment: a throwing plugin ends the **turn**, never the loop. A throwing `agent/turn-stop` policy likewise fails the turn closed. A successful terminal stop stays authoritative through `turn/end` and `session/flush`, preventing their listeners from resurrecting steering through the late fallback. Dispose mid-turn emits `agent/status('disposed')` and ends with reason `disposed`. A step that hits the model's output-token ceiling makes the turn end `max-tokens` (the rule: any `max-tokens` step in the turn surfaces as `max-tokens`; `disposed`/`aborted`/`error` still take precedence) — distinct from a clean `completed` stop.

Cancellation: `agent.cancel()` is the single public stop primitive — it clears the queued + steering FIFOs, aborts the in-flight step, and drives a turn-scoped marker the driver checks at every point a turn could start or continue (right after the idle wait, after the `running` flip, before each step, and at the continuation gate) so a turn about to start is dropped. A cancelled turn ends `aborted`; a queued-but-not-started prompt never runs and cannot be batched into the cancelled turn. The marker is reset once per loop iteration, so a cancel governs exactly one turn and never leaks onto a later prompt. (The loop still aborts its own per-step `AbortController` directly on disposal and from `cancel()`; that controller is loop-internal, not a public verb.)

### What belongs to plugins

Everything that goes beyond "call the model, run the tools, repeat" belongs to plugins listening on the event taxonomy:
- Hooks and policy: the relevant `agent/*` checkpoints plus the guarded `tools/pre-execute` → `tools/execute` → `tools/post-execute` → `tools/result` pipeline; exact signatures and modes live in the [generated event catalog](../../../docs/cordis-catalog/events.md)
- Compaction: `agent/pre-step`
- Sandbox, permission, plan mode: `tools/pre-execute` for extensible deny/ask, `tools.guard()` for monotonic owner policy, `tools/post-execute` for result decisions, and `tools/result` for final observation
- Sub-agents: implemented outside the loop as `ctx.subagents` providers; in-process providers use `ctx.agents.create()` and owned `AgentHandle` teardown, while child streaming/progress and background/poll collection remain deferred.
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

- **Tool calls within a step execute sequentially** — parallel execution waits on concurrency-safety metadata in the tool contract (see `dsh-tools`).
- **No resume-or-create policy on the config path** — config-driven `create()` starts a fresh `${id}-session-<uuid>` every run (`TODO(demo)`), and a config `resumeSessionId` whose resume fails logs a warning and creates no agent.
- **Config agents have no per-agent persona field or setup hook** — they use the deployment persona; scoped persona/tool composition is available only through the programmatic `ctx.agents.create()` / `resume()` factory options.
- **No built-in turn budget** — the default continuation is `continue` whenever a step had tool calls or steering; bounding a runaway turn requires an `agent/turn-continuation` force-stop plugin.
- **`runLoop`/`Inbox`/`InboxMessage` stay exported with no outside consumer** — [removal is proposed](../../../docs/rfc/proposed/simplification/2026-07-04-prune-dead-core-spine-surface.md).
