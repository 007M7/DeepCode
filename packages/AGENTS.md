# AGENTS.md — Harness Packages

This directory contains all `@deepseek-ai/dsh-*` harness packages. Repo-wide conventions (effects, declaration merging, waterfall semantics, ESM, testing policy) are in the root [AGENTS.md](../AGENTS.md) § Conventions; the points below are packages-specific.

- **Plugin export shape:** service packages default-export their service class; function plugins named-export `name` / `inject` / `Config` / `apply` and have no default export. Mixing the forms makes the Loader discard the function plugin's namespace ([postmortem](../docs/postmortem/0001-acp-default-export-drops-inject.md)).
- **Optional services use `ctx.get(name)`.** Reserve `ctx.<name>` for declared injections; the property proxy is topology-sensitive, while strict `ctx.get` reads the global service store ([postmortem](../docs/postmortem/0001-acp-default-export-drops-inject.md)).
- **A plugin shipped via `cordis.yml` needs at least one test through the REAL Loader/export path** — hand-built `ctx.plugin({...})` mounts bypass `unwrapExports` and cannot catch a broken export shape. Full testing policy (tiers, with-key generosity, real-entry-path guards): [docs/testing.md](../docs/testing.md).
- **Typed same-process service and plugin calls are contracts, not serialization boundaries.** Prefer readonly borrowed values; materialize or defensively validate only at parser/config, queued, model/tool JSON, durable/file, worker, process, or wire boundaries.
- **Represent one asynchronous operation with one lifecycle controller or transaction.** Separate readiness, cancellation, disposal, reservation, or sentinel state requires an independent owner or settlement boundary; otherwise fold it while preserving rollback, callback containment, and quiescence.

Naming notes:

- `src/types.ts` contains only types — no runtime code.
- Tests live at package level under `tests/`, not `src/__tests__/`.
- A package's README and JSDoc are part of the change: altered behavior (config keys, defaults, error codes, wire fields) updates them in the same commit. `doc-sync` gates what it can; prose accuracy stays on the author ([the documentation standard](../docs/AGENTS.md)).

Read the per-package README.md for package-specific details: service API, events, extension points, TODOs.
