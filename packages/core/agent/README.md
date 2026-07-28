# dsh-agent

English | [中文](README.zh.md)

Agent interface, registry, process-local initiator scope, and `agent/*` event vocabulary. Every plugin (UI, hooks, orchestrators) programs against the `Agent` handle defined here — it has zero loop dependency, so the loop is swappable.

The optional `@deepseek-ai/dsh-agent/invariant` companion registers this package's agent-status transition checks with `ctx.invariants`. The root agent service does not load diagnostics implicitly.

## Service: `AgentRegistry` (ctx key: `agents`)

Tracks live agents and carries the initiating Agent through asynchronous driver work without importing the concrete loop package.

### Public API

The scoped-registration surface: `Agent.ctx` is the agent's scope context (`dsh-scope`, key = the agent) — register tools/sections/variables/listeners through it for that agent alone, all unwound on disposal. `agentEvents(ctx, agent)` is the fused dispatcher for ordinary agent-subject operations (carrier + injected subject in one move); its notification mode invokes every listener and contains both synchronous throws and returned-promise rejections. The registry lifecycle pair reuses one stable routing carrier. `assembleContextFor(agent)` builds the per-agent assembly context (`agent` + `scope` together). `installAgentLlmTarget(agentCtx, target)` snapshots a mutable provider/model/reasoning-effort selection during prompt assembly, applies the route to prompt variables, and applies the complete target to request routing for one step; an absent selected effort clears an inherited effort so the target uses adapter/provider defaults. `CreateAgentOptions.setup(agentCtx)` and `ResumeAgentOptions.setup(agentCtx)` compose a fresh or resumed agent's scoped world while both objects remain unpublished. Setup is trusted, composition-only same-process code: drive the agent only after creation resolves.

`AgentOptions` supplies the initial provider/model route and an optional positive `maxTokens` output cap. The concrete loop records the cap in the request header and applies it to each conversation-model request; callers that omit it leave provider defaults in control.

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

The scope carries the `Agent` itself and is process-local. Ambient presence is neither liveness proof nor authorization; explicit Agent fields remain authoritative at service, worker, process, persistence, and wire boundaries. Teardown rejects new boundaries, lets injected dependents and returned-Promise boundaries drain, then disables the underlying `AsyncLocalStorage`; unreturned work remains owned by the subsystem that detached it. If a boundary's inherited async chain starts an owning Cordis fiber's unload, that nested boundary chain is released from the drain so the unload cannot wait on itself; its continuations observe the disposed service after teardown. The [initiator-scope decision](../../../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.md) owns the detailed boundary and teardown contract.

#### Factory seam (creation)

Agent *creation* is provided by the plugin implementing `AgentFactory` (`dsh-agent-loop`), registered via `setFactory`. This keeps creation on the `dsh-agent` interface so consumers (UI, the ACP bridge) program against `ctx.agents` without depending on the concrete loop package. The registry canonicalizes an already traced Service to its concrete target and re-traces each call through the caller's context; this avoids nested Cordis shadows while passing an explicit caller-bound `ownerCtx` to plain factories.

- `ctx.agents.setFactory(factory: AgentFactory): () => void` — register the creation factory (the loop calls this on construction). Throws on a second factory; the slot clears on dispose.
- `ctx.agents.create(options: CreateAgentOptions): Promise<AgentHandle>` — create a session and agent, await optional setup while unpublished, then publish through final `SessionStore.enter()` and `AgentRegistry.enter()` checks. Concurrent same-ID creation is unsupported: more than one operation may prepare, but only one can enter; every loser rolls its private scope/session/driver back. An optional creation-only `signal` cancels unpublished setup and is detached before the handle is returned; later cancellation uses `handle.dispose()` or `agent.cancel()`. Publication is rollback-covered and every delivered creation edge is paired during rollback. Rejects if no factory is registered.
- `ctx.agents.resume(options: ResumeAgentOptions): Promise<AgentHandle>` — load a persisted session ([session persistence](../../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md)), mint a fresh unpublished agent scope, await optional setup, and use the same final-entry publication sequence. Its optional `signal` is likewise creation-only. Rejects if no factory is registered or session persistence is unconfigured.

`AgentHandle = { agent: Agent; dispose(): Promise<void> }`. The disposer is a **consumer capability** — no observer holding the bare registry entry can tear the agent down. The caller fiber and the registered factory provider are structural co-owners: caller unload enforces structured ownership, while factory unload must stop old instances because their scoped dependency surface belongs to that provider. `dispose()` from any owner reaches one memoized quiescence boundary: it stops the loop, awaits its exit, unregisters the agent, removes its session from the store, and finally unwinds its scoped world. `ctx.agents.get(id)` still returns a bare `Agent`; the ACP bridge and in-process subagent backends hold consumer handles, while config-created agents are already owned by the loop fiber.

### Live events

`dsh-agent` declares the live `agent/*` coordination vocabulary so plugins do not depend on the concrete loop. Exact signatures, dispatch modes, scope-filtering rules, and payload contracts live in the generated [Cordis event catalog](../../../docs/cordis-catalog/events.md); the [architecture turn flow](../../../docs/architecture.md#turn-flow) shows their order relative to durable session events.

The lifecycle edges have two important local caveats. `agent/created` runs after scoped setup and after both session and agent registry entries exist. Setup is trusted composition-only code; the immediately following non-vetoing `agent/session-start` notification is the first supported startup injection point. `agent/disposed` always means the exact agent has left the registry. AgentLoop emits it after its driver is quiescent, while ordered teardown may still be detaching the session and unwinding the scope; custom agents registered directly own any stronger driver-ordering contract themselves.

Most interception points are cooperative waterfalls. Turn-scoped asynchronous seams receive one explicit `AbortSignal`, with `signal` immediately before a waterfall's final `next`; listeners may cooperate but must not retain it as authority over another turn. `agent/step` is the serial checkpoint before request derivation, while `agent/request-error` is the failed-model-request recovery waterfall: it receives the exact error, normalized failure facts, and signal after the failed step closes. A listener returns `{ kind: 'retry' }` without calling `next()` when it owns recovery; the loop closes the failed turn and opens one numbered retry turn. `agent/turn-stopping` runs before an otherwise completed turn closes. Ordinary queued prompts remain intact. Effective broad cancellation first emits the observe-only `agent/cancel-requested` with its resolved typed cause, then clears queues and aborts; notification failures are contained and cannot veto the stop. The [explicit-cancellation decision](../../../.agents/notes/implemented/architecture/2026-07-16-explicit-turn-cancellation.md) owns signal lifetime; the [agent-scope runtime-design Agent Note](../../../.agents/notes/implemented/architecture/2026-07-12-agent-scope-runtime-design.md#three-execution-boundaries-are-deliberately-one-way) owns scoped dispatch and terminal settlement.

`PromptDecision.additionalContexts` is an array of identified, frozen `UserMessage` values so every context keeps its own identity and source. The admitted prompt and every additional context become separate model-facing `user/message` events before the turn runs. A listener that wraps a downstream allow preserves its `content` and `additionalContexts` unless it intentionally replaces either field; replacing admitted content preserves the prompt's identity.

Turn and step boundaries and the model token stream are durable `session/event` facts rather than mirrored `agent/*` notifications. Consumers read `turn/*`, `step/*`, and `assistant/chunk` from the session feed; tool policy and outcome observation belong to the complete pipeline documented by [`dsh-tools`](../tools/README.md).

### Agent interface (`types.ts`)

The handle every plugin programs against:

- `agent.send(message, options)` — the one delivery primitive over the (`target` × `wakeup`) matrix. `message` is an already identified, frozen `UserMessage`; callers normally create it with `createUserMessage()` before routing begins. `SendOptions` owns only the `target` and `wakeup` policy. The agent publishes or queues the complete value as-is without minting or replacing its identity. The message's `agent/inbox/enqueue`/`dequeue`/`discard` events carry it so callers can correlate a queued item with its lifecycle; enqueue and dequeue also carry the resolved `queued | steering` placement so repeated message identities retire from the correct FIFO. `target: 'next-turn'` queues one independent FIFO item that, if admitted, becomes the sole ordinary prompt in its turn. `target: 'next-step'` with `wakeup: true` submits steering, while `target: 'next-step'` with `wakeup: false` injects durable context without running the model. The [one-send-one-turn Agent Note](../../../.agents/notes/implemented/simplification/2026-07-17-one-send-one-turn.md) owns the turn rationale.
- `agent.followup(input)` — the `next-turn`/wakeup preset of `send()`: queue an ordinary follow-up turn and wake the driver.
- `agent.steer(input)` — the `next-step`/wakeup preset: during prompt admission or an open turn, stage steering for the next safe boundary without dispatching `agent/prompt-submit`; outside that acceptance window, delegate to a woken follow-up. Admission failure leaves staged steering for retry or a later admitted prompt, while cancellation or disposal may discard it.
- `agent.inject(input)` — the `next-step`/no-wakeup preset: append model-facing context without running the model; the next request sees a verbatim user-role message whose provenance is carried by the required `input.source`. During prompt admission or an open turn, injection waits in the outbox for the next safe boundary. Outside that acceptance window, it appends immediately without opening a turn; a context-only admission batch takes this fallback if admission closes without a turn, while context staged beside steering remains pending with it. Persistence reacts to `session/event` independently. Injection emits no `agent/inbox/*` event.
- `agent.acceptsNextStep` — whether a `next-step` send would currently join prompt admission or the open turn. Use this narrower routing predicate when a caller must choose between steering and a fresh admitted prompt; `status === 'running'` also covers admission exit and turn settlement.
- `agent.cancel(cause, options?)` — cancel the active turn and, unless `options.keepInbox`, ALL pending work. Callers must choose the `user | parent` cause explicitly; an active holder copies its discriminant into a detached frozen signal reason before aborting. An effective call emits `agent/cancel-requested` with the cause before clearing queued and steering work; dropped items are reported on `agent/inbox/discard`, and observers may synchronize state but cannot veto cancellation. `keepInbox: true` aborts the turn but preserves queued and steering items (no discard, and un-started work is not dropped). The same-process typed seam adds no runtime validation or compatibility fallback for untyped callers. Repeated active-turn cancellation is first-wins for the signal, and idle cancellation is a safe no-op with no notification. ACP maps to `user`, while in-process parent propagation maps to `parent`. The cause is runtime-only; durable `turn/end` stays coarse `aborted`.
- `agent.whenIdle()` — resolve once the agent reaches quiescence after settling out of `running` (idle → immediately; disposed → awaits the loop exit). A non-owner's quiescence-observation hook: it observes the work settling WITHOUT tearing the agent down. Teardown is separate — a lifecycle owner stops and unregisters via `AgentHandle.dispose()`, which awaits the loop exit directly.
- `agent.session`, `agent.status`, `agent.options`, `agent.id`

`running` describes a driver-wide drain interval, not proof that a turn is still open; it can cover turn close, the durability checkpoint, and consecutive queued turns.

### Extension points

- Agent creation: `AgentLoop.create()` is the concrete config-path implementation (in `dsh-agent-loop`), while programmatic consumers create/resume owned agents through `ctx.agents.create()` / `ctx.agents.resume()`. Replace the loop by implementing `Agent` and registering via `ctx.agents.register()`.
- Event listeners: all `agent/*` events are declared here — no dependency on the loop package needed.
- Subagent delegation is not an `Agent` method; providers create or drive ordinary handles through the factory seam, so delegation transports stay outside the core agent interface.

## Model Experience

### User, steering, and injected messages

#### What the model sees

`send`, `steer`, and `inject` feed the owning session. `agent/prompt-submit`, `agent/step`, and other declared events let plugins block a prompt or add durable request material; this interface contributes no fixed prose itself.

#### Token effect

Accepted content becomes retained history or a repeated session prefix; blocked content contributes no request tokens. Size is caller- and plugin-dependent.

#### KV Cache effect

Accepted history and steering are append-only; a blocked submission sends no request. A session prefix remains stable within its loop instance, while a new or resumed instance may establish a different prefix.

### Agent-scoped request composition

#### What the model sees

Registrations through `agent.ctx` can shadow prompt sections or tools and can install agent-only interceptors during unpublished setup.

#### Token effect

The package adds zero tokens itself; scoped contributions affect only that agent and disappear on disposal.

#### KV Cache effect

Prefix-stable while an agent's scoped registrations are unchanged. Setup or reload that changes prompt sections, tool definitions, or request listeners may invalidate reuse from the first affected request token.

## Known Limitations and Deferred Work

- **Initiator scope is process-local** — workers, child processes, HTTP, durable queues, and restarts materialize any required identity explicitly.
- **Ambient identity may outlive liveness** — consumers still check `agent.status`, cancellation, and the owning capability contract before lifecycle-sensitive work.
- **Inter-agent channels beyond delegation** — shared state, streaming child output, and background/poll semantics remain outside the current synchronous `ctx.subagents` seam.
- **`agent/session-start` cannot gate startup** — it remains a synchronous, veto-less notification; async composition that must finish before publication belongs in the factory's `setup(agentCtx)` transaction instead.
- **`cancel()` clears the inbox by default** — it aborts the in-flight turn plus queued and steering work; `cancel(cause, { keepInbox: true })` aborts only the turn and preserves pending items. There is still no step-only abort that keeps the in-flight turn running ([stop-surface Agent Note](../../../.agents/notes/implemented/simplification/2026-06-20-public-agent-stop-surface.md)).
- **Each additional `UserMessage` carries exactly one `MessageSource`** — contributions from several plugins merged onto one tool call collapse under one source; mixed provenance is unrepresentable.
- **`SessionStartSource` reserves `'clear'`/`'compact'` with no emitter yet** — only `'startup'`/`'resume'` occur until the driving subsystems land (`TODO(compaction)`).
