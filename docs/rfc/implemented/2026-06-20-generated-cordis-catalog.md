# RFC: Generated cordis events + services catalog

Status: implemented (accepted 2026-06-20)

<!-- XXX: legacy ADR/RFC body format, not yet normalized to a unified RFC template. -->

## Context

A plugin author needs two reference surfaces that no single document gave them: every cordis **event** they can listen to (with its exact signature and dispatch mode) and every `ctx.<key>` **service** they can call (with its exact interface). The pieces existed but were scattered — a hand-maintained event-taxonomy *table* in `docs/architecture.md` (names + prose Mode/Purpose, name-set-checked by `verify-event-taxonomy`), a Service-map table (8 rows of role prose), and the `interface Events` / `interface Context` declarations themselves. The taxonomy table also could not catch a brand-new *undocumented* event: a name-set verifier only checks the names that are already in the table on both sides.

This is the wiring-axis complement to the [core-data-structures catalog](../../core-data-structures/core.md) ([its RFC](2026-06-20-core-data-structures-catalog.md)): that one catalogs the *data structures* the loop moves around (verified hand-pastes); this one catalogs the *events and services* that move them.

## Decision

Generate the catalog from source instead of hand-maintaining a table and verifying a subset.

`scripts/gen-cordis-catalog.ts` walks the `interface Events` and `interface Context` declarations (plus the service classes) with the TypeScript compiler API and emits `docs/cordis-catalog/events-and-services.md` — one `## Events` section (grouped by scope, each event rendered as signature + mode badge + its source JSDoc) and one `## Services` section (each `ctx.<key>` with its public method signatures + class JSDoc). It mirrors the `gen-module-graph` pattern exactly: `--write` regenerates, `--check` fails if the committed file is stale, output is deterministic (sorted), and the file is a build artifact that is never hand-edited. `verify-cordis-catalog` (the `--check`) runs inside `doc-sync`, so the freshness gate fires in the same lefthook pre-push and CI paths as every other doc gate.

Pure generation is correct here because the codebase is disciplined enough that the AST is the whole truth: every event/service name is a string literal that round-trips to a static declaration — there are no dynamically-named events and no runtime-only services. So a generated doc cannot be wrong, and it closes the undocumented-event gap structurally (generation enumerates source rather than checking a hand-written subset).

Specific choices:

- **`@mode` tag, cross-checked.** Each harness event's JSDoc carries an explicit `@mode emit|waterfall|parallel` tag; the generator hard-errors on a missing tag. Where the signature shape is conclusive — a trailing `next: () => …` parameter is structurally a waterfall — it asserts the tag agrees and hard-errors on a contradiction. The emit-vs-parallel distinction is not structurally visible (`session/flush` returns `Promise<void> | void` with no `next`), so it is trusted from the tag. The authoring rule lives in [AGENTS.md](../../../AGENTS.md).
- **Tiered scope.** The harness tier (the 8 `@deepseek-ai/dsh-*` services + their events) is rendered in full from source. The inherited tier (cordis-core `ctx.on/emit/effect/provide/…` + the `internal/*` events + loader/hmr/timer) is pinned vendor source a plugin also sees; it is rendered tersely (name + one-line + source pointer) from a curated table in the generator, NOT walked from the vendor AST — the cordis-core `Context` mixes true ctx members with non-service fields (`root`, `baseUrl`, `logger`), and the vendor surface changes only on a deliberate vendor sync.
- **Cross-links to the data-structure catalog.** A type name in a signature (`GenerateOptions`, `StreamChunk`, `ToolDefinition`, …) links to the core-data-structures page that documents it. The map is a small hand-curated const in the generator — NOT `type-equiv.manifest.json`, which documents the `…Map` symbols while signatures reference the derived union names, and lists a few symbols on two pages.
- **A dedicated fence.** Signature blocks use a ` ```ts cordis-catalog ` info string that `doc-typecheck` recognizes and skips (a bare signature fragment is not standalone-compilable), excluded from the opt-out ratio — the same treatment `type-equiv` blocks get.

This **supersedes the event-taxonomy half** of [doc-sync enforcement](2026-06-11-doc-sync-enforcement.md): `verify-event-taxonomy` and its `docs/architecture.md` table are retired (the architecture.md heading stays, its body now points at the catalog; the Service-map role table stays as curated prose). The verify-don't-generate principle that RFC chose for the taxonomy is reversed *for this surface only* — the data here is mechanically complete, so generation is strictly stronger (full signatures, cannot drift, catches undocumented events) than a name-set check of a hand-table. doc-typecheck, verify-md-wrap, verify-md-links, and verify-type-equiv are unchanged.

## Consequences

- The catalog cannot drift: a source change that the committed file doesn't reflect fails `verify-cordis-catalog` in the pre-push hook and CI. A new event with no `@mode` tag, or a tag that contradicts its signature, fails the generator outright.
- Event prose now has a single home — the JSDoc at the declaration. Thin JSDoc yields a thin catalog entry, which pressures authors to document at the source (the generator is a forcing function for the AGENTS.md "every export has a semantic JSDoc" rule).
- The inherited tier is hand-summarized, so a vendor sync that adds/renames a cordis-core event or `ctx` member needs a matching edit to the curated table in `gen-cordis-catalog.ts`. This is the deliberate cost of not walking pinned vendor source; it changes rarely and is called out in the generator.
- `verify-event-taxonomy.ts` is deleted and the `docs/architecture.md` event table is gone; anyone who linked to a specific table row now lands on the generated catalog instead.
