# ADR 0014: Doc-sync enforcement

Status: accepted (2026-06-14)

## Context

AGENTS.md promises that docs and code stay strictly in sync, but the promise was verified by eyeball. Review caught drift twice — a cookbook example contradicting the type policy, and a README citing the wrong `registerAdapter` call. Out-of-sync docs are worse than no docs, and this codebase is built primarily by agents that follow gates far more reliably than prose (ADR 0007). Two classes of doc drift are mechanically checkable: code blocks that no longer compile, and the event-taxonomy table that duplicates the `interface Events` declarations.

## Decision

Two gates, mirroring the existing `scripts/` style (tsx ESM, one job each):

1. **`doc-typecheck`** extracts every fenced ` ```ts ` block from `README.md`, `docs/**`, and `packages/*/README.md`, writes them to a temp project, and compiles with `tsc --noEmit`. The temp tsconfig copies only resolution-relevant options and the workspace `paths` map from `tsconfig.typecheck.json` (vendor → built `lib`, harness → `src`) — resolving vendor to `lib` is essential, or tsc type-checks raw vendor source and floods the run. A block that is a deliberate sketch opts out with an explicit ` ```ts ignore-check ` info string; the script reports the opt-out ratio and fails if it exceeds half, so the escape hatch can't quietly become the norm.
2. **`verify-event-taxonomy`** extracts the event names from the `interface Events` blocks across `packages/*/src` and from the taxonomy table in `docs/architecture.md`, and asserts the two sets match exactly. Verify, don't generate: the table keeps its hand-written Mode/Purpose columns; only the set of names is checked. (Landing this surfaced three events the table had been missing — `tools/change`, `llm/adapter-change`, `system-prompt/change`.)

Both run via a shared `doc-sync` package.json script that the lefthook pre-push hook and CI both invoke (ADR 0007: hooks and CI call the same scripts, so the gate fires locally before a push — not only after it). They run after `yarn typecheck` (which emits the vendor `lib/` that doc-typecheck resolves against). API-extractor golden reports (RFC 006 part 3) were deliberately **deferred** — low value for an internal monorepo where reviewers already see the source diff, and a heavy, finicky dependency.

## Consequences

- Doc drift in the two checkable classes now fails the pre-push hook and CI instead of waiting for a reviewer to notice. This is an instance of ADR 0007's "mechanical gates over prose."
- Making doc snippets compile costs a few stub imports/`declare`s; the `ignore-check` ratio must stay low or the gate is theater (the ratio guard enforces this).
- The taxonomy check is name-only — a wrong Mode or Purpose column still needs human review. Generating the table from source was considered and rejected as more machinery than the problem warrants.
- API reports remain available to revisit if the packages are ever published externally.
