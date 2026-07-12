# RFC: The agent is a registration scope

Status: implemented

## Problem

One application can run many agents that share infrastructure but must not share every capability or policy. A child agent may need a different persona, fewer tools, its own structured-result schema, and listeners that govern only its work, while still using the deployment's model adapters, persistence backend, tool implementations, and user interface.

This is a composition problem, not an application-isolation problem. Starting a separate service graph for every child would isolate too much; putting every registration in one global graph isolates too little.

| Surface | What varies by agent | Failure when it is only global |
|---|---|---|
| Tools | Available capabilities, a child-only tool, or a scoped replacement for one implementation | The model receives excess authority, or a child-specific tool leaks into every prompt |
| Prompt state | Persona, instructions, variables, and [Code Mode](../feature/2026-06-15-code-mode.md) SDK declarations | Every agent receives the same instructions or runtime facts |
| Live policy | Hooks, execution guards, result observers, and continuation rules | A listener intended for one agent can alter another agent's work |
| Lifetime | Cleanup when the agent fails, is cancelled, is disposed, or loses its owner | Registrations outlive the agent or disappear before its final work settles |

Two consistency requirements make the problem deeper than filtering a list. First, the model-visible and executable views must agree: a hidden tool must not remain callable, and an advertised tool must not fail merely because execution used a different registry view. This agreement must also cover Code Mode bindings and UI presentation.

Second, some rules are invariants rather than cooperative extensions. An ordinary middleware listener may replace a prompt assembly, turn an allow into a deny, rewrite a result, force another model step, or short-circuit listeners registered after it. Structured output therefore cannot rely on being “first” or “last” in an extensible listener chain; the owning service needs a final boundary for rules that later listeners must not undo.

Third, accepting a value must transfer ownership of the exact value that was checked. TypeScript `readonly` annotations disappear at runtime, callers and providers may expose stateful accessors, and a validation pass followed by a clone reads mutable input twice. Identity fields, schemas, session data, requests, and results therefore need runtime boundaries that capture each caller-owned field once, materialize data once, and expose only owner-controlled snapshots. Otherwise the checked, executed, logged, and observed views can diverge even when scope resolution itself is correct.

The subagent API makes these requirements concrete. Two concurrent children can request different personas, tool filters, and output schemas. Those requests are honest only when each child receives an independently owned view and when its terminal-output protocol survives unrelated plugins.

## Decision

Each live agent owns a registration context named `agent.ctx`, and services expose narrow owner-final policy boundaries where ordinary middleware ordering is not strong enough. Together these choices make one agent's world composable with normal plugin APIs while keeping authority, observation, and cleanup aligned.

The design has five parts:

| Part | Rule | Purpose |
|---|---|---|
| Registration scope | A registration through a plain plugin context is global; the same registration through `agent.ctx` belongs to that agent | Reuse existing APIs for per-agent tools, prompt state, and listeners |
| Lifecycle transaction | Caller and factory ownership cover create and resume from reservation or load through scoped setup, ordered publication, and teardown | No observer sees a partially composed agent, and caller or provider loss cannot orphan work |
| Lifecycle foundation | Effects become owner-visible before setup, child fibers become parent-owned before publication, and unloading fibers reject late effects | Reentrant HMR cannot strand a half-built or cleanup-time registration outside the unload snapshot |
| Owner-final policy | Prompt protection, tool guards, final tool-result observation, and terminal turn stopping run at service-owned boundaries | Invariants do not depend on listener registration order |
| Boundary ownership | Services capture fixed fields once, materialize lossless-JSON data once, and publish owner-controlled views | Validation, execution, persistence, and telemetry cannot observe different values from one call |

Three domain terms recur below. A **Session** is one agent run's append-only event log, from which model history and durable replay are derived. **Lossless JSON** means JSON primitives plus dense arrays and plain objects that can be copied without changing meaning; the boundary rejects sparse arrays, cycles, exotic prototypes, non-finite numbers, negative zero, `undefined`, `bigint`, functions, and symbols instead of coercing or erasing them. **Code Mode** presents the model with a generated software-development-kit interface and a reserved `run_code` transport, rather than advertising every end-capability as a native tool.

Ownership stays with the component that can enforce each fact. The scope package owns scope tags and carrier construction; each registry owns acceptance snapshots and resolution; the caller owns the programmatic agent lifetime it requested; the concrete agent factory owns identity reservation, setup, publication, and structural invalidation of agents that still depend on it; the session owns accepted history; the tool and subagent services own their pipeline records; and each workflow run captures its holder-bound dependencies and owns its cancellation after the engine returns it. A caller never validates a value that another component later rereads from the caller's mutable object.

The scope is flat. An agent resolves the deployment-global layer plus its own layer; a child does not inherit registrations from its parent's scope. Parent/child lineage remains explicit session data, and parent-owned disposal links lifetimes without silently inheriting authority.

The core implementation lives in [`dsh-scope`](../../../../packages/core/scope/README.md), [`dsh-agent`](../../../../packages/core/agent/README.md), [`dsh-agent-loop`](../../../../packages/core/agent-loop/README.md), [`dsh-session`](../../../../packages/core/session/README.md), [`dsh-system-prompt`](../../../../packages/core/system-prompt/README.md), and [`dsh-tools`](../../../../packages/core/tools/README.md). The composition example spans [`dsh-subagent`](../../../../packages/subagent/subagent/README.md), [`dsh-subagent-inprocess`](../../../../packages/subagent/subagent-inprocess/README.md), and [`dsh-workflow-workerthread`](../../../../packages/workflow/workflow-workerthread/README.md). The [generated Cordis event catalog](../../../cordis-catalog/events.md) is the exhaustive event-signature reference; this RFC explains why the contracts have their current shape.

## Background: the small Cordis vocabulary used here

The design relies on four framework ideas: contexts, effects, waterfall events, and dispatch receivers. This section gives the complete mental model needed for the rest of the RFC; the [Cordis primer](../../../cordis-primer.md) covers the framework more broadly.

### A context is both a service view and a registration origin

A Cordis `Context` is the object through which a plugin reaches services such as `ctx.tools`, `ctx.systemPrompt`, and `ctx.sessions`. A service method can recover the context through which it was accessed, so the service can tell whether a call came from an ordinary plugin context or from an agent's scoped context without adding a `scope` parameter to every registration API.

A context also carries a capability view. A derived context reaches the services injected into the plugin that created it. Handing out `agent.ctx` therefore hands out the agent loop's injected service surface; it is not an ambient root context.

Factory delegation uses two contexts whose jobs must remain separate. The registry derives a caller-bound context carrying the fiber and scope from which `ctx.agents.create()` or `resume()` was called and passes it explicitly as `ownerCtx`; those facts identify the fiber and optional parent agent that own the requested lifetime. When the registered factory is itself a Cordis service, the registry also invokes it through a traced receiver, which preserves the factory's own injected dependency origin. A plain object that merely implements the factory methods receives the same explicit `ownerCtx` without depending on Cordis tracing. Conflating these roles would either attach the agent to the factory registrant instead of the caller or make the concrete loop resolve dependencies from the wrong service view.

### Effects give registrations an owner

A Cordis effect is work whose cleanup belongs to a runtime unit called a fiber. Tool registration, prompt contribution, and event subscription are effects, so disposing their fiber unwinds them on normal teardown, failure, or hot reload.

Ownership must exist before effect setup can call arbitrary code. The vendored Fiber implementation therefore places an effect's cleanup wrapper in the owner list before running its setup body; a reentrant unload sees that in-construction effect and waits for setup plus every cleanup it collected. A child fiber likewise receives its parent-owned disposer before `internal/plugin` announces the child. Teardown delivers that notification with per-observer failure containment so one callback cannot starve peers or interrupt cleanup. Effects remain legal while a fiber is pending or loading, because setup needs them, but a fiber already unloading rejects new effects: its cleanup snapshot has been taken, so accepting another registration would strand it in the old epoch.

`dsh-scope` mounts a no-op plugin fiber for each scope. The plugin contributes no behavior; its fiber is the ownership bucket for everything registered through the scoped context.

### A waterfall is ordered around-middleware

A Cordis waterfall is an extensible middleware chain. A listener calls `next()` to delegate, can inspect or replace the downstream result, and can return without calling `next()` to short-circuit everything inside it.

This flexibility is useful for cooperative transformations, but registration order is not an invariant boundary. A later plugin can prepend another listener, a wrapper can replace the downstream result after `next()` returns, and a short-circuit can prevent inner listeners from running at all.

### The dispatch receiver selects scoped listeners

Cordis filters event listeners using the dispatch receiver, the object exposed as `this` inside a function-style listener. `dsh-scope` supplies a receiver carrying the operation's scope key, so the event system can admit global listeners plus listeners registered for that key and reject listeners belonging to other agents.

This receiver is live coordination state, not a durable session fact. The distinction matters later: `tools/result` is a live final-outcome notification, while the similarly named `tool/result` is an append-only session event stored for replay and model history.

## Agent-scoped registrations

An agent scope couples two facts that must not drift apart: who can see a registration and who disposes it. The calling context determines both facts, leaving the domain-specific merge rules to each registry.

### The resolution model is global plus exactly one scope

Every scope-aware registry keeps a global layer and per-scope layers. Resolving for agent A combines the global layer with A's layer only; it does not walk A's parent lineage or combine sibling scopes.

| Registration origin | Visible to | Disposed with |
|---|---|---|
| Plain plugin context | Every agent | The registering plugin |
| `agent.ctx` | That agent only | That agent's scope |

Named scoped contributions shadow a same-named global contribution. A child persona is therefore a scoped `deployment:persona` section, and a per-agent tool implementation can keep the same model-facing name. Duplicate names within one layer still fail loudly. The deliberate exception is a globally protected prompt-section name, whose owner reserves it against scoped shadowing.

The plugin-facing mechanism is the same API called through a different context. In language-neutral pseudocode:

```text
# Deployment-wide contribution
appContext.tools.register(readTool)

# Contribution visible only to agent A and disposed with A
agentA.ctx.tools.register(childOnlyTool)

resolveTools(agent A):
  visible = copy(globalTools allowed by A's restrictions)
  visible.overlay(tools registered through A.ctx)
  visible.append(reserved presentation transport, when configured)
  return visible
```

There is no `for each ancestor` step. Resolving for A never reads the parent or sibling layers.

The scope key is an opaque object compared by identity. The harness uses the live `Agent` object as its own key, so event payloads, tool executions, and prompt assemblies that already carry the agent can select the correct layer without translating through a string ID that may later be reused.

### `agent.ctx.agent` is an association, not the scope resolver

`agent.ctx` carries an own `agent` property for setup code and plugin ergonomics. Contexts derived from it inherit that association, while a plain context reads `undefined`.

The property is deliberately not treated as the authoritative scope tag. A nested scope can install a nearer scope key while still inheriting the original `ctx.agent` association, so lower-level services resolve layers with `scopeOf(context)`. In normal agent composition the two point at the same live agent; the separation keeps the generic scope primitive independent of the agent package.

### The scope primitive has separate public and composite disposal forms

`dsh-scope` exposes the minimum operations needed to create a layer, read it, target events, and dispose it. “Quiescent” here means that every asynchronous cleanup registered in the scope has settled and no teardown work remains in flight.

| Operation | Responsibility |
|---|---|
| `createScope(context, key)` | Mount the ownership fiber and return its tagged derived context |
| `scopeOf(context)` | Read the nearest inherited scope key |
| `scopeTarget(subject, key)` | Build the receiver used for scope-filtered dispatch |
| `Scope.dispose()` | Give ordinary callers an idempotent promise shared by repeat and racing calls until quiescence |
| `Scope.rawDispose` | Expose the exact Cordis disposer so a larger generator lifecycle can nest it at a precise teardown position |

The two disposal forms solve different framework constraints. Cordis identifies nested effects by disposer-function identity, so an ordered composite lifecycle must yield `rawDispose` exactly. Cordis disposers are also single-shot, so a second raw call may not await the first asynchronous teardown; `Scope.dispose()` follows the backing fiber's in-flight lifecycle and gives all ordinary callers the same quiescence boundary, including a race in which `rawDispose` started first. The test/tooling `ScopeHost.dispose()` extends that shared boundary across its host fiber and every minted child scope. Pre-registration of an effect wrapper solves a different race: it makes the first owner unload see construction in progress without changing this single-shot raw-disposer contract.

The primitive itself is small. Its essential implementation shape is:

```text
createScope(parentContext, key):
  fiber = mount no-op plugin under parentContext
  scopedContext = derive fiber.context with nearest-scope-tag = key

  rawDispose = fiber's exact disposer
  dispose = memoized operation that:
    invoke rawDispose if it has not started
    follow fiber's in-flight teardown until quiescent

  return { ctx: scopedContext, rawDispose, dispose }
```

Derived contexts inherit the nearest scope tag. Mounting an ordinary plugin under `agent.ctx` therefore preserves the agent's scope, while deliberately creating another scope replaces the tag for registrations below it.

### Registry resolution stays domain-specific

The shared primitive answers “which layer?” and “who owns cleanup?” but does not force every service to merge data the same way. Tools, prompt sections, variables, and tool-schema providers retain rules appropriate to their domains.

Prompt sections, prompt variables, and tools use scoped-over-global shadowing by name. Tool-schema providers are additive, but a provider registered through `agent.ctx` participates only in that agent's assemblies. Read operations name the subject explicitly: tool lookup and execution receive an agent or scope, and prompt assembly receives an `AssembleContext` whose `scope` selects the layer.

Calling a service through `agent.ctx` does not implicitly make every later read agent-scoped. For example, `agent.ctx.systemPrompt.assemble()` without an assembly scope still requests the global layer. This keeps shared services able to operate on behalf of any subject and makes the subject visible at the read or execution call site.

### Tool registrations are frozen snapshots

The tool view must not change because a caller kept the object it passed to `register()` or received a definition from `get()` or `visible()`. Registration therefore creates the stored identity once; future changes happen through explicit unregister/register effects.

Tool parameters cross the model and log boundary, so the registry materializes them with `snapshotJsonValue`: one recursive traversal reads each property once, rejects anything outside lossless JSON, and constructs the detached value that is actually stored. A check followed by `structuredClone` is not equivalent—a getter could return plain JSON to the check and a class instance to the clone, which would erase its prototype and silently accept different data.

The first-party `defineTool()` helper closes the authoring boundary with the same primitive. It reads every top-level option once, materializes the `SchemaSpec`, and derives an independent wire schema plus all later execute and presentation validation from that accepted snapshot. Without that split, mutating an author-owned spec after definition could make the model call a schema that the tool no longer accepts.

Registration then reads every top-level definition field exactly once, validates, binds, and stores only those captured values; a stateful `parameters` or callback accessor therefore cannot make the checked definition differ from the executable one. It snapshots the scalar fields, binds each callback once to the original definition as its method receiver, and deep-freezes the stored record. Replacing `definition.execute` after registration therefore has no effect, while a callback can still deliberately read mutable state from its closure or original receiver. `get()` and `visible()` return the frozen stored definitions; `schemas()` returns detached schema projections.

```text
defineTool(options):
  accepted = read each top-level option exactly once
  parameterSpec = snapshotLosslessJson(accepted.parameters)
  wireParameters = snapshotLosslessJson(convertToJsonSchema(parameterSpec))
  build execute and presentation validators over parameterSpec

registerTool(context, definition):
  accepted = read each top-level definition field exactly once
  parameters = snapshotLosslessJson(accepted.parameters)

  stored = deepFreeze({
    accepted name, description, timeout,
    parameters,
    execute: bind accepted.execute to definition,
    presentation callbacks: bind once when present
  })

  layerFor(scopeOf(context)).add(stored.name, stored)
```

The reserved Code Mode transport uses the same frozen-definition contract even though it lives outside the ordinary layers.

### Tool restrictions reduce end capabilities without removing transport

A tool restriction masks the global end-capability layer for one agent, while tools registered in that agent's own layer are explicit grants. Multiple restrictions intersect, so separately installed policies can only reduce the global surface.

The restriction reads `allow` and `deny` once, snapshots those exact values, rejects an empty filter, and validates named tools against the pre-restriction capability universe. The same captured arrays are then enforced, so a stateful accessor cannot pass one policy through validation and install another. A restricted-away tool behaves like an unknown tool at execution, avoiding disclosure of a hidden global implementation.

[Code Mode](../feature/2026-06-15-code-mode.md)'s `run_code` is not an end capability. It is a reserved presentation transport that carries calls to the visible end capabilities, so the registry keeps it outside both global and scoped registration layers: restrictions cannot remove it, a scoped tool cannot shadow it, and configuration cannot explicitly allow or deny it. Without this exception, a restriction could leave the generated SDK in the prompt but remove the only way to invoke it.

The registry still uses one executable visibility view. It first resolves restricted global capabilities plus scoped grants, then appends the reserved transport in non-native modes; registry-owned prompt schemas, lookup, execution, Code Mode SDK bindings, timeout lookup, inspection, and UI presentation all consume that view.

The guarantee covers the tool registry's contribution. A plugin can deliberately use the lower-level `systemPrompt.tools()` API or assembly waterfall to add an unrelated wire schema; that plugin owns the matching executable behavior and any ordering it introduces. Owner protection preserves reserved named infrastructure without turning the system-prompt service into a validator for unrelated contributions.

`knownNames` serves a narrower configuration purpose: it is the pre-restriction end-capability universe used to distinguish a typo from a deliberately hidden tool. The system-prompt provider adds presentation names when validating `toolOrder`: `code` mode accepts only `run_code`, `both` accepts end capabilities plus `run_code`, and a per-agent restriction may remove a known capability from one assembly without turning the deployment's order configuration into an error.

## Scoped event delivery

Scoped registration is incomplete unless behavior follows the same boundary. An event about agent A reaches global listeners and A-scoped listeners, never listeners installed for B.

### Delivery is global plus the matching scope

The dispatch receiver carries the operation's scope key. Its filter admits an unscoped listener or a listener registered through the matching scoped context, while a subject-less dispatch admits unscoped listeners only. Cordis's explicit `{ global: true }` listener option remains the intentional bypass for infrastructure that must observe every dispatch.

Registry-membership notifications remain unfiltered. Events such as `tools/change`, `system-prompt/change`, `skill/provider-*`, and `subagent/provider-*` describe shared registry state rather than one agent's activity, so a scoped subscriber still observes those global changes.

### Each event family derives its key from its real subject

The operation being described determines the key; callers cannot attach an unrelated scope. Fused helpers and store-owned carriers keep the payload subject and delivery subject together.

| Event family | Scope source |
|---|---|
| `agent/*`, including `agent/turn-stop` | The event's agent |
| `approval/request` | `ApprovalRequest.agent` |
| `tools/pre-execute`, `tools/execute`, `tools/post-execute`, `tools/result` | `ToolExecution.agent`, or no key for an agent-less call |
| `system-prompt/assemble` | `AssembleContext.scope` |
| `session/created`, `session/disposed`, `session/event`, `session/flush` | The owner scope captured when the session enters the store |
| `subagent/start`, `subagent/end` | The delegating parent agent |

Approval requests cross an asynchronous answer boundary, so the service snapshots the accepted record synchronously. It preserves the exact agent and abort-signal identities but copies the scalar fields, captures the agent's session once, and uses that one snapshot for `approval/asked`, scoped dispatch, cancellation, policy, and `approval/decided`. Mutating the caller-owned record after `request()` returns therefore cannot split the audit pair or redirect the question to another agent's listeners.

The dispatch rule can be read independently of Cordis internals:

```text
dispatchScoped(subject, scopeKey, event, arguments):
  carrier = proxy(subject, tag = scopeKey)

  for listener in listeners(event):
    if listener has no scope tag or requests the explicit global bypass:
      call listener with this = carrier
    else if listener.scopeTag == scopeKey:
      call listener with this = carrier
    else:
      skip listener
```

The real helpers fuse values that must agree. `agentEvents(context, agent)` uses the same agent as the subject, scope key, and first event argument. `assembleContextFor(agent)` similarly sets both the agent-facing field and the scope selector. The session store captures its carrier when a session enters because later appends and flushes may occur where the original agent context is no longer available.

### The carrier behaves like the subject but has distinct identity

Function-style listeners receive the carrier as `this`, and agent event APIs allow them to call subject methods. The carrier is therefore a JavaScript proxy that reads and writes through to the real subject and binds methods to it.

Binding matters for classes with JavaScript private fields: a method called with the proxy itself as receiver would fail the runtime private-field identity check. The carrier therefore uses a dedicated surrogate proxy target with its own immutable composed-filter slot, while ordinary property access, writes, own-key visibility, methods, invocation, and construction delegate to the real subject; callable carriers also preserve whether the subject is constructable.

The composed filter is an authorization boundary, not an ordinary exposed callback. It invokes a subject's pre-existing filter with stable references to the built-in `Reflect.apply` and `Function.prototype.call` operations, pins its own `.call` to that captured built-in, and freezes the callable. Code holding the subject or carrier therefore cannot replace either `.call` property to turn a scoped predicate into an always-allow predicate. Keeping the filter on the surrogate also means a filter property pinned on the subject before, during, or after carrier construction cannot trigger a Proxy invariant that silently replaces scope isolation with the subject's raw filter.

The surrogate must remain extensible so its reported own-key view can follow the subject. For non-overlay properties owned by the subject, descriptor queries preserve values and flags except that `configurable` is reported as `true`, which is the only Proxy-safe description of a property the extensible surrogate does not itself own. For the same reason, defining a property through the carrier is supported only when the descriptor explicitly says `configurable: true`; an omitted or false flag is rejected before the subject is touched. The carrier is intentionally not identity-equal to the subject; event arguments carry the real object whenever identity matters.

`Scoped<T>` is a TypeScript-only marker that requires this carrier at declared scoped dispatch sites. It improves authoring but adds no runtime security, so runtime marks and development invariants check the same contract for JavaScript, casts, and hand-written dispatches.

## Agent creation and teardown

An agent's scope, session, registry entry, and driver form one transaction with two ownership edges. The caller context owns the work it requested and receives the only consumer-facing teardown capability; the concrete `AgentLoop` provider is a structural co-owner because the live agent continues to use the provider's injected services. Either edge deactivates the transaction and converges on the same ordered, memoized quiescence boundary. Setup finishes before publication, and publication is synchronous and rollback-covered rather than magically atomic.

### Create and resume reserve identities before asynchronous work

Programmatic create and resume reserve both the agent ID and session ID before work that can await. Create prepares a fresh or seeded session; resume first loads and reconstructs the persisted session. Both paths then construct the agent, mint `agent.ctx`, and install the complete teardown skeleton before awaiting setup.

The registry treats the factory seam as an untrusted runtime boundary. A TypeScript interface checks source code but does not constrain the JavaScript object received at runtime, which may expose stateful getters. `setFactory()` therefore claims the single factory slot before reading method accessors, canonicalizes an already traced Cordis service to its concrete target, then captures that target plus the `createAgent` and `resume` callback identities once. A getter cannot reenter `setFactory()` and replace the outer factory while it is being accepted, later method replacement cannot redirect calls, and a service proxy cannot accumulate a second trace layer that breaks raw-identity state. On each call, the registry passes a caller-bound context carrying the accessing fiber and scope as `ownerCtx`, retraces the concrete service target exactly once through that context, and invokes the captured callback with both pieces. The explicit argument binds ownership; the traced receiver preserves the factory's dependency origin.

The factory first captures the requested IDs, setup callback, and caller-owned agent options. Seed events and session metadata take a stricter route than a preliminary clone: cloning can erase an exotic prototype before validation sees it, so the factory reads each reference once and hands it synchronously to the session store's reservation-bound prepare operation. That boundary rejects exotic shells, reads accepted metadata fields once, and recursively materializes each seed record in one pass. Resume applies the same rule to persistence output by capturing the loaded header fields once before reconstruction. The transaction therefore cannot move to different identities, storage routing, or lineage after an asynchronous boundary.

Before setup can observe the new objects, their ownership-bearing public properties become stable runtime data slots rather than TypeScript-only `readonly` promises. The concrete agent pins its ID, accepted options, and session; the factory binds its scope context exactly once. The session pins its ID and detached, deep-frozen header. Registry detach closures likewise close over their accepted map keys instead of rereading public properties during teardown. A JavaScript assignment or stateful accessor therefore cannot split registry lookup, dispatch, persistence, and the driver into different identities.

The session owns the accepted log as described in [the session-immutability RFC](2026-06-11-dev-invariants-over-deep-readonly.md). Seed and append paths materialize lossless JSON once, validate both the event envelope and the metadata that places message-producing events into derived model history, and deep-freeze the exact accepted event. `session.events` returns a frozen snapshot that never grows later. The store keeps append notification and scope-carrier state in store-owned private tables instead of caller-writable `Session` fields, so outside JavaScript cannot suppress or redirect `session/event` dispatch.

Reservations prevent two concurrent factory transactions from composing different unpublished objects under the same public identities. Each capability's `release` is its exact Cordis effect disposer. Before asynchronous work, the owning sentinel adopts those functions by identity, removing them from the caller fiber's concurrent sibling list; teardown reaches them only after the transaction's driver, registry entries, session, and scope have quiesced. Explicit release covers pre-lifecycle failure and the ordered final step, while the owning fiber remains the backstop for an abandoned transaction. The concrete factory also tracks the whole create transaction before reservation and session preparation begin, and keeps that structural edge through reservation release. Provider unload first stops the factory from accepting work, then aborts or drains every tracked transaction before its dependency surface disappears.

The agent registry and session store recognize their own reserved keys: setup code that calls public reserve, prepare, create, register, or bare enter APIs with the same IDs fails. The session capability can prepare exactly one object, and publication succeeds only when both stores receive the factory-held exact capabilities; the session store additionally checks that the capability owns that exact prepared session. This closes the otherwise possible path in which setup publishes a substitute object under an ID that the factory merely tracked in a separate pending set, without letting a vanished owner wedge the ID forever.

Resume needs an ownership edge before an agent object exists. It reserves the identities, then installs a caller-liveness sentinel that adopts both exact reservation disposers before persistence I/O; a factory-tracked load transaction supplies the provider edge. If either owner wins, resume rejects, waits for the load transaction to settle, and only then releases both reservations; a backend promise that settles later cannot publish. After a successful load, `startOwned` synchronously returns both the complete lifecycle disposer and the asynchronous setup/publication result. Even a preparation failure is represented by a disposer-backed result, so the load sentinel can hand off to a real quiescence boundary instead of mistaking an async function's rejected promise for successful installation. The load tracker remains until the surrounding transaction settles, while the load and caller sentinels remain lifecycle-long followers, so no ownership or ID-release gap opens. Once the shared lifecycle quiesces, each sentinel first disarms its follower and then removes its owner-fiber effect; long-lived callers therefore do not retain completed agents, scopes, or reservation closures.

The load sentinel changes what it follows at handoff but remains an owner-visible boundary:

```text
resume(ownerCtx, request):
  snapshot request ids, options, and setup callback
  reservations = reserve agentId in AgentRegistry and sessionId in SessionStore
  sentinel = ownerCtx.effect(
    onDispose => abort and await load settlement before reservation release,
    adopt exact reservation disposers)
  loadTransaction = factory.track(onDispose => signal deactivated and await settlement)

  try:
    persisted = await firstOf(persistence.load(sessionId), deactivated)
    session = reservations.session.prepare(reconstruct persisted data)

    # This synchronous call returns a lifecycle boundary even when preparation fails.
    starting = startOwned(ownerCtx, agentId, session, options, reservations, setup)
    sentinel.follow(starting.dispose)
    return await starting.result
  finally:
    release directly only if no lifecycle boundary was established
    settle and untrack the load transaction
```

If deactivation wins, the load promise may continue inside the backend, but it has no path back to publication.

### Setup composes an unpublished world

The optional `setup(agentCtx)` callback receives the new agent context and may synchronously register contributions or await child-plugin activation. During setup, neither the session nor agent is visible through its global registry, but `agentCtx.agent` exposes the unpublished agent to the code composing it.

Setup may register scoped tools, prompt sections, variables, restrictions, listeners, protections, or child plugins. If it throws or rejects, the scope unwinds without publishing either object, and the reserved IDs become reusable. If either the caller owner or concrete factory unloads during an await, the preinstalled teardown skeleton marks the transaction inactive; late setup completion cannot publish.

Both structural edges exist before driver preparation or scope minting. The provider uses a tracked placeholder, while the caller gets a lifecycle-long sentinel that adopts the reservation effects and resolves to the same memoized lifecycle disposer. If `internal/plugin` reentrantly unloads either owner while the scope fiber is being constructed, Cordis has already attached the child disposer to its parent and the sentinel waits until preparation publishes either the complete lifecycle or a rollback disposer. A failure halfway through preparation therefore leaves both owners with a quiescence boundary for the prepared driver, minted scope, and reservations.

The factory checks liveness before invoking arbitrary setup. After setup settles, it yields one microtask checkpoint and checks the lifecycle flag, factory state, caller-fiber state, and the owner context's associated agent state again. Cordis begins owner unload synchronously but may run nested effect disposers in the next microtask; the explicit checks and checkpoint let a same-turn unload win instead of allowing an immediately fulfilled setup to publish an already-doomed agent.

Setup composes but does not drive. The concrete agent rejects `send`, `steer`, `inject`, and `cancel` until publication reaches the session-start boundary, keeps its inbox in a JavaScript native-private field, and allows only one concrete driver to claim a session. Driver startup is absent from the package surface: the package exports neither its loop/inbox internals nor source subpaths, and only instance-bound controls held by the factory can enable and start the driver. JavaScript or a type cast therefore cannot bypass the lock by calling a public `start()` or writing directly into the queue. These boundaries prevent a turn from opening before lifecycle listeners know the session exists.

The common create/resume tail makes the unpublished boundary explicit:

```text
startOwned(ownerCtx, snapshot, preparedSession):
  try:
    world = prepareLifecycle(ownerCtx, snapshot, preparedSession)
    # Factory placeholder, lifecycle-long caller sentinel, reservation adoption,
    # and complete rollback/teardown skeleton all exist before the first await.
  catch preparationError with rollbackBoundary:
    return { dispose: rollbackBoundary,
             result: await rollbackBoundary then reject original error }

  result = async:
    require world.lifecycleActive
    await firstOf(snapshot.setup(world.agent.ctx), world.deactivated)
    await oneMicrotask()
    require world.lifecycleActive
    require world.factoryActive
    require world.ownerFiberActive
    require world.ownerAgentNotDisposed

    world.publish(snapshot.source)
    return handle(world.agent, world.dispose)
  catch error:
    await world.dispose()
    throw error

  return { dispose: world.dispose, result }
```

`setup` can await arbitrary plugin activation, but every exit still passes through the already-installed disposer.

### Publication is ordered and rollback-covered

After setup succeeds, the factory publishes in one synchronous sequence with no `await` between steps. Each registry has already claimed its ID across every caller-code boundary needed to construct a stable entry: the agent registry pins the accepted ID and captures one lifecycle carrier while its claim is held, and the session store holds the same kind of claim while evaluating its filter and carrier. A Proxy trap or filter getter can therefore neither overwrite a reentrant same-ID entry nor create a stale detach capability that later deletes another object. Liveness checkpoints then divide publication into three notification phases, and an outer publication barrier keeps teardown from revoking either registry entry or the scope while one of those phases is on the stack:

1. Enter the session store and capture its scope carrier.
2. Enter the agent registry without announcing it.
3. Recheck caller and factory liveness; entering either registry may have evaluated a caller-owned getter that began teardown.
4. Emit `session/created`.
5. Recheck liveness; if teardown began, skip the agent announcement and roll back.
6. Emit `agent/created`.
7. Recheck liveness; if teardown began, keep driving locked and roll back.
8. Enable driving.
9. Emit `agent/session-start`.
10. Recheck liveness; if teardown began, roll back without starting the driver.
11. Start the driver loop.

The implementation keeps publication synchronous and leaves rollback to the surrounding owned transaction:

```text
publish(world):
  world.beginSynchronousPublication()
  try:
    world.detachSession = world.agent.ctx.sessions.enter(world.session, world.sessionReservation)
    world.detachAgent   = app.agents.enter(world.agent, world.agentReservation)
    require world.callerAndFactoryActive
    app.sessions.announce(world.session)
    require world.callerAndFactoryActive
    app.agents.announce(world.agent)
    require world.callerAndFactoryActive
    world.driver.enableDrivingVerbs()
    emitNonVetoing(agent/session-start)
    require world.callerAndFactoryActive
    world.driver.start()
  finally:
    world.endSynchronousPublication()
```

Both registry entries exist before the first creation listener runs, and setup-installed listeners receive every announcement that publication reaches. Driving opens immediately before `agent/session-start`, so that event remains the first supported place for a listener to inject or queue startup work. A synchronous teardown request from any notification marks the lifecycle inactive immediately, which makes the next checkpoint abort, but actual loop, registry, session, and scope cleanup waits until the current synchronous notification phase and publication call stack unwind. Teardown itself therefore cannot make a later listener that still runs observe a different world; teardown from `session/created` prevents `agent/created`, teardown from `agent/created` prevents session start, and teardown from `agent/session-start` prevents the driver from starting.

The sequence is not described as atomic because observers run between its steps. If a `session/created` or `agent/created` listener throws synchronously, the transaction rolls the registry entries and scope back, but effects already performed by an earlier listener cannot be retracted. Each store therefore marks its announcement as begun before invoking creation listeners and rejects a repeat or reentrant announcement before dispatch. Rollback emits `session/disposed` or `agent/disposed` exactly once for every corresponding creation announcement that began, including a partial emit in which an early listener observed creation before a later listener threw. An object entered but never announced has no disposal notification because no observer was told it existed.

Each registry also protects ordering inside its own creation phase. If a listener uses an advanced detach capability while `session/created` or `agent/created` is dispatching, removal and the paired disposal edge are deferred until that dispatch unwinds. The agent's creation and disposal edges reuse the carrier captured before commit instead of rebuilding it from a mutable filter getter. A detach request therefore cannot make a later listener observe `created` after `disposed`, find the just-created entry missing, or trigger disposal while creation is still constructing its receiver. Exact-object guards on both detach paths are the final defense against a stale capability deleting a later same-ID entry. The factory's outer publication barrier is the cross-registry complement: caller or provider teardown cannot remove the other entry or unwind `agent.ctx` while the current phase is still running.

Creation notification preserves that synchronous veto while also defending against JavaScript's asynchronous callback shape. A listener may return a promise even though the event type returns `void`; the dispatcher does not await it because publication has no asynchronous gap, but it observes and logs a later rejection. Such a rejection is too late to roll back, does not become unhandled, and does not starve the listeners invoked after that callback.

The disposal notifications and `agent/session-start` do not treat return values or listener failures as vetoes. Their dispatchers invoke every listener synchronously and independently; they log and contain both a synchronous throw and a rejection from a returned promise. Completion or rejection of a returned promise is observed but not awaited, so it cannot delay rollback or teardown, veto driver startup, or starve a later listener. The callback's synchronous prefix remains ordinary code: if it holds and disposes a structural ownership edge, the next publication liveness check deliberately aborts startup.

### Teardown stops work before revoking its world

Every owner path reaches the same memoized reverse order: the consumer handle, caller-fiber disposal, and structural factory-provider unload first deactivate the lifecycle; wait for an in-progress synchronous publication phase; stop the loop and await its actual exit plus every agent-started durability checkpoint; remove the agent from the registry; detach the session; unwind the scope; and only then release both IDs. Final turn events, the turn-ending flush, and any outstanding idle-injection flush therefore settle while the session and scoped listeners are still live, and a replacement cannot reuse either identity while old scoped cleanup remains in flight.

```text
disposeOwnedAgent(world):
  mark world inactive
  await world.synchronousPublicationIfRunning()
  await world.stopDriver()     # waits for loop exit and all agent-started flushes
  world.detachAgent()          # leaves registry; emits agent/disposed if announced
  world.detachSession()        # stops event feed, leaves store; emits session/disposed if announced
  await world.scope.dispose()
  world.releaseSessionReservation()
  world.releaseAgentReservation()
```

The actual Cordis generator yields these disposers in reverse so its last-in-first-out teardown executes in the order shown.

For the concrete AgentLoop transaction, `agent/disposed` runs after the driver is quiescent and the agent has left the registry; the session is still live during that notification. The public AgentRegistry alone promises only exact removal, because a custom registered `Agent` owns any stronger driver contract itself. `session/disposed` follows after append notification has been detached and the session has left its store. The scope is still live when each disposal listener is selected and invoked, although returned asynchronous work is observed rather than awaited. Both notifications use the stable scope key and delivery rule captured for their creation partners and occur exactly once only when those creation announcements began.

`AgentHandle.dispose()` is memoized so repeated consumer calls await the same full transaction. The lifecycle-long caller sentinel independently follows that memoized promise, so handle-first teardown cannot make a racing caller-fiber unload observe Cordis's inert second raw-disposer call and return early. Once the transaction reaches its final quiescent stage, retirement disarms and removes the sentinel before settling that shared promise. `Scope.dispose()` provides the corresponding shared boundary for direct scope disposal and raw-disposer races. The provider's ownership ledger is internal rather than another public handle: it stops accepting new transactions, invokes every tracked disposer independently, and waits for all of them before the AgentLoop service surface disappears.

Provider co-ownership is specific to resources that remain structurally dependent on their provider. An AgentLoop-created agent continues to resolve the loop's injected services, so loop unload must stop it. A worker workflow run instead captures its holder-bound `SubagentService` handle synchronously at `start()` and stores that independent dependency on the run; unloading `WorkerWorkflowEngine` removes the ability to start new runs but does not revoke an already returned run or prevent its later worker message from starting a child. The two lifetimes differ by dependency shape, not by a blanket rule that every service must own every value it creates.

Parent-owned subagents use explicit ownership rather than capability inheritance. The driver creates one run-owner fiber under `parent.ctx` and invokes the child factory through that fiber, so lifecycle ownership exists before setup or publication begins; disposing a parent reaches its descendants even if a delegating tool never reaches its own `finally`. The child still receives a newly minted scope and resolves only global plus child-scoped capabilities.

## Owner-final policy boundaries

Cooperative waterfalls remain the general extension mechanism, but an invariant belongs after the last transformable point. The design adds four narrow boundaries, each owned by the service that can define what “final” means.

### Prompt protection restores named canonical contributions

`systemPrompt.protect({ sections, tools })` declares that selected names must match the canonical registry/provider assembly after the complete `system-prompt/assemble` waterfall. It reads each caller array once before deduplication, so the names checked for an empty protection are the names actually installed. Protections registered globally and for the current scope compose by set union, so callback order cannot weaken them. Protection finalizes a returned assembly rather than recovering from listener failure; if the waterfall throws, assembly still fails.

For each protected name, the service restores the canonical presence and definition. If the canonical assembly omitted the name, protection removes a listener-fabricated entry; this makes mode-dependent absence enforceable as well as presence. Tool providers receive the same coherence treatment: assembly reads `schemas`, optional `knownNames`, and every schema field once, detaches that record, and uses its captured names for both `toolOrder` validation and the model-visible collection. A stateful provider therefore cannot validate a phantom name while showing a different tool.

A global section protection also reserves the registry name against scoped shadowing. Registering a scoped section under an already protected global name throws, and adding global protection throws if any scoped shadow already exists. Section registration copies `name`, `order`, and the text value or callback before the check and stores that record, so later mutation of the caller's object cannot rename a safe section into a reserved one. This check must happen before assembly: otherwise the ordinary scoped-over-global merge would make the shadow itself look canonical, leaving post-waterfall restoration with the wrong owner's value. Tool-schema protection does not impose a blanket schema-name reservation because providers are additive and may deliberately contribute unrelated executable schemas.

Restoration is intentionally not a whole-assembly reset. The service first removes protected names from the waterfall result, then reinserts protected canonical entries in their canonical order immediately before the first surviving later unprotected canonical neighbor, or at the end when no such neighbor survives. Unprotected entries keep the ordering and definitions chosen by the waterfall. This anchor rule preserves the protected contribution's meaningful local placement without claiming that protection restores every global relative position after arbitrary listener reordering.

Only the restoration inputs are detached before dispatch: the canonical section array when section protection is active and the canonical tool array when tool protection is active. The waterfall receives the original mutable assembly, not a clone, and variables and other merge-extensible fields remain entirely under ordinary waterfall semantics.

```text
registerSection(input, scope):
  stored = copy(input.name, input.order, input.text)
  if scope exists and stored.name is globally protected:
    fail before registration
  sectionLayer(scope).add(stored)

assemble(context):
  assembly = assemble registries for context.scope
  canonicalSections = active section protection ? clone(assembly.sections) : absent
  canonicalTools = active tool protection ? clone(assembly.tools) : absent
  transformed = await systemPromptAssembleWaterfall(assembly)

  for each protected name in the corresponding canonical array:
    remove every transformed entry with that name
    if the canonical array contains the name:
      if a later unprotected canonical neighbor survived:
        insert the canonical entry before that neighbor
      else:
        append the canonical entry

  return transformed
```

This algorithm restores a protected entry's definition, presence or absence, and useful local anchor without erasing unrelated listener output.

Code Mode uses global protection for the `tools:sdk` section and reserved `run_code` schema. Structured output adds scoped protection for its instruction and capture schema. These are named guarantees: unrelated listeners may still contribute unrelated sections or tools.

### Tool executions have stable identity

`ctx.tools.execute(input)` accepts a caller-owned `ToolExecutionInput` and snapshots it into a distinct pipeline-owned `ToolExecution`. It reads `callId` and `name` once and requires each value to be a string before treating the pair as trustworthy correlation identity. A throwing accessor or non-string value rejects before `tools/result`, because even an error result could not carry a valid identity. After that boundary, the registry reads every other top-level caller field once, and any later accessor or validation failure becomes one normalized final error notification built from the already accepted strings and captured optional fields.

The registry materializes `arguments` in one lossless-JSON traversal and deep-freezes the result, so parent-token validation, scope routing, policy, dispatch, and final observation receive exactly the value that passed validation. A cloneable but mutable exotic such as `Map` or a class instance is rejected before policy rather than smuggled through an apparently frozen wrapper.

The registry assigns each pipeline trip a frozen, property-free `ToolExecutionToken`; callers cannot choose that token. The execution is identity-stable, not fully immutable, while the pipeline runs: its `token`, `callId`, `name`, `agent`, optional opaque `parent` token, and detached `arguments` are non-writable and non-configurable from the first policy listener onward. `signal` is the only operational field; an around-dispatch wrapper may add, replace, or remove it. The registry freezes the complete execution before outcome observation.

Stable identity prevents a listener from changing which capability or scope was authorized after policy ran. It also gives commit-style observers a safe `WeakMap` key even when an adapter reuses a model call ID.

For a nested transport dispatch, `parent` carries only the enclosing execution's opaque token rather than its live object. Code Mode sets an SDK sub-call's `parent` to the outer `run_code` execution's `token`, so an observer can correlate the two outcomes without receiving a reference that could mutate the still-running outer wrapper.

The input-to-execution conversion is intentionally one-way:

```text
prepareExecution(input):
  callId = read input.callId exactly once
  name = read input.name exactly once
  require callId and name are strings
  # A failure above rejects: no trustworthy correlation identity exists.

  accepted = read arguments, agent, parent, and signal exactly once
  require accepted.parent is absent or a registry-minted token
  detachedArguments = snapshotLosslessJson(accepted.arguments)

  execution = {
    token: new frozen property-free object,
    callId,
    name,
    arguments: deepFreeze(detachedArguments),
    agent: accepted.agent,
    parent: accepted.parent,
    signal: accepted.signal
  }

  make every field except signal non-writable and non-configurable
  return execution
```

### Tool guards can deny but never re-allow

`ctx.tools.guard()` installs a synchronous global or scope-specific guard after the extensible `tools/pre-execute` waterfall and before dispatch. A guard returns a denial reason or `undefined`; it has no allow result.

This one-way result makes the boundary monotonic. Pre-execution hooks can still compose ordinary allow, deny, and ask decisions; an ask resolves through the optional `ctx.approval` seam, where only `allowed-once` becomes allow and an absent channel or any non-grant becomes deny before guards run. No listener ordering can convert a guard denial back into dispatched work. A denied call still continues through result transformation and final observation as an error outcome.

### `tools/result` observes the authoritative live outcome

The complete live pipeline is `tools/pre-execute` → monotonic guards → `tools/execute` → `tools/post-execute` → `tools/result`. The first three named events are transformable waterfalls; `tools/result` is an awaited, observe-only notification after all transforms and the registry's outer error normalization. At each untrusted result boundary, the registry captures every top-level field once and materializes the complete authoritative outcome as detached lossless JSON. Immediately before observation it materializes that owned outcome again and deep-freezes the shared listener snapshot. An invalid tool or listener result becomes a normal JSON-safe `isError` outcome instead of reaching observers as apparent success and failing later at the session log.

Every `tools/result` listener receives the same frozen execution and deep-frozen result snapshot. Listener failures are contained independently, so they cannot change the caller's result or starve peer observers. Scope filtering derives from `execution.agent`.

`tools/result` is not the durable session event `tool/result`. The live notification belongs to the registry and also fires for direct programmatic executions; the agent loop subsequently appends `tool/result` to the session log for replay, UI reconstruction, and model history. A policy that needs the final in-process verdict uses the former, while a consumer that needs persisted transcript state uses the latter.

The entire registry method reads like one authority ladder:

```text
execute(input):
  callId = read input.callId exactly once
  name = read input.name exactly once
  require callId and name are strings

  try:
    execution = prepareExecutionFromTrustedIdentity(input, callId, name)
  catch invalidInput:
    execution = frozen identity shell with arguments = undefined
    result = errorResult(invalidInput)
    await tools/result observers with independent failure containment
    return result

  try:
    gate = await tools/pre-execute(execution)
    decision = gate
    if gate asks:
      decision = await resolveWithApproval(gate, execution.agent)
    # approval absence and every non-grant resolve to deny

    if decision allows:
      denial = firstRegisteredGuardDenial(execution)
    else:
      denial = decision.denial

    if denial exists:
      result = errorResult(denial)
    else:
      result = await tools/execute(execution, next = dispatchRegisteredTool)
      result = requireValidExecutionResult(result)

    result = await tools/post-execute(execution, result)
    result = snapshotLosslessJson(result)
  catch pipelineFailure:
    result = errorResult(pipelineFailure)

  freeze(execution)
  frozenResult = deepFreeze(snapshotLosslessJson(result))
  await every tools/result observer independently, containing each failure
  return result
```

Waterfalls can transform only at their named stages. Guards can only deny, and the final observers can only observe.

### `agent/turn-stop` makes a composed continuation terminal

Steering is input injected into an already running turn for the next model step; ordinary queued prompts wait for a future turn. The loop normally preserves that distinction by moving leftover steering into another step while leaving the queued-prompt FIFO alone.

Ordinary continuation remains extensible. The loop computes a default, runs the `agent/turn-continuation` waterfall, records any force-continue reason as steering, and folds pending steering into the decision because steering normally demands another model step.

The scoped serial `agent/turn-stop` checkpoint runs after that folding. Its strict serial helper consults listeners in order until one returns a non-`undefined` value; a listener returns `{ action: 'stop' }` or abstains with `undefined`. The dedicated helper exists because ordinary Cordis serial dispatch treats `null` and `false` as framework abstentions, while this public contract has exactly one abstention value. A stop is terminal, so later listeners and pending steering cannot restore continuation. A malformed result, including `null` or `false`, or a throwing policy closes the current turn with an error while leaving the driver available for later work.

Terminal stop deliberately discards steering while preserving ordinary queued prompts. Its terminal state remains in force through `turn/end` and the durability flush, so steering added by continuation, turn-close, or flush listeners cannot escape through the loop's late-steering fallback into another step or turn. This is the explicit exception to the normal rule that leftover steering becomes input for another turn. The authority is reserved for protocols, such as a completed structured child, where further model work would violate the result contract.

```text
afterSuccessfulStep(turn):
  decision = await agent/turn-continuation(defaultDecision)
  record decision.reason as steering when present
  if steering is pending: decision = continue

  terminal = await strictSerial(agent/turn-stop)
  # undefined means abstain; null, false, malformed values, and throws are errors
  if terminal == stop:
    discard steering
    terminalStopped = true
    decision = stop

  append turn/end
  await session/flush

  if terminalStopped:
    discard steering added by turn/end or flush listeners
  else:
    move leftover steering to the next-turn queue
```

The queued-prompt FIFO is separate and is never drained by terminal stop.

## Subagent composition

In-process subagents demonstrate how the scope, lifecycle, and final-policy pieces compose. A provider builds the child's world during unpublished setup, then lets the ordinary agent lifecycle own it.

### Inputs and ownership are fixed before asynchronous creation

Provider registration first freezes an acceptance snapshot of the provider name, capability flags, parent-context descriptor, and `start` callback; the callback is bound to the original provider object so its intentional internal state stays live. Lookup, validation, model-facing wording, dispatch, lifecycle notifications, and hot-reload cleanup all use that snapshot. Mutating or reusing the caller's provider object later therefore cannot rename a live entry, change its advertised powers, replace its callback, or make its disposer delete the wrong key.

Starting a run reads every top-level request field once before capability validation, then snapshots every accepted field before asynchronous owner setup. This order makes checked and delegated capabilities identical even for a JavaScript caller with stateful accessors. Fixed scalars are checked at the same boundary: `maxDepth` must be a non-negative safe integer and `persona` must be a string. The parent and abort signal are retained as identity capabilities but never reread from the mutable request record; tool filters, seed events, agent options, output schema, and prompt are detached through the one-pass lossless-JSON materializer. The exported in-process driver repeats this boundary for direct callers before it awaits run-owner activation, including taking one seed snapshot from which it derives both the child prefix and `seedLength`. Later caller mutation therefore cannot change lifecycle scope, configuration, the schema enforced by the capture tool, or the prompt eventually logged and sent.

The driver first installs provider ownership. Only after that succeeds does it attach the request's abort listener and create one run-owner Cordis fiber under `parent.ctx`; an already-unloading provider therefore leaves neither a child nor an orphaned listener. Calling `runOwner.ctx.agents.create()` gives the child factory an explicit `ownerCtx` carrying the run-owner fiber and scope, while the registry's traced factory receiver preserves AgentLoop's injected dependency origin. Parent teardown, provider teardown, and manual run disposal all dispose this same run-owner node; moving it out of the active state synchronously prevents an unpublished setup from publishing afterward, while all three paths follow one quiescence promise. This structured ownership does not change the child's flat capability view.

The provider's run separates acceptance from publication with `started: Promise<void>`, but the service does not expose that caller-owned handle directly. It captures `id`, `started`, `result`, and each method once, binds methods to the provider-owned run handle, and returns a frozen service-owned wrapper. Capturing `dispose` first also preserves a rollback capability if a later accessor or method check reveals a malformed handle. The wrapper installs its shared disposal promise before invoking the raw provider callback, so synchronous reentry through the returned wrapper and ordinary repeat calls join one provider disposal rather than slipping through a not-yet-assigned memo. If the raw disposer directly returns that same reentrant wrapper promise, the service rejects the cyclic provider contract instead of awaiting a promise that depends on itself forever.

The wrapper's `result` promise captures `output`, optional `structured`, and `stopReason` once and resolves to one detached, deeply frozen lossless-JSON value shared by the caller and lifecycle telemetry. Malformed terminal data is an infrastructure fault; it rejects only after the service has started rollback of the provider attempt. The service observes the normalized result immediately, before waiting for readiness, so an early rejection is never temporarily unhandled.

For spawn and fork, the accepted `started` promise fulfills only after the child factory returns a published handle. The service can then emit `subagent/start` with `ctx.agents.get(id)` already live and release any buffered terminal event; if readiness rejects, it emits neither start nor end. Lifecycle notification is fire-and-forget and non-vetoing: each listener receives the same deeply frozen payload, and synchronous throws or returned-promise rejections are logged and contained per listener without awaiting them. The child result driver awaits the same readiness boundary before sending the prompt.

```text
startInProcessRun(providerContext, acceptedRequest):
  snapshot all request data, including parent identity

  providerLink = providerContext.effect(onDispose => disposeRunOwner())
  attach snapshot.abortSignal listener
  runOwner = mount no-op plugin under snapshot.parent.ctx

  returnedRun.dispose = () =>:
    dispose providerLink
    await disposeRunOwner()

  creation = runOwner.ctx.agents.create({
    fresh ids and lineage,
    detached options and optional seed,
    setup(childCtx) => install persona, tool restriction, structured runtime
  })

  returnedRun.started = creation.then(childHandle => publication complete)
  returnedRun.result = async:
    await returnedRun.started
    send the child prompt, await idle, derive the terminal result

SubagentService.start(...):
  providerRun = provider.start(detached request)
  serviceRun = freeze({
    id, started, and methods captured once from providerRun,
    methods bound to providerRun,
    result: normalize once into detached, deeply frozen lossless JSON
  })
  attach settlement handlers to serviceRun.result immediately
  attach handlers to serviceRun.started:
    on fulfillment, emit subagent/start and then buffered or eventual subagent/end
    on rejection, discard buffered lifecycle telemetry
  return serviceRun immediately

Workflow worker bridge after receiving returnedRun:
  register the run so cancellation can reach pre-publication work
  attach result settlement handlers immediately and snapshot the outcome
  re-check terminal admission after provider start returns
  if admission closed:
    if the exact run remains registered: cancel once and dispose it
    if worker-message admission remains open: send ChildStartError
  else wait for returnedRun.started:
    on fulfillment:
      re-check terminal admission
      if closed: apply the same identity-guarded refusal
      else: send ChildStarted; then send the buffered or eventual outcome
    on rejection:
      if worker-message admission remains open: send ChildStartError
      if the exact run remains registered: dispose it

Worker after choosing its result:
  queue Result on the worker-to-host port
  only then reap stray child handles

Host at workflow Result receipt:
  cancellationWasRequested = external cancellation is already in flight
  atomically claim chosen =
    if cancellationWasRequested and result is not cancelled:
      cancelledResult
    else:
      result

  if not cancellationWasRequested:
    abort the shared child-request signal
    call cancel("workflow settled") on every host-registered run

  settle chosen

Host at the first worker death signal:
  close worker-message admission
  claim death or preserve an earlier cancellation/Result/grace outcome
  cancel and dispose every registered child
  synthesize missing lifecycle ends

Host at physical worker exit:
  perform a final disposal-only sweep
  do not repeat explicit child cancellation
```

Every downstream protocol that announces a subagent must honor the same boundary. The workflow worker bridge therefore registers the returned run before waiting, observes and snapshots `result` immediately, and sends `ChildStarted` only after `started` fulfills while admission remains open. A readiness rejection is refused and host-disposed; `ChildStartError` is sent while worker-message admission remains open, and an already-retired exact run is not cleaned twice. Provider `start()` is itself arbitrary code and may synchronously reenter workflow cancellation before its returned run reaches that registry. The bridge attaches both promise observers, re-checks terminal admission immediately after `start()` returns and again at readiness, and turns a closed boundary into identity-guarded cancellation, disposal, and refusal rather than late worker admission or lifecycle announcement. An arbitrary provider may still fulfill its own `started` promise after the workflow boundary; the bridge refuses and cleans up that attempt instead of claiming it can undo provider-side publication.

Cancellation before readiness is a publication decision, not merely a flag for later result mapping. The in-process run synchronously deactivates its owner fiber. If cancellation lands before publication, the factory's liveness check prevents either creation edge. If it begins synchronously inside `session/created`, `agent/created`, or `agent/session-start`, the publication barrier lets the current notification phase unwind without revoking its world, the next liveness check prevents every later phase and driver start, and rollback pairs every creation edge that already began. In either case `started` rejects, no `subagent/start` or `subagent/end` is emitted, and the run result settles as `aborted`.

Receipt of the worker's `Result` message is the workflow host's atomic first-wins boundary. The worker queues that message before its own settlement-reap `ChildCancel` messages, so same-port FIFO prevents an internal child callback from masquerading as earlier run cancellation. Each contender records its claim before its own callback fanout: external `cancel()` records its reason first, while Result receipt snapshots any earlier cancellation and claims the resulting terminal outcome before invoking settlement-cleanup provider code. A caller, signal, or dispose cancellation already in flight therefore overrides a non-cancelled worker report, while the report wins otherwise. Before exposing that chosen result, the host drives both permitted child-cancellation channels by aborting the shared request signal and calling every registered run's `cancel()`, including runs still waiting on readiness. Those calls are settlement-only cleanup, and the terminal claim makes a reentrant `WorkerRun.cancel()` a side-effect-free loser rather than merely repairing its result afterward. Host fanout and the worker's FIFO-later `ChildCancel` can both reach the explicit channel, so a per-call gate invokes each provider `cancel()` at most once; the seam does not require that callback to be idempotent. Explicit child cancel callbacks are contained independently so one throwing callback cannot starve peers or alter settlement.

Unexpected worker death uses the same terminal-claim rule, but terminal ownership, message admission, and exit cleanup are separate state. The host snapshots whether external cancellation was already accepted, claims either `cancelled` or the death error, closes inbound worker messages, and only then reaps children and synthesizes missing lifecycle events. Closing admission is necessary because Node may emit `error`, deliver an already-queued `message`, and only then emit `exit`; without the logical barrier, that message could start a child or narrate after `workflow/end`. Provider code reentering cancellation during cleanup cannot rewrite a death-first error; conversely, a cancellation accepted before death remains the winner. If Result or grace already claimed the outcome, death preserves it while still reaping promptly. Physical exit then performs a final disposal-only sweep without repeating explicit provider cancellation. `handle.dispose()` claims its public promise before that traversal invokes cancellation or disposal callbacks, and every `disposeChild` path independently claims the call ID promise before invoking the wrapped child disposer. Public-first reentry returns the existing holder promise; worker-first reentry may begin holder disposal, whose child traversal joins the already-claimed call ID promise. This distinction is necessary because grace settlement precedes `worker.terminate()` and its exit event: suppressing a duplicate outcome, late message, or repeated cleanup request must not suppress disposal of survivors in the host registry.

Together these rules prevent an early result rejection from going unhandled, ensure `workflow/agent-start` never names an unready child, and prevent the bridge from admitting or announcing a child after its workflow has ended.

Parent teardown reaches `runOwner` by nesting; the provider and returned run handle reach the same node through their explicit disposers.

### Persona, filtering, and lifetime use ordinary registrations

A child persona is a scoped `deployment:persona` section that shadows the deployment-wide section. A child tool filter is a scoped restriction over global end capabilities. Omitted filters remain omitted; a materialized empty `allow` list means “allow nothing” and is not confused with absence.

The child's persona, filter, and structured runtime are installed inside factory setup. The common run-owner fiber gives structured-concurrency-style teardown without importing the parent's capability layer into the child.

### Structured output is a child-owned terminal protocol

A structured child registers a real-schema `structured_output` tool and its instruction through its own context. Concurrent children can use different schemas because each scope resolves its own definition, with no global placeholder, reference count, or remove-for-everyone-else pass.

Presentation mode changes where the model invokes the capture capability, but not which child owns it:

| Tool mode | Registry's canonical wire contribution | Generated SDK | Structured-output guarantee |
|---|---|---|---|
| `native` | Visible end-capability schemas, including scoped `structured_output` | None | Protection restores the capture schema and instruction |
| `code` | Reserved `run_code` transport | Visible end-capability bindings, including `structured_output` | Protection keeps `run_code` and the SDK present, keeps native `structured_output` absent from the wire, and restores the instruction |
| `both` | Visible native schemas plus reserved `run_code` | Visible end-capability bindings, including `structured_output` | The model may call the protected capture capability natively or through the protected transport |

The table describes the registry's named canonical contribution. An unrelated assembly listener may deliberately add another schema; protection does not erase unrelated names.

### Capture uses stage, final commit, monotonic denial, and terminal stop

The capture tool validates its arguments and stages the cloned value in a JavaScript `WeakMap` keyed by the identity-stable `ToolExecution`. This is an object-identity table whose key does not keep an abandoned execution alive. Validation failure becomes the ordinary `INVALID_ARGS` error that the model can correct within the turn.

The scoped `tools/result` observer commits a direct native capture only when that exact execution's authoritative final result succeeds. A later call with a reused string call ID cannot reach the weak-keyed stage, and a post-execution block cannot promote it.

```text
# Native structured-output call
structured_output.body(value, execution):
  validate value against this child's schema
  staged[execution] = clone(value)
  return ordinary success

on tools/result(execution, finalResult):
  if execution is staged:
    value = staged.remove(execution)
    if finalResult succeeded:
      captured = value
```

For a Code Mode SDK call, successful inner observation records a pending value against the child execution's opaque `parent` token instead of committing immediately. When the enclosing `run_code` reaches its own `tools/result`, the observer compares that pending token with the outer execution's `token` and commits only on success. A program error or outer post-policy block discards the pending value. This extra boundary is necessary because an inner side effect can succeed while the transport that is supposed to deliver the structured answer still fails.

```text
# Code Mode adds an outer transport commit
on tools/result(innerStructuredCall, innerResult):
  if innerStructuredCall is staged:
    value = staged.remove(innerStructuredCall)
    if innerResult succeeded:
      pending = { outerToken: innerStructuredCall.parent, value }

on tools/result(outerRunCodeCall, outerResult):
  if pending.outerToken == outerRunCodeCall.token:
    value = pending.value
    pending = none
    if outerResult succeeded:
      captured = value
```

The native path has one final-result commit; Code Mode has two because the inner capability and outer transport can fail independently.

Once a value is captured or pending on its outer transport, the scoped `ToolGuard` denies later calls in the same response. After a committed capture, the scoped `agent/turn-stop` ends the turn after ordinary continuation and steering have been folded. Together these boundaries prevent post-capture side effects and prevent a successful tool call from purchasing an otherwise automatic extra model step.

The provider does not re-prompt a child that finishes without a committed capture. Such a run returns an error result with no `structured` value; requesting an output schema creates a requirement, not a guarantee that a failed child produces a value.

## Correctness enforcement

Scope mistakes are fail-open if they merely omit a carrier, so the implementation checks the contract at API, type, runtime, and repository-gate boundaries. None of these checks substitutes for using the correct runtime carrier.

### API shape couples subjects that must agree

`agentEvents(context, agent)` couples the dispatch carrier to the agent argument, `assembleContextFor(agent)` couples prompt facts to the scope selector, and `SessionStore.flush(session)` owns lookup of the carrier captured when the session entered the store. These helpers make a mismatched subject harder to express than the correct spelling.

### Type markers cover every scoped event declaration

Scoped agent, approval, tool, prompt, session, and subagent lifecycle events declare a `Scoped<T>` receiver. TypeScript therefore rejects a bare subject at typed dispatch sites, including the `subagent/start` and `subagent/end` paths whose scope is the delegating parent.

The marker is compile-time only. JavaScript callers, casts, and direct use of Cordis's dispatch APIs can bypass it, which is why the runtime checks remain necessary.

### Development invariants check actual dispatch

The invariants plugin observes Cordis's internal dispatch path before listener delivery. For each scope-filtered event it requires a marked carrier and, where the event arguments expose the subject, verifies that the carrier key is the same object.

Session and subagent payloads do not expose the owner key directly, so their invariant proves carrier presence while their service centralizes how the correct key is chosen. Additional invariants reject an assembly whose `agent` and `scope` disagree and a turn opened before `agent/session-start`.

### Repository gates keep declarations and dispatchers aligned

`verify-scoped-dispatch` compares the declared scoped events with the runtime invariant table, and the generated event matrix requires every declaration to have a recognized dispatcher. Source JSDoc is regenerated into the [event catalog](../../../cordis-catalog/events.md), keeping the exhaustive signature and mode reference in one place.

## Alternatives considered

The rejected designs either split visibility from ownership, isolate the wrong boundary, or depend on extension ordering for correctness.

### Pass an agent option to every registration

An API such as `tools.register(definition, { agent })` leaves global registration as the leak-by-omission default and requires parallel scope plumbing in every registry. It also allows “visible to agent A, disposed with unrelated plugin B,” which the scoped context makes unrepresentable.

### Create one isolated service graph per agent

Service isolation chooses one registry instance for a context, while agent composition needs a merged view of deployment-global contributions plus one agent's additions. Per-agent graphs would duplicate shared adapters and force infrastructure such as persistence and UI bridges to discover every new instance.

Isolation remains appropriate for independent applications. It is too coarse for collaborating agents inside one deployment.

### Inherit the parent's scope into a child

Hierarchical capability inheritance makes lifetime convenient but silently grants every child the parent's scoped tools and policies. A flat view plus an explicit parent-owned disposer separates the two questions: the parent owns the child without conferring its authority.

### Publish the agent before running setup

Early publication lets setup resolve the agent from global registries, but observers can see and act on a partially configured world. Rollback can remove entries but cannot retract external effects from already-run listeners.

The unpublished callback already receives both the agent context and its `ctx.agent` association, so early global lookup is unnecessary.

### Allow only synchronous setup

Synchronous setup is simpler but cannot honestly compose a child plugin whose activation is asynchronous. In TypeScript, a callback returning a promise can also be assigned to a void-returning callback type, so declaring setup as synchronous would not reliably prevent accidental escape from the rollback boundary.

Awaited setup makes the transaction explicit and keeps the first assembly behind it.

### Enforce invariants with prepended waterfall listeners

A prepended listener is not necessarily outermost: another plugin can prepend later, a short-circuit can skip inner work, and an outer wrapper can replace the result after delegation. The same issue appears in prompt assembly, tool authorization, result commit, and turn continuation.

The owner-final APIs express the actual strength required by each rule: restore named canonical data, deny monotonically, observe the immutable final outcome, or stop after all ordinary continuation inputs are folded.

### Filter events while keeping registries global

Listener filtering prevents a hook from intercepting the wrong agent but does not scope tool schemas, executable lookup, prompt sections, variables, or Code Mode bindings. Persona, tool filtering, and concurrent structured schemas would still require global mutation.

### Put agent-scope policy inside vendored Cordis

Cordis already provides derived contexts, effect-owning fibers, and receiver-based listener filtering, so the harness-level primitive composes those mechanisms instead of teaching the framework about agents, tools, prompts, or global-plus-scope resolution. The implementation does harden Cordis's domain-neutral lifecycle substrate: effects are owner-visible before setup callbacks, child fibers are parent-owned before publication, and an unloading fiber rejects registrations that missed its cleanup snapshot. Those rules are required by every plugin under reentrant HMR, not scope-specific policy pushed into the framework.

## Consequences

The design makes per-agent composition ordinary and lifecycle-safe at the cost of a small scope runtime and several deliberately narrow final-policy APIs. The complexity is concentrated in services and dispatch helpers rather than repeated in every plugin.

### Benefits

The main benefit is one composition model across data, behavior, and lifetime: registrations follow their context, while service-owned finalizers protect only the invariants that require stronger ordering.

- Plugin authors use the same registration APIs globally and per agent; only the context changes.
- Registry-owned prompt schemas, executable lookup, Code Mode bindings, policy listeners, and UI presentation resolve from the same agent view.
- Create and resume expose no partially configured registry entry during awaited setup, and overlapping caller/factory ownership leaves no gap between resume load, preparation failure, and the live lifecycle.
- Agent disposal revokes scoped contributions after the driver and all final or idle-injection session flushes have settled, and retains both public IDs until scope cleanup is quiescent.
- Structured output composes per child without global mutation or listener-order assumptions.
- Existing unscoped plugins remain deployment-wide contributors and observers.

### Costs and constraints

The costs are concentrated in dispatch discipline, per-scope registry state, and explicit authority boundaries that are intentionally stronger than ordinary middleware.

- Every scoped event dispatcher must carry the correct receiver; fused helpers, type markers, invariants, and gates exist because omission would otherwise deliver only to global listeners.
- `agent.ctx` is capability-bearing. Its available services come from the agent loop's injected context, so holders receive that deliberate service surface.
- Registries maintain per-scope maps and perform a global-plus-one-layer merge for the agent lifetime.
- The dispatch carrier is proxy-shaped and not identity-equal to its subject, even though method calls and property access behave like the subject. Its composed filter is frozen, and defining a property through the carrier requires an explicitly configurable descriptor because the extensible surrogate cannot truthfully expose a new non-configurable subject property.
- Flat scopes do not inherit parent capabilities; a desired child capability must be global or explicitly registered for the child.
- `run_code` is protected transport infrastructure rather than a filterable end capability, so a policy that must forbid programs denies execution at the tool-policy layer instead of removing the transport from a Code Mode prompt.
- Prompt protection restores named canonical contributions and their anchor placement, not the entire assembly; unprotected output remains extensible, while a globally protected section name is deliberately unavailable for scoped shadowing.
- Terminal turn stopping has authority to discard pending steering. That power is appropriate for owner-enforced terminal protocols and too strong for ordinary cooperative continuation policy.
- Programmatic `ctx.agents.create()` and `ctx.agents.resume()` are asynchronous because they await setup. The direct no-setup `ctx.agentLoop.create()` path, used by configuration and programmatic callers that already have complete options, remains synchronous.
- A programmatic agent is caller-owned but also structurally owned by its concrete AgentLoop provider. Reloading that provider tears the agent down even if a consumer still holds its handle, because the handle cannot keep the provider's dependency surface valid.
- Ordered composition requires exact raw effect identities plus shared public quiescence promises; the dual surfaces and lifecycle-long owner sentinels reflect distinct Cordis nesting and repeated-caller requirements.

### Deliberate boundaries

The scope primitive is generic, but this decision applies it only where one agent needs a coherent registration view: tools, prompt state, scoped events, sessions, and in-process subagent composition. `agent.ctx` does not automatically scope every service call; filesystem policy, LLM interception, background subagent state, and other registries retain their existing seams until their own designs explicitly adopt the context rule.
