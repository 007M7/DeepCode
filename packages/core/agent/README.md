# dsh-agent

Agent interface, registry, and `agent/*` event vocabulary. Every plugin (UI, hooks, orchestrators) programs against the `Agent` handle defined here — it has zero loop dependency, so the loop is swappable.

## Service: `AgentRegistry` (ctx key: `agents`)

Tracks live agents so UI, hook, and orchestrator plugins can find them without importing the concrete loop package.

### Public API

`Agent.ctx` owns registrations visible only to that agent. `agentEvents()` couples event subjects to their scope carrier, and `assembleContextFor()` couples the agent and prompt scope. Creation and resume may compose this context through `setup`; the agent remains unpublished and must not be driven until creation resolves.

- `ctx.agents.register(agent: Agent): () => void` — record an **already-constructed** agent. Disposed with the calling fiber.
- Advanced factory lifecycle: `enter(agent)` publishes without announcing and returns an entry-bound detach; `announce(agent)` emits creation once. Detach during creation dispatch is deferred. Ordinary plugins use `register()`.
- `ctx.agents.get(id: AgentId): Agent | undefined`
- `ctx.agents.list(): Agent[]`

#### Factory seam (creation)

The loop plugin registers `AgentFactory`, keeping consumers independent of its concrete package. Each call is traced through the caller's context so the caller owns the resulting transaction and handle.

- `ctx.agents.setFactory(factory: AgentFactory): () => void` — register the creation factory (the loop calls this on construction). Throws on a second factory; the slot clears on dispose.
- `ctx.agents.create(options)` creates and composes an unpublished session and agent, then atomically enters the registries and starts the loop. A creation-only signal cancels before publication; same-ID contenders arbitrate at entry and losers roll back.
- `ctx.agents.resume(options)` loads a persisted session and follows the same composition and publication boundary. It requires [session persistence](../../../docs/rfc/implemented/architecture/2026-06-14-session-persistence.md).

`AgentHandle = { agent, dispose }` is the consumer teardown capability; registry observers receive only the bare agent. Disposal stops and drains the loop and idle-injection flushes before unregistering the agent, detaching its session, and unwinding its scope. Caller and factory unload share that memoized boundary.

### Live events

`dsh-agent` declares the live `agent/*` coordination vocabulary so plugins do not depend on the concrete loop. Exact signatures, dispatch modes, scope-filtering rules, and payload contracts live in the generated [Cordis event catalog](../../../docs/cordis-catalog/events.md); the [architecture turn flow](../../../docs/architecture.md#turn-flow) shows their order relative to durable session events.

`agent/created` runs after setup and both registry entries; the following `agent/session-start` is the first supported startup injection point. `agent/disposed` means the exact entry left the registry. The loop quiesces its driver first; directly registered custom agents own any stronger ordering.

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
- Subagent delegation is not an `Agent` method; providers create or drive ordinary handles through the factory seam, so delegation transports stay outside the core agent interface.

## Model Experience

### User, steering, and injected messages

**What the model sees**: `send`, `steer`, and `inject` feed the owning session. `agent/prompt-submit`, `agent/session-prefix`, and other declared events let plugins block a prompt or add request material; this interface contributes no fixed prose itself.

**Token effect**: Accepted content becomes retained history or a repeated session prefix; blocked content contributes no request tokens. Size is caller- and plugin-dependent.

### Agent-scoped request composition

**What the model sees**: Registrations through `agent.ctx` can shadow prompt sections or tools and can install agent-only interceptors during unpublished setup.

**Token effect**: The package adds zero tokens itself; scoped contributions affect only that agent and disappear on disposal.

## Known Limitations and Deferred Work

- **Inter-agent channels beyond delegation** — shared state, streaming child output, and background/poll semantics remain outside the current synchronous `ctx.subagents` seam.
- **`agent/session-start` cannot gate startup** — it remains a synchronous, veto-less notification; async composition that must finish before publication belongs in the factory's `setup(agentCtx)` transaction instead.
- **No public step-only abort** — `cancel()` clears ALL pending work (queued + steering + in-flight); an abort that preserves queued prompts returns only with a named consumer ([stop-surface RFC](../../../docs/rfc/implemented/simplification/2026-06-20-public-agent-stop-surface.md)).
- **`HookContext` carries exactly one `MessageSource`** — contributions from several plugins merged onto one tool call collapse under one source; mixed provenance is unrepresentable.
- **`SessionStartSource` reserves `'clear'`/`'compact'` with no emitter yet** — only `'startup'`/`'resume'` occur until the driving subsystems land (`TODO(compaction)`).
