# RFC: Generate the RFC index tables

Status: implemented

## Problem

`docs/rfc/README.md`'s per-lifecycle/per-class tables list facts that are fully derivable: an RFC's path encodes lifecycle and class, its filename encodes the first-proposed date, and its H1 carries the title. A hand-maintained copy of those facts is also the repo's highest-contention docs hotspot: every proposal wave appends rows to the same few lines, so concurrent RFC branches conflict precisely there while agreeing everywhere else, and each conflict is resolved by hand-merging rows whose content the filesystem already knows. [The classification RFC](2026-06-20-rfc-classification.md) originally kept the index hand-written for curation's sake — but the curated part of the README is the prose, and the prose never conflicts; only the mechanical tables do.

## Decision

Keep the curated prose; generate the tables. [`scripts/rfc-index.ts`](../../../../scripts/rfc-index.ts) is the shared source of truth — the tree walker (owning the closed lifecycle/class sets and the structure rules, including a parseable-H1 requirement) and the renderer (rows from H1 title with any `RFC: ` prefix stripped, plus the filename date, sorted by date then filename, grouped as `### {Class}` sections in canonical class order). Two thin consumers share it:

- [`scripts/gen-rfc-index.ts`](../../../../scripts/gen-rfc-index.ts) (`pnpm run gen-rfc-index`) rewrites the three marker-delimited regions in the README (`<!-- gen-rfc-index:begin {lifecycle} -->` … `end`), one per `## {Lifecycle}` section, leaving everything outside the markers untouched.
- [`scripts/verify-rfc-classification.ts`](../../../../scripts/verify-rfc-classification.ts) (a `doc-sync` member) checks structure and asserts the committed regions byte-match a fresh render — the `gen-cordis-catalog`/`verify-cordis-catalog` pattern. Freshness subsumes the index-completeness check: a generated-from-disk table is definitionally complete and correctly headed.

Adding, moving, or deleting an RFC means editing only the RFC file and running the generator; the classification RFC's rejected-alternatives record carries the supersession cross-link.

## Why not the verifier-only model?

It catches mistakes but still makes every proposal edit a shared hotspot, and a failed verifier is strictly more annoying than a generator for a purely mechanical row: the author has already named and placed the file; the index copy adds no information. This is the same hand-list-versus-derivation judgment the [package-inventory proposal](../../proposed/process/2026-06-20-discover-package-inventory.md) applies to tsconfig references and knip stanzas — applied to the one list that demonstrably conflicts.

## Consequences

- The generated regions are explicit: marker comments make script ownership obvious to reviewers, and the generator refuses to run on a structurally invalid tree.
- A malformed or missing H1 is a hard error in both the generator and the gate — the H1 is now load-bearing as the index title source.
- Concurrent RFC branches resolve index conflicts by rerunning the generator, never by hand-merging rows.
