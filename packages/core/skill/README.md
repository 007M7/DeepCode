# @deepseek-ai/dsh-skill

Agent skill provider registry and model-facing skill guidance.

This package owns the `ctx.skills` interface. It does not know whether skills come from local files, embedded plugin data, HTTP, or another backend; providers register those sources with `ctx.skills.registerProvider(...)`. The shipped local implementation is [`@deepseek-ai/dsh-skill-local`](../skill-local).

## Service: `SkillService` (ctx key: `skills`)

### Public API

- `ctx.skills.registerProvider(provider): () => void` Registers a provider by unique `provider.name`. Duplicate provider names throw, and `runtime` is reserved for `ctx.skills.register(...)`. The registration is effect-scoped and HMR-safe.
- `ctx.skills.list({ cwd? })` Returns model-invocable skill summaries for the current workspace, merged across providers.
- `ctx.skills.get(name, { cwd? })` Returns the full winning skill, including disabled-for-model skills.
- `ctx.skills.register(skill): () => void` Registers a runtime embedded skill. Same-name runtime registrations are first-wins: a duplicate logs a warning and gets a no-op disposer.
- `ctx.skills.renderModelListing({ cwd? })` Renders the request-time `## Skills` catalog.

### Config

| Field | Default | Meaning |
|---|---|---|
| `promptFieldMaxLength` | `500` | Maximum rendered `description` / `whenToUse` length in the prompt listing; must be at least `3` because truncated fields reserve `...`. |
| `collectCacheMaxEntries` | `128` | Maximum cwd/provider discovery promises kept in memory. |

## Provider Contract

A provider returns `SkillCandidate[]` from `list(options)` and later receives the winning candidate back in `get(candidate, options)`. The candidate's `locator` is opaque to the registry, so a local provider can store a file path while a future HTTP provider can store a URL, id, or version token.

The registry validates candidate names, descriptions, ranks, and provider ownership. Candidate contract violations fail fast because the provider plugin is malformed; a provider `list()` rejection is treated as a transient source failure, logged, skipped for that request, and not cached. Duplicate skill names are resolved first-wins by `rank`, provider registration order, then the provider's own local order. The final model-visible summary list is sorted by skill `name` for deterministic prompt text and provider prefix-cache friendliness.

## Runtime Skills

`ctx.skills.register(...)` is a convenience for embedded runtime skills. Runtime skills use rank `250`: project providers can override them, while they override the shipped local provider's custom and user roots. Runtime registration is also first-wins within runtime contributions, so a duplicate contribution cannot remove the active one through its disposer.

## Prompt Integration

The service listens on `system-prompt/assemble` and appends a short `## Skills` section to the calling agent's assembled system prompt. The listing contains only stable routing metadata (`name`, `source`, `description`, and optional `whenToUse`), not skill bodies or absolute local paths. `description` and `whenToUse` are whitespace-normalized, capped, XML-escaped, and have `{{` / `}}` delimiters split so provider text cannot trip prompt-variable interpolation. Models load full instructions through the `skill` tool.

The prompt-injection surface is intentionally separate from provider loading: changing where skills come from means adding or swapping providers, not changing prompt assembly or the `skill` tool.
