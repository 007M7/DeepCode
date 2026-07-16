# RFC: Agent execution context over AsyncLocalStorage

Status: proposed

English | [中文](2026-07-15-agent-execution-context.zh.md)

## Problem

The harness has two useful but different notions of context:

- A Cordis `Context` is a composition and lifetime object. The deployment context exposes shared services, while `agent.ctx` exposes the flat registration layer owned by one live Agent.
- Agent, Session, turn, step, and tool identity are execution subjects. The loop passes them explicitly through events, prompt assembly, LLM requests, and `ToolExecution`.

These concepts must not be conflated. In particular, `agent.ctx.agent` is a static association on the Agent's scoped composition context. A plain root context deliberately returns `undefined`; it cannot be changed to mean "whichever Agent happens to be running now" because one Node process may run many Agents concurrently.

This leaves a practical gap for deeply nested infrastructure. A capability transport, skill provider, tracing helper, logger, or gateway client may need to know which Agent initiated the current asynchronous operation. Passing `agent` through every intermediate helper is noisy, while deriving identity from a process-global mutable slot is incorrect as soon as two Agents overlap. Model-visible tool arguments are also the wrong carrier: the model must not be able to choose a trusted Session or sandbox-routing header.

The gap becomes important when a single Harness runtime multiplexes Sessions for a multi-tenant hosting platform. Outbound capability requests must automatically carry the current Harness Session ID so the host can resolve the correct tenant and sandbox owner. Model-facing skills and tools should not know host-specific routing, but the selected capability implementation still needs a trusted current Agent at the transport boundary.

## Proposal

Add a narrow Agent execution-context facility backed by Node `AsyncLocalStorage`. It provides ambient access to the Agent associated with the current asynchronous execution chain without replacing Cordis contexts, explicit protocol fields, or durable Session state.

The first version stores only the Agent:

```text
export interface AgentExecution {
  readonly agent: Agent
}

export interface AgentExecutionService {
  current(): AgentExecution | undefined
  require(): AgentExecution
  run<T>(execution: AgentExecution | undefined, operation: () => T): T
}
```

`Session` is derived as `execution.agent.session`; it is not duplicated in the store. Turn, step, tool call, model, cwd, and sandbox identity remain outside the first version because they already have authoritative owners and no confirmed ambient consumer requires them yet. The single-field wrapper is deliberate: a later execution-frame refinement extends `AgentExecution` without changing `run()` callers, so implementations must not flatten the store to a bare `Agent`.

`AgentExecution` deliberately retains the exact live `Agent`, not an id snapshot. This is the one capability admitted to the first-version store because it is the subject whose driver establishes the boundary and because existing scoped helpers operate on that exact object. Ambient presence is not proof of liveness or authorization: consumers must still honor the Agent lifecycle and the explicit capability contract before performing lifecycle-sensitive work.

The API must always establish an ALS boundary, including when the supplied execution is `undefined`. This provides an explicit way to clear inherited context for unrelated detached work. A comparable implementation observed an uncleared ambient value crossing scheduled work into a later turn; the explicit undefined boundary prevents that class of leak.

### Package and service placement

Create `packages/core/agent-execution/` as `@deepseek-ai/dsh-agent-execution`. The package owns the Node-specific ALS implementation and augments Cordis with the mandatory `ctx.agentExecution` service. It belongs to `core/` because it is part of the stable Agent control spine that every concrete Agent loop and ambient-identity consumer programs against.

The public key is `ctx.agentExecution`, settled here so every surface — service key, interface name, and package name — shares one word root. It names the Agent-owned asynchronous chain rather than one turn or tool call. `ctx.execution` is too broad; a runtime-flavored name would collide with `packages/code-runtime/` and with "Harness runtime" meaning the whole process; and changing `ctx.agent` is excluded because it already means the static Agent association of `agent.ctx`.

The package exposes the service through Cordis rather than a mutable module-global slot:

- the Agent Loop can inject the service explicitly;
- tests can mount an isolated service per Harness context;
- service disposal can disable its ALS instance after dependent Agent drivers quiesce;
- the dependency remains visible in Cordis configuration and generated catalogs.

The service loads mandatorily with the standard agent composition bundle, and `dsh-agent-loop` declares it in `inject`: a composition that drives agents without it fails at load, per the fail-loud rule, rather than degrading to absent ambient identity at the first deep consumer. Configuration tests pin this policy. The facility relies only on stable Node `AsyncLocalStorage`, available without a polyfill across the supported `node ^22.19 || >=24` range. Node 24+ uses an `AsyncContextFrame`-backed implementation, while Node 22 uses the earlier implementation; this RFC accepts the always-on propagation cost for the invariant and makes no zero-overhead claim.

Service teardown is ordered rather than transparent. The Agent Loop stops accepting new work, cancels and drains every driver, and only then may the service disable its ALS instance. HMR of the service rebuilds that dependent subtree; it does not preserve an in-flight turn across reload. A retained reference to a disposed service throws a stable disposed-service error from both `current()` and `require()` instead of silently returning `undefined`.

### Lifecycle boundary

Bind the execution context around each concrete Agent driver's `runLoop` lifetime:

```text
agentExecution.run({ agent }, () => runLoop(ctx, agent, handle))
```

This gives every operation initiated by that driver the same trusted Agent:

- prompt interception and prompt assembly;
- LLM adapter calls;
- tool policy and tool bodies;
- capability providers and transports;
- synchronous and asynchronous helpers awaited by those operations.

Concurrent drivers receive distinct ALS stores. A child Agent's own driver establishes a new boundary with the child, so child operations do not inherit the parent Agent merely because child creation started inside a parent tool call. When a nested boundary returns, ALS restores the parent automatically.

Agent creation setup is deliberately outside this dynamic boundary. Setup already receives `agentCtx`, whose `agentCtx.agent` is the correct unpublished Agent. Publication and lifecycle ownership continue to use the existing explicit Agent and scoped carrier. One consequence is a defined contract, not an accident: when child creation starts inside a parent tool call, the child's setup and persistence load run under the PARENT's ambient identity, because the child's driver has not started. A transport reached during that window routes under the parent's Session — correct for trusted routing, since the parent initiated and owns the creation work. Setup code that needs the child's identity uses the explicit `agentCtx.agent`, never the ambient store.

### Explicit subjects remain authoritative

Ambient identity is a convenience for deep infrastructure, not a replacement for existing contracts:

- `AgentEventDispatch` continues to carry the explicit Agent subject and scope.
- `AssembleContext.agent` remains explicit.
- `ToolExecution.agent` remains explicit and continues to select the scoped tool and policy view.
- `GenerateOptions.sessionId` remains explicit at the LLM boundary.
- Subagent requests and lifecycle events continue to carry explicit parent and child identity.
- Session events remain the durable truth for replay and resume.

Code at a public service, process, worker, persistence, or wire boundary must materialize the identity it needs into that boundary's typed request. A remote process cannot access the parent's ALS store.

### Trusted transport use

A host-aware capability transport may read `ctx.agentExecution.require().agent.session.id` when constructing an outbound request and add a deployment-owned trusted header such as `X-Harness-Session-Id`. The header is not present in model-visible tool arguments and cannot be overridden by the model. Ambient presence alone does not authorize a request; the transport still runs inside its normal explicit capability and Agent-lifecycle contracts.

The bash seam's existing `OwnerToken` is the nearest explicit-identity precedent and shows why it does not close this gap: `BashExecSpec.owner` is a background-task isolation key that `dsh-tool-bash` casts from the session id, foreground `run()` deliberately ignores it, and the filesystem seam has no counterpart — its provider methods carry no identity parameter at all. Extending every capability seam with a routing-identity parameter would push hosting concerns into seam vocabularies that are otherwise deployment-neutral; ambient identity lets the transport implementation own routing without widening any seam.

The hosting platform remains responsible for resolving the Harness runtime Session ID to its product Session and sandbox owner. Harness does not learn the host's sandbox identifier, sandbox provider, or persistence model.

Model-facing skill and tool plugins should not add hosting-specific headers themselves. They call a capability service; the selected provider owns remote execution and identity propagation. This preserves the separation between model behavior and backend routing.

### Detached asynchronous work

Node ALS is inherited by asynchronous resources created inside `run()`, even when callers do not await them. This is useful for an Agent-owned background operation, but it can also retain a stale turn's context in unrelated work.

Identity inheritance does not replace cancellation ownership. Work started inside an Agent's boundary is either **foreground** — it inherits `{ agent }` and separately receives the explicit cancellation signal owned by its execution seam — or **detached** — it starts under `run(undefined, operation)` and owns its own lifecycle with an explicit stop. The caller must keep those choices aligned. The implementation must document and test these rules:

- Work logically owned by the Agent is foreground: it may inherit `{ agent }`, receives cancellation through the existing explicit seam, and must honor the Agent's disposal contract.
- Long-lived deployment infrastructure, timers, and work queues unrelated to that Agent are detached: they must start under `run(undefined, operation)` and be stopped by their own owner, never implicitly by a turn ending.
- Code that enqueues data for later processing must serialize the required identity into the queue item; it must not expect ALS to cross the queue, process, or worker boundary.
- Consumers must not treat an ambient Agent reference as proof that the Agent is still live. Lifecycle-sensitive operations still check `agent.status`, an explicit signal, or the owning service's contract.

`turn` and `step` remain outside the first version; they can join later as a separate immutable execution-frame refinement if a real cross-cutting consumer (tracing, logging) cannot use the existing explicit fields. The full `Agent` is the deliberate capability exception because it is the execution subject that establishes the boundary. Every additional field must be a stale-safe label whose stale copy can at worst mislabel a trace; another capability or control channel requires its own RFC. `AbortSignal` is excluded from the first version under that rule; see Alternatives considered.

## Current Harness evidence

The implementation Session should re-check these symbols on its target branch before editing because this handoff was prepared against a local source snapshot and the branch may have advanced.

- `packages/core/agent/src/types.ts`: `Agent` already owns `session`, `status`, and `ctx`. Its `ctx` documentation defines a registration scope, not a dynamic request context.
- `packages/core/agent/src/index.ts`: Cordis `Context.agent` is installed as an Agent-scope DX association and defaults to `undefined` on a plain context. Do not change this semantic.
- `packages/core/agent-loop/src/agent.ts`: `ReactLoopAgent` already owns inbox, cancellation, per-step abort, status, and driver lifetime. Do not create a parallel mutable runtime-state object.
- `packages/core/agent-loop/src/loop.ts`: `runLoop(ctx, agent, handle)` has the exact lifetime boundary to wrap. It passes Agent, turn, step, and signal explicitly to narrower operations.
- `packages/core/tools/src/index.ts`: `ToolExecutionInput.agent` is explicit and selects scoped policy and tool resolution. It remains in the contract after ALS is added.
- `packages/core/agent/src/dispatch.ts`: `agentEvents()` deliberately fuses the Agent subject with its scoped carrier. Ambient context must not replace this correctness mechanism.
- `packages/core/README.md` and the existing core packages: they show that stable Agent control contracts belong in `core/`; `agent-execution` is mandatory control infrastructure rather than optional model-visible context enrichment.

This proposal extends, rather than supersedes, [the Agent registration-scope decision](../../implemented/architecture/2026-07-08-agent-scope-contexts.md) and its [runtime design](../../implemented/architecture/2026-07-12-agent-scope-runtime-design.md).

## Claude Code reference implementation

| Claude Code | Harness translation |
|---|---|
| AppState store | Cordis deployment services and their owned live state |
| QueryEngine | `ReactLoopAgent` plus its loop-owned runtime state |
| ToolUseContext | Explicit Agent/tool/request parameters at capability seams |
| AgentContext ALS | Proposed narrow `AgentExecution` carrier |
| Transcript | Event-sourced `Session` and persistence backends |

## Implementation handoff

The implementation Session should perform the work in this order:

1. Switch to the intended target branch and inspect the current versions of the files listed under "Current Harness evidence". Do not merge or copy changes from the branch on which this handoff was authored.
2. Add `packages/core/agent-execution/` with package metadata, README, exported types, the Cordis service, module augmentation, and focused tests.
3. Add the package to TypeScript project references, path candidates, runtime closure/configuration, and generated catalogs according to existing package gates. Prefer repository generators over hand-editing generated files. Also update the `core/` repository-layout line in root `AGENTS.md`, the package table in `packages/core/README.md`, and the package-group description in `packages/README.md`.
4. Make the Agent Loop declare and consume the service. Wrap each Agent driver's complete `runLoop` invocation in `{ agent }` without changing public Agent, event, tool, LLM, or Session signatures.
5. Add an integration test that overlaps two Agents in one process and observes the correct ambient Agent from inside asynchronous tool execution after at least one `await`.
6. Add nested-Agent coverage proving a child sees itself and the parent context is restored after the child boundary settles.
7. Add clearing and failure coverage: outside a boundary returns `undefined`, `require()` fails clearly, `run(undefined, ...)` masks an inherited Agent, and thrown/rejected operations do not contaminate later unrelated work.
8. Add a test-double capability transport to the integration suite. Keep the model-facing schema unchanged and assert that a trusted Session header is generated internally. Adapting a production remote backend is follow-up work outside this RFC.
9. Run typecheck, targeted tests, documentation gates, generated-catalog checks, and then the repository's normal CI/pre-push gate.

Suggested focused test matrix:

| Scenario | Required observation |
|---|---|
| Outside driver | `current()` is `undefined` |
| One Agent across awaits | Every continuation sees the same exact Agent |
| Two concurrent Agents | A never observes B and B never observes A |
| Nested child | Child sees child; parent is restored afterward |
| Child creation window | Setup inside a parent tool call sees the parent ambiently; `agentCtx.agent` is the child |
| Direct Agent-less tool call | Explicit tool behavior remains valid; ambient identity is absent |
| Cleared detached work | `run(undefined, ...)` hides the inherited Agent |
| Failure and cancellation | Context restores after throw, rejection, and abort |
| Agent disposal | Lifecycle-sensitive consumers reject work from a captured Agent after disposal |
| Service reload | Agent drivers drain before ALS disable; retained disposed-service calls throw the documented stable error |
| Capability transport boundary | Session identity is materialized into the typed request/header by the test-double transport |

## Alternatives considered

**Pass Agent through every function.** This remains the right choice at public and authority-bearing boundaries, but forcing it through every private helper creates plumbing that ambient execution context is designed to remove. The proposal keeps explicit subjects at seams and uses ALS only within one trusted asynchronous process.

**Change `ctx.agent` to return the currently executing Agent.** Rejected because `ctx.agent` already denotes the static association of an Agent-scoped Cordis context. Making a root context dynamic would combine registration scope with execution scope, produce surprising behavior under concurrency, and break the implemented Agent-scope RFCs.

**Store a complete mutable runtime object in ALS.** Rejected because Agent, Session, inbox, cancellation, turn/step state, tool execution, and durable log already have authoritative owners. Duplicating them creates stale snapshots, write-order questions, and another lifecycle to clean up.

**Carry the step `AbortSignal` in the first-version ALS frame.** Rejected for this RFC. The signal is per-step while the proposed boundary is per-driver, so carrying it requires nested step and tool boundaries plus explicit rules for detached work, deadline ownership, and restoration. Existing execution seams already pass cancellation explicitly. A future RFC may revisit this only with a concrete cross-cutting consumer and tests that establish those nested lifecycle semantics.

**Use one process-global mutable `currentAgent`.** Rejected because concurrent Agents and subagents overwrite one another across awaits. It is correct only under serialization, which multi-Agent execution explicitly does not guarantee.

**Infer the Session from model-visible tool arguments.** Rejected because the model can alter those arguments. Sandbox routing and authorization require a trusted in-process identity, not user/model input.

**Put a hosting platform's sandbox-owner identifier or provider data in Harness context.** Rejected because sandbox ownership is hosting-product state resolved outside Harness. Harness should carry only its own Session identity across the trusted transport boundary.

## Acceptance criteria

- One Node Harness process can execute at least two Agents concurrently, and asynchronous consumers always observe the exact initiating Agent.
- Outside Agent driver execution, ambient lookup returns `undefined` and `require()` throws a stable, actionable error.
- Nested Agent execution restores the parent context after the child settles.
- `agent.ctx`, `ctx.agent`, Agent events, prompt assembly, `ToolExecution.agent`, LLM `sessionId`, and Session persistence retain their existing semantics.
- No Agent, Session, turn, step, sandbox, or authorization identity becomes model-controlled.
- The implementation provides an explicit undefined boundary for unrelated detached work and tests it against context leakage without changing existing explicit cancellation contracts.
- The service loads with the standard agent bundle and `dsh-agent-loop` fails at load without it; a configuration test pins the policy.
- Disposal/HMR drains every dependent Agent driver before disabling ALS; retained calls on the disposed service fail with the documented stable error, and no active ALS state remains reachable through the disposed Cordis context.
- A test-double capability transport proves trusted Session ID propagation without adding a model-visible schema field.
- Package catalogs, dependency graphs, API docs, and relevant architecture docs are regenerated or updated, and the repository's documentation gates pass.

## Risks

- Ambient context hides a dependency from function signatures. Restricting it to deep cross-cutting infrastructure and retaining explicit public subjects limits that cost.
- ALS inheritance into detached promises and timers can retain semantically stale identity. An explicit undefined boundary, documentation, and regression tests are required rather than assumed cleanup.
- ALS does not cross worker threads, subprocesses, Redis, HTTP, or persisted queues. Every such boundary must serialize the required identity explicitly.
- The ambient store intentionally carries the full live Agent capability. A captured reference can outlive publication, so ambient presence alone never authorizes lifecycle-sensitive work and consumers must still honor Agent lifecycle and cancellation contracts.
- Mandatory loading adds a core runtime dependency to every agent composition; the RFC accepts that cost because an optional service would make ambient identity composition-dependent. Propagation cost remains measurable across supported Node versions and should be benchmarked separately.
- Adding turn, step, signal, cwd, or tool details prematurely would expand inheritance and staleness hazards. The first version deliberately accepts the limitation of Agent-only ambient identity; any additional capability or control field requires a separate RFC.
