# RFC 006: Doc-sync enforcement and API reports

Status: proposed

## Problem

AGENTS.md policy says docs and code must stay strictly in sync, but sync is
verified by eyeball. Review has already caught drift twice (a cookbook
example contradicting the type policy; a README citing the wrong
registerAdapter call). Public API changes are similarly invisible — nothing
makes "this commit changed the public surface" an explicit, reviewable fact.

## Proposal

1. **Typecheck documentation code blocks.** A script extracts fenced ```ts
   blocks from README.md / docs/architecture.md / packages/*/README.md into a
   temp project resolving workspace packages, and runs tsc. Blocks that are
   intentionally elided get an explicit `ts ignore-check` info string —
   opt-out is visible in the source. (twoslash is the fancier alternative;
   start with plain extraction.)
2. **Generate or verify the event-taxonomy table.** The table in
   docs/architecture.md duplicates the `Events` declarations. Either generate
   it from source (ts-morph walk over the `declare module 'cordis'` blocks)
   or CI-assert that every declared event name appears in the table and vice
   versa.
3. **API reports.** api-extractor (or `tsc --emitDeclarationOnly` + a
   normalized public-surface dump) producing a checked-in `etc/<pkg>.api.md`
   per package; CI fails if regeneration differs. Every public-API change
   becomes a diff line a reviewer (or review agent) must see.

## Plan

1 is a standalone script + CI step. 3 next (it also documents the surface for
plugin authors). 2 last — verify-don't-generate is likely sufficient.

## Risks

Doc blocks often show fragments; the ignore-check escape hatch must stay rare
or the gate is theater — lint the ratio if needed.
