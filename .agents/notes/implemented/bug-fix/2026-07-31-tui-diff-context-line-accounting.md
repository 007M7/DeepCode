# Agent Note: TUI diff context lines stay neutral

Status: implemented

English | [中文](2026-07-31-tui-diff-context-line-accounting.zh.md)

## Problem

Result-time filesystem diffs carry the applied change with three surrounding context lines in each `FileDiff.oldText` and `FileDiff.newText`. The TUI rendered every old-side row as removed and every new-side row as added, including the identical context present on both sides. A one-line edit therefore appeared as seven removals plus seven additions, and the footer repeated those inflated totals.

## Decision

The TUI compares each non-create `FileDiff.oldText` and `FileDiff.newText` at render time. Added and removed rows retain their green `+` and red `-` markers; equal context rows use the recessed body tone with a neutral two-space prefix. The footer sums only the rows classified as added or removed. A create (`oldText: null`) continues to classify every non-empty new-content row as added.

This remains a consumer-side interpretation of the existing `FileDiff` contract. Filesystem tools continue to persist contextual before/after snippets, so other consumers keep their placement context and existing session logs replay with corrected TUI presentation. The TUI uses the same maintained `diff` package as `dsh-tool-fs` instead of introducing a second line-diff implementation.

## Alternatives considered

**Remove context from filesystem result metadata.** Rejected: contextual applied hunks are intentional producer output used by capable editors, and changing them would weaken every consumer while leaving old session logs misleading in the TUI.

**Extend `FileDiff` with persisted per-line tags.** Rejected: the tags can be derived deterministically from the existing before/after pair; persisting them would widen the cross-package and session-log contract solely for one renderer.

**Match equal lines by position without a diff algorithm.** Rejected: insertions and deletions shift subsequent context, so positional pairing would misclassify valid hunks.

## Consequences

TUI diff cards distinguish evidence-bearing context from the mutation itself, and their `+A -R` footer reports the actual line delta. Replaying an existing contextual diff gains the corrected rendering without a migration. Rendering performs one additional line comparison per non-create hunk; result-time hunks are already context-bounded, while create cards bypass the comparison.

The focused TUI test covers neutral context and exact totals. The assembled `advanced-cards` terminal snapshots pin the neutral context style, semantic change colors, and `+1 -1` footer through collapsed and expanded card states.
