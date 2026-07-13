# AGENTS.md — Harness Packages

This directory contains all `@deepseek-ai/dsh-*` harness packages. Repo-wide conventions (effects, declaration merging, waterfall semantics, ESM, testing policy) are in the root [AGENTS.md](../AGENTS.md) § Conventions; the points below are packages-specific.

- **Plugin export shape — namespace OR default, never both.** A *service* package exports the service class as `export default` (the Loader instantiates it). A *function/namespace* plugin exports `name` / `inject` / `Config` / `apply` as separate named exports and **must NOT add `export default`** — the cordis Loader's `unwrapExports` does `exports.default ?? exports`, so a stray default export collapses the module to the bare `apply` function and silently discards the `inject`/`name`/`Config` namespace, leaving the plugin with no injected services (it then throws `cannot get property … without inject` at load). See [docs/postmortem/0001](../docs/postmortem/0001-acp-default-export-drops-inject.md).
- **Read an optional (non-injected) service via `ctx.get(name)`, not `ctx.<name>`.** For a service a plugin reads opportunistically but deliberately leaves out of `static inject` (e.g. `AgentLoop` reading `sessionPersistence`), the `ctx.<name>` property proxy resolves by an ancestor-only fiber walk that throws when the call arrives through a foreign traceable shadow (the service lives on a sibling fiber). `ctx.get(name)` is the topology-independent global-store lookup, strict by default (an inactive/absent backend reads as `undefined` — prefer it over the `ctx.get(name, false)` overload, which also skips the active-state check). Services that ARE in `static inject` resolve fine via `ctx.<name>`. See [docs/postmortem/0001](../docs/postmortem/0001-acp-default-export-drops-inject.md).
- **A plugin shipped via `cordis.yml` needs at least one test through the REAL Loader/export path** — hand-built `ctx.plugin({...})` mounts bypass `unwrapExports` and cannot catch a broken export shape. Full testing policy (tiers, with-key generosity, real-entry-path guards): [docs/testing.md](../docs/testing.md).
- **Typed same-process service and plugin calls are contracts, not serialization boundaries.** Prefer readonly borrowed values; materialize or defensively validate only at parser/config, queued, model/tool JSON, durable/file, worker, process, or wire boundaries.
- **Represent one asynchronous operation with one lifecycle controller or transaction.** Separate readiness, cancellation, disposal, reservation, or sentinel state requires an independent owner or settlement boundary; otherwise fold it while preserving rollback, callback containment, and quiescence.

Naming notes:

- A *service* `src/index.ts` exports the service class as `export default` + all public types; a *function/namespace plugin* `src/index.ts` exports `name`/`inject`/`Config`/`apply` as named exports and NO default (the export-shape rule above).
- `src/types.ts` contains only types — no runtime code.
- Tests live at package level under `tests/`, not `src/__tests__/`.
- A package's README and JSDoc are part of the change: altered behavior (config keys, defaults, error codes, wire fields) updates them in the same commit. `doc-sync` gates what it can; prose accuracy stays on the author ([the documentation standard](../docs/AGENTS.md)).

Read the per-package README.md for package-specific details: service API, events, extension points, TODOs.
