# RFC: The agent is a registration scope

Status: implemented

## Problem

One application can run many agents that share infrastructure but must not share every capability or policy. A child agent may need a different persona, fewer tools, its own structured-result schema, and listeners that govern only its work, while still using the deployment's model adapters, persistence backend, tool implementations, and user interface.

This is a composition problem, not an application-isolation problem. Starting a separate service graph for every child would isolate too much; putting every registration in one global graph isolates too little.

| Surface | What varies by agent | Failure when it is only global |
|---|---|---|
| Tools | Available capabilities, a child-only tool, or a scoped replacement for one implementation | The model receives excess authority, or a child-specific tool leaks into every prompt |
| Prompt state | Persona, instructions, variables, and Code Mode SDK declarations | Every agent receives the same instructions or runtime facts |
| Live policy | Hooks, execution guards, result observers, and continuation rules | A listener intended for one agent can alter another agent's work |
| Lifetime | Cleanup when the agent fails, is cancelled, is disposed, or loses its owner | Registrations outlive the agent or disappear before its final work settles |

Two consistency requirements make the problem deeper than filtering a list. First, the model-visible and executable views must agree: a hidden tool must not remain callable, and an advertised tool must not fail merely because execution used a different registry view. This agreement must also cover Code Mode bindings and UI presentation.

Second, some rules are invariants rather than cooperative extensions. An ordinary middleware listener may replace a prompt assembly, turn an allow into a deny, rewrite a result, force another model step, or short-circuit listeners registered after it. Structured output therefore cannot rely on being “first” or “last” in an extensible listener chain; the owning service needs a final boundary for rules that later listeners must not undo.

The subagent API makes both needs concrete. Two concurrent children can request different personas, tool filters, and output schemas. Those requests are honest only when each child receives an independently owned view and when its terminal-output protocol survives unrelated plugins.

## Decision

Each live agent owns a registration context named `agent.ctx`, and services expose narrow owner-final policy boundaries where ordinary middleware ordering is not strong enough. Together these choices make one agent's world composable with normal plugin APIs while keeping authority, observation, and cleanup aligned.

The design has three parts:

| Part | Rule | Purpose |
|---|---|---|
| Registration scope | A registration through a plain plugin context is global; the same registration through `agent.ctx` belongs to that agent | Reuse existing APIs for per-agent tools, prompt state, and listeners |
| Lifecycle transaction | Create and resume await scoped setup while the agent and session are unpublished, then publish them in an ordered rollback-covered sequence | No observer sees a partially composed agent, and every failure path owns cleanup |
| Owner-final policy | Prompt protection, tool guards, final tool-result observation, and terminal turn stopping run at service-owned boundaries | Invariants do not depend on listener registration order |

The scope is flat. An agent resolves the deployment-global layer plus its own layer; a child does not inherit registrations from its parent's scope. Parent/child lineage remains explicit session data, and parent-owned disposal links lifetimes without silently inheriting authority.

The implementation lives primarily in [`dsh-scope`](../../../../packages/core/scope/README.md), [`dsh-agent`](../../../../packages/core/agent/README.md), [`dsh-system-prompt`](../../../../packages/core/system-prompt/README.md), and [`dsh-tools`](../../../../packages/core/tools/README.md). The [generated Cordis event catalog](../../../cordis-catalog/events.md) is the exhaustive event-signature reference; this RFC explains why the contracts have their current shape.

## Background: the small Cordis vocabulary used here

The design relies on four framework ideas: contexts, effects, waterfall events, and dispatch receivers. This section gives the complete mental model needed for the rest of the RFC; the [Cordis primer](../../../cordis-primer.md) covers the framework more broadly.

### A context is both a service view and a registration origin

A Cordis `Context` is the object through which a plugin reaches services such as `ctx.tools`, `ctx.systemPrompt`, and `ctx.sessions`. A service method can recover the context through which it was accessed, so the service can tell whether a call came from an ordinary plugin context or from an agent's scoped context without adding a `scope` parameter to every registration API.

A context also carries a capability view. A derived context reaches the services injected into the plugin that created it. Handing out `agent.ctx` therefore hands out the agent loop's injected service surface; it is not an ambient root context.

### Effects give registrations an owner

A Cordis effect is work whose cleanup belongs to a runtime unit called a fiber. Tool registration, prompt contribution, and event subscription are effects, so disposing their fiber unwinds them on normal teardown, failure, or hot reload.

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

The two disposal forms solve different framework constraints. Cordis identifies nested effects by disposer-function identity, so an ordered composite lifecycle must yield `rawDispose` exactly. Cordis disposers are also single-shot, so a second raw call may not await the first asynchronous teardown; `Scope.dispose()` follows the backing fiber's in-flight lifecycle and gives all ordinary callers the same quiescence boundary, including a race in which `rawDispose` started first. The test/tooling `ScopeHost.dispose()` extends that shared boundary across its host fiber and every minted child scope.

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

Tool parameters cross the model and log boundary, so the registry requires them to be lossless JSON before cloning and validates the clone again to contain unstable getters. It snapshots the scalar fields, binds each callback once to the original definition as its method receiver, and deep-freezes the stored record. Replacing `definition.execute` after registration therefore has no effect, while a callback can still deliberately read mutable state from its closure or original receiver. `get()` and `visible()` return the frozen stored definitions; `schemas()` returns detached schema projections.

```text
registerTool(context, definition):
  require definition.parameters is lossless JSON
  parameters = clone(definition.parameters)
  require parameters is still lossless JSON

  stored = deepFreeze({
    copied name, description, timeout,
    parameters,
    execute: bind definition.execute to definition,
    presentation callbacks: bind once when present
  })

  layerFor(scopeOf(context)).add(stored.name, stored)
```

The reserved Code Mode transport uses the same frozen-definition contract even though it lives outside the ordinary layers.

### Tool restrictions reduce end capabilities without removing transport

A tool restriction masks the global end-capability layer for one agent, while tools registered in that agent's own layer are explicit grants. Multiple restrictions intersect, so separately installed policies can only reduce the global surface.

The restriction snapshots its input, rejects an empty filter, and validates named tools against the pre-restriction capability universe. A restricted-away tool behaves like an unknown tool at execution, avoiding disclosure of a hidden global implementation.

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
| `session/created`, `session/event`, `session/flush` | The owner scope captured when the session enters the store |
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

Binding matters for classes with JavaScript private fields: a method called with the proxy itself as receiver would fail the runtime private-field identity check. The proxy preserves the subject's existing event filter and JavaScript object invariants, but it is intentionally not identity-equal to the subject; event arguments carry the real object whenever identity matters.

`Scoped<T>` is a TypeScript-only marker that requires this carrier at declared scoped dispatch sites. It improves authoring but adds no runtime security, so runtime marks and development invariants check the same contract for JavaScript, casts, and hand-written dispatches.

## Agent creation and teardown

An agent's scope, session, registry entry, and driver form one owned transaction. Setup finishes before publication, publication is synchronous and rollback-covered rather than magically atomic, and teardown reaches one ordered quiescent boundary.

### Create and resume reserve identities before asynchronous work

Programmatic create and resume reserve both the agent ID and session ID before work that can await. Create prepares a fresh or seeded session; resume first loads and reconstructs the persisted session. Both paths then construct the agent, mint `agent.ctx`, and install the complete teardown skeleton before awaiting setup.

The factory captures IDs and the setup callback and clones caller-owned agent options, session metadata, and seed events before the first asynchronous boundary. Resume does the same before persistence loading. A caller mutating its options object later therefore cannot move the transaction away from the identities it reserved or change the configuration eventually published.

Reservations prevent two concurrent transactions from composing different unpublished agents under the same public identity. They remain held across persistence loading and setup and are released on every success or failure path.

Resume installs an owner-liveness sentinel before reserving IDs or starting persistence I/O, then races loading against owner disposal. If disposal wins, resume rejects and releases both reservations immediately; a backend promise that settles later cannot publish. After a successful load, the factory synchronously installs the full agent lifecycle before removing the sentinel, so ownership passes from load to setup without an unobserved disposal gap.

The sentinel exists only for the interval in which no agent lifecycle can exist yet:

```text
resume(request):
  snapshot request ids, options, and setup callback
  sentinel = owner.effect(onDispose => signal ownerDisposed)
  reserve(agentId, sessionId)

  try:
    persisted = await firstOf(persistence.load(sessionId), ownerDisposed)
    session = reconstruct(persisted)

    # This call installs the full lifecycle before its first await.
    starting = startOwned(agentId, session, options, setup)
    disarm and dispose sentinel
    return await starting
  finally:
    release both ids
    settle the sentinel transaction
```

If `ownerDisposed` wins, the load promise may continue inside the backend, but it has no path back to publication.

### Setup composes an unpublished world

The optional `setup(agentCtx)` callback receives the new agent context and may synchronously register contributions or await child-plugin activation. During setup, neither the session nor agent is visible through its global registry, but `agentCtx.agent` exposes the unpublished agent to the code composing it.

Setup may register scoped tools, prompt sections, variables, restrictions, listeners, protections, or child plugins. If it throws or rejects, the scope unwinds without publishing either object, and the reserved IDs become reusable. If the owner unloads during an await, the preinstalled teardown skeleton marks the transaction inactive; late setup completion cannot publish.

After setup settles, the factory yields one microtask checkpoint and rechecks the lifecycle flag, owner-fiber state, and owning agent's disposed state. Cordis begins owner unload synchronously but may run nested effect disposers in the next microtask; the explicit owner checks and checkpoint let a same-turn unload win instead of allowing an immediately fulfilled setup to publish an already-doomed agent.

Setup composes but does not drive. The concrete agent rejects `send`, `steer`, `inject`, and `cancel` until publication reaches the session-start boundary, keeps its inbox in a JavaScript native-private field, and allows only one concrete driver to claim a session. Driver startup is absent from the package surface: the package exports neither its loop/inbox internals nor source subpaths, and only instance-bound controls held by the factory can enable and start the driver. JavaScript or a type cast therefore cannot bypass the lock by calling a public `start()` or writing directly into the queue. These boundaries prevent a turn from opening before lifecycle listeners know the session exists.

The common create/resume tail makes the unpublished boundary explicit:

```text
startOwned(snapshot, preparedSession):
  world = prepareLifecycle(snapshot, preparedSession)
  # world now owns agent.ctx and the complete rollback/teardown skeleton

  try:
    await firstOf(snapshot.setup(world.agent.ctx), world.deactivated)
    await oneMicrotask()
    require world.lifecycleActive
    require world.ownerFiberActive
    require world.ownerAgentNotDisposed

    world.publish(snapshot.source)
    return handle(world.agent, world.dispose)
  catch error:
    await world.dispose()
    throw error
```

`setup` can await arbitrary plugin activation, but every exit still passes through the already-installed disposer.

### Publication is ordered and rollback-covered

After setup succeeds, the factory publishes in one synchronous sequence with no `await` between steps:

1. Enter the session store and capture its scope carrier.
2. Enter the agent registry without announcing it.
3. Emit `session/created`.
4. Emit `agent/created`.
5. Enable driving.
6. Emit `agent/session-start`.
7. Start the driver loop.

The implementation keeps publication synchronous and leaves rollback to the surrounding owned transaction:

```text
publish(world):
  world.detachSession = world.agent.ctx.sessions.enter(world.session)
  world.detachAgent   = app.agents.enter(world.agent)
  app.sessions.announce(world.session)
  app.agents.announce(world.agent)
  world.driver.enableDrivingVerbs()
  emitNonVetoing(agent/session-start)
  world.stopDriver = world.driver.start()
```

Both registry entries exist before the first creation listener runs, and setup-installed listeners receive both announcements. Driving opens immediately before `agent/session-start`, so that event remains the first supported place for a listener to inject or queue startup work.

The sequence is not described as atomic because observers run between its steps. If a `session/created` or `agent/created` listener throws, the transaction rolls the registry entries and scope back, but effects already performed by an earlier listener cannot be retracted. An announced agent is paired with its disposal notification during rollback. `agent/session-start` is a non-vetoing notification: listener failures are logged and contained so the loop still starts.

### Teardown stops work before revoking its world

Every owner path uses the same reverse order: stop the loop and await its actual exit plus every agent-started durability checkpoint, remove the agent from the registry, detach the session, then unwind the scope. Final turn events, the turn-ending flush, and any outstanding idle-injection flush therefore settle while the session and scoped listeners are still live.

```text
disposeOwnedAgent(world):
  await world.stopDriver()     # waits for loop exit and all agent-started flushes
  world.detachAgent()          # emits agent/disposed when announced
  world.detachSession()
  await world.scope.dispose()
```

The actual Cordis generator yields these disposers in reverse so its last-in-first-out teardown executes in the order shown.

`agent/disposed` means the driver is quiescent and the agent has left the registry; session detachment and scope unwind may still be completing after that notification. `AgentHandle.dispose()` is memoized so concurrent owners await the same full transaction, and `Scope.dispose()` provides the corresponding shared boundary for direct scope disposal and raw-disposer races.

Parent-owned subagents use explicit ownership rather than capability inheritance. The driver creates one run-owner fiber under `parent.ctx` and invokes the child factory through that fiber, so lifecycle ownership exists before setup or publication begins; disposing a parent reaches its descendants even if a delegating tool never reaches its own `finally`. The child still receives a newly minted scope and resolves only global plus child-scoped capabilities.

## Owner-final policy boundaries

Cooperative waterfalls remain the general extension mechanism, but an invariant belongs after the last transformable point. The design adds four narrow boundaries, each owned by the service that can define what “final” means.

### Prompt protection restores named canonical contributions

`systemPrompt.protect({ sections, tools })` declares that selected names must match the canonical registry/provider assembly after the complete `system-prompt/assemble` waterfall. Protections registered globally and for the current scope compose by set union, so callback order cannot weaken them. Protection finalizes a returned assembly rather than recovering from listener failure; if the waterfall throws, assembly still fails.

For each protected name, the service restores the canonical presence and definition. If the canonical assembly omitted the name, protection removes a listener-fabricated entry; this makes mode-dependent absence enforceable as well as presence.

A global section protection also reserves the registry name against scoped shadowing. Registering a scoped section under an already protected global name throws, and adding global protection throws if any scoped shadow already exists. Section registration copies `name`, `order`, and the text value or callback before the check and stores that record, so later mutation of the caller's object cannot rename a safe section into a reserved one. This check must happen before assembly: otherwise the ordinary scoped-over-global merge would make the shadow itself look canonical, leaving post-waterfall restoration with the wrong owner's value. Tool-schema protection does not impose a blanket schema-name reservation because providers are additive and may deliberately contribute unrelated executable schemas.

Restoration is intentionally not a whole-assembly reset. The service first removes protected names from the waterfall result, then reinserts protected canonical entries in their canonical order immediately before the first surviving later unprotected canonical neighbor, or at the end when no such neighbor survives. Unprotected entries keep the ordering and definitions chosen by the waterfall. This anchor rule preserves the protected contribution's meaningful local placement without claiming that protection restores every global relative position after arbitrary listener reordering.

```text
registerSection(input, scope):
  stored = copy(input.name, input.order, input.text)
  if scope exists and stored.name is globally protected:
    fail before registration
  sectionLayer(scope).add(stored)

assemble(context):
  canonical = assemble registries for context.scope
  transformed = await systemPromptAssembleWaterfall(clone(canonical))

  for each protected name:
    remove every transformed entry with that name
    if canonical contains the name:
      if a later unprotected canonical neighbor survived:
        insert the canonical entry before that neighbor
      else:
        append the canonical entry

  return transformed
```

This algorithm restores a protected entry's definition, presence or absence, and useful local anchor without erasing unrelated listener output.

Code Mode uses global protection for the `tools:sdk` section and reserved `run_code` schema. Structured output adds scoped protection for its instruction and capture schema. These are named guarantees: unrelated listeners may still contribute unrelated sections or tools.

### Tool executions have stable identity

`ctx.tools.execute(input)` accepts a caller-owned `ToolExecutionInput` and snapshots it into a distinct pipeline-owned `ToolExecution`. The registry requires `arguments` to be losslessly JSON-serializable, validates before cloning and again after cloning to contain unstable accessors, then deep-freezes the detached value. A cloneable but mutable exotic such as `Map` is rejected before policy rather than smuggled through an apparently frozen wrapper. Invalid input still produces one normalized final error notification.

The registry assigns each pipeline trip a frozen, property-free `ToolExecutionToken`; callers cannot choose that token. The execution's `token`, `callId`, `name`, `agent`, optional opaque `parent` token, and detached `arguments` are non-writable and non-configurable from the first policy listener onward. `signal` is the only operational field: an around-dispatch wrapper may add, replace, or remove it, and the registry freezes the complete execution before outcome observation.

Stable identity prevents a listener from changing which capability or scope was authorized after policy ran. It also gives commit-style observers a safe `WeakMap` key even when an adapter reuses a model call ID.

For a nested transport dispatch, `parent` carries only the enclosing execution's opaque token rather than its live object. Code Mode sets an SDK sub-call's `parent` to the outer `run_code` execution's `token`, so an observer can correlate the two outcomes without receiving a reference that could mutate the still-running outer wrapper.

The input-to-execution conversion is intentionally one-way:

```text
prepareExecution(input):
  require input.parent is absent or a registry-minted token
  require input.arguments is lossless JSON
  detachedArguments = clone(input.arguments)
  require detachedArguments is still lossless JSON

  execution = {
    token: new frozen property-free object,
    callId: input.callId,
    name: input.name,
    arguments: deepFreeze(detachedArguments),
    agent: input.agent,
    parent: input.parent,
    signal: input.signal
  }

  make every field except signal non-writable and non-configurable
  return execution
```

### Tool guards can deny but never re-allow

`ctx.tools.guard()` installs a synchronous global or scope-specific guard after the extensible `tools/pre-execute` waterfall and before dispatch. A guard returns a denial reason or `undefined`; it has no allow result.

This one-way result makes the boundary monotonic. Pre-execution hooks can still compose ordinary allow, deny, and ask decisions; an ask resolves through the optional `ctx.approval` seam, where only `allowed-once` becomes allow and an absent channel or any non-grant becomes deny before guards run. No listener ordering can convert a guard denial back into dispatched work. A denied call still continues through result transformation and final observation as an error outcome.

### `tools/result` observes the authoritative live outcome

The complete live pipeline is `tools/pre-execute` → monotonic guards → `tools/execute` → `tools/post-execute` → `tools/result`. The first three named events are transformable waterfalls; `tools/result` is an awaited, observe-only notification after all transforms and the registry's outer error normalization. Immediately before that boundary, the registry validates that the entire authoritative result can round-trip losslessly through JSON; an invalid tool or listener result becomes a normal JSON-safe `isError` outcome instead of reaching observers as apparent success and failing later at the session log.

Every `tools/result` listener receives the same frozen execution and deep-frozen result snapshot. Listener failures are contained independently, so they cannot change the caller's result or starve peer observers. Scope filtering derives from `execution.agent`.

`tools/result` is not the durable session event `tool/result`. The live notification belongs to the registry and also fires for direct programmatic executions; the agent loop subsequently appends `tool/result` to the session log for replay, UI reconstruction, and model history. A policy that needs the final in-process verdict uses the former, while a consumer that needs persisted transcript state uses the latter.

The entire registry method reads like one authority ladder:

```text
execute(input):
  try:
    execution = prepareExecution(input)
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
    result = requireLosslessJson(result)
  catch pipelineFailure:
    result = errorResult(pipelineFailure)

  freeze(execution)
  frozenResult = deepFreeze(clone(result))
  await every tools/result observer independently, containing each failure
  return result
```

Waterfalls can transform only at their named stages. Guards can only deny, and the final observers can only observe.

### `agent/turn-stop` makes a composed continuation terminal

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

Provider registration first freezes an acceptance snapshot of the provider name, capability flags, parent-context descriptor, and `start` callback; the callback is bound to the original provider receiver so its intentional internal state stays live. Lookup, validation, model-facing wording, dispatch, lifecycle notifications, and HMR cleanup all use that snapshot. Mutating or reusing the caller's provider object later therefore cannot rename a live entry, change its advertised powers, replace its callback, or make its disposer delete the wrong key.

Starting a run snapshots every accepted field before asynchronous owner setup. The parent and abort signal are retained as identity capabilities but never reread from the mutable request record; tool filters, seed events, agent options, output schema, and prompt are detached. The schema is validated before cloning, while the prompt must pass the same lossless-JSON check before and after cloning that the session log requires. Later caller mutation therefore cannot change lifecycle scope, configuration, the schema enforced by the capture tool, or the prompt eventually logged and sent.

The driver first installs provider ownership. Only after that succeeds does it attach the request's abort listener and create one run-owner Cordis fiber under `parent.ctx`; an already-unloading provider therefore leaves neither a child nor an orphaned listener. The child factory runs through the owner fiber. Parent teardown, provider teardown, and manual run disposal all dispose this same node; moving it out of the active state synchronously prevents an unpublished setup from publishing afterward, while all three paths follow one quiescence promise. This structured ownership does not change the child's flat capability view.

The returned run separates acceptance from publication with `started: Promise<void>`. For spawn and fork, it fulfills only after the child factory returns a published handle, so the service can emit `subagent/start` with `ctx.agents.get(run.id)` already live; it rejects when rollback prevents publication. The service observes `result` immediately but buffers its cloned end payload until readiness, preserving start-before-end order without leaving an early rejection unhandled. A readiness rejection emits neither lifecycle event. The result driver awaits the same boundary before sending the child prompt.

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
    cloned options and optional seed,
    setup(childCtx) => install persona, tool restriction, structured runtime
  })

  returnedRun.started = creation.then(childHandle => publication complete)
  returnedRun.result = async:
    await returnedRun.started
    send the child prompt, await idle, derive the terminal result

SubagentService.start(...):
  attach result settlement handlers immediately
  await returnedRun.started
  emit subagent/start; later emit the buffered or eventual subagent/end
```

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

The capture tool validates its arguments and stages the cloned value in a JavaScript `WeakMap` keyed by the immutable `ToolExecution`. This is an object-identity table whose key does not keep an abandoned execution alive. Validation failure becomes the ordinary `INVALID_ARGS` error that the model can correct within the turn.

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

### Add scope semantics to vendored Cordis

Cordis already provides derived contexts, effect-owning fibers, and receiver-based listener filtering. The harness-level primitive combines those mechanisms without adding a framework fork whose synchronization cost would outlive this feature.

## Consequences

The design makes per-agent composition ordinary and lifecycle-safe at the cost of a small scope runtime and several deliberately narrow final-policy APIs. The complexity is concentrated in services and dispatch helpers rather than repeated in every plugin.

### Benefits

The main benefit is one composition model across data, behavior, and lifetime: registrations follow their context, while service-owned finalizers protect only the invariants that require stronger ordering.

- Plugin authors use the same registration APIs globally and per agent; only the context changes.
- Registry-owned prompt schemas, executable lookup, Code Mode bindings, policy listeners, and UI presentation resolve from the same agent view.
- Create and resume expose no partially configured registry entry during awaited setup.
- Agent disposal revokes scoped contributions after the driver and all final or idle-injection session flushes have settled.
- Structured output composes per child without global mutation or listener-order assumptions.
- Existing unscoped plugins remain deployment-wide contributors and observers.

### Costs and constraints

The costs are concentrated in dispatch discipline, per-scope registry state, and explicit authority boundaries that are intentionally stronger than ordinary middleware.

- Every scoped event dispatcher must carry the correct receiver; fused helpers, type markers, invariants, and gates exist because omission would otherwise deliver only to global listeners.
- `agent.ctx` is capability-bearing. Its available services come from the agent loop's injected context, so holders receive that deliberate service surface.
- Registries maintain per-scope maps and perform a global-plus-one-layer merge for the agent lifetime.
- The dispatch carrier is proxy-shaped and not identity-equal to its subject, even though method calls and property access behave like the subject.
- Flat scopes do not inherit parent capabilities; a desired child capability must be global or explicitly registered for the child.
- `run_code` is protected transport infrastructure rather than a filterable end capability, so a policy that must forbid programs denies execution at the tool-policy layer instead of removing the transport from a Code Mode prompt.
- Prompt protection restores named canonical contributions and their anchor placement, not the entire assembly; unprotected output remains extensible, while a globally protected section name is deliberately unavailable for scoped shadowing.
- Terminal turn stopping has authority to discard pending steering. That power is appropriate for owner-enforced terminal protocols and too strong for ordinary cooperative continuation policy.
- Programmatic `ctx.agents.create()` and `ctx.agents.resume()` are asynchronous because they await setup. The config-only `ctx.agentLoop.create()` path has no setup callback and remains synchronous.
- Ordered composition requires both an exact raw scope disposer and a shared public quiescence promise; the dual surface reflects two distinct Cordis lifecycle requirements.

### Deliberate boundaries

The scope primitive is generic, but this decision applies it only where one agent needs a coherent registration view: tools, prompt state, scoped events, sessions, and in-process subagent composition. `agent.ctx` does not automatically scope every service call; filesystem policy, LLM interception, background subagent state, and future registries retain their existing seams until their own designs explicitly adopt the context rule.
