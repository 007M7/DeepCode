# RFC: Generate the RFC index tables

Status: proposed

## Problem

`docs/rfc/README.md` is hand-maintained even though the repo already has a machine-readable RFC layout: every RFC lives at `docs/rfc/{lifecycle}/{class}/yyyy-mm-dd-topic.md`, and `scripts/verify-rfc-classification.ts` walks that tree to verify structure and index completeness. The current gate prevents drift, but every new RFC still edits the same README tables by hand.

The stacked hook work made the cost visible. PR #138 added implemented feature/testing/process rows while this simplification sweep added proposed simplification rows, and the only merge conflict when retargeting the sweep onto #138 was the RFC index table. That is predictable: high-churn proposal waves all touch the same few lines even though the truth is already in filenames and H1 titles.

[The classification RFC](../../implemented/process/2026-06-20-rfc-classification.md) explicitly rejected auto-generating the README index so the file could stay curated. That was a reasonable first cut, but the repo now has enough RFC volume and stacked-PR churn that the hand-written table is the unstable part, not the curated prose. The verifier already does the expensive parsing; it just reports instead of writing.

## Proposal

Keep the curated prose in `docs/rfc/README.md`, but generate the per-lifecycle/per-class tables from the filesystem.

- Add a `gen-rfc-index` script (or extend `verify-rfc-classification.ts` with `--write`) that scans RFC files, reads each H1, derives the first-proposed date from the filename, and writes the table rows under stable generated markers for each `## {Lifecycle}` / `### {Class}` section.
- Keep the class set and lifecycle set closed in one script-owned source of truth.
- Make `verify-rfc-classification` check that the generated sections are fresh, analogous to `verify-cordis-catalog`.
- Preserve manually curated prose, classification descriptions, and "when to write one" guidance outside the generated table blocks.
- Update [the classification RFC](../../implemented/process/2026-06-20-rfc-classification.md) to say the earlier "verify, do not generate" choice was superseded after stacked-PR conflicts made the tradeoff worse.

The generated output should stay boring Markdown: the same tables reviewers read today, just mechanically produced from the path + title source of truth.

## Why not keep the current verifier-only model?

The current model catches mistakes but still forces every proposal to edit a shared hotspot. A failed verifier is also more annoying than a generator for a purely mechanical row: the author has already named and placed the file correctly, then has to copy the same facts into the index. That is exactly the kind of hand-maintained inventory the repo already proposes removing elsewhere.

This does not turn the whole README into a build artifact. The prose remains curated. Only the parts whose content is derivable from RFC files become generated.

## Acceptance criteria

- `pnpm run gen-rfc-index` (or the chosen command) rewrites only the generated RFC table regions.
- `pnpm run verify-rfc-classification` fails when those generated regions are stale and passes after regeneration.
- Adding, moving, or deleting an RFC requires editing the RFC file itself; the README rows are produced mechanically.
- The generated rows use each RFC's H1 title and filename date, and preserve the existing lifecycle/class grouping.
- `pnpm run doc-sync` passes after implementation.

## Risks

- Generated regions inside a curated README can be jarring. Use explicit markers and keep the table output minimal so reviewers know what is owned by the script.
- Reading H1 titles makes malformed RFC headers a generator concern. That is useful pressure: a missing or nonstandard H1 should fail clearly.
- This supersedes an implemented process decision. The implementing PR must amend the old classification RFC so the historical record explains why the tradeoff changed.
