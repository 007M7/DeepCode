# dsh-agent

Agent interface, registry, and `agent/*` event vocabulary. Every plugin (UI, hooks, orchestrators) programs against the `Agent` handle defined here — it has zero loop dependency, so the loop is swappable.

## Service: `AgentRegistry` (ctx key: `agents`)

Tracks live agents so UI, hook, and orchestrator plugins can find them without importing the concrete loop package.

### Public API

The scoped-registration surface: `Agent.ctx` is the agent's scope context (`dsh-scope`, key = the agent) — register tools/sections/variables/listeners through it for that agent alone, all unwound on disposal. `agentEvents(ctx, agent)` is the fused dispatcher every agent-subject event goes through (carrier + injected subject in one move); `assembleContextFor(agent)` builds the per-agent assembly context (`agent` + `scope` together). `CreateAgentOptions.setup(agentCtx)` and `ResumeAgentOptions.setup(agentCtx)` compose a fresh or resumed agent's scoped world while the factory keeps the agent and session unpublished; creation awaits setup and a same-turn owner-unload checkpoint before either creation notification or the first assembly. Setup composes, it never drives: the concrete loop rejects driving verbs until the `agent/session-start` boundary.

- `ctx.agents.register(agent: Agent): () => Promise<void> | void` — record an **already-constructed** agent. Disposed with the calling fiber.
- Advanced ordered lifecycle: `enter(agent): () => void` inserts without announcing, and `announce(agent)` emits `agent/created` only for that exact live entry. The async factory uses this split after setup; ordinary plugins use `register()`.
- `ctx.agents.get(id: AgentId): Agent | undefined`
- `ctx.agents.list(): Agent[]`

#### Factory seam (creation)

Agent *creation* is provided by the plugin implementing `AgentFactory` (`dsh-agent-loop`), registered via `setFactory`. This keeps creation on the `dsh-agent` interface so consumers (UI, the ACP bridge) program against `ctx.agents` without depending on the concrete loop package.

- `ctx.agents.setFactory(factory: AgentFactory): () => Promise<void> | void` — register the creation factory (the loop calls this on construction). Throws on a second factory; the slot clears on dispose.
- `ctx.agents.create(options: CreateAgentOptions): Promise<AgentHandle>` — snapshot caller-owned IDs/options/metadata and hand the one-read raw seed synchronously to the session boundary for one-pass lossless-JSON materialization, construct and await optional setup while unpublished, insert and announce both session and agent, open the `agent/session-start` driving boundary, then start a new loop on the caller-supplied `sessionId`. Agent/session IDs are reserved across setup; seed rejection, setup rejection, or owner unload publishes nothing. Publication is rollback-covered: if a creation listener throws, entries and scope unwind but effects of already-delivered notifications remain observable; an agent whose announcement began emits `agent/disposed` during that rollback. Rejects if no factory is registered.
- `ctx.agents.resume(options: ResumeAgentOptions): Promise<AgentHandle>` — snapshot caller-owned IDs/options, load a persisted session ([session persistence](../../../docs/rfc/implemented/architecture/2026-06-14-session-persistence.md)), mint a fresh agent scope, await optional setup while unpublished, then follow the same insert → announce → session-start → loop-start boundary. The IDs are reserved across persistence load and setup; load/setup rejection or owner unload publishes nothing. Rejects if no factory is registered or session persistence is unconfigured.

`AgentHandle = { agent: Agent; dispose(): Promise<void> }`. The disposer is a **capability** — only the holder can tear this agent down. `dispose()` stops the loop, `await`s its exit plus every outstanding idle-injection flush (quiescence — NOT just the `disposed` status flip), unregisters the agent, removes its session from the store, and finally unwinds its scoped world. This order captures every agent-started `session/flush` before the session is detached and keeps scoped listeners alive through those checkpoints. `ctx.agents.get(id)` still returns a bare `Agent` — the handle is only for the OWNER that created it. The ACP bridge and in-process subagent backends are production consumers; config-created agents are owned by the loop fiber and never need a handle.

### Live events

`dsh-agent` declares the live `agent/*` coordination vocabulary so plugins do not depend on the concrete loop. Exact signatures, dispatch modes, scope-filtering rules, and payload contracts live in the generated [Cordis event catalog](../../../docs/cordis-catalog/events.md); the [architecture turn flow](../../../docs/architecture.md#turn-flow) shows their order relative to durable session events.

The lifecycle edges have two important local caveats. `agent/created` runs after scoped setup and after both session and agent registry entries exist, but concrete driving remains locked until the immediately following `agent/session-start`; that non-vetoing notification is the first supported startup injection point. `agent/disposed` runs after the driver is quiescent and the agent leaves the registry, while ordered teardown may still be detaching its session and unwinding its scope.

Most interception points are cooperative waterfalls returning seam-specific decisions. `agent/pre-step` is a serial surface-mutation checkpoint, while `agent/turn-stop` is the owner-final exception: it runs after ordinary continuation and steering folding, and its terminal state remains through turn close and flush so steering from those later listeners cannot create an extra step or turn. Ordinary queued prompts remain intact. The full rationale is in [the agent-scope RFC](../../../docs/rfc/implemented/architecture/2026-07-08-agent-scope-contexts.md#owner-final-policy-boundaries).

Turn and step boundaries and the model token stream are durable `session/event` facts rather than mirrored `agent/*` notifications. Consumers read `turn/*`, `step/*`, and `assistant/chunk` from the session feed; tool policy and outcome observation belong to the complete pipeline documented by [`dsh-tools`](../tools/README.md).

### Agent interface (`types.ts`)

The handle every plugin programs against:

- `agent.send(content, options?)` — queue a message; starts a turn when idle
- `agent.steer(content, options?)` — steer a running turn (inject between steps); behaves like `send` when idle
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
