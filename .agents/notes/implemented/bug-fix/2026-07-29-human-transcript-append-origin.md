# Agent Note: The human transcript projects append-origin events

Status: implemented

English | [中文](2026-07-29-human-transcript-append-origin.zh.md)

## Problem

The terminal and the host history gateway both treated the model-visible surface as the human transcript. A successful compaction replaces a surface range with one checkpoint node, so the moment that replacement landed the terminal dropped every message it shadowed — conversation the user had already read — and re-ran that destructive rebuild on any later replacement. The same confusion reached pagination: `maxMessages` counted every `user/message`, `assistant/message`, and `steering/message` in the window, so a model-only replacement copy consumed a page slot the human never filled, and the cut could land between a compaction's log-only provenance and the replacement that cites it.

Nothing was lost from the log. `Session.events` still held every original message and full tool result; the surface only decides what the model is sent next. The defect was entirely in the projection.

## Decision

Model and human projections are separate, and the event's own marker decides which one an event belongs to. `dsh-session` exports the marker split `isAppendSurfaceEvent(event)` and `isReplacementSurfaceEvent(event)` over the two `SurfaceOp` variants, from the browser-safe `surface` module. Append-origin events are the durable source for a transcript; replacement copies stay model-only. Everything that must send exactly what the model sees — `deriveMessages`, token accounting, the compaction backends, tool pairing, injected-context liveness, cross-session reference projection — keeps reading `session.surface`.

The terminal replays the transcript from append-origin surface events and keeps a shadowed step's tool cards paired through `transcriptToolCallIds`, which reads the append-origin `assistant/message` rather than surface membership. A landed compaction contributes one dim `… earlier context was compacted …` row at its own log position: the marker reports where the model stopped seeing that history instead of erasing it. The framed checkpoint payload never renders, and the replay and live paths share one rule, so a compaction that arrives live and the same log replayed after resume produce the same transcript.

A checkpoint is recognized through the compaction seam's own contract — `isCompactCheckpointSource`, the backend-independent marker `CompactService` requires on the replacement user message — so the terminal depends on the declared vocabulary, not on the shape of the replacement. `dsh-session-reference` already consumes that predicate to project another session's log; this is the same question asked by a different reader. Other replacements are silent: a pruned `tool/result` and a regenerated `assistant/message` rewrite one node for the model and mark no boundary in the conversation.

`session.history` counts only append-origin human messages toward `maxMessages`. Each page remains one contiguous raw event range, so a compaction's `compact/summary` provenance stays on the page of the replacement that cites it.

No persisted event, RPC envelope, compaction transaction, or model-visible surface changed, and no migration is required.

## Deferred

The browser client still builds its conversation from the model surface through `FoldAdapter`, so compaction still collapses web history to a single context row. The same predicate is the fix there, together with an append-order transcript projection and a marker component; that work is a separate change against `packages/client/runtime` and `packages/client/ui-conversation`. Rendering compaction *progress* — a terminal indicator while a compaction runs — needs the bracket-first ordering that the queued manual `/compact` work introduces, and is likewise out of scope here.

## Alternatives considered

**Recognize a checkpoint by shape (a replacement `user/message`).** Rejected: it reads a coincidence of today's producers instead of a declared contract, and any future producer that replaces a range with a user message would silently inherit the compaction marker. The seam already publishes `COMPACT_CHECKPOINT_SOURCE` precisely so consumers can recognize a checkpoint independently of the backend.

**Keep rendering the checkpoint as an injected-context card.** Rejected: the framed checkpoint is an instruction envelope written for the model, not human conversation content. Showing it while hiding the history it replaced inverts what the reader needs.

**Persist a second display transcript.** Rejected: the append-only log already contains the authoritative source material, so a parallel record buys nothing and adds migration and consistency work.

**Derive the marker from the `compact/*` bracket instead of the checkpoint.** Rejected for the transcript: the bracket is a pair of time-point markers around an operation, while the transcript needs the position where the surface actually changed. The bracket is the right source for progress and duration, which this change does not render.

**Classify events by re-folding the log, as `session-query` does for search (`current` / `shadowed` / `log-only`).** Rejected: a fold answers a whole-log question, while a projection asks a per-event one that the event's own marker already answers in constant time.

## Consequences

Compaction no longer erases terminal history; a session compacted several times shows one marker per landed compaction, in log order. Pagination pages can carry more raw events than before, because quota is spent only on messages a human or model actually produced.

`dsh-tui` gains a dependency on the `dsh-compact` seam for one pure predicate, mirroring `dsh-session-reference`'s existing use. The terminal still needs no compaction backend at runtime.

Two behaviors changed with their tests. The surface-replacement terminal test previously pinned erasure ("hides shadowed tool calls") and now pins preservation plus exactly one marker, including a pruned result copy, a regenerated assistant message, and a foreign plugin's replacement all rendering nothing. The compaction snapshot scenario wrote a `workspace-context` source while claiming to pin compaction; it now writes a real checkpoint source, and its three fixtures are re-recorded to show the preserved prompt, the full tool card, and the marker.
