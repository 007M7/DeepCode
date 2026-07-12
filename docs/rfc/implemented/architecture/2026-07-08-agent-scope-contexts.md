# RFC: The agent is a registration scope

Status: implemented

## Problem

One application needs to share infrastructure across many agents while giving each agent a coherent local world. Model adapters, persistence, user interfaces, and most tool implementations belong to the deployment; personas, visible tools, live policy, and cleanup often belong to one agent.

This is a composition problem, not an application-isolation problem. A separate service graph per agent duplicates too much shared infrastructure, while one global registration graph lets agent-specific contributions leak across agents.

| Question | Required behavior | Failure without it |
|---|---|---|
| What participates? | Each operation sees deployment-global contributions plus the contributions for its agent | A child-only tool, prompt, or listener affects unrelated agents |
| When does that world exist? | The complete agent world appears only after setup and remains until work and cleanup reach quiescence | Observers see partial setup, or final work loses its scoped policy |
| Which value is authoritative? | Validation, execution, logging, and observation use the same accepted data | Mutable inputs pass one check and produce different behavior later |
| What may extensions override? | Ordinary middleware stays extensible, while a few protocol invariants finish at owner-controlled boundaries | Listener order removes required prompt state, re-allows denied work, commits a failed result, or forces an extra model step |

In-process subagents expose all four requirements at once. Two concurrent children can request different personas, tool filters, and structured-result schemas; each child must receive its own complete view, publish only after that view exists, preserve the exact accepted request, and keep terminal structured-output rules stronger than unrelated middleware.

## Decision

Every live agent owns one flat registration layer through `agent.ctx`. Four matching rules make that layer coherent: registration and dispatch select the agent view, lifecycle publishes and revokes the view transactionally, acceptance transfers caller data into owner-controlled records, and four narrow owner-final checkpoints preserve invariants after extensible middleware.

| Governing question | Decision | Guarantee |
|---|---|---|
| What participates? | Resolve deployment globals plus exactly one agent layer; route scoped events by the operation's real agent | Data and behavior use the same flat agent view |
| When does it exist? | Treat scope, session, registry entry, and driver as one caller- and agent-factory-owned transaction | Setup is unpublished; teardown drains before revocation |
| Which value is authoritative? | Read caller-owned fields once, validate that capture, and retain only owner-controlled identities or snapshots | Checked, executed, logged, and observed values cannot diverge |
| What may extensions override? | Keep waterfalls for cooperation, then place prompt protection, monotonic guards, final result observation, and terminal turn stopping at service-owned boundaries | Extension ordering cannot undo protocol invariants |

The scope is deliberately flat. An agent resolves deployment-global registrations plus its own registrations; it never traverses parent or sibling scopes. Parent ownership links lifetimes without importing the parent's registration layer.

This is a composition boundary, not an authority boundary. Agent scopes compose trusted in-process registrations; they do not sandbox plugins or define a parent-to-child authority lattice. A plugin holding a Cordis context runs in the same process and can call the services injected into that context. Scope selection answers which registered contribution participates and who cleans it up, not whether a child can do no more than its parent.

The detailed consequences for tool filters, future global registrations, and child-local tools appear under [the tool-view contract](#the-tool-view-is-live-and-executable). Security hardening requires a separate authority representation and enforcement boundary.

### Worked example: one agent-local reviewer

Agent setup uses ordinary registration methods through `agent.ctx`; the context determines visibility and cleanup together. In these focused examples, `ctx` is a plugin service context, `setup(agentCtx)` receives the unpublished agent's scoped context, and helpers such as `AgentId`, `SessionId`, and `CallId` construct opaque IDs.

Assume the deployment already registered global `read` and `bash` tools. This creates a reviewer whose persona, filtered global tools, and reporting tool exist only for that agent and disappear with its handle:

```js
const reviewSummaryTool = {
  name: 'review_summary',
  description: 'Return the review summary.',
  parameters: { type: 'object', properties: {} },
  async execute() {
    return [{ type: 'text', text: 'review complete' }]
  },
}

const handle = await ctx.agents.create({
  agentId: AgentId('reviewer'),
  sessionId: SessionId('reviewer-session'),
  agentOptions: { model: 'model-name' },
  setup(agentCtx) {
    agentCtx.systemPrompt.section({
      name: 'deployment:persona',
      order: 0,
      text: 'Review code, but do not modify files.',
    })
    agentCtx.tools.restrict({ allow: ['read'] })
    agentCtx.tools.register(reviewSummaryTool)
  },
})

const reviewer = handle.agent
ctx.tools.get('read', reviewer)            // global tool, visible
ctx.tools.get('bash', reviewer)            // undefined: filtered global tool
ctx.tools.get('review_summary')            // undefined: not global
ctx.tools.get('review_summary', reviewer)  // reviewer-only definition

await handle.dispose()
ctx.tools.get('review_summary', reviewer)  // undefined: scope was unwound
```

The remaining sections descend from this contract.

## Reader model: domain terms and Cordis mechanics

Readers need four domain terms and four Cordis mechanics to follow the implementation. Readers already familiar with this codebase and Cordis can skim this section.

### Recurring domain terms

Four domain terms keep the rest of the RFC compact. A **Session** is an agent run's append-only event log, from which model history and durable replay are derived. **Lossless JSON** is the JSON subset that can be copied without changing meaning: primitives, dense arrays, and plain objects; cycles, sparse arrays, exotic prototypes, non-finite numbers, negative zero, `undefined`, `bigint`, functions, and symbols are rejected. An **end capability** is an actual callable tool implementation, whether the model sees it as a native schema or a Code Mode binding. **Code Mode** gives the model a generated SDK and a reserved `run_code` transport instead of advertising every end capability as a native wire tool.

### Four Cordis mechanics

Contexts select service access and registration origin, fibers own effects, waterfalls provide cooperative transformation, and dispatch receivers select listeners.

| Cordis concept | Meaning in this RFC |
|---|---|
| Context | The object through which a plugin reaches services and registers contributions; a derived context can carry a different registration scope |
| Fiber and effect | The runtime owner and one owned piece of setup/cleanup; disposing the fiber unwinds its effects |
| Waterfall | Ordered around-middleware whose listener calls `next()` to include downstream work and may transform or short-circuit the result |
| Dispatch receiver | The `this` object used by Cordis listener filtering; a scope carrier encodes the operation's agent key |

#### Context selects both service access and registration origin

A Cordis `Context` is the object through which code calls services such as `ctx.tools`, `ctx.systemPrompt`, and `ctx.sessions`. A service can recover the context through which it was accessed, so the same method can register globally from a plain plugin context or locally from `agent.ctx` without adding an `agent` option to every registration API. Cordis implements contextual service access with a **traced receiver**: a proxy that carries the accessing context while forwarding calls to the concrete service object.

```js
ctx.tools.register(globalTool)
agent.ctx.tools.register(agentOnlyTool)

ctx.on('tools/result', globalObserver)
agent.ctx.on('tools/result', agentObserver)
```

A context also exposes the dependency view injected into the plugin that minted it. `agent.ctx` therefore carries the agent loop's deliberate service surface; it is not an ambient root context or a security boundary.

#### Effects make cleanup follow ownership

An effect is setup whose cleanup belongs to a fiber. Tool registration, prompt contribution, event subscription, and an agent scope are effects, so normal disposal, failure, and hot module reload all follow the same ownership graph.

```js
ctx.effect(() => {
  const resource = openResource()
  return async () => {
    await resource.close()
  }
})
```

Cordis also supports generator effects that nest child effects in a chosen teardown order. The lifecycle section explains why construction must become owner-visible before arbitrary callbacks run.

#### Waterfalls remain cooperative extension points

A waterfall listener wraps downstream work. Calling `next()` includes the remaining listeners and base implementation; returning directly skips that downstream portion.

```js
ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
  const downstream = await next()
  return {
    ...downstream,
    sections: [...downstream.sections, extraSection],
  }
})

ctx.on('system-prompt/assemble', async () => replacementAssembly)
// The direct return skips this listener's downstream/base. An outer listener
// that already awaited next() still resumes around replacementAssembly.
```

This flexibility is intentional for ordinary policy, but it cannot express a fact that must remain true after every wrapper and short-circuit. [Owner-final policy](#owner-final-policy-four-narrow-boundaries) adds only the four final checkpoints that need stronger semantics.

#### Dispatch receivers select scoped listeners

Cordis filters listeners using the dispatch receiver, the object visible as `this` inside a function-style listener. `dsh-scope` builds a receiver carrying the operation's scope key, allowing global listeners plus listeners registered for that exact key while rejecting other agents' listeners.

The receiver is live coordination state, not durable session data. For example, `tools/result` is a live final-outcome notification, while `tool/result` is an append-only session event used for replay and model history.

## Registration and delivery: global plus exactly one agent layer

One scope key controls both registered data and registered behavior. Reads combine the deployment-global layer with exactly one agent layer, while scoped event dispatch admits global listeners plus the listeners for that same agent.

Scope keys are opaque objects compared by identity; a live `Agent` is its own registration key. There is no name-based equality or parent traversal.

### Scope mechanism: context, key, and lifetime

The registration context selects the layer, the scope primitive binds that layer to cleanup, and the nearest scope tag—not an inherited convenience property—selects the key.

#### The calling context selects visibility and cleanup

A contribution made through a plain plugin context is visible to every agent and disposed with that plugin. A contribution made through `agent.ctx` is visible only to that agent and disposed with its scope.

| Registration origin | Visible to | Disposed with |
|---|---|---|
| Plain plugin context | Every agent | Registering plugin |
| `agent.ctx` | That agent only | Agent scope |

The table describes ordinary registrations. Cordis listeners alone have an explicit `{ global: true }` bypass: it suppresses contextual filtering, so a listener registered through `agent.ctx` can receive other agents' and subjectless dispatches while its cleanup still belongs to that agent scope. Cross-scope observation must opt into this bypass deliberately.

Named scoped contributions shadow same-named global contributions. This is how a child persona replaces `deployment:persona` and how one agent can use a different implementation under the same tool name. Duplicate names within one layer still fail loudly.

```text
resolveLayer(agentA):
  visible = copy(global registrations)
  visible.overlay(registrations from agentA.ctx)
  return visible
```

There is no ancestor loop. Resolving for agent A never reads parent or sibling layers.

#### The scope primitive keeps layer and owner together

`dsh-scope` exposes only the operations needed to mint a tagged ownership layer, read its key, target dispatch, and reach quiescent cleanup. A separate `{ scope }` option on each registry could express “visible to A, disposed with B”; the scoped context makes that mismatch unrepresentable.

| Operation | Responsibility |
|---|---|
| `createScope(context, key)` | Mount an ownership fiber and return its tagged context |
| `scopeOf(context)` | Read the nearest inherited scope key |
| `scopeTarget(subject, key)` | Build the receiver for scope-filtered dispatch |
| `Scope.dispose()` | Return one shared idempotent promise that reaches cleanup quiescence |
| `Scope.rawDispose` | Expose the exact Cordis disposer for ordered generator composition |

`Scope.dispose()` and `rawDispose` serve different callers. Cordis raw disposers are single-shot, so a repeated raw call need not wait for an earlier asynchronous teardown; the public method follows the backing fiber's in-flight cleanup and gives racing callers the same completion promise. Generator lifecycles use `rawDispose` because Cordis recognizes nested ownership by exact disposer identity.

The primitive has one essential shape:

```text
createScope(parentContext, key):
  fiber = mount no-op plugin under parentContext
  scopedContext = derive fiber.context with nearest-scope-tag = key

  rawDispose = fiber's exact disposer
  dispose = memoized operation that:
    invoke rawDispose if teardown has not started
    follow fiber's in-flight cleanup until quiescent

  return { ctx: scopedContext, rawDispose, dispose }
```

Derived contexts inherit the nearest tag. Mounting a plugin under `agent.ctx` preserves the agent scope; deliberately creating another scope replaces the tag below it.

#### `ctx.agent` is an association; `scopeOf()` selects the layer

`agent.ctx.agent` gives setup code convenient access to the associated agent, but the nearest scope tag remains authoritative for resolution. A nested scope can inherit the ergonomic `agent` property while replacing the registration key.

```js
const auditKey = {}
const auditScope = createScope(agent.ctx, auditKey)

auditScope.ctx.agent === agent        // true: inherited association
scopeOf(auditScope.ctx) === auditKey  // true: nearest registration key

await auditScope.dispose()
```

This separation keeps the generic scope package independent of the agent package.

### Resolution contracts preserve domain semantics

The shared scope selects two layers, but each registry retains its own merge rules and must keep presentation, lookup, and execution coherent within the view it owns.

#### Registries retain domain-specific merge rules

The shared primitive answers “which layer?” and “who owns cleanup?”; each service still defines how its values combine. Prompt sections, variables, and tools use scoped-over-global shadowing by name. Tool-schema providers are additive. Tool lookup and execution receive an agent or scope explicitly, while prompt assembly receives an `AssembleContext` whose `scope` selects the layer.

Calling a read method through `agent.ctx` does not silently choose an agent subject. For example, `agent.ctx.systemPrompt.assemble()` without an assembly scope still requests the global view. Registration origin and operation subject remain explicit, allowing one shared service to act for any agent.

#### The tool view is live and executable

Within `ToolRegistry`'s contribution, presentation, lookup, execution, Code Mode bindings, timeouts, inspection, and UI rendering all consume one resolved view. The registry filters the live global layer, overlays scope-local tools, and then adds reserved presentation transport when the configured mode requires it.

```js
ctx.tools.register(readTool)
ctx.tools.register(bashTool)

agent.ctx.tools.restrict({ allow: ['read'] })
agent.ctx.tools.register(reviewSummaryTool)

ctx.tools.get('read', agent)            // visible global definition
ctx.tools.get('bash', agent)            // undefined: filtered global definition
ctx.tools.get('review_summary', agent)  // visible scope-local definition
ctx.tools.get('review_summary')         // undefined: absent globally
```

Executing `bash` for this agent follows the same lookup and returns the ordinary unknown-tool error. A hidden global implementation therefore cannot remain callable through a second registry.

Final prompt assembly remains extensible beyond `ToolRegistry`. A lower-level `systemPrompt.tools()` provider or assembly listener may add an unrelated wire schema; that extension then owns the matching executable behavior and ordering. The one-view guarantee covers the registry-owned schemas, SDK bindings, lookup, execution, and presentation—not arbitrary schemas contributed elsewhere.

A restriction filters only the global end-capability layer. `allow` keeps named global tools, `deny` removes named global tools, multiple restrictions intersect, and scope-local tools are merged afterward. The filter values are captured when registered, but resolution uses the live global registry:

Filter presence is explicit: omitting a filter installs no restriction, `restrict({})` rejects as ambiguous, and `allow: []` deliberately hides every global end capability.

```text
at time 0:
  global tools        = { read, bash }
  deny { bash } view  = { read }
  allow { read } view = { read }

after registering global tool web:
  deny { bash } view  = { read, web }
  allow { read } view = { read }
```

The flat child relationship follows directly:

```text
global tools                  = { read, bash }
parent restriction           = allow { read }
parent scoped registrations  = { delegate }
child restriction            = none
child scoped registrations   = { deploy }

visible(parent) = { read, delegate }
visible(child)  = { read, bash, deploy }
```

Through `delegate`, the parent can ask the child to perform work with `bash` or `deploy`. This is why registration scope is not an authority ceiling. A deployment that needs parent-to-child non-escalation requires a separate authorization model, including authority representation, propagation, and execution checks.

`run_code` is a reserved presentation transport rather than an end capability. Restrictions cannot remove it, scope-local tools cannot shadow it, and configuration cannot explicitly allow or deny it. In Code Mode the transport remains available while its generated SDK contains only the end capabilities visible to the agent. Without that exception, a filter could leave SDK declarations in the prompt but remove the only invocation path.

Two similarly named checks use different universes. `ToolRegistry.knownNames()` exposes the pre-restriction end-capability set so a misspelled restriction fails loudly. The system-prompt provider validates `toolOrder` against a mode-specific set: native mode accepts end capabilities, both mode accepts end capabilities plus `run_code`, and code mode accepts only `run_code`. Filtering one agent's view does not turn a valid deployment-wide order into a configuration error.

### Dispatch contract follows the operation subject

The operation supplies the scope key, and a carrier composes that key with the subject's existing dispatch behavior. Callers cannot provide an independent routing value that might disagree with the payload.

#### The operation subject selects the listener set

An event about agent A ordinarily reaches unscoped listeners and A-scoped listeners, never B-scoped listeners. An agent-less dispatch admits only unscoped listeners. A listener registered with `{ global: true }` is the deliberate Cordis filtering bypass described above. The operation itself supplies the key; callers do not attach an independent scope that could disagree with the payload.

| Event family | Scope source |
|---|---|
| `agent/*`, including `agent/turn-stop` | Event's agent |
| `approval/request` | `ApprovalRequest.agent` |
| Tool execution events | `ToolExecution.agent`, or no key for an agent-less call |
| `system-prompt/assemble` | `AssembleContext.scope` |
| Session lifecycle/events | Owner scope captured when the session enters the store |
| `subagent/start`, `subagent/end` | Delegating parent agent |

Registry-membership events such as `tools/change`, `system-prompt/change`, and `SubagentProvider` added/removed events remain unfiltered because they describe shared registry state rather than one agent operation.

```js
const seen = []
ctx.tools.register(readTool)
ctx.on('tools/result', () => seen.push('global'))
agentA.ctx.on('tools/result', () => seen.push('A'))
agentB.ctx.on('tools/result', () => seen.push('B'))

await ctx.tools.execute({
  callId: CallId('read-1'),
  name: 'read',
  arguments: {},
  agent: agentA,
})
seen  // ['global', 'A']
```

Fused helpers keep values that must agree together. `agentEvents(context, agent)` uses one agent as the subject, scope key, and first event argument. `assembleContextFor(agent)` sets both prompt facts and the scope selector. The session store captures its carrier when a session enters because later appends and flushes may occur without the original agent context.

#### The carrier preserves subject behavior

Function-style listeners receive the carrier as `this`, and agent listeners may call subject methods. The carrier is therefore a proxy that selects listeners while reading, writing, and invoking through the real subject.

The implementation uses a dedicated surrogate proxy target with an immutable composed-filter slot. It combines the subject context's existing `Context.filter` with the scope predicate instead of replacing it. Methods bind to the real subject; callable carriers preserve call and construct shape; descriptor queries normalize configurable flags as required by Proxy invariants; and definitions through the carrier require an explicitly configurable descriptor. Stable built-in references protect the composed filter from accidental `.call` replacement.

Those mechanics preserve observable JavaScript behavior, including private-field method identity:

```js
class Subject {
  #count = 0
  increment() { this.#count += 1 }
}

const subject = new Subject()
new Proxy(subject, {}).increment()  // TypeError: proxy lacks Subject's private identity

const carrier = scopeTarget(subject, subject)
carrier.increment()                // works: method is bound to subject
carrier === subject                // false: carrier has distinct identity
```

Together these constraints keep listener selection correct while preserving the subject behavior listeners expect.

The TypeScript-only `Scoped<T>` marker requires a carrier at typed dispatch sites. Runtime marks and development invariants cover JavaScript, casts, and direct Cordis dispatch; they detect routing mistakes but do not confine hostile same-process code.

## Lifecycle: compose privately, publish once, tear down in reverse

Scope, session, registry entry, and driver form one transaction with two owners. Request fields are captured first; AgentLoop tracking and both identity reservations precede asynchronous work; the caller owns the prepared lifecycle before setup; publication proceeds in synchronous observable phases; and every teardown path reaches one reverse-order quiescence boundary.

Two services split the public API from the implementation. `AgentRegistry`, reached as `ctx.agents`, stores live agents and is the front door for `create()` and `resume()`. Its registered `AgentFactory` is concretely implemented by `AgentLoop`, which constructs and drives agents using its own injected dependencies. The rest of this section calls that concrete co-owner the **AgentLoop factory**.

| Phase | Public state | Ownership fact |
|---|---|---|
| Reserve | IDs unavailable to competitors | AgentLoop tracking and exact reservations cover the next await |
| Prepare or load | Persistence data is loading, or session, scope, and driver exist privately | Resume's load sentinel covers persistence; the complete caller lifecycle covers setup |
| Setup | `setup(agent.ctx)` may await and register | Neither ID is published |
| Publish and start | Session, agent, and lifecycle notifications appear in order | Liveness is checked between observable phases |
| Dispose | Driver drains, registries detach, scope unwinds, IDs release | All owner paths join one completion promise |

The public lifecycle is simple:

```js
const setupGate = Promise.withResolvers()
const agentId = AgentId('reviewer')
const sessionId = SessionId('reviewer-session')
const creating = ctx.agents.create({
  agentId,
  sessionId,
  agentOptions: { model: 'model-name' },
  async setup(agentCtx) {
    await setupGate.promise
    agentCtx.systemPrompt.section({
      name: 'deployment:persona',
      order: 0,
      text: 'Review the change.',
    })
  },
})

ctx.agents.get(agentId)      // undefined during setup
ctx.sessions.get(sessionId)  // undefined during setup
setupGate.resolve()

const handle = await creating
ctx.agents.get(agentId) === handle.agent
ctx.sessions.get(sessionId) === handle.agent.session

await handle.dispose()
ctx.agents.get(agentId)      // undefined after quiescent teardown
ctx.sessions.get(sessionId)  // undefined after quiescent teardown
```

### Reservations precede awaiting; lifecycle ownership precedes setup

AgentLoop tracking and exact identity reservations precede the first await. Resume adds a caller sentinel across persistence loading; create and resume both establish the complete caller-owned lifecycle before invoking setup.

#### The prepared lifecycle is owned before setup callbacks

The caller context owns the work it requested and receives the consumer-facing `AgentHandle`. The AgentLoop factory is a structural co-owner because a live agent continues to depend on its injected services. Either owner can deactivate the transaction; both converge on the same lifecycle disposer.

| Owner mechanism | Covers | Retires when |
|---|---|---|
| Caller lifecycle sentinel | Caller-fiber loss from lifecycle preparation through live lifecycle | Shared lifecycle reaches quiescence |
| Resume load sentinel | Caller-fiber loss across persistence load and lifecycle handoff | Load rollback or the adopted lifecycle reaches quiescence |
| AgentLoop tracker | AgentLoop unload and structural dependency loss | Transaction and lifecycle settle |
| ID reservations | Competing agent/session insertion | Ordered teardown releases both IDs |

A **sentinel** is an owner-visible effect that follows work whose final disposer is not yet available. It adopts the exact reservation disposers immediately, then follows the complete lifecycle disposer once preparation establishes it.

Cordis must make construction owner-visible before setup can reenter teardown. An effect's cleanup wrapper enters its owner list before its setup body runs, a child fiber receives its parent-owned disposer before Cordis's child-plugin notification (`internal/plugin`) announces it, and a fiber already unloading rejects new effects after taking its cleanup snapshot. Teardown observers are contained independently so one callback cannot starve peers or interrupt cleanup. These are domain-neutral lifecycle rules; `dsh-scope` uses them by mounting a no-op plugin fiber as the ownership bucket for one scope.

#### Caller ownership and factory dependency lookup stay separate

Factory delegation carries two contexts because ownership and dependency origin are different facts. `ownerCtx` is the caller-bound context whose fiber and optional scope own the requested lifecycle. The factory method receiver is the accepted factory traced through that access so the concrete service retains its own injected dependency view.

```text
callerCtx.agents.create(options)
  ownerCtx    = context carrying callerCtx's fiber and scope
  factoryThis = concrete accepted factory traced through ownerCtx
  Reflect.apply(capturedCreateAgent, factoryThis, [ownerCtx, options])
```

`setFactory()` captures the concrete target and its `createAgent` and `resume` callbacks once. It canonicalizes an already traced service before retracing, avoiding a second proxy layer that would break raw-identity state. Plain factory objects receive the explicit `ownerCtx` without depending on Cordis tracing.

#### Create and resume reserve identities before awaiting

Programmatic create and resume reserve both agent and session IDs before any operation can await. Create prepares a new or seeded session; resume loads persisted data while a caller sentinel and AgentLoop load tracker already own the interval in which no `Agent` object exists.

Reservations are capabilities, not advisory sets. Setup code cannot reserve, prepare, create, register, or enter a substitute under the same IDs. A session reservation prepares at most one exact object, and publication requires the matching factory-held capabilities. A failed or abandoned transaction therefore cannot publish a substitute or wedge an ID indefinitely.

Resume transfers ownership rather than opening a gap:

```text
resume(ownerCtx, request):
  snapshot request identity, options, and setup callback
  reserve agentId and sessionId
  install caller sentinel adopting both reservation disposers
  track load under AgentLoop

  persisted = await firstOf(persistence.load(sessionId), deactivated)
  session = sessionReservation.prepare(reconstruct persisted data)
  starting = startOwned(ownerCtx, session, reservations, setup)
  caller sentinel follows starting.dispose
  return await starting.result
```

If deactivation wins, a backend load may still settle internally but has no path back to publication. Preparation failure still returns a rollback-backed lifecycle result, so both owners can wait for actual cleanup instead of mistaking a rejected async result for successful installation.

### Setup composes an unpublished world

`setup(agentCtx)` may register tools, prompt state, restrictions, listeners, protections, or child plugins and may await their activation. The new agent is available as `agentCtx.agent`, but neither agent nor session is visible in its global registry.

The complete rollback skeleton exists before setup runs. If setup throws, rejects, or loses either owner, the scope and prepared resources unwind and the IDs become reusable. After setup settles, a microtask checkpoint and liveness checks let a same-turn owner unload win before publication.

Setup composes but cannot drive. `send`, `steer`, `inject`, and `cancel` reject until publication reaches the session-start boundary. The driver lock and inbox use runtime-private state, and only factory-held controls enable and start the loop; JavaScript casts cannot call a public start method or write directly into the queue.

```text
startOwned(ownerCtx, snapshot, preparedSession):
  world = prepareLifecycleWithCompleteRollback(ownerCtx, snapshot, preparedSession)

  result = async:
    require world active
    await firstOf(snapshot.setup(world.agent.ctx), world.deactivated)
    await oneMicrotask()
    require caller, factory, owner fiber, and owner agent still active
    world.publish(snapshot.source)
    return handle(world.agent, world.dispose)

  on any error:
    await world.dispose()
    rethrow
```

### Publication is ordered, observable, and rollback-covered

Publication is one synchronous sequence with liveness checks between three observable notification phases. Both registry entries exist before the first listener runs, but driving stays locked until immediately before `agent/session-start`.

1. Enter the session store and capture its scope carrier.
2. Enter the agent registry without announcing it.
3. Recheck caller and factory liveness.
4. Emit `session/created`.
5. Recheck liveness.
6. Emit `agent/created`.
7. Recheck liveness.
8. Enable driving.
9. Emit `agent/session-start`.
10. Recheck liveness.
11. Start the driver.

```text
publish(world):
  world.beginSynchronousPublication()
  try:
    world.detachSession = sessions.enter(world.session, sessionReservation)
    world.detachAgent = agents.enter(world.agent, agentReservation)
    require callerAndFactoryActive
    sessions.announce(world.session)
    require callerAndFactoryActive
    agents.announce(world.agent)
    require callerAndFactoryActive
    world.driver.enableDrivingVerbs()
    emitNonVetoing(agent/session-start)
    require callerAndFactoryActive
    world.driver.start()
  finally:
    world.endSynchronousPublication()
```

#### Creation is paired, not atomic

Observers run between publication steps, so the sequence is not described as atomic. Effects already performed by an earlier listener cannot be retracted if a later listener throws. Instead, each registry marks a creation announcement as begun before dispatch and emits exactly one matching disposal edge during rollback. An entered object that was never announced has no disposal notification because no observer was told it existed.

A detach requested during `session/created` or `agent/created` is deferred until that dispatch unwinds. Stable captured carriers and exact-object guards prevent a later listener from observing `disposed` before `created` or a stale detach from deleting a replacement with the same ID. The outer publication barrier likewise prevents caller or AgentLoop teardown from removing the other registry entry or unwinding `agent.ctx` while an announcement remains on the stack.

Creation listener synchronous throws remain vetoes. Returned promise rejections are observed and logged but not awaited: publication has no asynchronous gap in which such a result could roll back safely. Disposal notifications and `agent/session-start` are non-vetoing and independently contain both synchronous throws and returned-promise rejections so one listener cannot block cleanup or later observers.

### Teardown stops work before revoking registrations

Every owner path reaches one memoized reverse-order transaction. It marks the lifecycle inactive, waits for an in-progress synchronous publication phase, stops the driver through actual exit and final durability work, detaches the agent and session, unwinds the scope, and releases IDs last.

Final turn events, the turn-ending flush, and any outstanding session flush started while the agent was idle therefore run while the session and scoped listeners still exist. `agent/disposed` observes an already quiescent and unregistered concrete agent while its session remains live; `session/disposed` follows after event feed detachment and store removal. Both use the stable carrier captured for their matching creation edge.

```text
disposeOwnedAgent(world):
  mark world inactive
  await world.synchronousPublicationIfRunning()
  await world.stopDriver()  # loop exit plus agent-started flushes
  world.detachAgent()
  world.detachSession()
  await world.scope.dispose()
  world.releaseSessionReservation()
  world.releaseAgentReservation()
```

`AgentHandle.dispose()` gives repeated and racing consumers the same completion promise. The lifecycle-long caller sentinel follows that promise even when handle disposal wins first, while the AgentLoop ledger independently stops new transactions and waits for every structurally dependent agent before the service disappears.

AgentLoop co-ownership follows dependency shape, not a blanket “creator owns every returned value” rule. An AgentLoop-created agent continues to depend on the loop's services, so AgentLoop unload stops it.

## Boundary ownership: accept once and own the accepted value

Acceptance-sensitive boundaries that cross asynchronous, reentrant, model-visible, or durable-log code read caller-owned fields once and retain only owner-controlled identities or snapshots. This rule is independent of TypeScript: `readonly` annotations vanish at runtime, and JavaScript accessors can return a different value on every read.

The shared shape distinguishes identity-bearing references from data. Agent objects and abort signals are retained by identity after one read. Boundaries whose contract requires lossless JSON—such as session events and subagent payloads—validate and materialize it in one traversal; other boundaries use their own owned representation, such as `structuredClone` for agent options. Scalars and callbacks are captured once, then each boundary applies the validation promised by its API before downstream use.

```text
accept(input):
  read every relevant top-level field exactly once
  retain identity-bearing references without rereading them
  validate acceptance-time fields from those captures
  copy or pin data in the representation owned by this boundary
  bind accepted callbacks once when method receiver state is intentional
  expose only owner-controlled identities, frozen records, or detached results
```

Capture does not imply uniform eager callback type-checking. Agent `setup` is captured once and any invocation failure enters rollback; a tool guard is likewise captured, and an invalid cast becomes a normalized execution error. The invariant is that later work never rereads caller fields to choose a different value.

| Boundary | Identity retained | Data detached or pinned |
|---|---|---|
| Tool and `SubagentProvider` registration | Original callback receiver | Name, flags, schemas, scalar config |
| Agent create/resume | Caller context, setup callback | IDs, options, session metadata and seed |
| Approval request | Agent and abort signal | Tool name, call ID, and reason |
| Tool execution | Agent, signal, registry-minted parent token | Call identity and arguments |
| Session append/load | Session identity | Header and event envelopes |
| Subagent start/result | Parent and signal | Prompt, filters, schema, options, result |

Before agent setup can run, the concrete agent pins its accepted ID, options, and session and binds `ctx` once. Registry detach closures likewise close over their accepted keys instead of rereading mutable public fields.

A stateful getter shows why validation and ownership must use the same capture:

```js
let reads = 0
const input = {
  get name() {
    reads += 1
    return reads === 1 ? 'safe_tool' : 'different_tool'
  },
}

// Wrong: validation and storage observe different values.
validateName(input.name)
storeName(input.name)

// Right: one accepted value drives both.
reads = 0
const acceptedName = input.name
validateName(acceptedName)
storeName(acceptedName)
```

### Registered definitions are frozen snapshots

Tool registration creates the stored definition identity once; changes occur through explicit unregister/register effects rather than mutation of a caller-retained object. Parameters are materialized in one traversal, callbacks bind once to the accepted definition receiver, and the stored record is deep-frozen.

The first-party `defineTool()` helper applies the same boundary before registration. It captures each option once, materializes the authoring `SchemaSpec`, and derives both the wire schema and later execution/presentation validation from that owned spec.

```text
defineTool(options):
  accepted = read each option exactly once
  parameterSpec = snapshotLosslessJson(accepted.parameters)
  wireSchema = snapshotLosslessJson(convertToJsonSchema(parameterSpec))
  build execute and presentation validation over parameterSpec

registerTool(context, definition):
  accepted = read each definition field exactly once
  stored = deepFreeze({
    accepted name, description, timeout,
    parameters: snapshotLosslessJson(accepted.parameters),
    execute: bind accepted.execute to definition,
    presentation callbacks: bind accepted callbacks when present
  })
  layerFor(scopeOf(context)).add(stored.name, stored)
```

`get()` and `visible()` return the frozen stored definitions; `schemas()` returns detached projections. Replacing `definition.execute` after registration has no effect, while a callback can deliberately read live state from its closure or original receiver.

Factory and backend registration use different reentrancy orderings around the same ownership rule. `AgentFactory` registration claims its single slot before reading callback accessors. `SubagentProvider` registration first snapshots the provider fields, then its effect checks and enters the accepted name. Both capture callback identity and intentional receiver state once, and hot-reload cleanup closes over the accepted slot or key instead of rereading a mutable public property.

### Durable session data belongs to the session

The session pins its ID and detached, deep-frozen header. Seed and append paths materialize lossless JSON once, validate the event envelope and message-history metadata against that owned record, and deep-freeze the exact accepted event. `session.events` returns a frozen snapshot that never grows later.

The store keeps append observers, accepted registry IDs, and scope carriers in private owner state rather than caller-writable fields. Outside JavaScript therefore cannot rename a stored session, redirect `session/event`, or mutate an earlier snapshot into newer history.

Approval requests follow the same async boundary at smaller scale: one capture preserves exact agent/signal identities, copies scalar fields, captures the session once, and drives `approval/asked`, scoped policy, cancellation, and `approval/decided` from that record.

### Tool execution has pipeline-owned identity

`ctx.tools.execute(input)` turns caller-owned input into one pipeline-owned `ToolExecution`. It first reads `callId` and `name` once and requires strings; a failure there rejects because even an error result would lack trustworthy correlation identity. Once those strings are accepted, later input failures can become normal final error outcomes.

Arguments are materialized once and deep-frozen. The registry assigns a frozen property-free `ToolExecutionToken`; callers cannot choose it. `token`, `callId`, `name`, `arguments`, `agent`, and optional opaque `parent` token become non-writable and non-configurable before policy. `signal` is the only operational field an around-dispatch wrapper may replace or remove.

```text
prepareExecution(input):
  callId = read input.callId exactly once
  name = read input.name exactly once
  require both are strings

  accepted = read arguments, agent, parent, and signal exactly once
  require parent is absent or a registry-minted token
  arguments = deepFreeze(snapshotLosslessJson(accepted.arguments))

  execution = {
    token: new frozen property-free object,
    callId, name, arguments,
    agent: accepted.agent,
    parent: accepted.parent,
    signal: accepted.signal
  }
  protect every field except signal
  return execution
```

Stable execution identity prevents middleware from changing which tool or scope policy accepted. It also gives structured-output commit a safe `WeakMap` key when an adapter reuses a string call ID. Code Mode correlates an SDK sub-call with its enclosing `run_code` using only the outer execution's opaque token, never a mutable reference to the live outer object.

Result boundaries apply the same ownership rule. Each transform returns data that is captured field-by-field, validated, materialized, and ultimately deep-frozen for final observers; malformed outcomes normalize to JSON-safe error results rather than reaching the session log as apparent success.

## Owner-final policy: four narrow boundaries

Waterfalls remain the ordinary extension mechanism; each of four protocol invariants runs after the last extension point capable of violating that specific invariant. Each owner-final API has the weakest one-way power that can preserve its guarantee.

Here **canonical** means the named registry or tool-schema-provider output assembled before the waterfall—not “all output the service approves.” Protection restores only the names its owner declares.

| Invariant | Cooperative extension point | Owner-final boundary | Guarantee |
|---|---|---|---|
| Named prompt/tool contribution | `system-prompt/assemble` waterfall | `systemPrompt.protect()` finalization | Canonical presence, absence, definition, and local anchor survive |
| Non-overridable tool denial | `tools/pre-execute` allow/deny/ask waterfall | Synchronous `tools.guard()` | A denial cannot become allow |
| Authoritative live outcome | Execute and post-execute waterfalls | Awaited `tools/result` notification | Observers receive one immutable final result |
| Terminal protocol completion | Continuation waterfall and pending steering | Serial `agent/turn-stop` | No middleware or late steering creates another step |

### Prompt protection restores named canonical contributions

`systemPrompt.protect({ sections, tools })` snapshots the requested names and restores their canonical registry or tool-schema-provider output after the complete assembly waterfall. Global and matching scoped protections compose by set union; a waterfall failure still fails assembly rather than triggering recovery.

Protection covers both presence and absence. If the canonical assembly omits a protected name, finalization removes a listener-fabricated entry; this is how Code Mode keeps a native schema absent while preserving the SDK/transport form. Tool providers likewise expose one captured coherent record for schemas and optional known names, so a stateful getter cannot validate one name and display another.

#### Global section protection reserves its name

A globally protected section name cannot be shadowed by a scoped section. Scoped registration under an already protected name fails, and adding protection fails if a scoped shadow already exists. This check occurs before assembly because scoped-over-global merge would otherwise make the shadow itself appear canonical.

Tool-schema protection does not create a blanket reservation for unrelated schema names. Providers are additive and may deliberately contribute other executable schemas; the owner-final guarantee covers only the named canonical contribution.

#### Restoration preserves a useful local anchor

Protection does not reset the whole assembly. It removes protected names from the waterfall result and reinserts each canonical entry before the first surviving later unprotected canonical neighbor, or at the end if none survives. Unprotected entries retain the order and definitions chosen by middleware.

```text
assemble(context):
  assembly = assemble registries for context.scope
  canonical = snapshot protected section/tool inputs
  transformed = await systemPromptAssembleWaterfall(assembly)

  for each protected canonical name:
    remove every transformed entry with that name
    if canonical includes the name:
      insert before first surviving later canonical neighbor, else append

  return transformed
```

Code Mode globally protects `tools:sdk` and reserved `run_code`; structured output adds scoped protection for its instruction and capture schema.

### Tool guards deny monotonically

`ctx.tools.guard()` installs a global or scoped synchronous check after the complete `tools/pre-execute` waterfall and before dispatch. A guard returns a denial reason or `undefined`; it has no allow result.

Pre-execute hooks still compose ordinary allow, deny, and ask decisions. An ask resolves through the optional approval service, where only `allowed-once` becomes allow and absence or any non-grant becomes deny. Guards run afterward, so listener order cannot convert their denial into dispatched work.

```js
agent.ctx.on(
  'tools/pre-execute',
  async () => ({ kind: 'allow' }),
  { prepend: true },
)

agent.ctx.tools.guard(execution =>
  execution.name === 'bash'
    ? 'reviewer agents are read-only'
    : undefined,
)
```

Even a later prepended allow listener cannot bypass the guard. A denied call still becomes an error outcome that flows through result transformation and final observation.

### `tools/result` observes the final live outcome

The live pipeline is `tools/pre-execute` → guards → `tools/execute` → `tools/post-execute` → `tools/result`. The first, execute, and post stages are transformable waterfalls; `tools/result` is an awaited observe-only notification after every transform and outer error normalization.

Every observer receives the same frozen execution and a separate deep-frozen snapshot of the owned result returned to the caller. Listener failures are contained independently, so they cannot change that returned result or starve peers. Routing uses `execution.agent`.

`tools/result` is not the durable `tool/result` session event. The live notification also fires for direct programmatic executions and is the source of truth for in-process commit logic. The agent loop later appends the durable event for replay, UI reconstruction, and model history.

```text
execute(input):
  accept trustworthy callId and name
  try to prepare pipeline-owned execution
  on preparation failure:
    create an identity-bearing error shell
    ownedResult = owned error result
    freeze execution
    observerResult = deepFreeze(snapshotLosslessJson(ownedResult))
    await every tools/result observer independently with observerResult
    return ownedResult

  gate = await tools/pre-execute(execution)
  resolve ask through approval when needed
  denial = policy denial or first guard denial

  if denied:
    result = errorResult(denial)
  else:
    result = await tools/execute(execution, dispatchRegisteredTool)

  result = await tools/post-execute(execution, result)
  ownedResult = normalize into owned lossless JSON
  freeze execution
  observerResult = deepFreeze(snapshotLosslessJson(ownedResult))
  await every tools/result observer independently with observerResult
  return ownedResult
```

Waterfalls transform only at their named stages; guards only deny; final observers only observe.

### `agent/turn-stop` makes continuation terminal

Steering is input for another model step inside the current turn; queued prompts wait for a future turn. Ordinary continuation remains extensible: the loop computes a default, runs `agent/turn-continuation`, records any force-continue reason as steering, and treats pending steering as a reason to continue.

The scoped serial `agent/turn-stop` checkpoint runs after that folding. A listener returns `{ action: 'stop' }` or abstains with `undefined`; malformed values and throws close the current turn with an error. A stop is terminal, so later listeners and steering cannot restore continuation.

The loop uses `strictSerial` because ordinary Cordis serial dispatch treats `null` and `false` as abstentions. This terminal protocol permits only `undefined` to abstain, making accidental return values fail closed.

Terminal state remains active through `turn/end` and the durability flush. Steering added by continuation, turn-close, or flush listeners is discarded after a terminal stop, while the ordinary queued-prompt FIFO remains untouched.

```text
afterSuccessfulStep(turn):
  decision = await agent/turn-continuation(defaultDecision)
  record decision.reason as steering when present
  if steering is pending: decision = continue

  terminal = await strictSerial(agent/turn-stop)
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

This stronger control is reserved for terminal protocols such as a completed structured child; ordinary continuation policy remains cooperative.

## Subagents: the composition proof

In-process subagents add no second scoping model. They create a fresh flat child scope during unpublished setup, install ordinary scoped persona/filter/protocol registrations, own the child through a run handle, and use the same owner-final checkpoints for structured output.

The roles and phases are explicit:

| Role | Responsibility |
|---|---|
| Caller | Supplies parent, prompt, optional child configuration, and eventual disposal |
| `SubagentService` | Validates capabilities, owns the public wrapper, normalizes result and lifecycle telemetry |
| `SubagentProvider` backend | Chooses transport and creates one run |
| In-process driver | Owns child creation, setup, prompt drive, result read, cancellation, and teardown |
| Child `Agent` | Uses the ordinary agent lifecycle and its fresh `agent.ctx` |

```text
accepted start -> started (published) -> result (settled) -> dispose (quiescent)
```

Assume the in-process `spawn` backend uses its default name, `parent` is top-level, and global `read` exists:

```js
const run = ctx.subagents.start('spawn', {
  parent,
  prompt: [{ type: 'text', text: 'Review this change.' }],
  persona: 'You are a careful code reviewer.',
  toolFilter: { allow: ['read'] },
  maxDepth: 2,
  outputSchema: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
    additionalProperties: false,
  },
})

try {
  await run.started
  const result = await run.result
  // result.structured exists only after successful final commit.
} finally {
  await run.dispose()
}
```

### The child world uses ordinary registrations

A child persona is a scoped `deployment:persona` section. Its tool filter is a scoped restriction over the live global tool layer. Structured output is a bundle of scoped tool, prompt, protection, guard, and listener registrations.

```js
let structured
const setup = childCtx => {
  if (persona !== undefined) {
    childCtx.systemPrompt.section({
      name: 'deployment:persona',
      order: 0,
      text: persona,
    })
  }
  if (toolFilter !== undefined) childCtx.tools.restrict(toolFilter)
  if (schema !== undefined) {
    structured = attachStructuredRuntime(childCtx, schema)
  }
}
```

The driver creates one run-owner fiber under `parent.ctx` and calls the child factory through it. Parent teardown, `spawn` backend teardown, and manual run disposal reach the same node, but the child still receives a new registration key. Lifetime inheritance therefore does not imply registration inheritance.

### Structured output is a child-owned terminal protocol

A structured child registers a real-schema `structured_output` tool and instruction in its own scope. Concurrent children can use different schemas without a global placeholder, reference count, or remove-for-everyone pass.

Presentation mode changes the invocation route, not ownership:

| Mode | Advertised invocation route | Canonical wire contribution | Generated SDK | Owner-final guarantee |
|---|---|---|---|---|
| `native` | Native `structured_output` | Visible native schemas, including scoped capture | None | Restore the capture schema and instruction |
| `code` | The `structured_output` SDK binding inside `run_code` | Reserved `run_code`; native capture remains absent | Visible end-capability bindings, including capture | Restore the transport, SDK, native absence, and instruction |
| `both` | Either native capture or its SDK binding | Visible native schemas plus `run_code` | Visible end-capability bindings, including capture | Restore both invocation routes and the instruction |

Tool mode controls presentation, not an execution allowlist. In code mode, an adapter or direct caller that emits the unadvertised `structured_output` name can still resolve the scoped end capability and takes the native one-stage commit path; a deployment that must forbid that route needs an execution guard.

An unrelated assembly listener may deliberately add another schema; named protection does not erase unrelated contributions.

#### Native commits once; Code Mode commits twice

The capture body validates and stages a cloned value by stable `ToolExecution` identity. The scoped final-result observer commits a native capture only if that exact execution's final result succeeds.

A schema-validation failure becomes the ordinary `INVALID_ARGS` tool result, so the model can correct the value and call the capture tool again within the same turn.

```text
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

For a Code Mode SDK call, successful inner observation records a pending value against the opaque outer `run_code` token. Commit waits for the outer transport's own successful final result because an inner side effect can succeed while the program or its post-policy still fails.

```text
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

Once capture is staged against an outer transport or committed, the scoped guard denies later calls in that response. After commit, `agent/turn-stop` ends the turn after ordinary continuation and steering fold. A child that otherwise completes cleanly without a committed capture returns an error rather than being re-prompted; requesting a schema makes output mandatory, not guaranteed.

### The run protocol separates acceptance, readiness, result, and disposal

`SubagentService.start()` returns synchronously, but `run.started` is the publication boundary. Callers treat the child as live only after readiness, consume `result`, and always dispose the run.

Pre-readiness cancellation of an in-process run deactivates the run-owner fiber, prevents publication, rejects `started`, resolves `result` as `aborted`, and emits neither subagent lifecycle edge.

`SubagentProvider` registration captures name, capability flags, the `inheritsParentContext` conversation-history descriptor, and the bound start callback once. The descriptor says whether completed parent turns seed the child's conversation; it says nothing about scope, services, tools, or authority.

Starting a run captures every request field once. Parent and abort signal remain identity references; prompt, filter, schema, and options are detached lossless JSON; fixed `persona` and absolute `maxDepth` values validate before backend ownership. The in-process backend separately snapshots its optional session seed, and the service snapshots the terminal result when it settles.

Depth validation repeats at each public entry while one helper owns the accepted domain:

```text
tool-subagent plugin load:
  assertSubagentMaxDepth(config.maxDepth)

SubagentService.start(request):
  capture and validate request.maxDepth

startInProcessRun(request):
  capture and validate request.maxDepth
  parentDepth = validated depthOf(parent)
  childDepth = parentDepth + 1
  reject if childDepth is not a safe integer
  reject if maxDepth exists and childDepth > maxDepth
```

Only `undefined` means parent depth zero. Present depth and cap values must be non-negative safe integers and must not be negative zero; derived overflow rejects even when no request cap exists.

The service does not expose the backend-owned run handle directly. It captures `id`, `started`, `result`, and methods once; binds methods to that handle; wraps result in one detached frozen record; and installs a shared disposal promise before calling untrusted backend cleanup. Once a callable backend disposer has been captured, a malformed later field triggers rollback; if no callable disposer exists, rollback is impossible and acceptance fails immediately. A backend disposer that directly returns the wrapper's reentrant promise is rejected as a cycle instead of hanging.

```text
startInProcessRun(backendContext, acceptedRequest):
  install backend ownership
  attach accepted abort signal
  create run-owner fiber under accepted parent.ctx
  create child through runOwner.ctx.agents with unpublished setup

  started = child creation publication
  result = after started:
    send accepted prompt
    await child idle
    derive owned terminal result
  dispose = dispose run owner and await quiescence

SubagentService.start(...):
  backendRun = backend.start(detached request)
  serviceRun = freeze accepted id, readiness, bound methods, normalized result
  observe result immediately
  after readiness:
    emit subagent/start, then buffered/eventual subagent/end
  on readiness failure:
    emit neither lifecycle edge
```

The service observes result settlement immediately even while readiness is pending, preventing an early rejection from becoming temporarily unhandled. Lifecycle listeners receive one frozen payload; their throws and returned-promise rejections are contained independently and cannot veto the run.

## Workflow integration preserves the subagent contract

The worker workflow bridge preserves the same readiness, terminal-claim, and bounded-cleanup boundaries across a message port. It never announces an unready child, never lets cleanup rewrite an already chosen result, and never suppresses disposal merely because another terminal fact already won.

The worker executes the workflow script and exchanges protocol messages; the host owns `SubagentService`, which invokes `SubagentProvider` backends and returns normalized run wrappers that the host retains. Their lifetimes follow dependency shape: an AgentLoop-created agent stops when its loop unloads, while a workflow run captures its holder-bound `SubagentService` at start, so unloading the workflow engine prevents new runs without revoking an already returned run.

Three state dimensions remain separate:

| Dimension | Question | Winning rule |
|---|---|---|
| Admission | May a worker message still start or announce a child? | Closed admission refuses the exact run and cleans it up |
| Terminal claim | Which external result does the workflow expose? | Earlier accepted external cancellation wins; otherwise first result/death claim wins |
| Physical cleanup | Which registered children and worker resources remain? | Every path may still dispose survivors through per-call gates |

### Child admission waits for readiness

After `SubagentService.start()` returns its normalized wrapper, the host registers that exact wrapper before awaiting, attaches result observers immediately, and rechecks admission both then and when `started` settles. A closed boundary claims cancellation and disposal for that exact entry, removes it only when disposal settles, and reports `ChildStartError` only while the worker reply channel remains open.

The backend's nested `start()` may synchronously reenter workflow cancellation before the service wrapper reaches the host registry. The immediate post-start check and exact-wrapper identity guard close that interval; a backend that later fulfills its own readiness cannot resurrect workflow admission.

```text
after subagents.start returns its run wrapper:
  register exact wrapper for cancellation
  observe and snapshot result immediately
  if admission closed: refuse and clean exact wrapper
  else await run.started

  on ready:
    if admission closed: refuse and clean exact run
    else send ChildStarted, then buffered/eventual outcome

  on readiness failure:
    send ChildStartError only if the worker reply channel remains open
    dispose exact wrapper if still registered
```

### Each terminal contender claims before its own callbacks

Each terminal path records the state it owns before invoking its own callback fanout. External `cancel()` records the accepted cancellation reason before invoking child cancellation. On the Result path, the worker queues its `Result` message before settlement cleanup messages on the same port, and the host records the winning result before any Result-triggered abort or cancellation. Reentry therefore observes the fact that already won instead of rewriting it.

```text
on workflow Result:
  cancellationWasAlreadyAccepted = external cancellation is in flight
  claim chosen result:
    if earlier external cancellation and result is not cancelled:
      cancelled result
    else:
      worker result

  if not cancellationWasAlreadyAccepted:
    abort shared child-request signal
    cancel every registered child through its at-most-once gate
  settle chosen result
```

The worker may also send a later `ChildCancel`; host fanout and the worker message share one per-call cancellation gate, so an arbitrary backend's `cancel()` need not be idempotent. Each callback is contained independently.

### Worker death, exit, and disposal remain separate

The first worker death signal closes message admission, claims a death result unless an earlier terminal fact won, cancels and disposes registered children, and synthesizes missing lifecycle ends. A queued message can arrive between Node's `error` and `exit`, so the logical admission barrier—not physical exit—prevents late child creation or narration.

Physical exit performs a final disposal-only sweep without repeating explicit cancellation. A cancellation grace period bounds how long the host waits for cooperative settlement before terminating the worker; a grace result can already be chosen while exit cleanup still needs to dispose surviving child handles. The bound is real: after grace expires, public disposal may return after invoking child disposal and reaping host resources even if a slow backend disposer has not reached quiescence.

Public `handle.dispose()` claims its shared promise before invoking cancellation or child callbacks. Each `disposeChild` likewise claims its call-ID promise before invoking the backend disposer. Public-first reentry joins the public promise; worker-first reentry lets the holder traversal join the already claimed child promise. Settled `dispose()` still drives a host-side reap before awaiting quiescence, so a fire-and-forget child cannot remain alive merely because workflow result settlement already occurred.

Together these rules ensure `workflow/agent-start` names only ready children, external result precedence is stable, and every surviving child reaches disposal.

## Correctness enforcement

The runtime rule is checked at four escape boundaries: API shape couples related subjects, TypeScript marks typed dispatch, development invariants inspect actual dispatch, and repository gates keep declarations aligned with enforcement.

### API shape couples values that must agree

`agentEvents(context, agent)` couples carrier, subject, and first event argument. `assembleContextFor(agent)` couples prompt facts with scope selection. `SessionStore.flush(session)` owns lookup of the carrier captured when the session entered.

```text
assembleContextFor(agent):
  return { agent, scope: agent }

agentEvents(context, agent):
  carrier = scopeTarget(agent, agent)
  return dispatcher that always injects agent as the event subject
```

These helpers make a mismatch harder to express than the correct spelling.

### Type markers cover every scoped event declaration

Scoped agent, approval, tool, prompt, session, and subagent lifecycle events declare a `Scoped<T>` receiver. TypeScript rejects a bare subject at typed dispatch sites, including subagent lifecycle events scoped to the delegating parent.

The marker is compile-time only; JavaScript, casts, and direct Cordis dispatch can bypass it.

### Development invariants inspect actual dispatch

The invariants plugin observes Cordis's internal dispatch before listener delivery. Every scoped event requires a marked carrier, and events whose arguments expose the subject require the carrier key to be the same object.

Session and subagent payloads do not expose their owner key directly, so their service centralizes key selection and the invariant proves carrier presence. Additional invariants reject an assembly whose `agent` and `scope` disagree and a turn opened before `agent/session-start`.

Dedicated `dsh-scope` unit tests cover the carrier's advanced Proxy behavior: private-field method binding, call/construct shape, primordial filter invocation, own-key/descriptor consistency, and explicit configurable definitions. These are implementation tests, not checks performed by the invariants plugin.

### Repository gates keep declarations and dispatchers aligned

`verify-scoped-dispatch` compares declared scoped events with the runtime invariant table, and the generated event matrix requires every declaration to name a recognized dispatcher. Source JSDoc generates the [event catalog](../../../cordis-catalog/events.md), which remains the exhaustive signature and mode reference.

## Alternatives considered

The rejected designs fail one of the four governing questions: they separate visibility from ownership, choose the wrong isolation unit, expose partial lifecycle, leave accepted values mutable, or rely on extension order for invariants.

### Pass an agent option to every registration

An API such as `tools.register(definition, { agent })` leaves global registration as the leak-by-omission default and repeats scope plumbing in every registry. It can also express “visible to A, disposed with unrelated plugin B,” which `agent.ctx` prevents.

### Filter events while keeping registries global

Listener filtering prevents a hook from intercepting the wrong agent but does not scope tool schemas, executable lookup, prompt sections, variables, or Code Mode bindings. Persona, tool filtering, and concurrent structured schemas would still require global mutation.

### Create one isolated service graph per agent

Service isolation chooses one registry instance, while agent composition needs a merged view of deployment globals plus one agent layer. Per-agent graphs duplicate adapters and force shared persistence and UI infrastructure to discover every instance.

Independent applications still deserve separate graphs; collaborating agents inside one deployment do not.

### Inherit the parent's registrations into a child

Hierarchical registration inheritance silently copies every parent-scoped tool and policy into the child. A flat child layer plus a parent-owned disposer separates lifetime from composition: the parent owns the child without importing its registrations.

This choice does not create a parent-subset authority guarantee; registration scope and authorization are different designs.

### Publish the agent before running setup

Early publication lets setup find the agent in global registries but lets observers act on a partially configured world. Rollback can remove entries but cannot retract external effects from listeners that already ran.

The unpublished setup callback already receives `agent.ctx` and `ctx.agent`, so early global lookup is unnecessary.

### Allow only synchronous setup

Synchronous setup cannot honestly compose child plugins whose activation is asynchronous. TypeScript also permits a promise-returning callback where a void return is expected, so a synchronous-looking type would not reliably contain accidental async work.

Awaited setup makes the transaction explicit and keeps first publication and prompt assembly behind it.

### Validate caller data, then clone it

Validation followed by a separate clone rereads accessors, so it can approve one value and retain another. A generic JSON clone can also erase or coerce exotic prototypes and unsupported values. The lossless-JSON traversal validates and materializes one captured value in the same operation.

### Enforce invariants with prepended waterfall listeners

A prepended listener is not permanently outermost: another plugin can prepend later, a short-circuit can skip inner work, and an outer wrapper can replace a downstream result. The same defect appears in prompt assembly, tool decisions, result commit, and turn continuation.

The four owner-final APIs express the exact one-way power required: restore named canonical data, deny monotonically, observe immutable final outcome, or stop after ordinary continuation folding.

### Put agent-scope policy inside vendored Cordis

Cordis already supplies derived contexts, effect ownership, and receiver-based filtering. The harness-level primitive composes those domain-neutral mechanisms rather than teaching Cordis about agents, tools, prompts, or global-plus-agent merge rules.

The lifecycle hardening remains correctly inside Cordis because effect pre-registration, parent ownership before child publication, and rejection of late effects protect every plugin under reentrant hot reload, not only agent scopes.

## Consequences

The design buys one composition model across data, behavior, and lifetime. Its cost is per-scope state, transactional lifecycle machinery, owned runtime snapshots, disciplined dispatch, and four deliberately narrow owner-final APIs.

### Benefits

The main benefit is that plugin authors change context, not API. Registries and dispatchers then apply the same agent key across presentation, execution, observation, and cleanup.

- Global plugins remain deployment-wide contributors and observers.
- Per-agent tools, prompt state, restrictions, and listeners use ordinary registration methods through `agent.ctx`.
- Model-visible schemas, executable lookup, Code Mode bindings, policy, and UI presentation resolve from one agent view.
- Create and resume expose no partially configured registry entry, while caller and AgentLoop ownership cover every await and rollback path.
- Agent teardown preserves the session and scoped listeners through loop exit and final flush, then releases IDs only after scope quiescence.
- Structured output composes independently per child without global mutation or middleware-order assumptions.

### Costs and constraints

The costs correspond to the four governing questions rather than one hidden framework abstraction.

- **Registration and delivery:** registries maintain global and per-scope state; every scoped dispatcher must carry the real subject's key; the carrier is proxy-shaped and not identity-equal to its subject.
- **Lifecycle:** programmatic `create()` and `resume()` are asynchronous; caller sentinels, AgentLoop trackers, reservations, publication barriers, and shared quiescence promises cover construction and teardown races.
- **Boundary ownership:** public values are copied, frozen, bound, or retained by identity at their acceptance boundary; data that the boundary's owned representation cannot preserve fails instead of being coerced.
- **Owner-final policy:** prompt protection can reserve names, guards can only deny, final result observers cannot transform, and terminal stop may discard steering.
- **Flat scope:** a desired child-local contribution must be global or registered explicitly for the child; parent ownership alone does not import registrations.
- **Code Mode:** `run_code` remains protected transport infrastructure, so policy that forbids programs denies execution rather than removing the transport from an SDK-based prompt.

The direct no-setup `ctx.agentLoop.create()` path remains synchronous for configuration and callers that already have complete options. Programmatic registry create/resume use the full unpublished transaction.

### Deliberate boundaries

The decision applies registration scope to tools, prompt state, scoped events, sessions, approvals, and in-process subagent composition. `agent.ctx` does not automatically scope every service call; filesystem policy, LLM interception, background subagent state, and other registries retain their existing subject or policy seams until their own designs adopt the rule.

Security hardening remains separate work. This design does not sandbox same-process plugins, derive child authorization from a parent, freeze a grant set at agent creation, or introduce generic capability/output/termination tags. Those requirements need an explicit authority model rather than additional meaning attached to registration scope.
