# @deepseek-ai/dsh-skill

Pure agent skill provider registry.

This package owns the `ctx.skills` interface. It does not know whether skills come from local files, embedded plugin data, HTTP, or another backend; providers register those sources with `ctx.skills.registerProvider(...)`. The shipped local implementation is [`@deepseek-ai/dsh-skill-local`](../skill-local).

## Service: `SkillService` (ctx key: `skills`)

### Public API

- `ctx.skills.registerProvider(provider): () => void` Registers a provider by unique `provider.name`. Duplicate provider names throw, and `runtime` is reserved for `ctx.skills.register(...)`. The registration is effect-scoped and HMR-safe.
- `ctx.skills.list({ cwd?, signal? })` Returns model-invocable skill summaries for the current workspace, merged across providers and sorted by name.
- `ctx.skills.get(name, { cwd?, signal? })` Returns the full winning skill, including disabled-for-model skills.
- `ctx.skills.register(skill): () => void` Registers a runtime embedded skill. Same-name runtime registrations are first-wins: a duplicate logs a warning and gets a no-op disposer.

### Config

| Field | Default | Meaning |
|---|---|---|
| `collectCacheMaxEntries` | `128` | Maximum completed cwd/provider catalog snapshots kept in memory. |

## Provider Contract

A provider registers synchronously from its `apply()` and returns `SkillCandidate[]` from `list(options)` when discovery is requested. Remote setup, authentication, and discovery belong in the awaited `list()` call rather than plugin registration. Providers should stop promptly when `options.signal` aborts; the registry also stops awaiting an uncooperative provider so agent cancellation cannot hang prefix composition. The provider later receives the winning candidate back in `get(candidate, options)`. The candidate's `locator` is opaque to the registry, so a local provider can store a file path while a remote provider can store a URL, id, or version token.

The registry validates candidate names, descriptions, ranks, and provider ownership. Candidate contract violations fail fast because the provider plugin is malformed; a provider `list()` rejection is treated as a transient source failure, logged, skipped for that request, and not cached. Only completed catalogs are cached, and a provider/runtime revision change during discovery discards the stale result and retries. Duplicate skill names are resolved first-wins by `rank`, provider registration order, then the provider's own local order. The final summary list is sorted by skill `name` for deterministic consumers.

## Runtime Skills

`ctx.skills.register(...)` is a convenience for embedded runtime skills. Runtime skills use rank `250`: project providers can override them, while they override the shipped local provider's custom and user roots. Runtime registration is also first-wins within runtime contributions, so a duplicate contribution cannot remove the active one through its disposer.

## Consumer boundary

The registry does not render model guidance or register model-facing tools. [`@deepseek-ai/dsh-tool-skill`](../tool-skill) consumes `ctx.skills` to provide the session-prefix catalog and `skill` tool, so providers remain independent of the model surface.
