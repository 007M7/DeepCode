# Agent Note: Child agents join their parent's preset composition

Status: implemented

English | [中文](2026-08-10-child-agents-join-their-parent-preset.zh.md)

## Problem

Tool and prompt-section visibility is inherited along `dsh-scope`'s parent chain, and an agent's scope key is minted with no parent. [Per-session agent presets](../architecture/2026-08-03-per-session-agent-presets.md) moved every model-facing row onto the agent plane and made `AgentPresets.mount()` the one thing that binds that parent link — from the api-proxy's session create, resume, and fork paths. The two in-process subagent drivers compose their children through `applyChildComposition()`, which installed only the per-child persona and tool filter, so a child's scope chain had length one and its registry view resolved the global layer alone.

That layer is now empty in any deployment with a preset roster: the web-app patch layer disables every host-plane tool row. A one-shot child therefore reached the model with zero tools, a continuable child with only the host-plane `report`, and neither carried its parent's persona, workspace context, plan-mode section, or skill catalog. The fork path had already been given the same treatment for the same reason; delegation had not.

The child's durable header compounded it. `childSessionMeta()` recorded no preset, so a cold read of a child session resolved the deployment default — a tool set the child never ran under, which is exactly what the model-visible ⟺ logged rule exists to prevent.

## Decision

`AgentPresets.composeFrom(agentCtx, parentCtx)` joins one agent to the standing composition another already runs on, and returns the preset id joined. It locates the parent's mount through `standingMountFor()` — the agent's key is parented to its preset's standing key, the same relation `serviceForAgent()` reads — and binds the child's key to that same standing key, keeping the binding under the roster's sole re-link authority. A parent that joined no preset yields no join and no error, which is the rosterless deployment: its model-facing rows sit in the host composition, where the child already resolves them through the global layer.

This is a bind, not a mount, and both differences are load-bearing. The child gets its parent's exact generation, so a composition file edited since the parent started cannot hand the child a different one than its parent's history was produced under, and a preset deleted since cannot fail a child whose parent keeps running. It is also synchronous, which is what lets the child creation windows use it — both in-process drivers compose inside a synchronous `setup`.

`applyChildComposition(childCtx, parent, composition)` takes the parent and performs the join before applying the child's own registrations. The parameter is the point: it makes composing a child without the join unrepresentable at the call sites, rather than leaving each new driver to remember a second step. `childSessionMeta()` records the joined id through `AgentPresets.composedPreset()`, read from the parent's live scope chain rather than its header, because a parent that switched preset while blank runs on the newer composition while its header still names the older one.

`dsh-subagent` reaches the roster through `ctx.get('agentPresets')` with a type-only import and an optional peer dependency — the documented opportunistic-consumption pattern it already uses for `sandboxPolicy` and `approval`.

## Alternatives considered

**Re-mount the parent's preset by id in the child's setup.** Rejected on both semantics and mechanics. It re-reads the roster and re-stats the composition file, so an edit since the parent started forks the child onto a different generation, and a preset deleted since fails the child while its parent runs on. `mount()` is also asynchronous, which the synchronous creation windows cannot accept without restructuring both drivers.

**Bind the child's key to the PARENT's key rather than to the standing mount.** Rejected because it changes what a child inherits: the parent's own scope layer carries its per-agent restrictions, which would then intersect into every descendant, and a child outliving its parent would hang off a disposed agent's key. Joining the standing mount gives the child its parent's composition and nothing else.

**Extend the continuable activation setup registry to cover one-shot children.** Rejected because that registry's contribution type is synchronous `(childCtx) => () => void` with per-installation revocation, modelling deployment capabilities that come and go, while a preset join is a one-time bind with no revocation of its own. Widening it would have made the omission possible again for any driver that skipped the registry.

**Let `dsh-subagent` import `resolveSessionPreset` and mount by the resolved id.** Rejected because it makes the preset roster a hard module edge for a package that must work without one, and it lands back on the remount semantics above.

**Leave the durable header alone and fix only the live join.** Rejected because the live child and the same child read cold would then disagree about which composition produced its history — the same class of defect, moved rather than fixed.

## Testing

`packages/preset/agent-presets/tests/mount.spec.ts` covers the join against real fixture compositions: the child sees its parent's tools and prompt sections, no second generation is mounted, the join survives the parent's disposal (a background child outliving its parent), the reported id matches, a parent without a preset joins nothing, and an unscoped context is refused.

`packages/subagent/subagent-inprocess/tests/preset-inheritance.spec.ts` asserts the model-visible result through `startInProcessRun()` on a host composition carrying no model-facing rows: the schemas in the child's own request, its parent's prompt section, the recorded header preset, and a parent that switched preset while blank.

## Consequences

Delegation now costs a scope-parent bind per child and nothing else — no extra plugin instances, no roster read, no failure mode. A child's capabilities are exactly its parent's, minus whatever its own `toolFilter` removes; a per-subagent preset ("agent types") remains unbuilt and would be a new request field rather than a change to this join.

`applyChildComposition()` changed shape, so any future out-of-tree in-process driver must supply the parent. That is the intended cost: the previous signature let a caller compose a capability-less child and get no error.
