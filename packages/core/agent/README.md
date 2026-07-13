# dsh-agent

Agent interface, registry, and `agent/*` event vocabulary. Every plugin (UI, hooks, orchestrators) programs against the `Agent` handle defined here — it has zero loop dependency, so the loop is swappable.

## Service: `AgentRegistry` (ctx key: `agents`)

Tracks live agents so UI, hook, and orchestrator plugins can find them without importing the concrete loop package.

### Public API

The scoped-registration surface: `Agent.ctx` is the agent's scope context (`dsh-scope`, key = the agent) — register tools/sections/variables/listeners through it for that agent alone, all unwound on disposal. `agentEvents(ctx, agent)` is the fused dispatcher for ordinary agent-subject operations (carrier + injected subject in one move); its notification mode invokes every listener and contains both synchronous throws and returned-promise rejections. The registry lifecycle pair reuses one stable routing carrier. `assembleContextFor(agent)` builds the per-agent assembly context (`agent` + `scope` together). `CreateAgentOptions.setup(agentCtx)` and `ResumeAgentOptions.setup(agentCtx)` compose a fresh or resumed agent's scoped world while both objects remain unpublished. Setup is trusted, composition-only same-process code: drive the agent only after creation resolves.

- `ctx.agents.register(agent: Agent): () => void` — record an **already-constructed** agent. Disposed with the calling fiber.
- Advanced ordered lifecycle: `enter(agent): () => void` performs the authoritative ID collision check and inserts without announcing; `announce(agent)` emits `agent/created` exactly once. A detach requested synchronously by a creation listener is deferred until that dispatch unwinds, and every detach checks the captured entry object, so a stale capability cannot delete a later same-ID replacement. The async factory uses this split; ordinary plugins use `register()`.
- `ctx.agents.get(id: AgentId): Agent | undefined`
- `ctx.agents.list(): Agent[]`

#### Factory seam (creation)

Agent *creation* is provided by the plugin implementing `AgentFactory` (`dsh-agent-loop`), registered via `setFactory`. This keeps creation on the `dsh-agent` interface so consumers (UI, the ACP bridge) program against `ctx.agents` without depending on the concrete loop package. The registry canonicalizes an already traced Service to its concrete target and re-traces each call through the caller's context; this avoids nested Cordis shadows while passing an explicit caller-bound `ownerCtx` to plain factories.

- `ctx.agents.setFactory(factory: AgentFactory): () => void` — register the creation factory (the loop calls this on construction). Throws on a second factory; the slot clears on dispose.
- `ctx.agents.create(options: CreateAgentOptions): Promise<AgentHandle>` — create a session and agent, await optional setup while unpublished, then publish through final `SessionStore.enter()` and `AgentRegistry.enter()` checks. Concurrent same-ID creation is unsupported: more than one operation may prepare, but only one can enter; every loser rolls its private scope/session/driver back. An optional creation-only `signal` cancels unpublished setup and is detached before the handle is returned; later cancellation uses `handle.dispose()` or `agent.cancel()`. Publication is rollback-covered and every delivered creation edge is paired during rollback. Rejects if no factory is registered.
- `ctx.agents.resume(options: ResumeAgentOptions): Promise<AgentHandle>` — load a persisted session ([session persistence](../../../docs/rfc/implemented/architecture/2026-06-14-session-persistence.md)), mint a fresh unpublished agent scope, await optional setup, and use the same final-entry publication sequence. Its optional `signal` is likewise creation-only. Rejects if no factory is registered or session persistence is unconfigured.

`AgentHandle = { agent: Agent; dispose(): Promise<void> }`. The disposer is a **consumer capability** — no observer holding the bare registry entry can tear the agent down. The caller fiber and the registered factory provider are structural co-owners: caller unload enforces structured ownership, while factory unload must stop old instances because their scoped dependency surface belongs to that provider. `dispose()` from any owner reaches one memoized quiescence boundary: it stops the loop, `await`s its exit plus every outstanding idle-injection flush (not just the `disposed` status flip), unregisters the agent, removes its session from the store, and finally unwinds its scoped world. This order captures every agent-started `session/flush` before the session is detached and keeps scoped listeners alive through those checkpoints. `ctx.agents.get(id)` still returns a bare `Agent`; the ACP bridge and in-process subagent backends hold consumer handles, while config-created agents are already owned by the loop fiber.

### Live events

`dsh-agent` declares the live `agent/*` coordination vocabulary so plugins do not depend on the concrete loop. Exact signatures, dispatch modes, scope-filtering rules, and payload contracts live in the generated [Cordis event catalog](../../../docs/cordis-catalog/events.md); the [architecture turn flow](../../../docs/architecture.md#turn-flow) shows their order relative to durable session events.

The lifecycle edges have two important local caveats. `agent/created` runs after scoped setup and after both session and agent registry entries exist. Setup is trusted composition-only code; the immediately following non-vetoing `agent/session-start` notification is the first supported startup injection point. `agent/disposed` always means the exact agent has left the registry. AgentLoop emits it after its driver is quiescent, while ordered teardown may still be detaching the session and unwinding the scope; custom agents registered directly own any stronger driver-ordering contract themselves.

Most interception points are cooperative waterfalls returning seam-specific decisions. `agent/pre-step` is a serial surface-mutation checkpoint, while `agent/turn-stop` is the terminal serial fold: it runs after ordinary continuation and steering folding, and a returned stop remains in force through turn close and flush so later steering cannot create an extra step or turn. Ordinary queued prompts remain intact. The full rationale is in the [agent-scope runtime-design RFC](../../../docs/rfc/implemented/architecture/2026-07-12-agent-scope-runtime-design.md#three-execution-boundaries-are-deliberately-one-way).

Turn and step boundaries and the model token stream are durable `session/event` facts rather than mirrored `agent/*` notifications. Consumers read `turn/*`, `step/*`, and `assistant/chunk` from the session feed; tool policy and outcome observation belong to the complete pipeline documented by [`dsh-tools`](../tools/README.md).

### Agent interface (`types.ts`)

The handle every plugin programs against:

- `agent.send(content, options?)` — queue a message; starts a turn when idle. Content and resolved source become one detached, deeply frozen lossless-JSON record before `agent/queued` and enqueue; invalid data throws synchronously, and caller or notification-listener in-place mutation cannot change the log or model input (`agent/prompt-submit` still rewrites by returning replacement content).
- `agent.steer(content, options?)` — steer a running turn (inject between steps); uses the same owned acceptance boundary and behaves like `send` when idle
- `agent.inject(content, options?)` — inject in-session context (context/message event); the next request sees it. Does not run the model. While a turn is open it joins that turn; while idle it is wrapped in a one-shot `injection` turn so every event stays turn-enclosed ([the turn-enclosure invariant](../../../docs/rfc/implemented/architecture/2026-06-15-turn-enclosure-invariant.md))
- `agent.cancel(reason?)` — cancel ALL pending work: clears the queued + steering FIFOs, aborts the in-flight step, and drops a turn about to start (the pre-step window) so a queued-but-not-started prompt never runs. A UI/ACP `session/cancel` maps to this. The single public stop primitive. Idle with nothing pending → a safe no-op.
- `agent.whenIdle()` — resolve once the agent reaches quiescence after settling out of `running` (idle → immediately; disposed → awaits the loop exit). A non-owner's quiescence-observation hook: it observes the work settling WITHOUT tearing the agent down. Teardown is separate — a lifecycle owner stops and unregisters via `AgentHandle.dispose()`, which awaits the loop exit directly.
- `agent.session`, `agent.status`, `agent.options`, `agent.id`

### Extension points

- Agent creation: `AgentLoop.create()` is the concrete config-path implementation (in `dsh-agent-loop`), while programmatic consumers create/resume owned agents through `ctx.agents.create()` / `ctx.agents.resume()`. Replace the loop by implementing `Agent` and registering via `ctx.agents.register()`.
- Event listeners: all `agent/*` events are declared here — no dependency on the loop package needed.
- Subagent delegation: implemented by `@deepseek-ai/dsh-subagent`, not by a method on `Agent`; providers create or drive ordinary `Agent` handles through the factory seam, so spawn/fork/ACP transports stay outside the core agent interface.

### What is NOT here (TODO)

- **Inter-agent channels beyond delegation** — shared state, streaming child output, and background/poll semantics remain outside the current synchronous `ctx.subagents` seam.
