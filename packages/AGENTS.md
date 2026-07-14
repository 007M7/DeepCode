# AGENTS.md — Harness Packages

These package-specific rules supplement the repo-wide [conventions](../AGENTS.md#conventions).

- **Plugin export shape:** service packages default-export their service class; function plugins named-export `name` / `inject` / `Config` / `apply` and have no default export. Mixing the forms makes the Loader discard the function plugin's namespace ([postmortem](../docs/postmortem/0001-acp-default-export-drops-inject.md)).
- **Optional services use `ctx.get(name)`.** Reserve `ctx.<name>` for declared injections; the property proxy is topology-sensitive, while strict `ctx.get` reads the global service store ([postmortem](../docs/postmortem/0001-acp-default-export-drops-inject.md)).
- **A plugin shipped via `cordis.yml` needs at least one test through the REAL Loader/export path** — hand-built `ctx.plugin({...})` mounts bypass `unwrapExports` and cannot catch a broken export shape. Full testing policy (tiers, with-key generosity, real-entry-path guards): [docs/testing.md](../docs/testing.md).
- **Typed same-process service and plugin calls are contracts, not serialization boundaries.** Prefer readonly borrowed values; materialize or defensively validate only at parser/config, queued, model/tool JSON, durable/file, worker, process, or wire boundaries.
- **Represent one asynchronous operation with one lifecycle controller or transaction.** Separate readiness, cancellation, disposal, reservation, or sentinel state requires an independent owner or settlement boundary; otherwise fold it while preserving rollback, callback containment, and quiescence.

Naming notes:

- `src/types.ts` contains only types — no runtime code.
- Tests live at package level under `tests/`, not `src/__tests__/`.
- A package's README and JSDoc are part of the change: altered behavior (config keys, defaults, error codes, wire fields) updates them in the same commit. `doc-sync` gates what it can; apply [dsh-prose-standard](../.agents/skills/dsh-prose-standard/SKILL.md) for complete, concise prose and verify accuracy against code.
- Package READMEs document model/token effects using the [canonical Model Experience format](../docs/cookbook/adding-a-package.md#4-write-the-package-readme).
- Package READMEs put durable consumer gaps and non-obvious maintainer constraints under `## Known Limitations and Deferred Work`; ordinary cleanup stays in its TODO or RFC. Packages with none use a justified [allowlist entry](../scripts/verify-package-readme-limitations.ts) ([rationale](../docs/rfc/implemented/process/2026-07-10-readme-known-limitations-gate.md)).
