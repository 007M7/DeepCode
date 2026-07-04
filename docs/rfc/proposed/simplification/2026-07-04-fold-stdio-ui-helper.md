# RFC: Fold the stdio UI helper into the stdio app

Status: proposed

## Problem

`@deepseek-ai/dsh-ui-stdio` lives under `packages/support/`, but its only runtime importer is the product app package `@deepseek-ai/dsh-stdio-agent` ([packages/ui/stdio-agent/src/index.ts](../../../../packages/ui/stdio-agent/src/index.ts)). Direct `createStdioChat()` uses are package-local tests and the production wrapper inside the same support package. The examples reach it by loading `dsh-stdio-agent`, not by composing the UI helper themselves.

That leaves an awkward package boundary. `support/` is documented as lower-compat dev/test/example infrastructure, and the `ui-stdio` README says it is a convenience REPL, not a product surface. But `dsh-stdio-agent` is a shipped app package whose front-door cluster always includes the readline UI, console logger, JSONL persistence, and a pre-created `main` agent. In practice the helper is not an independent swappable capability; it is an implementation detail of the stdio app.

The boundary adds package metadata, workspace references, generated module-graph rows, README entries, publish lint surface, and a cross-group dependency from `packages/ui/stdio-agent` to `packages/support/ui-stdio`. It also creates a policy mismatch: a product UI app depends on a support package whose docs say it should not be treated as load-bearing product surface.

## Proposal

Fold the stdio UI helper into `@deepseek-ai/dsh-stdio-agent`.

- Move the `createStdioChat` implementation, its `StdioRuntime` test seam, and its unit tests into `packages/ui/stdio-agent`.
- Delete the `packages/support/ui-stdio` package, package references, path aliases, dependency entries, module-graph rows, and support README row.
- Keep the testable runtime seam inside `dsh-stdio-agent` so EOF handling, rendering, disposal, and piped-vs-TTY behavior remain covered without hijacking process globals.
- Update docs that currently point at `../support/ui-stdio` to describe stdio rendering as part of the stdio app.

After the fold, the stdio app owns its front door the same way `dsh-acp-agent` owns its ACP bridge cluster. The examples still load one app package; no leaf config has to learn a new plugin.

## Why not promote it to `packages/ui/` instead?

Promotion would fix the support/product mismatch but keep the extra package boundary. That would make sense if more than one product app composed `createStdioChat()` directly, or if the readline UI were a swappable UI integration in its own right. The current consumer audit says neither is true. The stdio app is the consumer and the owner.

Re-extraction stays cheap while the repo is unreleased. If a second product app needs the same readline UI independently, split it back out then, with that consumer shaping the package contract.

## Acceptance criteria

- `rg "@deepseek-ai/dsh-ui-stdio|support/ui-stdio|createStdioChat" packages examples docs scripts --glob '!docs/rfc/**' --glob '!**/lib/**'` finds no deleted package dependency or docs reference; `createStdioChat` remains only as an internal/tested helper under `packages/ui/stdio-agent` if the name survives.
- The stdio app still prints transcript events, handles stdin lines/EOF, renders todo updates, and disposes readline listeners under HMR.
- Echo/coding-agent keyless smoke tests still boot through the real Loader path and guard the named-export shape.
- Package manifests, tsconfig project references, generated module graph, and docs are updated.
- `pnpm run test:coverage`, `pnpm run test:snapshot`, `pnpm run doc-sync`, `pnpm run build`, and `pnpm run hygiene` pass after implementation.

## Risks

- `dsh-ui-stdio` currently has focused tests with a small package-local setup. Moving them risks blurring app composition tests with UI rendering tests; keep the helper test seam and colocated unit tests to avoid that.
- A future standalone terminal UI may want the helper as a package. Reintroduce it when a second product consumer exists rather than keeping a boundary for hypothetical reuse.
- Docs that mention the stdio UI as a support example need careful wording so they still distinguish the non-product terminal demo from the ACP product surface.
