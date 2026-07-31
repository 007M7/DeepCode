# Agent Note: Live standalone compaction progress in the terminal

Status: implemented

English | [中文](2026-07-30-compaction-progress-visibility.zh.md)

## Problem

A standalone manual compaction runs between turns while the agent remains idle. The TUI's turn-phase indicator therefore kept its plain `>` caret throughout the slow summary operation, and a failed attempt produced no transcript row because no replacement checkpoint landed. Replacing only that caret with a one-cell glyph made the operation technically visible but still easy to miss while attention remained on the transcript.

The durable log can retain an unmatched `compact/start` after a process dies. That orphan is useful recovery evidence, but it is not proof that work is running in the current process; replaying it as progress would leave resumed sessions with a permanent phantom indicator.

## Decision

The TUI treats the live standalone `compact/start { turn: null }` to matching `compact/end` bracket as the source of in-flight compaction presentation. A module-local `compacting` cell records the render-clock start, owns one animation timer, and retains a terminal-only progress component. The existing one-cell indicator renders `⊙` through the same fade and throb path as turn-phase glyphs, while the component renders a `◐` / `◓` / `◑` / `◒ Compaction in progress…` row; the terminal progress bit remains active until the bracket closes.

The progress component owns its leading blank line and is re-pinned to the transcript tail on every compaction render. New session content, `/clear`, and a transcript rebuild therefore cannot strand or erase the live marker. The compaction timer refreshes both the prompt glyph and the row; the row does not own another timer.

Turn-phase glyphs take precedence over `⊙`. Numbered compaction brackets are ignored because they are enclosed by a running turn whose phase already lights the indicator. The compaction cell does not change the idle editor border, hint, or steering badge, so prompts remain visibly accepted while standalone compaction reserves turn admission.

The cell and row are live-only. Mount and transcript replay never scan history for an unmatched start; only a `session/event` notification observed by the mounted TUI can open them. Turn-status transitions preserve the cell, while terminal teardown removes the row and clears its timer and progress bit.

On `compact/end`, the TUI removes the live row and clears the cell before starting the ordinary glyph fade-out. An end carrying `error` adds `Compaction failed: <error>` as a warning. Successful completion remains represented by the landed replacement's transcript marker, and duration remains derivable from the matching durable start and end timestamps without another settled row.

This decision partially supersedes only the progress-related deferred clauses in the [terminal transcript decision](../bug-fix/2026-07-29-human-transcript-append-origin.md) and [browser transcript decision](../bug-fix/2026-07-30-web-transcript-log-ordered-projection.md): progress does not require marker scale or a replacement-rendering refactor. Both notes remain active and continue to own append-origin transcript projection and landed checkpoint markers. The [queued manual compaction decision](2026-07-30-queued-manual-compaction.md) remains the owner of bracket ordering, locking, and stale-orphan classification.

## Alternatives considered

**Add `progressLabel` to `CommandDefinition` and a second TUI status controller, as explored in PR #669.** Rejected because command metadata is not the compaction lifecycle authority, automatic compaction does not originate from a human command, and two status controllers can disagree about the same indicator.

**Add `compacting` to `TurnPhase`, as explored in PR #669.** Rejected because standalone compaction deliberately has no turn, while numbered compaction already has a visible running-turn phase.

**Add a fifth `TimingBucket`.** Rejected because timing buckets partition an open model step and feed its transcript footer. Standalone compaction has no step transition, and a new bucket would add a meaningless compaction column to every step total.

**Share one timer among running, fading, and compaction states.** Rejected because fade-out owns a self-terminating timer, while live compaction has an independent open/close lifetime. Sharing would restructure the reviewed animation state machine without removing an actual concurrent timer.

**Scan the log for an unmatched `compact/start`.** Rejected because a stale orphan from an earlier process lifecycle is expected durable history. Only the live notification proves current work.

**Use a generic command-running indicator.** Rejected for this behavior because the compaction bracket is the more precise source and also covers non-command paths. A future generic command indicator belongs to the `command/run` / `command/done` lifecycle.

**Keep only the prompt-caret glyph.** Rejected because the caret is a single peripheral cell, while a slow compaction primarily leaves the user's attention on the transcript. A live transcript row makes the same bracket visible without creating a durable session event.

**Print a success notice with duration.** Rejected because the landed replacement already supplies the completion marker. The bracket timestamps preserve duration for a future presentation that justifies another transcript row.

## Consequences

Manual compaction now has visible liveness in both the transcript and prompt while the agent is idle, failure has a direct warning, and a resumed orphan never looks active. The prompt indicator remains one terminal cell wide, and both presentations share the existing compaction timer, semantic palette, and terminal-progress lifecycle.

The live cell, row, and timer are additional process-local state, cleared on both bracket close and TUI teardown. This is intentionally not reconstructible presentation state: durable history supplies the successful marker and timing facts, while current-process observation alone supplies liveness.

The package-level TUI tests pin standalone start, spinner animation, transcript-tail reattachment, numbered-start exclusion, fade-out, failure warning, idle-status preservation, running-turn precedence, orphaned resume, and timer disposal. The assembled `queued-manual-compact` terminal scenario observes both `dsh ⊙` and `Compaction in progress…` while the real summary boundary is held.
