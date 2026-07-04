# RFC: Fold the stdio UI helper into the stdio app

Status: proposed

## Problem

`@deepseek-ai/dsh-ui-stdio` is a whole package whose only runtime importer is the app package `@deepseek-ai/dsh-stdio-agent` (`packages/ui/stdio-agent/src/index.ts`). The examples reach the readline UI by loading the app, never by composing the helper themselves; every other repo reference is mechanical or descriptive surface that exists BECAUSE the package boundary exists — manifest and tsconfig entries, generated module-graph rows, dependency-graph and README rows, and doc comments naming the package. [The ui group README](../../../../packages/ui/README.md) records the placement rationale — the helper "exists chiefly for the examples and the coverage gate — `ui/` is reserved for surfaces shipped as product" — which leaves a standing tension: a shipped product app depends on a support package documented as NOT product surface.

The boundary buys package metadata, workspace and tsconfig references, module-graph rows, README entries, and publint surface for a helper that is not independently swappable: the stdio app's front-door cluster always includes the readline UI, and nothing else can meaningfully consume it.

## Proposal

Fold the helper into `@deepseek-ai/dsh-stdio-agent`: move `createStdioChat`, its `StdioRuntime` test seam, and its unit tests into `packages/ui/stdio-agent`; delete the `packages/support/ui-stdio` package with its manifest, references, module-graph rows, and README rows; update every reference that names the package (the example e2e module docs, `packages/README.md`, the support and todo README rows, the stdio-agent README, the ui group README, tsconfig references, the generated module graph). Keep the runtime seam so EOF handling, rendering, disposal, and piped-vs-TTY behavior stay unit-covered without hijacking process globals; the keyless Loader-path smokes keep guarding the export shape end-to-end.

## Why not promote it to `ui/` instead?

Promotion would resolve the support-vs-product mismatch while keeping the boundary — the right call only if the readline UI were an independently swappable integration or had a second composer, and the consumer census says neither. The structured ACP bridge stays its own package because it is the product protocol surface with its own contract and snapshot tiers; the readline helper is scaffolding for one app's front door. Re-extraction stays cheap pre-release: if a second product app wants the readline UI, split it back out then, with that consumer shaping the package contract.

## Acceptance criteria

- `packages/support/ui-stdio` no longer exists; the helper and its tests live in `packages/ui/stdio-agent`; no reference to the deleted package remains outside RFC history.
- The stdio app still renders transcript events, handles stdin lines and EOF, renders todo checklists, and disposes readline listeners under HMR; the echo/coding keyless smokes still boot through the real Loader path and guard the export shape.
- Manifests, tsconfig references, the generated module graph, and docs are updated; `pnpm run test:coverage`, `pnpm run test:snapshot`, `pnpm run doc-sync`, `pnpm run build`, and `pnpm run hygiene` pass.

## Risks

A future standalone terminal UI may want the helper as a package again — reintroduce it with that second consumer rather than keeping the boundary for hypothetical reuse. Moving tests risks blurring app-composition tests with UI-rendering tests; keeping the runtime seam and the colocated unit tests avoids that.
