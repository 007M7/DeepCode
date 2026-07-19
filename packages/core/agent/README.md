# dsh-agent

Agent interface, registry, process-local initiator scope, and `agent/*` event vocabulary. Every plugin (UI, hooks, orchestrators) programs against the `Agent` handle defined here — it has zero loop dependency, so the loop is swappable.

## Service: `AgentRegistry` (ctx key: `agents`)

Tracks live agents and carries the initiating Agent through asynchronous driver work without importing the concrete loop package.

### Public API

The scoped-registration surface: `Agent.ctx` is the agent's scope context (`dsh-scope`, key = the agent) — register tools/sections/variables/listeners through it for that agent alone, all unwound on disposal. `agentEvents(ctx, agent)` is the fused dispatcher for ordinary agent-subject operations (carrier + injected subject in one move); its notification mode invokes every listener and contains both synchronous throws and returned-promise rejections. The registry lifecycle pair reuses one stable routing carrier. `assembleContextFor(agent)` builds the per-agent assembly context (`agent` + `scope` together). `CreateAgentOptions.setup(agentCtx)` and `ResumeAgentOptions.setup(agentCtx)` compose a fresh or resumed agent's scoped world while both objects remain unpublished. Setup is trusted, composition-only same-process code: drive the agent only after creation resolves.

- `ctx.agents.register(agent: Agent): () => void` — record an **already-constructed** agent. Disposed with the calling fiber.
- Advanced ordered lifecycle: `enter(agent, owner): () => void` enforces `agent.id === agent.session.id`, performs the authoritative ID collision check, and inserts without announcing; `owner` explicitly records the live creator-agent relation (or `undefined` for a root), independently of durable session lineage. `announce(agent)` emits `agent/created` exactly once. A detach requested synchronously by a creation listener is deferred until that dispatch unwinds, and every detach checks the captured entry object, so a stale capability cannot delete a later same-ID replacement. The async factory uses this split; ordinary plugins use `register()`.
- `ctx.agents.get(id: SessionId): Agent | undefined`
- `ctx.agents.isOwnedBy(id: SessionId, owner: Agent): boolean` — whether the exact live entry was created through that parent agent's scoped context; runtime ownership is independent of durable session lineage.
- `ctx.agents.list(): Agent[]`
- `ctx.agents.roots(): Agent[]` — live agents created without an owning agent context; a resumed lineage-bearing session can still be a runtime root.

#### Initiating Agent scope

`AgentLoop` runs each concrete driver's complete lifetime inside an initiator boundary. Concurrent drivers remain isolated: a child driver's continuations carry the child, while the parent continuation regains the parent as soon as `withInitiator()` returns; drain tracking continues until the child driver's Promise settles. Creation, persistence load, and unpublished setup remain outside the child's boundary, so setup initiated by a parent inherits the parent while `agentCtx.agent` identifies the child explicitly.

- `ctx.agents.currentInitiator(): Agent | undefined` — read the inherited initiator without requiring one.
- `ctx.agents.requireInitiator(): Agent` — read it or throw `no initiating agent is active`.
- `ctx.agents.withInitiator(agent, operation)` — run with one exact Agent and preserve the operation's exact synchronous value or Promise.
- `ctx.agents.withoutInitiator(operation)` — hide an inherited initiator for unrelated process-local work.

The scope carries the `Agent` itself and is process-local. Ambient presence is neither liveness proof nor authorization; explicit Agent fields remain authoritative at service, worker, process, persistence, and wire boundaries. Teardown rejects new boundaries, lets injected dependents and returned-Promise boundaries drain, then disables the underlying `AsyncLocalStorage`; unreturned work remains owned by the subsystem that detached it. If a boundary's inherited async chain starts an owning Cordis fiber's unload, that nested boundary chain is released from the drain so the unload cannot wait on itself; its continuations observe the disposed service after teardown. The [initiator-scope decision](../../../docs/rfc/implemented/architecture/2026-07-15-agent-initiator-scope.md) owns the detailed boundary and teardown contract.

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

`PromptDecision.additionalContexts` is an array so every injected context keeps its own source, envelope, and metadata. A `ContinuationDecision` reason is narrower: it becomes a `steering/message`, not a `context/message`, and therefore carries only content and source.

Turn and step boundaries and the model token stream are durable `session/event` facts rather than mirrored `agent/*` notifications. Consumers read `turn/*`, `step/*`, and `assistant/chunk` from the session feed; tool policy and outcome observation belong to the complete pipeline documented by [`dsh-tools`](../tools/README.md).

### Agent interface (`types.ts`)

The handle every plugin programs against:

- `agent.send(content, options?)` — queue a message; starts a turn when idle. Content and resolved source become one detached, deeply frozen lossless-JSON record before `agent/queued` and enqueue; invalid data throws synchronously, and caller or notification-listener in-place mutation cannot change the log or model input (`agent/prompt-submit` still rewrites by returning replacement content).
- `agent.steer(content, options?)` — steer a running turn (inject between steps); uses the same owned acceptance boundary and behaves like `send` when idle
- `agent.inject(content, options?)` — accept detached in-session context without running the model; the next request sees its `context/message`. `options.envelope` defaults to the canonical `<context>` framing and may be `'raw'` when the caller owns a complete familiar frame; `options.meta` persists opaque JSON state without rendering it. While a turn is open it joins that turn, deferring FIFO while the current tool batch executes and draining before turn close if execution is interrupted; while idle it is wrapped in a one-shot `injection` turn and durability checkpoint ([the turn-enclosure invariant](../../../docs/rfc/implemented/architecture/2026-06-15-turn-enclosure-invariant.md)).
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

- **Initiator scope is process-local** — workers, child processes, HTTP, durable queues, and restarts materialize any required identity explicitly.
- **Ambient identity may outlive liveness** — consumers still check `agent.status`, cancellation, and the owning capability contract before lifecycle-sensitive work.
- **Inter-agent channels beyond delegation** — shared state, streaming child output, and background/poll semantics remain outside the current synchronous `ctx.subagents` seam.
- **`agent/session-start` cannot gate startup** — it remains a synchronous, veto-less notification; async composition that must finish before publication belongs in the factory's `setup(agentCtx)` transaction instead.
- **No public step-only abort** — `cancel()` clears ALL pending work (queued + steering + in-flight); an abort that preserves queued prompts returns only with a named consumer ([stop-surface RFC](../../../docs/rfc/implemented/simplification/2026-06-20-public-agent-stop-surface.md)).
- **`HookContext` carries exactly one `MessageSource`** — contributions from several plugins merged onto one tool call collapse under one source; mixed provenance is unrepresentable.
- **`SessionStartSource` reserves `'clear'`/`'compact'` with no emitter yet** — only `'startup'`/`'resume'` occur until the driving subsystems land (`TODO(compaction)`).
- **`agent/pre-step`'s `fullSystemPrompt`/`sessionPrefix` parameters are a flagged smell** — compaction is their only consumer; a lazy prompt provider or a compaction-specific pressure seam is the marked revisit.
