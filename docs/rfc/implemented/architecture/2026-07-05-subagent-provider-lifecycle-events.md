# RFC: Subagent provider-lifecycle events — `subagent/provider-added` / `subagent/provider-removed`

Status: implemented

## Problem

[The prompt-variables RFC](2026-07-05-prompt-variables-and-tool-guidance-ownership.md) makes `dsh-tool-subagent` DERIVE its model-facing wording from its provider: `SubagentProvider.inheritsParentContext` (spawn/ACP `false`, fork `true`) drives both the tool description and the `prompt` parameter description (`providerWording`), so the fork tool stops lying about context inheritance. That fix created a cross-fiber data dependency: a tool's description is fixed at TOOL REGISTRATION (deliberately — the description is where tool-choice guidance lives), but the provider arrives on its own plugin fiber, on no particular schedule.

The first implementation resolved the provider at the tool plugin's `apply` time and threw when it was absent — an implicit load-order requirement ("list the backend before the tool in cordis.yml"). Review reproduced the failure that requirement hides: the cordis Loader starts sibling entries CONCURRENTLY (`Promise.all` over the group) and `Entry.init()` does not await activation, so a backend whose activation is delayed leaves the tool's fiber permanently failed even when "listed first". The ordering the requirement leaned on is not a contract the Loader offers — "async state is not synchronous state" ([defensive patterns](../../../defensive-patterns.md)).

## Decision

The registry announces provider membership as typed events, and the consumer mirrors them instead of assuming order:

- **`subagent/provider-added(provider)`** — a provider became resolvable in the `ctx.subagents` registry. Emitted on registration.
- **`subagent/provider-removed(name)`** — a provider left the registry (its plugin's fiber was disposed — an unload or an HMR reload). Emitted from the registration's disposer.

`dsh-tool-subagent` mirrors its named provider's lifecycle: it registers the tool when the provider is (or becomes) available — deriving the wording from that provider at that moment — unregisters the tool when the provider goes away, and re-derives on re-registration (HMR reload). While the provider is absent the tool does not exist, which cannot lie to the model. There is deliberately NO load-order requirement left to document: the events make the ordering question disappear instead of pinning it.

The events also complete the seam's vocabulary: `ctx.subagents` is a named registry on which multiple delegation backends coexist (`spawn`, `fork`, `acp`), and a registry whose contents other plugins derive state from should announce membership changes as typed events rather than requiring polling or load-order faith.

## Alternatives considered

- **Resolving the provider at `apply` time and throwing when absent (a load-order requirement)** — the first implementation, rejected after review reproduced the failure above. Documenting the requirement ("list backends first") would pin a guarantee the Loader does not make.
- **Retrying the lookup (poll until the provider appears)** — converges eventually but invents a private readiness protocol beside the one the framework already has (effect registration + disposal); it also cannot notice a provider LEAVING, so HMR would strand a tool whose wording describes a disposed backend.
- **Section-only subagent wording, lazily resolved at assemble time** — tolerates any load order too, but moves tool-choice guidance out of the DESCRIPTION, contradicting the ownership rule the prompt-variables RFC establishes (per-tool semantics and when-to-use belong in the description). Reactive registration keeps the description authoritative AND order-free.
- **Keying wording off the provider NAME instead of the provider object** — `providerName` is itself config, so a renamed provider silently gets the wrong words; deriving from the resolved provider's own `inheritsParentContext` cannot drift.

## Consequences

- Consumers deriving state from a named provider react to `subagent/provider-added`/`-removed` instead of reading the registry at `apply` time; `dsh-tool-subagent` is the reference implementation.
- **The two emits carry asymmetric failure semantics, deliberately.** `provider-removed` fires inside the registration's disposer and is delivered with PER-LISTENER containment (the service's `emitLifecycle`, not raw `ctx.emit`, which halts dispatch on the first throw): a throwing subscriber is logged, never starves a later mirror into holding a stale tool, and never disrupts the backend fiber's teardown — dispose reaches quiescence. `provider-added` propagates: it fires at registration time, where a throwing listener unwinds the yielded rollback — the same fail-loud register-time semantics as the system-prompt registries. The run-time backstop bounds what a stale mirror could cost anyway: `start()` re-resolves the provider by name per run, so a tool that outlived its provider fails that call cleanly instead of dispatching into a dead backend. The [events catalog](../../../cordis-catalog/events.md) carries the exact signatures, and the [producer/consumer map](../../../event-producer-consumer.md) shows `dsh-subagent` emitting and `dsh-tool-subagent` consuming both events.
- **A window where the tool is absent.** Between backend disposal and re-registration (an HMR reload), the model sees no subagent tool. This is the honest state — the alternative is a tool that dispatches into nothing — and the tool registry's `tools/change` emit keeps prompt assembly current.
- **Two waiting fibers sharing a `toolName` is an invalid config caught late.** If two loads of `dsh-tool-subagent` name different providers but the same `toolName`, both wait, and whichever provider arrives first registers; the second registration throws only when ITS provider arrives. `TODO(subagent-dup-toolname)` in the plugin records this blast radius; the tool registry's duplicate-name rejection remains the backstop.
