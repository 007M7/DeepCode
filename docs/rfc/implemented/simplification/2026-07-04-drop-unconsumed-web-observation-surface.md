# RFC: Drop the unconsumed web observation surface — the `providers-change` event and the status methods

Status: implemented (proposed and accepted 2026-07-04)

## Problem

`WebService` exposes an observation surface no production code observes:

- **`web/providers-change`** (`packages/web/web/src/index.ts`) is declared and emitted on every provider registration and disposal, and each registration effect's rollback yield is ordered BEFORE the emit solely so a throwing change listener unwinds the registration. No listener exists outside the package's own two unit tests (one of which exists to pin that rollback ordering).
- **`searchStatus()` / `fetchStatus()` and the `WebCapabilityStatus` union** (same package) have zero production callers: `dsh-tool-web` executes directly through `ctx.web.search()`/`fetch()` and surfaces unavailability as the structured `WebError` codes the seam throws at execution time (`packages/web/tool-web/src/search.ts`, `packages/web/tool-web/src/fetch.ts`); the only status callers are the web packages' own tests. The prose in `packages/web/tool-web/README.md` and [architecture.md](../../../architecture.md) claims the tool "reads only the aggregated `searchStatus()`/`fetchStatus()`" — drift that survives only because nothing checks prose against call sites.

The seam's own design starves both surfaces of consumers: tool registration follows product ENABLEMENT, not provider availability (`packages/web/tool-web/src/index.ts`), and provider selection resolves at execution time, never cached — so there is no cache to invalidate, no registration set to recompute, and no caller that needs an availability probe distinct from executing and routing the structured error. HMR cleanup is carried by the effect disposers themselves.

This mirrors [drop the unconsumed `llm/adapter-change` event](../../implemented/simplification/2026-06-20-drop-unconsumed-llm-adapter-change-event.md), which removed the same notification shape, the same rollback-before-emit machinery, and the same listener-throw test from `LlmService`. That RFC's keep/cut criterion — keep `tools/change` for its plausible user-facing tool-list consumer, cut the boot-time backend-registry signal — puts a web-provider registry squarely on the cut side; the status methods are the same judgment applied to a pull surface instead of a push one.

## Proposal

Delete the event declaration, both emits, and the rollback-before-emit ordering (the plain `ctx.effect` disposer keeps HMR cleanup). Delete `searchStatus()`/`fetchStatus()`/`WebCapabilityStatus` — the provider-private `status()` stays, since it feeds execution-time selection. Delete the listener-throw rollback test that exists solely for the removed event, and rewrite the emission assertions and every status-based assertion onto the behavior a real caller observes (a successful `search()`/`fetch()`, or the structured `WebError` codes for unavailable/ambiguous/misconfigured provider sets). Run `pnpm run gen-cordis-catalog`; update `packages/web/web/README.md`, `packages/web/tool-web/README.md` (the drifted reads-status sentence), [web.md](../../../core-data-structures/web.md), and the web paragraph in [architecture.md](../../../architecture.md). Amend the [web capability seam RFC](../../implemented/architecture/2026-06-24-web-capability-seam.md)'s facts (it specified the event and the status aggregation) per [implemented/AGENTS.md](../AGENTS.md).

## Why not keep it?

The web seam RFC specified both deliberately — the event as a minimal HMR-visibility signal, the status methods as the tool's aggregated diagnostics — and a future provider-status panel is imaginable. But the same RFC's other choices starved them: derived-on-call selection and enablement-based registration leave no consumer that CAN need either, the shipped tool demonstrates the real pattern (execute and route the structured error), and the drifted README sentence shows the promised consumer never materialized. Per AGENTS.md "RFCs are proposals, not golden truth", these are the parts of that proposal the code has since shown to over-reach; a future observer reintroduces the smallest signal or query it actually consumes, shaped by that consumer.

## Acceptance criteria

- No `providers-change`, `searchStatus`, `fetchStatus`, or `WebCapabilityStatus` spelling outside RFC history; the catalog is regenerated and fresh (`verify-cordis-catalog` green).
- Registration/disposal HMR-safety tests prove cleanup through execution behavior rather than the removed surfaces.
- `packages/web/tool-web/README.md` and the architecture paragraph describe the execution-time error-routing contract the tool actually has.

## Risks

A future provider-picker UI or diagnostics panel wants change notifications or a status query — it re-adds the smallest surface it consumes; the identical judgment, and its reversal condition, is already recorded on the llm precedent.
