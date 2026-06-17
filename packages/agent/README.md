# dsh-agent

Agent interface, registry, and `agent/*` event vocabulary. Every plugin (UI, hooks, orchestrators) programs against the `Agent` handle defined here — it has zero loop dependency, so the loop is swappable.

## Service: `AgentRegistry` (ctx key: `agents`)

Tracks live agents so UI, hook, and orchestrator plugins can find them without importing the concrete loop package.

### Public API

- `ctx.agents.register(agent: Agent): () => void` — record an **already-constructed** agent. Disposed with the calling fiber.
- `ctx.agents.get(id: string): Agent | undefined`
- `ctx.agents.list(): Agent[]`

#### Factory seam (creation)

Agent *creation* is provided by whichever plugin implements `AgentFactory` (phase 1: `dsh-agent-loop`), registered via `setFactory`. This keeps creation on the `dsh-agent` interface so consumers (UI, the ACP bridge) program against `ctx.agents` without depending on the concrete loop package.

- `ctx.agents.setFactory(factory: AgentFactory): () => void` — register the creation factory (the loop calls this on construction). Throws on a second factory; the slot clears on dispose.
- `ctx.agents.create(options: CreateAgentOptions): Agent` — construct, start, AND register a new agent on a caller-supplied `sessionId` (with optional `meta.cwd`). Distinct from `register` (which only records). Throws if no factory is registered.
- `ctx.agents.resume(options: ResumeAgentOptions): Promise<Agent>` — load a persisted session ([session persistence](../../docs/rfc/implemented/2026-06-14-session-persistence.md)) and resume an agent on it. Async; rejects if no factory is registered, or if the factory finds session persistence unconfigured.

### Events

The full `agent/*` event taxonomy is declared via declaration merging in `dsh-agent` (not `dsh-agent-loop`), so plugins depend only on this package.

#### Lifecycle (emit)

- `agent/created`, `agent/disposed` — registration/deregistration
- `agent/status` — idle / running / disposed transition
- `agent/queued` — message entered inbox (source-resolved, steering flag)

#### Turn/step boundaries (emit)

- `agent/turn-start`, `agent/turn-end` (carries `TurnEndReason`)
- `agent/step-start`, `agent/step-end`

#### Interception seams (waterfall)

- `agent/request` — mutate `GenerateOptions` before the model call (hooks, compaction, model switching, tool filtering)
- `agent/step-result` — post-process the assembled assistant message before tool dispatch (validates what the log records)
- `agent/turn-continuation` — override the continue/stop decision (force-continue /loop, force-stop budget guard)

#### Streaming + tool (emit)

- `agent/stream-chunk` — raw chunk from the model (token-level UI/log feed)
- `agent/steering` — steering content injected mid-turn
- `agent/error` — step/turn error

### Agent interface (`types.ts`)

The handle every plugin programs against:

- `agent.send(content, options?)` — queue a message; starts a turn when idle
- `agent.steer(content, options?)` — steer a running turn (inject between steps); behaves like `send` when idle
- `agent.inject(content, options?)` — inject in-session context (context/message event); the next request sees it. Does not run the model. While a turn is open it joins that turn; while idle it is wrapped in a one-shot `injection` turn so every event stays turn-enclosed ([the turn-enclosure invariant](../../docs/rfc/implemented/2026-06-15-turn-enclosure-invariant.md))
- `agent.abort(reason?)` — abort the in-flight step
- `agent.whenIdle()` — resolve once the agent reaches quiescence after settling out of `running` (idle → immediately; disposed → awaits the loop exit), the signal a teardown awaits (`abort()` then `await whenIdle()`). Observes the transition without disposing the agent.
- `agent.session`, `agent.status`, `agent.options`, `agent.id`

### Extension points

- Agent creation: `AgentLoop.create()` is the concrete implementation (in `dsh-agent-loop`). Replace the loop by implementing `Agent` and registering via `ctx.agents.register()`.
- Event listeners: all `agent/*` events are declared here — no dependency on the loop package needed.

### What is NOT here (TODO)

- **Sub-agent spawn/fork** — seam on `AgentLoop.create()`, semantics deferred.
