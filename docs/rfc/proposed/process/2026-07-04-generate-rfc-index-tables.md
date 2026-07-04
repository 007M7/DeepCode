# RFC: Generate the RFC index tables

Status: proposed

## Problem

`docs/rfc/README.md`'s per-lifecycle/per-class tables are hand-maintained even though every fact in them is derivable: an RFC's path encodes lifecycle and class, its filename encodes the first-proposed date, and its H1 carries the title. `scripts/verify-rfc-classification.ts` already walks the tree and cross-checks the index — the expensive parsing exists; it reports instead of writing.

The tables are also the repo's highest-contention docs hotspot: every proposal wave appends rows to the same few lines, so concurrent RFC branches conflict precisely there while agreeing everywhere else, and each conflict is resolved by hand-merging rows whose content the filesystem already knows. [The classification RFC](../../implemented/process/2026-06-20-rfc-classification.md) records rejecting auto-generation to keep the file curated — but the curated part of the README is the prose, and the prose never conflicts; only the mechanical tables do.

## Proposal

Keep the curated prose; generate the tables. Add a `gen-rfc-index` mode (a `--write` flag on `verify-rfc-classification.ts`, or a sibling script sharing its walker) that scans the RFC tree, reads each H1, derives the date from the filename, and rewrites the table rows under stable generated markers per `## {Lifecycle}` / `### {Class}` section; `verify-rfc-classification` asserts freshness — the `gen-cordis-catalog`/`verify-cordis-catalog` pattern. The class and lifecycle sets stay closed in the script. The implementing PR amends the classification RFC's rejected-alternatives record per [implemented/AGENTS.md](../../implemented/AGENTS.md), since this supersedes that recorded choice.

## Why not keep the verifier-only model?

It catches mistakes but still makes every proposal edit a shared hotspot, and a failed verifier is strictly more annoying than a generator for a purely mechanical row: the author has already named and placed the file; the index copy adds no information. This is the same hand-list-versus-derivation judgment the [package-inventory proposal](2026-06-20-discover-package-inventory.md) applies to tsconfig references and knip stanzas — applied to the one list that demonstrably conflicts.

## Acceptance criteria

- `pnpm run gen-rfc-index` (or the chosen spelling) rewrites only the generated table regions; `verify-rfc-classification` fails when they are stale and passes after regeneration.
- Adding, moving, or deleting an RFC requires editing only the RFC file itself; the rows are produced from path + H1 + filename date.
- The prose outside the generated markers is untouched by the generator; `pnpm run doc-sync` passes.

## Risks

Generated regions inside a curated file need explicit markers so ownership is obvious to reviewers. Reading H1s makes a malformed header a generator error — useful pressure, and it should fail clearly. This supersedes an implemented process decision; amending that RFC's record is part of the change, not optional.
