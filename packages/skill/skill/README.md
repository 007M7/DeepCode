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

A provider registers synchronously and performs remote setup, authentication, and discovery in its awaited `list(options)` call. Provider objects, lookup options, candidates, and definitions are borrowed readonly rather than cloned or rebound. Providers should honor `options.signal`; the registry also stops awaiting uncooperative discovery or loading after cancellation.

The registry validates candidates before caching and definitions before returning them. The winning provider receives the same candidate and opaque `locator` it returned from `list()`, allowing backend-specific file, URL, id, or version handles. Callers and providers must preserve the readonly contract.

Contract violations fail fast. A rejected `list()` is treated as a transient source failure: it is logged, skipped, and not cached. Only completed catalogs are cached; a provider or runtime revision change discards an in-flight result and retries. Duplicate names resolve by rank, provider registration order, then provider-local order. Summaries are sorted by skill name.

## Runtime Skills

`ctx.skills.register(...)` is a convenience for embedded runtime skills. Runtime skills use rank `250`: project providers can override them, while they override the shipped local provider's custom and user roots. Runtime definitions and nested resource metadata are borrowed readonly; the service only materializes the top-level definition needed to supply the default `provider`. Registration is first-wins within runtime contributions, so a duplicate contribution cannot remove the active one through its disposer.

## Consumer boundary

The registry does not render model guidance or register model-facing tools. [`@deepseek-ai/dsh-tool-skill`](../tool-skill) consumes `ctx.skills` to provide the session-prefix catalog and `skill` tool, so providers remain independent of the model surface.

## Model Experience

Indirectly, through `dsh-tool-skill`, which renders provider summaries into the session prefix and loaded instructions into retained tool results.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Completed catalogs have no TTL or watcher invalidation** — a provider's underlying files or remote data can change without a registration revision, so a cached cwd stays stale until eviction or provider/runtime reload.
- **Providers are queried sequentially** — one slow cooperative provider delays every provider registered after it; cancellation stops the caller's wait but cannot terminate work an uncooperative provider keeps running.
- **A provider-list failure removes that whole source for the request** — the registry logs and skips it, with no model-visible diagnostic or partial-catalog recovery contract.
- **Duplicate resolution is first-wins** — later lower-priority candidates are logged and hidden; there is no API to inspect all shadowed definitions.
