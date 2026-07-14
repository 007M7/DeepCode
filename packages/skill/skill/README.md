# @deepseek-ai/dsh-skill

Pure agent skill provider registry.

This package owns the `ctx.skills` interface. It does not know whether skills come from local files, embedded plugin data, HTTP, or another backend; providers register those sources with `ctx.skills.registerProvider(...)`. The shipped local implementation is [`@deepseek-ai/dsh-skill-local`](../skill-local).

## Service: `SkillService` (ctx key: `skills`)

### Public API

- `ctx.skills.registerProvider(provider): () => void` Registers a readonly provider by unique `provider.name`. Duplicate provider names throw, and `runtime` is reserved for `ctx.skills.register(...)`. The registry borrows the provider object and invokes its methods directly. The registration is effect-scoped and HMR-safe, and the exact Cordis disposer supports ordered composite teardown.
- `ctx.skills.list({ cwd?, signal? })` Borrows the readonly lookup options, then returns model-invocable summaries for the current workspace, merged across providers and sorted by name.
- `ctx.skills.get(name, { cwd?, signal? })` Uses the same readonly options and winning candidate for discovery and loading, rechecks cancellation after discovery or a cache hit, races provider loading against the signal, validates the loaded definition, then returns it, including disabled-for-model skills.
- `ctx.skills.register(skill): () => void` Registers a readonly runtime embedded skill, adding `provider: "runtime"` when omitted. Same-name runtime registrations are first-wins: a duplicate logs a warning and gets a no-op disposer. Successful registrations return the exact Cordis disposer for ordered composite teardown.

### Config

| Field | Default | Meaning |
|---|---|---|
| `collectCacheMaxEntries` | `128` | Maximum completed cwd/provider catalogs kept in memory. |

## Provider Contract

A provider registers synchronously from its `apply()` and returns `readonly SkillCandidate[]` from `list(options)` when discovery is requested. The provider, lookup options, candidates, and loaded definitions are readonly same-process contracts: the registry borrows them rather than cloning, freezing, or rebinding callbacks. Remote setup, authentication, and discovery belong in the awaited `list()` call rather than plugin registration. Providers should stop promptly when `options.signal` aborts; the registry also stops awaiting uncooperative discovery and loading work so agent cancellation cannot hang prefix composition or skill loading.

The registry validates parsed provider candidates before caching them and validates loaded definitions before returning them. The winning provider receives the exact candidate and opaque `locator` identity it returned from `list()`; a local provider can therefore use a file-path handle while a remote provider can use a URL, id, or version token. Callers and providers must honor the readonly contract after handing values to the registry.

Parsed candidate and loaded-definition fields are validated at the provider boundary: names/descriptions/content use their declared string types, ranks are finite numbers, and `disableModelInvocation` is boolean when present. Candidate contract violations fail fast because the provider or its parser is malformed; a provider `list()` rejection is treated as a transient source failure, logged, skipped for that request, and not cached. Only completed catalogs are cached, and a provider/runtime revision change during discovery discards the stale result and retries. Duplicate skill names are resolved first-wins by `rank`, provider registration order, then the provider's own local order. The final summary list is sorted by skill `name` for deterministic consumers.

## Runtime Skills

`ctx.skills.register(...)` is a convenience for embedded runtime skills. Runtime skills use rank `250`: project providers can override them, while they override the shipped local provider's custom and user roots. Runtime definitions and nested resource metadata are borrowed readonly; the service only materializes the top-level definition needed to supply the default `provider`. Registration is first-wins within runtime contributions, so a duplicate contribution cannot remove the active one through its disposer.

## Consumer boundary

The registry does not render model guidance or register model-facing tools. [`@deepseek-ai/dsh-tool-skill`](../tool-skill) consumes `ctx.skills` to provide the session-prefix catalog and `skill` tool, so providers remain independent of the model surface.

## Model Experience

Indirectly, through `dsh-tool-skill`, which renders provider summaries into the session prefix and loaded instructions into retained tool results.

## Known Limitations and Deferred Work

- **Completed catalogs have no TTL or watcher invalidation** — a provider's underlying files or remote data can change without a registration revision, so a cached cwd stays stale until eviction or provider/runtime reload.
- **Providers are queried sequentially** — one slow cooperative provider delays every provider registered after it; cancellation stops the caller's wait but cannot terminate work an uncooperative provider keeps running.
- **A provider-list failure removes that whole source for the request** — the registry logs and skips it, with no model-visible diagnostic or partial-catalog recovery contract.
- **Duplicate resolution is first-wins** — later lower-priority candidates are logged and hidden; there is no API to inspect all shadowed definitions.
