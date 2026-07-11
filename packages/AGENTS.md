# AGENTS.md — Harness Packages

This directory contains all `@deepseek-ai/dsh-*` harness packages. Repo-wide conventions (effects, declaration merging, waterfall semantics, ESM, testing policy) are in the root [AGENTS.md](../AGENTS.md) § Conventions; the points below are packages-specific.

- **Plugin export shape: namespace or default, never both.** Service packages default-export their service class; function plugins named-export `name` / `inject` / `Config` / `apply` and have no default export. The Loader otherwise discards the namespace ([postmortem](../docs/postmortem/0001-acp-default-export-drops-inject.md)).
- **Read an optional, non-injected service with `ctx.get(name)`.** Use `ctx.<name>` only for injected services; its fiber-relative lookup is not safe for opportunistic sibling services ([postmortem](../docs/postmortem/0001-acp-default-export-drops-inject.md)).
- **A plugin shipped through `cordis.yml` needs a real Loader-path test.** A hand-mounted plugin does not exercise `unwrapExports`; see [testing.md](../docs/testing.md).

Naming notes:

- A service `src/index.ts` default-exports the service class and named-exports public types; a function plugin named-exports its plugin namespace.
- `src/types.ts` contains only types — no runtime code.
- Tests live at package level under `tests/`, not `src/__tests__/`.
- Altered behavior updates the package README and JSDoc in the same commit; keep both concise under [the documentation standard](../docs/AGENTS.md).

Read the per-package README.md for package-specific details: service API, events, extension points, TODOs.
