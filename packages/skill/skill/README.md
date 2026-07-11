# @deepseek-ai/dsh-skill

Pure agent skill provider registry.

This package owns the `ctx.skills` interface. It does not know whether skills come from local files, embedded plugin data, HTTP, or another backend; providers register those sources with `ctx.skills.registerProvider(...)`. The shipped local implementation is [`@deepseek-ai/dsh-skill-local`](../skill-local).

## Service: `SkillService` (ctx key: `skills`)

### Public API

- `ctx.skills.registerProvider(provider): () => Promise<void> | void` Registers a provider by unique `provider.name`. Duplicate provider names throw, and `runtime` is reserved for `ctx.skills.register(...)`. The registry snapshots the name and callback identities at registration, so replacing those fields later cannot change lookup or HMR cleanup; callbacks remain bound to the original provider object and can still read its mutable state. The registration is effect-scoped and HMR-safe, and the exact Cordis disposer supports ordered composite teardown.
- `ctx.skills.list({ cwd?, signal? })` Snapshots the lookup options, then returns detached model-invocable summaries for the current workspace, merged across providers and sorted by name.
- `ctx.skills.get(name, { cwd?, signal? })` Uses one lookup-options snapshot to select and load the winner, rechecks cancellation after discovery or a cache hit, races provider loading against the same signal, then returns a detached full definition, including disabled-for-model skills.
- `ctx.skills.register(skill): () => Promise<void> | void` Registers a detached runtime embedded skill. Same-name runtime registrations are first-wins: a duplicate logs a warning and gets a no-op disposer. Successful registrations return the exact Cordis disposer for ordered composite teardown.

### Config

| Field | Default | Meaning |
|---|---|---|
| `collectCacheMaxEntries` | `128` | Maximum completed cwd/provider catalog snapshots kept in memory. |

## Provider Contract

A provider registers synchronously from its `apply()` and returns `SkillCandidate[]` from `list(options)` when discovery is requested. Registration copies `name` and binds the current `list` and `get` methods once; replacing those fields on the caller-owned object later does not rewrite the live registry entry, and disposal always removes the original name. Remote setup, authentication, and discovery belong in the awaited `list()` call rather than plugin registration. Providers should stop promptly when `options.signal` aborts; the registry also stops awaiting uncooperative discovery and loading work so agent cancellation cannot hang prefix composition or skill loading.

Each public lookup captures `cwd` and the abort-signal identity once before cache or provider work, and providers receive that frozen lookup record. The registry reads each returned candidate once, validates that snapshot, and detaches its resource metadata before caching it. The winning provider receives another detached candidate in `get(candidate, options)`, while `candidate.locator` preserves the exact provider-owned identity originally returned by `list()`; a local provider can therefore use a file-path handle while a remote provider can use a URL, id, or version token. A loaded definition is detached again before it reaches the caller.

The registry validates fixed provider, candidate, runtime-registration, and loaded-definition fields before detachment: names/descriptions/content use their declared string types, ranks are finite numbers, and `disableModelInvocation` is boolean when present. Caller-owned objects masquerading as scalars are rejected without being frozen. Candidate contract violations fail fast because the provider plugin is malformed; a provider `list()` rejection is treated as a transient source failure, logged, skipped for that request, and not cached. Only completed, registry-owned catalogs are cached, and a provider/runtime revision change during discovery discards the stale result and retries. Duplicate skill names are resolved first-wins by `rank`, provider registration order, then the provider's own local order. The final summary list is sorted by skill `name` for deterministic consumers.

## Runtime Skills

`ctx.skills.register(...)` is a convenience for embedded runtime skills. Runtime skills use rank `250`: project providers can override them, while they override the shipped local provider's custom and user roots. Runtime registration detaches the accepted definition and nested resource metadata; later mutation of the registration object or a returned list/get value cannot rewrite the live skill. Registration is also first-wins within runtime contributions, so a duplicate contribution cannot remove the active one through its disposer.

## Consumer boundary

The registry does not render model guidance or register model-facing tools. [`@deepseek-ai/dsh-tool-skill`](../tool-skill) consumes `ctx.skills` to provide the session-prefix catalog and `skill` tool, so providers remain independent of the model surface.
