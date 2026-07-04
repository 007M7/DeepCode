# RFC: Share the app bins' boot glue instead of maintaining twin copies

Status: proposed

## Problem

`packages/ui/stdio-agent/src/bin.ts` and `packages/ui/acp-agent/src/bin.ts` carry four near-twin helpers — `loadEnv`, `installFailLoud`, `assertEntriesLoaded`, `boot` — whose bodies differ essentially in the diagnostic prefix, plus two copies of the hardest-won boot lore in the repo: the `Promise.allSettled` swallow inside `loader.await()`, the silent-exit-0 import-failure guard, and the `--expose-internals` resolution note (the failure classes behind AGENTS.md's "real entry path means the published artifact" pattern). Drift has already begun: `boot(configPath)` resolves the path internally in one bin but requires a pre-resolved absolute path in the other, and the twin JSDoc prose has forked.

The duplication is aggravated by a coverage hole: all of this logic sits OUTSIDE the per-file 100% gate — `vitest.config.ts` excludes `packages/*/*/src/bin.ts` because importing a self-executing bin (top-level `await main()`) runs it — which also makes the `export` keywords on these helpers decorative: no spec can import them, so the only exercisers are the subprocess smokes, and the two `built-bin.e2e.ts` suites duplicate their temp-node_modules scaffolding as well. The genuinely per-app pieces are small and real: the ACP bin owns snapshot-mode config selection (`resolveConfigPath`), replay-mode env skipping, the stdin-EOF dispose lifecycle, and stdout purity; the stdio bin owns nothing extra.

## Proposal

Extract the four helpers, parameterized by the bin's diagnostic prefix, into an importable non-bin module shared by both apps — a small published package in the `ui` group (the bins are published artifacts, so their runtime dependency must be published too, not `support/`). Each `bin.ts` becomes a thin self-executing `main()` plus its app-specific glue. The shared module gains unit tests and falls under the coverage gate; the loader-failure lore gets one home; the subprocess smokes remain the artifact-level guard — the published-bin smoke is NOT replaced by unit tests, per the "real entry path" defensive pattern. The implementing PR amends the [extract example app packages RFC](../../implemented/architecture/2026-06-20-extract-example-app-packages.md)'s facts ("boot glue moved into that bin, owned by the app" is the sentence that changes).

## Why not keep the duplication?

The bins were framed as independently-owned published artifacts, and a new package carries fixed overhead (manifest, README, tsconfig reference, publint surface) that rivals the deduplicated line count. But app-vs-app sharing was never weighed by that RFC — it consolidated three example `start.ts` copies INTO the bins and stopped there; the drift is now observed fact rather than speculation; and the coverage-gap argument is independent of the dedup argument: this is the only nontrivial runtime logic in the repo exempt from the per-file 100% gate. The alternative of a copy-by-convention shared source file is the current state with extra steps.

## Acceptance criteria

- The four helpers exist once, unit-tested, under the coverage gate; both bins are thin mains plus app-specific glue.
- Both built-bin smokes still pass under plain node in the node_modules-shaped temp dir, including the missing-config non-zero exit.
- The app-packages RFC's facts are amended in the same change.

## Risks

Churn in two published bins and one new package boundary; the shared module must stay dependency-light (cordis plus the loader). If the implementing PR finds the package overhead genuinely exceeds the dedup — the honest failure mode of this proposal — the fallback that still pays is extracting only the coverage-exempt pure logic (`assertEntriesLoaded`, `resolveConfigPath`) into an importable module within each app package, ending the coverage exemption without a new package.
