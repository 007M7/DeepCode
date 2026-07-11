# RFC: The agent is a registration scope

Status: implemented

## Problem

The harness runs multiple agents inside one application, but those agents need different capabilities and policies. A child created to summarize a file may need a different persona, a smaller tool set, and listeners that govern only its work; applying those contributions to every agent would leak authority and couple otherwise independent runs.

This is not the same problem as running several isolated applications. The agents intentionally share the deployment's model adapters, persistence backend, tool implementations, and other services. What varies is the view assembled for one agent and the policy attached to its activity.

The affected extension surfaces include both data and behavior:

| Surface | Per-agent need | Failure when global |
|---|---|---|
| Tools | Hide dangerous or irrelevant tools; add a child-only result tool; replace one implementation for one agent | The model sees excess authority, or a child-specific tool leaks into every prompt |
| Prompt sections and variables | Give a child its own persona or runtime facts | Every agent receives the same instructions or values |
| Event listeners | Apply a hook, guard, or continuation policy to one agent | A listener written for one agent can veto or mutate another agent's work |
| Lifetime | Remove all of the above when the agent ends | Manual cleanup misses failure, cancellation, hot-reload, or owner-teardown paths |

The model-visible and executable views must also agree. Hiding a tool only from the prompt is not a security boundary if a generated call can still execute it; hiding it only from execution produces a prompt that advertises unusable capabilities. The same consistency requirement extends to Code Mode bindings and user-interface presentation.

The subagent API exposes the practical gap. A provider can accept a child persona, a tool filter, and a structured-output schema, but those options are honest only if two concurrent children can receive different registrations without mutating shared global state.

## Decision

Each live agent owns a registration context named `agent.ctx`. Registering through the application's ordinary plugin context contributes globally; registering through `agent.ctx` contributes to that agent alone and ties the contribution's lifetime to the agent.

The rule is intentionally small enough to be the normal plugin-author mental model:

| Registration context | Visibility | Lifetime owner |
|---|---|---|
| Ordinary plugin context | Every agent | The registering plugin |
| `agent.ctx` | Exactly that agent | That agent |

The scope is flat. A child does not inherit registrations from its parent's scope; parent/child lineage remains explicit session data. A child sees the deployment-global layer plus its own layer, which prevents accidental authority inheritance through an agent tree.

This decision is implemented by the [`dsh-scope` primitive](../../../../packages/core/scope/README.md), scope-aware tool and prompt registries, scope-filtered event dispatch, and an agent lifecycle that creates and destroys the entire scoped world as one ordered operation.

## Background: the Cordis concepts used by the design

The implementation reuses four Cordis mechanisms. Readers do not need Cordis internals beyond this section; the [Cordis primer](../../../cordis-primer.md) is the broader reference.

### Contexts provide services

A Cordis context is the object through which a plugin reaches shared services such as `ctx.tools`, `ctx.systemPrompt`, and `ctx.sessions`. A service call retains the context used to access it, so a registry can tell whether a registration came through an ordinary plugin context or through an agent's context without adding a scope argument to every method.

Contexts also represent a capability view. A derived context can reach only the services made available by the plugin that created it. Handing out `agent.ctx` therefore hands out the agent loop's injected service surface, a deliberate part of the `Agent.ctx` contract rather than an ambient root context.

### Effects own registrations

Registrations are Cordis effects: adding a tool, prompt section, or listener returns cleanup behavior owned by the context's runtime unit, called a fiber. Disposing a fiber unwinds all effects registered through it, which is the basis for hot reload and reliable cleanup.

`dsh-scope` creates a no-op plugin fiber for each scope. The fiber contributes no behavior of its own; it exists to provide one lifetime bucket for everything registered through the scoped context.

### Event dispatch can filter listeners

Cordis decides which listeners receive an event by inspecting the object used as the dispatch receiver, known as the event's `this` value. `dsh-scope` supplies a receiver with a filter: unscoped listeners are admitted for compatibility, while a scoped listener is admitted only when its key matches the event's subject.

### Disposal order requires explicit nesting

Cordis may dispose sibling effects concurrently. When order matters, a generator effect yields the exact disposer functions to create a nested last-in-first-out chain; wrapping a disposer in another function breaks the identity Cordis uses to remove it from the concurrent sibling set.

This detail drives both `Scope.rawDispose` and the convention that registry `register` methods return their exact Cordis disposer. It is what lets agent teardown wait for the loop, then unregister the agent, then detach the session, rather than racing those operations.

## Scope model

The scope primitive joins visibility and ownership while remaining independent of the agent packages. This lets lower-level packages such as sessions and prompt assembly participate without depending upward on the agent loop.

### One registration fact controls two properties

The decisive fact is which context performed a registration. The scope tag selects its visibility layer, and the same context's fiber owns its disposal.

Keeping those properties coupled prevents a dangerous state such as “visible to agent A but disposed with unrelated plugin B.” An API shaped as `register(value, { agent })` would make that state expressible and would retain global registration as the easy-to-forget default.

### Scope keys are opaque identities

A scope key is an object compared by identity, not a string or database identifier. The harness uses the live `Agent` object as its own key, so event payloads and execution records that already carry an agent can select the right scope without translating through another registry.

Object identity decouples a live scope from externally meaningful or sequentially reused string IDs. The key is meaningful only during the live agent's lifetime.

### The primitive has four responsibilities

The public API is small; the package README carries the exact signatures.

| Responsibility | Mechanism |
|---|---|
| Create an ownership bucket | `createScope(context, key)` mounts the no-op fiber and returns its derived context |
| Read the registration layer | `scopeOf(context)` reads the nearest inherited scope tag |
| Filter event delivery | `scopeTarget(subject, key)` creates the dispatch carrier |
| Tear down in a larger ordered lifecycle | `Scope.rawDispose` exposes the exact fiber disposer |

Derived contexts inherit the tag, and a nested scope replaces it with the nearer key. This allows `agent.ctx.plugin(...)` to build a reusable profile whose registrations remain scoped to the same agent.

### Scoping is explicit at each seam

The scoped context automatically supplies effect ownership, but it does not magically change every service operation. A scope-aware registry must read `scopeOf()` when registering, and a scope-filtered event dispatcher must provide a carrier naming the operation's subject.

Read and execution operations select their subject explicitly: callers use `tools.schemas(agent)`, `tools.get(name, agent)`, `tools.execute({ agent, ... })`, or `systemPrompt.assemble({ scope: agent, agent })`. Calling `agent.ctx.systemPrompt.assemble()` with an empty assembly context still asks for the global layer. This separation lets a shared service operate on behalf of any agent while making the subject visible at the call site.

## Registration resolution

The tool and system-prompt services each keep a global layer plus a map of per-scope layers. Resolution combines only the global layer and the requesting agent's own layer.

### Scoped names shadow global names

For named contributions, the scoped definition wins over a global definition with the same name. Duplicates inside one layer still fail loudly.

Shadowing is what makes a child persona ordinary configuration: the system-prompt service owns a global `deployment:persona`, and a child registers another section with that name through its context. The same rule supports a per-agent implementation of a model-facing tool without renaming the tool.

Tool-schema providers are additive rather than named, but a provider registered through `agent.ctx` is consulted only for that agent's assemblies. Prompt variables use the same named-shadowing rule as sections and tools.

### Restrictions mask global tools; scoped tools are explicit grants

`agent.ctx.tools.restrict({ allow, deny })` filters the global tool layer for that agent. `allow` keeps only listed names, `deny` removes listed names, and multiple restrictions intersect so independently installed policies can only reduce the global surface.

Restrictions do not remove tools registered in the agent's own layer. A scoped tool is an explicit grant, which is necessary for facilities such as a child's `structured_output` capture tool to remain available under a restrictive allow-list.

The restriction snapshots its arrays when registered, validates every named tool against the current pre-restriction universe, and rejects an empty filter. These choices make configuration mistakes loud and prevent later caller mutation from changing a live policy.

An out-of-view tool resolves exactly like an unregistered tool and returns `UNKNOWN_TOOL` if called. This avoids exposing whether a hidden global implementation exists.

### One visibility function feeds every consumer

The tool registry defines one canonical `visible()` rule and every consumer uses it for prompt schemas, lookup, execution, Code Mode's generated SDK and bindings, timeout-policy lookup, Cordis inspection, and ACP presentation. A model cannot be shown one definition while execution or the UI resolves another.

Code Mode introduces one intentional distinction. A restriction is per-agent runtime state, so a globally configured `toolOrder` may name a restricted-away tool and simply leave an empty position for that agent. By contrast, `mode: 'code'` is deployment configuration that deliberately collapses the wire-visible universe to `run_code`; a `toolOrder` that still names native tools is invalid configuration and fails every assembly.

To preserve this distinction, a prompt tool provider returns both the post-restriction schemas and the pre-restriction `knownNames` universe. Ordering validates names against the latter but orders only the former.

## Scoped event delivery

Registrations alone are insufficient: a listener installed for one agent must hear only events about that agent. Scoped dispatch applies that rule while preserving the existing behavior of global plugins.

### Delivery is global-plus-matching-scope

For an event about agent A, the dispatch carrier admits ordinary unscoped listeners and listeners registered through A's context. It rejects listeners registered through every other agent context.

A subject-less dispatch, such as an agent-less tool execution or a bare session created outside an agent scope, admits only unscoped listeners. Cordis's explicit `{ global: true }` listener option still bypasses filtering for infrastructure that intentionally observes everything.

Events about registry membership stay unfiltered. A notification that a tool or provider was added concerns shared registry state rather than one agent's activity, so scoped subscribers to `tools/change`, `system-prompt/change`, or `subagent/provider-*` still hear the global notification.

### Each event family has one scope source

The event subject determines the key; callers do not choose an unrelated scope.

| Event family | Scope key |
|---|---|
| `agent/*` | The event's agent |
| `tools/pre-execute`, `tools/execute`, `tools/post-execute` | `execution.agent`, or no key for an agent-less call |
| `system-prompt/assemble` | The assembly context's scope |
| `session/created`, `session/event`, `session/flush` | The owner scope captured when the session enters the store |
| `subagent/start`, `subagent/end` | The delegating parent agent |

Agent events use `agentEvents(context, agent)`, which creates the carrier and injects the same agent as the first event argument in one operation. Prompt assembly similarly uses `assembleContextFor(agent)` to set both the human-friendly `agent` field and the scope selector. These fused helpers make a mismatched carrier and subject difficult to express.

The session store captures its carrier when a session is entered because later appends and flushes may originate from code that no longer has the agent's context in hand. `ctx.sessions.flush(session)` is the only durability-checkpoint entry point, so callers cannot forget the captured carrier.

### The carrier is method-transparent

Cordis passes the dispatch carrier to a function-style listener as `this`. Agent event declarations allow a listener to call methods such as `this.send(...)`, so the carrier must behave like the real subject rather than merely look like it.

The carrier is a JavaScript proxy whose property reads use the real subject as receiver and whose methods are bound to that subject. This matters for classes with native private fields: calling a method with the proxy itself as receiver would throw because the proxy does not possess the class's private-field identity.

The proxy preserves the subject's own event filter, writes through to the subject, returns the real constructor, and obeys JavaScript's invariants for frozen own properties. Its object identity is intentionally not transparent; the actual subject is also present in event arguments whenever identity matters.

`Scoped<T>` is a TypeScript-only marker requiring a carrier at scoped dispatch sites. It adds no runtime behavior; runtime carrier marks and development invariants provide the corresponding check for JavaScript and casted code.

## Agent creation and teardown

An agent's scope, session, registry entry, and driver loop form one lifecycle. Creating them inside one composite effect gives both rollback on partial construction and deterministic teardown on every ownership path.

### Creation has a deliberate composition window

Agent creation proceeds in this order:

1. Construct the live agent object.
2. Mint its scope and assign `agent.ctx`.
3. Enter the session through `agent.ctx`, capturing the session's carrier.
4. Announce `session/created`.
5. Register the agent, which announces `agent/created`, so setup code can resolve it.
6. Run `CreateAgentOptions.setup(agentCtx)` to compose scoped tools, prompt contributions, restrictions, listeners, or child plugins.
7. Emit `agent/session-start`.
8. Start the driver loop.

The setup callback runs inside the storage rollback boundary and before the first prompt assembly. A synchronous throw removes the agent and session and unwinds every scoped registration, so no half-created entry keeps either ID occupied.

The two creation notifications occur before setup. Observers can therefore see the pre-setup world, and listeners installed by setup do not receive this agent's `session/created` or `agent/created`; rollback cannot retract external side effects those earlier listeners performed. This is a current atomicity limitation, not a guarantee provided by the setup window.

Setup performs direct synchronous registrations but does not drive the agent. Calling `send`, `steer`, or `inject` there could open a turn before `agent/session-start`, reversing a lifecycle contract used by bridges and hooks; development invariants report that misuse at the first `turn/start`. Mounting an asynchronously activating child plugin also does not extend the synchronous setup window unless its activation ordering is separately awaited.

### Teardown waits for one quiescent boundary

The yielded disposers produce this teardown order:

1. Request the loop to stop and await its actual exit, including its closing session events and durability flush.
2. Unregister the agent.
3. Detach the session from the store.
4. Unwind the scope's listeners and registrations.

Detaching the session before the asynchronous scope unwind keeps registry and store rollback synchronous on construction failures. Scoped listeners remain installed through the stop-and-drain phase, so they hear the final flush before the session detaches.

Cordis disposers are single-shot but a second call does not necessarily await a first call already in progress. The agent lifecycle therefore owns a shared completion promise in addition to the raw disposer. Tool cleanup, parent teardown, explicit `AgentHandle.dispose()`, and owner-fiber unload all await the same fully quiescent result.

Every registry returns its exact effect disposer so the composite lifecycle can preserve this order even when the whole owner fiber unloads. Returning a wrapper would leave the inner registration as a concurrently disposed sibling and could emit `agent/disposed` while the final turn was still draining.

## Subagent composition

The subagent seam demonstrates why agent scoping exists: a provider can compose a child-specific world with ordinary registrations and let the agent lifecycle own it.

### Persona and tool filters become real capabilities

The in-process spawn and fork providers advertise persona and tool-filter support because their child setup can register a shadowing `deployment:persona` section and a tool restriction through the child's context. ACP remains honest about not supporting those capabilities because it delegates to a separate process whose registration context is not locally available.

Omitted configuration stays absent. This matters for schema-driven configuration: a materialized empty `allow` list means “allow nothing,” which is not equivalent to an omitted list, and an empty filter is not equivalent to no filter. The configuration schema preserves those distinctions before setup calls `restrict`.

### Parent disposal owns the subtree

After creating a child, the in-process driver registers the child's memoized disposer as an effect on the parent scope. Disposing a parent therefore reaches the whole descendant tree even if the delegating tool's `finally` block never runs.

This is structured concurrency expressed through ownership rather than through scope inheritance. The child still has a flat capability view—global plus child-only registrations—while its lifetime is linked explicitly to the parent.

### Structured output becomes per-child state

A structured child registers a real-schema `structured_output` tool and its instruction section through its own context. Concurrent children can carry different schemas because each resolves only its own tool definition; no placeholder global schema, reference count, or strip-for-other-agents pass is needed.

Four scoped listeners enforce the terminal protocol:

1. An outer prompt-assembly listener reasserts the exact tool schema and instruction after downstream listeners have run. It replaces an existing tool in place, appends it when absent, removes duplicates, and restores the instruction to its order-190 section band.
2. A tool pre-execution listener denies calls after a value has been captured, preventing later side effects in the same model response.
3. A tool post-execution listener commits a staged value only if the final pipeline decision accepts that same execution.
4. A turn-continuation listener stops the child after capture instead of spending another model step merely because a tool ran.

Staging is keyed by the `ToolExecution` object's identity in a `WeakMap`, not by the model or adapter's call ID. Only the pipeline trip whose tool body staged a value can commit it; a blocked trip cannot leave state that a later call with a reused ID accidentally promotes. The weak key also allows an abandoned stage to be reclaimed without global cleanup bookkeeping.

## Correctness enforcement

Scoping errors are dangerous because a missed carrier silently restores global delivery. The implementation therefore makes the safe path short and checks it at type, runtime, test, and documentation boundaries.

### Compile-time and API shaping

Scoped event declarations require the `Scoped<T>` carrier marker. `agentEvents` couples carrier creation to the agent argument, `assembleContextFor` couples agent prompt facts to the scope selector, and session flush is a service method that owns carrier lookup.

These TypeScript checks improve authoring but are not treated as a security boundary: JavaScript callers, casts, and hand-written dispatches can bypass them.

### Development-time invariants

The invariants plugin observes Cordis's internal dispatch seam. For every scope-filtered event it verifies that a carrier exists and, where the subject is present in the arguments, that the carrier key is the same object. Session and subagent lifecycle payloads do not expose the owner key, so their runtime check proves carrier presence only; the session store and subagent service centralize the dispatch spelling that selects the key. The plugin also rejects an assembly context whose `agent` and `scope` fields disagree and a setup callback that opens a turn before `agent/session-start`.

The invariant checks run before listener delivery, so a violation points at the dispatching call site instead of appearing later as cross-agent behavior.

### Drift gates and focused tests

`verify-scoped-dispatch` compares the runtime invariant table with the event declarations marked as scope-filtered. The generated event matrix also rejects a declared event with no recognized dispatcher, preventing helper-shaped calls from disappearing silently from the architecture documentation.

Focused tests cover scoped visibility, shadowing, restrictions, carrier transparency, setup rollback, teardown order, shared quiescence, session delivery, structured-output tamper recovery, stale-stage isolation, Code Mode bindings, and parent-child disposal. The [events catalog](../../../cordis-catalog/events.md) remains the exhaustive event contract rather than being duplicated here.

## Alternatives considered

The alternatives below solve only part of the problem or separate visibility from ownership, which would make safe composition harder to reason about.

### Pass an agent or scope option to every registration

An API such as `tools.register(definition, { agent })` makes global registration the leak-by-omission default and requires every registry to invent parallel scope plumbing. It also lets visibility point at one agent while cleanup belongs to an unrelated context.

The chosen design leaves existing registry signatures unchanged and uses the calling context as the single source of both facts.

### Create an isolated service instance per agent

Cordis isolation selects one service instance for a context. Agent composition needs a merged view—deployment-global tools plus one agent's additions—not a choice between two independent registries.

Per-agent service instances would require delegating merge registries for every scoped service and would force single-subscription infrastructure such as persistence and ACP to discover and subscribe to each new instance. Isolation remains the right bulkhead for co-hosting independent applications, not for agents collaborating inside one application.

### Filter events but keep registries global

Listener filtering prevents a hook from intercepting the wrong agent, but it does not scope the model-visible tool schemas, prompt sections, variables, or executable tool lookup. Persona, tool filtering, and concurrent structured-output schemas would remain impossible or require ad hoc mutation.

### Add first-class scope support to vendored Cordis

Cordis already exposes the primitives needed for this design: derived contexts, effect-owning plugin fibers, and listener filtering through the dispatch receiver. Modifying the vendored framework would add synchronization and maintenance cost without providing an additional harness capability.

### Give each subsystem a separate per-agent API

Tool filters, prompt profiles, listener predicates, and session routing can each be implemented independently. That approach multiplies concepts, cleanup paths, and opportunities for the views to disagree.

The shared scope primitive gives every subsystem the same answer to “which agent sees this?” and “when does it go away?” while letting each registry retain its own domain-specific resolution rules.

## Consequences

The design adds one central concept and some low-level implementation machinery. In return, it makes per-agent composition ordinary, leak-resistant, and lifecycle-safe.

### Benefits

- Plugin authors use the same registration APIs globally or per agent; only the context changes.
- An agent's prompt, executable tools, Code Mode bindings, policy listeners, and UI definitions resolve from the same scoped view.
- Agent disposal revokes its registrations automatically, including failure and hot-reload paths.
- Subagent persona, tool filtering, structured output, and parent-owned teardown compose without global mutation.
- Existing unscoped plugins remain global observers and contributors, preserving the deployment-wide extension model.

### Costs and constraints

- Every agent-subject event dispatcher must carry the correct scope; types, fused helpers, invariants, and gates exist because omission would otherwise fail open to global delivery.
- `agent.ctx` is a capability-bearing context. The loop plugin's injected service set determines what holders can reach.
- Scoped registry layers consume memory for the agent lifetime and add a two-layer resolution step, then disappear on scope disposal.
- The dispatch carrier is proxy-shaped and not identity-equal to its subject, even though property access and method calls are transparent.
- Restrictions are flat and apply only to the global tool layer; scoped registrations are deliberate grants, and parent scopes do not confer capabilities on children.
- The generic `Scope.dispose()` and `ScopeHost.dispose()` normalize Cordis's single-shot disposer but do not give racing callers a shared quiescence promise; the agent lifecycle adds that stronger boundary itself.
- Setup is a synchronous contract, but its current `(Context) => void` TypeScript shape accepts an `async` function and the runtime does not inspect the returned promise; asynchronous setup can escape rollback and race the first assembly.

### Deliberate boundaries

The primitive is general, but this decision scopes only the surfaces needed for coherent agent composition. Per-agent filesystem policy, LLM adapter selection, named profile registries, and background subagents can build on the same context without changing the core scope model.
