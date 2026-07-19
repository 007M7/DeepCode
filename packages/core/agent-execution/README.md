# dsh-agent-execution

Process-local ambient Agent identity for asynchronous work initiated by a concrete agent driver. The default export, `AgentExecutionProvider`, installs the mandatory `ctx.agentExecution` service; [`dsh-agent-loop`](../agent-loop/README.md) establishes one boundary around each driver's complete lifetime.

## Service: `AgentExecutionService` (ctx key: `agentExecution`)

- `current()` returns the inherited `AgentExecution` or `undefined` outside a driver and inside an explicit clearing boundary.
- `require()` returns the inherited execution or throws `no agent execution context is active`.
- `run(execution, operation)` returns the exact synchronous value or Promise from `operation`. Passing `undefined` establishes a real boundary that hides an inherited Agent.

The store contains only `{ readonly agent: Agent }`. The `Session` remains available through `agent.session`; turn, step, `signal`, `cwd`, sandbox, authorization, and other capability state remain with their explicit owners. Ambient presence identifies the initiator but does not prove that the Agent is live or that an operation is authorized.

## Lifetime and detached work

Provider teardown rejects new `run()` boundaries, removes the service so injected dependents drain, waits for returned Promise boundaries, then disables its `AsyncLocalStorage`. In-flight code retaining the service can call `current()` and `require()` while it drains; after disposal, all three methods throw `agent execution service is disposed`.

Async resources created inside `run()` inherit its Agent even if `operation` returns before they settle, but provider teardown waits only for the Promise returned by `operation`. The owning seam must stop unreturned work explicitly. Unrelated timers, queues, and deployment infrastructure start under `run(undefined, operation)` and own an explicit stop; queue, worker, process, and wire boundaries serialize any identity they need instead of relying on ALS propagation.

## Known Limitations and Deferred Work

- **Process-local only** — ALS does not cross workers, child processes, HTTP, durable queues, or restarts; each boundary materializes a typed identity explicitly.
- **Agent identity only** — turn, step, signal, cwd, sandbox, and authorization stay outside the frame until a concrete cross-cutting consumer justifies a separate design.
- **Ambient references may outlive liveness** — consumers still check `agent.status`, their explicit signal, and the owning capability contract before lifecycle-sensitive work.
