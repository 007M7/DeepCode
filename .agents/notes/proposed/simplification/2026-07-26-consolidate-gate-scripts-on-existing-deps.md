# Agent Note: Consolidate gate scripts on already-present deps and builtins

Status: proposed

English | [中文](2026-07-26-consolidate-gate-scripts-on-existing-deps.zh.md)

## Problem

The `scripts/` gates mostly use the right tools (`node:fs` `globSync` in 15+ gates, mdast/micromark in the markdown gates), but a handful of stragglers hand-roll what a sibling gate already does with an existing dependency or builtin:

- **Duplicated fence scanners.** `scripts/md-fences.ts` (~55 lines, consumed by `doc-typecheck.ts`) and `extractEquivBlocks` in `scripts/verify-type-equiv.ts` (~39 lines) are two copies of the same regex line-scanner for fenced code blocks, while `scripts/verify-mermaid.ts` already extracts fences by visiting mdast `code` nodes via the shared `scripts/markdown.ts` helpers — and `markdownProseLines` in `markdown.ts` itself parses to mdast but then hand-tracks fence state with a second regex. The regex scanners only recognize backtick fences at column 0, so they silently disagree with the mdast-based gates on tilde and indented fences.
- **Hand-rolled argv parsing.** `parseOptions` in `scripts/publint-all.ts` and its near-identical copy in `scripts/verify-built-package-invariants.mjs` (~26 lines) step argv indexes manually, while sibling scripts (`verify-runtime-closure.ts`, `build-exe-for-python-sdk.ts`, `packages/sdk/scripts/src/args.ts`) already use the `node:util` `parseArgs` builtin.
- **Hand-rolled directory walks.** Five sites re-derive nested `readdirSync` walks that `globSync` covers: `verify-runtime-closure.ts` (packages + vendor manifests), `dev-web.ts` `discoverPluginDirs`, `verify-package-paths.ts` `realPackageNames`, `verify-client-domain-graph.ts` `listSources`, and `publint-all.ts` `addPath` (~55–65 lines total). `scripts/package-invariants.ts` shows the one-line `globSync` template.

No new dependency is needed anywhere; every replacement is an existing devDep or a Node builtin.

## Proposal

- Extract a shared ~10–15-line mdast fence helper (visiting `code` nodes for `lang`, `meta`, `value`, `position.start.line`) into `scripts/markdown.ts`; rewrite `doc-typecheck.ts` and `verify-type-equiv.ts` onto it; delete `md-fences.ts` and the duplicated scanner; drop the redundant fence regex in `markdownProseLines`.
- Replace both `parseOptions` copies with `parseArgs`.
- Replace the five straggler walks with `globSync`. Keep the walks in `check-workspace-constraints.ts` and `clean.ts`: they need dirent-level detail to diagnose malformed trees, which glob-by-pattern cannot report.

## Alternatives considered

- **A new glob/walking dependency (`tinyglobby`, `fdir`).** Rejected: the builtin already won repo-wide; these are stragglers, not a gap.
- **`p-map` for `publint-all.ts`'s ~19-line ordered worker pool.** Deliberately left out: one new devDep for one small deletion is at the edge of the [dependency policy](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.md) bar, and the pool's requirements (bounded workers, deterministic order, env override) are documented in the [parallel-gates note](../../implemented/process/2026-07-06-parallel-pre-push-gates.md). Fold it in only if `p-map` earns a second consumer.
- **Leaving the fence scanners.** Rejected: two drifting copies of a parser beside a third correct implementation is exactly the duplication the shared `markdown.ts` helper exists to prevent, and the column-0-backtick-only limitation is a latent inconsistency between sibling gates.

## Acceptance criteria

- `md-fences.ts` is gone; `doc-typecheck` and `verify-type-equiv` extract fences through `scripts/markdown.ts`; `pnpm run doc-sync` passes with unchanged results on the current tree (any delta traces to a fence shape the regex scanners mishandled).
- Both CLIs parse via `parseArgs`; unknown options still fail loud.
- The five walk sites use `globSync`; the gates they feed pass unchanged.

## Risks

- Behavioral deltas on pathological markdown: mdast honors tilde/indented fences the regex scanners ignored, so `doc-typecheck`'s opt-out ratio could shift if any stray fence shape exists in the docs tree; verify by running `doc-sync` before/after.
- `parseArgs` keeps the last value of a duplicated option instead of erroring — a dev-tool edge case the tests don't pin. (Strict mode still rejects a `--`-prefixed token where a value is expected, matching the current parsers.)
