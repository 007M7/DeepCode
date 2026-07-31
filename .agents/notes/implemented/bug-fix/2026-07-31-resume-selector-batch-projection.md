# Agent Note: Resume selector batch projection

Status: implemented

English | [中文](2026-07-31-resume-selector-batch-projection.zh.md)

## Problem

Opening the TUI `/resume` selector called `sessionQuery.readSession()` once per listed session under an unbounded `Promise.all`. Each call re-listed the whole persistence store inside `SessionCorpus.load()` (O(N²) listings), read and decompressed the complete log, replay-validated every event through the `Session` constructor, and deep-cloned the header and events up to three times — all to derive one selector row's title, last-activity time, last `turn/end` label, provider/model route, and goal phase. On a real store (185 sessions, 87 MB compressed, ~353k events) the selector took tens of seconds to open, and the cost grows with total log size rather than session count.

## Decision

`SessionQueryService` exposes the existing internal `SessionCorpus.projectMany` batch as public `projectSessions(sessionIds, project, signal?)`: one persistence listing, at most `persistedInspectConcurrency` concurrent persisted inspections, per-id failure isolation, and a synchronous projector over a borrowed `LogicalSessionSource` with no replay validation and no cloning. `readTitleSnapshots` now routes through it; `LogicalSessionSource` and `LogicalProjectionResult` are exported and documented in the session-query core-data-structures page.

The `/resume` selector builds all candidate rows from one `projectSessions` batch; a rejected projection degrades to that row's disabled "Unreadable session" fallback exactly as a failed `readSession` did. `summarizeResumeCandidate` takes the borrowed source and retains only the record and derived scalars. The pre-handoff preflight still reads the single chosen session through `readSession`, keeping full replay validation before the process re-execs; its redundant live-session shortcut was dropped because `readSession` is already live-preferred.

## Alternatives considered

**Fix only the O(N²) listing inside `SessionCorpus.load()`.** Rejected as the primary fix: the per-candidate full decompress, replay validation, and triple clone dominate on large logs and remain O(total log bytes). The redundant pre-listing in `load()` is still a candidate cleanup, but it changes not-found/consistency error semantics and is not needed once the selector stops calling `readSession` per row.

**A resume-specific summary method on `sessionQuery`.** Rejected: resume is a TUI concept, and the service seam should not import consumer vocabulary. The generic synchronous projection mirrors the seam `readTitleSnapshots` already used internally and lets the TUI own its fold.

**A persisted summary index (e.g. in the SQLite query backend).** Rejected for now: one bounded pass over the store (~1–3 s on the measured machine) is acceptable selector latency, and an index adds an invalidation contract. Reintroduce if stores grow to where one bounded pass is still too slow.

## Consequences

Opening `/resume` performs one listing plus one bounded-concurrency pass instead of N listings and N validated full copies; memory stays bounded by the concurrency limit because each projected log is released before its worker dequeues another id. Selector rows are no longer replay-validated — a log that lists and parses but would fail replay shows as a normal row until preflight rejects it, which preflight always re-checks before handoff. Fake `sessionQuery` services in TUI tests must now provide `projectSessions` alongside `listSessions`/`readSession`.
