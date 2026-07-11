# RFC: The agent is a registration scope

Status: implemented

## Problem

One application can run many agents that share infrastructure but need different capabilities and policy. A child may have its own persona, tool set, structured-output schema, and listeners while still using the deployment's model adapters, persistence, and UI.

Neither a global registry nor a separate service graph per agent fits that shape. Global registration leaks child-specific behavior; independent graphs duplicate shared services and make cross-agent infrastructure harder to compose.

The model-visible, executable, and observable views must agree. A hidden tool must not remain callable, an advertised tool must execute through the same scoped definition, and policy intended for one agent must not intercept another. The registrations must also disappear only after their agent reaches quiescence.

Some owner rules cannot depend on middleware order. Prompt assembly, tool policy, result transformation, and continuation are extensible waterfalls, so another listener can wrap, replace, or short-circuit ordinary listeners. Structured output and reserved transport need service-owned final boundaries.

## Decision

Each live agent owns a Cordis registration context, `agent.ctx`. Registering through a plain plugin context contributes to the deployment; registering through `agent.ctx` contributes only to that agent and is disposed with it.

The design has three parts:

| Part | Contract |
|---|---|
| Registration scope | Resolve the global layer plus exactly one agent layer; the registration context determines both visibility and ownership. |
| Lifecycle transaction | Compose the scope while the agent and session are unpublished, then publish through an ordered rollback-covered sequence. |
| Owner-final policy | Services provide narrow final boundaries for canonical prompt entries, monotonic tool denial, authoritative results, and terminal turn stopping. |

Scopes are flat. A child does not inherit its parent's scoped registrations; parentage is explicit session data, and an ownership link controls lifetime without granting authority.

The public contracts live in [`dsh-scope`](../../../../packages/core/scope/README.md), [`dsh-agent`](../../../../packages/core/agent/README.md), [`dsh-system-prompt`](../../../../packages/core/system-prompt/README.md), and [`dsh-tools`](../../../../packages/core/tools/README.md). The generated [event catalog](../../../cordis-catalog/events.md) is the signature reference.

## Registration scope

### Context selects visibility and ownership

A Cordis context is both a service view and the origin of effects such as tool registration, prompt contribution, and event subscription. `createScope(ctx, key)` mounts an ownership fiber and returns a derived context tagged with an opaque `ScopeKey`; derived contexts inherit the nearest tag.

| Registration origin | Visible to | Disposed with |
|---|---|---|
| Plain plugin context | Every agent | Registering plugin |
| `agent.ctx` | That agent | Agent scope |

This coupling prevents a registration from being visible to one agent but owned by an unrelated lifecycle. The live `Agent` object is its scope key, so operations that already carry the agent need no secondary string lookup.

`agent.ctx.agent` is a convenient association, not the generic scope tag. Lower-level services use `scopeOf(context)` because a nested scope may replace the nearest key while retaining inherited context properties.

The scope exposes two disposal forms. `rawDispose` is the exact Cordis disposer required when nesting a scope at a precise generator-effect position; `dispose()` is the idempotent promise ordinary callers use to await the backing fiber's quiescence, including a race started through `rawDispose`.

### Registries retain domain-specific merge rules

The scope primitive selects a layer but does not prescribe how a service combines it. Named tools, prompt sections, and variables use scoped-over-global shadowing; tool-schema providers are additive within the selected view. Duplicate names in one layer fail.

Reads name their subject explicitly. Prompt assembly receives an `AssembleContext.scope`; tool lookup, visibility, execution, timeout policy, Code Mode bindings, inspection, and presentation receive an agent or scope. Merely calling a read method through `agent.ctx` does not silently choose a subject.

Tool restrictions mask global end capabilities for one agent, and multiple restrictions intersect. Tools registered in the agent's own layer are explicit grants. A hidden global tool behaves as unknown at execution.

Code Mode's `run_code` is reserved transport rather than an end capability. It remains outside the filterable layers so a restriction cannot leave an SDK in the prompt without its only transport. The registry resolves restricted globals plus scoped grants, then adds the transport in non-native modes; every registry-owned view consumes that same result.

### Scoped events use the operation's subject

A scoped event reaches global listeners and listeners registered through the matching agent context. It never reaches another agent's listeners. Cordis's explicit `{ global: true }` option remains the intentional bypass.

The dispatch receiver carries the scope key and is exposed as `this` to function listeners. Each event family derives the key from its real subject rather than accepting an independent caller-supplied scope:

| Event family | Scope source |
|---|---|
| `agent/*` | Event agent |
| `approval/request` | `request.agent` |
| Tool execution events | `execution.agent` |
| `system-prompt/assemble` | `AssembleContext.scope` |
| Session events and flushes | Owner captured when the session enters the store |
| `subagent/start` and `subagent/end` | Delegating parent |

Registry-membership notifications remain unfiltered because they describe shared registry state rather than one agent's operation.

The receiver is a proxy over the subject. Property access and writes reach the subject, and methods bind to the subject so classes with private fields work; the proxy is intentionally not identity-equal to it. Event arguments carry the real object where identity matters. `Scoped<T>` marks the required receiver at typed dispatch sites, while runtime marks and development invariants cover JavaScript and casts.

## Agent lifecycle transaction

### Setup finishes before publication

Create and resume reserve both agent and session IDs before any await, snapshot caller-owned options and setup inputs, construct the agent, mint its scope, and install the teardown skeleton. Resume also races persistence loading against owner disposal so a late backend result cannot publish after its owner is gone.

The optional `setup(agentCtx)` callback runs while neither the session nor the agent is globally visible. It may register scoped contributions or await child-plugin activation. A rejection, owner unload, or failed liveness check unwinds the complete unpublished world and releases both IDs.

Setup code can reach the unpublished agent through `agentCtx.agent`, but the driver cannot accept work until publication enables its private controls. This keeps the first turn behind the lifecycle boundary without publishing a partially configured agent.

### Publication is ordered and rollback-covered

After setup, publication runs synchronously in this order: enter the session store, enter the agent registry, announce `session/created`, announce `agent/created`, enable driving, emit the contained `agent/session-start` notification, and start the loop.

Both registry entries exist before creation listeners run. The sequence is not atomic: observers run during it, and rollback cannot retract effects they already performed. A throwing creation listener causes the owned transaction to unwind; failures from the non-vetoing session-start notification are reported without preventing loop startup.

### Teardown preserves the scoped world until work settles

Every owner path stops and awaits the driver and agent-started durability checkpoints, removes the agent, detaches the session, then unwinds the scope. Final session events and flushes therefore still see the session and scoped listeners. `AgentHandle.dispose()` and `Scope.dispose()` give racing callers shared quiescence boundaries.

In-process subagents add a run-owner fiber under `parent.ctx`. This makes the parent own the child lifecycle without merging the parent's scoped capabilities into the child's new flat scope.

## Owner-final policy

Ordinary waterfalls remain the extension mechanism. The following service-owned boundaries are reserved for invariants whose result must not depend on listener order:

| Boundary | Guarantee |
|---|---|
| `systemPrompt.protect()` | After the assembly waterfall, restore the canonical presence, definition, and local anchor of named sections or schemas. Canonical absence is protected too. |
| `tools.guard()` | After pre-execute policy, guards may deny or abstain but cannot allow, so denials compose monotonically. |
| `tools/result` | After execution, post-processing, error normalization, and JSON validation, notify observers of one immutable authoritative outcome. Observer failures are contained independently. |
| `agent/turn-stop` | After ordinary continuation and steering folding, a strict serial stop is terminal through turn close and flush; it discards steering but preserves queued prompts. |

Prompt protection is narrow rather than a whole-assembly reset. It removes protected names from the transformed result and reinserts canonical entries near their surviving canonical neighbors; unrelated contributions remain extensible. A globally protected section name cannot be shadowed by a scoped section. Code Mode protects its SDK section and `run_code`; structured output protects its capture instruction and schema.

Tool execution identity supports the final-result boundary. The registry snapshots lossless-JSON arguments into a distinct execution, assigns an opaque frozen token, and makes identity fields immutable before policy. Only `signal` remains replaceable by around-dispatch wrappers. Nested transports carry the parent's token, not its live execution object.

`tools/result` is a live registry notification and also fires for programmatic execution. The singular `tool/result` session event is the durable transcript record appended later by the loop. Consumers choose the live final verdict or persisted history according to their contract.

`agent/turn-stop` has stronger authority than ordinary continuation and is intended only for terminal protocols. `undefined` is its sole abstention value; malformed returns and listener failures end the current turn as errors. Once stopped, steering added during turn close or flush cannot create another step or fallback turn.

## Subagent composition

The in-process spawn and fork providers build a child through the unpublished setup transaction. Spawn uses an empty session; fork seeds only the parent's balanced completed-turn prefix, excluding the currently open tool-call turn.

Provider definitions and accepted requests are snapshotted before asynchronous creation. Identity capabilities such as the parent and abort signal are retained; mutable options, filters, seed events, schema, and prompt are detached. One run-owner fiber coordinates provider unload, parent teardown, manual disposal, and cancellation during creation.

`SubagentRun.started` separates acceptance from publication. It resolves only after the child is in the agent registry and rejects if rollback prevents publication. Lifecycle notifications and workflow bridges wait for this boundary, while attaching result handlers immediately so an early settlement is not unhandled.

Persona, tool restriction, and structured output are ordinary registrations installed through the child's context during setup. The child's scope owns them and prevents concurrent children with different schemas or policy from interacting.

### Structured output is a terminal protocol

A structured child receives a scoped `structured_output` tool with its actual schema and a protected prompt instruction. Native mode exposes the tool directly; Code Mode exposes it through the protected SDK and `run_code` transport; both mode offers both paths.

The capture tool validates and stages a cloned value by immutable `ToolExecution` identity. A scoped `tools/result` observer commits it only if that execution's authoritative result succeeds. For a Code Mode sub-call, the value remains pending until the enclosing `run_code` token also reaches a successful final result, so an inner success cannot survive outer runtime or policy failure.

Once a value is pending or committed, a scoped guard denies later calls. After commit, a scoped turn-stop ends the child turn after ordinary continuation has settled. A child that finishes without a committed capture returns an error; the provider does not re-prompt it.

## Correctness enforcement

Scope selection would otherwise fail open to global-only behavior, so the contract is checked at several boundaries:

| Boundary | Check |
|---|---|
| API | Helpers couple the payload subject to the dispatch carrier; stores capture subjects they must use later. |
| Type system | Scoped event declarations require `Scoped<T>` receivers. |
| Runtime | Development invariants require marked carriers and compare keys with exposed subjects. |
| Repository gates | `verify-scoped-dispatch` aligns declarations with the invariant table; generated catalogs require recognized dispatchers. |

These checks make omissions visible but do not replace the runtime carrier.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Add `{ agent }` to every registration | Separates visibility from effect ownership and repeats scope plumbing in every service. |
| Build a service graph per agent | Duplicates shared infrastructure and cannot naturally merge global contributions with one agent layer. |
| Inherit the parent's scope | Couples ownership to authority and silently grants parent-scoped capabilities. |
| Publish before setup | Exposes partially configured agents; rollback cannot retract observer side effects. |
| Require synchronous setup | Cannot compose asynchronous plugins and is not reliably enforced by TypeScript callback assignability. |
| Prepend invariant listeners | Later prepends, short-circuits, and outer wrappers can still bypass or replace their results. |
| Scope only event delivery | Leaves schemas, lookup, prompt state, Code Mode bindings, and lifetime global. |
| Modify vendored Cordis | Existing contexts, fibers, and receiver filtering are sufficient; a framework fork adds unnecessary maintenance. |

## Consequences

Plugin authors use the same registration APIs globally and per agent; only the context changes. Prompt schemas, executable lookup, Code Mode bindings, policy listeners, and UI presentation resolve from one agent view. Existing unscoped plugins remain deployment-wide contributors.

The implementation pays for per-scope maps, a proxy-shaped event carrier, explicit subject parameters on reads, and disciplined dispatch helpers. `agent.ctx` is capability-bearing and exposes the service surface injected into the agent loop. Flat scopes require child capabilities to be global or explicitly registered for the child.

Reserved transport and final-policy APIs are deliberately narrow. `run_code` cannot be removed by an end-capability filter; policy that forbids programs must deny execution. Prompt protection preserves named canonical contributions, not the whole assembly. Terminal turn stopping may discard steering and is too strong for ordinary cooperative policy.

This decision applies scoping to tools, prompt state, selected live events, sessions, and in-process subagent composition. It does not make every service call agent-scoped; other capabilities adopt the context rule only through their own explicit contracts.
