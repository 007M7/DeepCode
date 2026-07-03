# RFC: Drop the unconsumed `web/providers-change` event

Status: proposed

## Problem

`WebService` declares and emits `web/providers-change` (`packages/web/web/src/index.ts`) on every provider registration and disposal, and orders each registration effect's rollback yield BEFORE the emit solely so a throwing change listener unwinds the registration. No listener exists outside the package's own two unit tests (one of which exists to pin that rollback ordering). The remaining references are the generated catalog and README/doc prose.

The seam's own design removed the natural consumer. `dsh-tool-web` registers tools by product ENABLEMENT, deliberately not by provider availability (`packages/web/tool-web/src/index.ts`), and `searchStatus()`/`fetchStatus()` are derived per call, never cached — so there is no cache to invalidate and no registration set to recompute when providers come and go. HMR cleanup is already carried by the effect disposers themselves.

This is shape-for-shape the surface the repo already cut once: [drop the unconsumed `llm/adapter-change` event](../../implemented/simplification/2026-06-20-drop-unconsumed-llm-adapter-change-event.md) removed the same notification, the same rollback-before-emit machinery, and the same listener-throw test from `LlmService`. That RFC's keep/cut criterion — keep `tools/change` for its plausible user-facing tool-list consumer, cut the boot-time backend-registry signal — puts a web-provider registry squarely on the cut side.

## Proposal

Delete the event declaration, both emits, and the rollback-before-emit ordering (the plain `ctx.effect` disposer keeps HMR cleanup); delete the two event tests; run `pnpm run gen-cordis-catalog` and commit the regenerated catalog; update `packages/web/web/README.md` and the [web.md](../../../core-data-structures/web.md) prose. The implementing PR amends the [web capability seam RFC](../../implemented/architecture/2026-06-24-web-capability-seam.md)'s facts (it specifies the event in its interface sketch and test list), per [implemented/AGENTS.md](../../implemented/AGENTS.md).

## Why not keep it?

The web seam RFC specified the event deliberately — days after the adapter-change removal — as a minimal HMR-visibility signal. But the same RFC also made every status read derived-on-call and tool registration availability-independent, which is precisely why no consumer can need the signal: the design's other choices starved this one. Per AGENTS.md "RFCs are proposals, not golden truth", the event is the part of that proposal the code has since shown to over-reach; validating it against the repo's own precedent yields the verdict the precedent already recorded.

## Acceptance criteria

- No `providers-change` spelling outside this RFC and the amended seam RFC; the catalog is regenerated and fresh (`verify-cordis-catalog` green).
- Registration/disposal HMR-safety tests still prove cleanup via `searchStatus()`/`fetchStatus()` derivation rather than via the event.

## Risks

A future provider-picker UI or diagnostics panel that wants live change notifications re-adds the event with that consumer — the identical judgment, and its reversal condition, is already recorded on the llm precedent.
