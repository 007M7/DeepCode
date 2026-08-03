# Agent Note: Resume selector folds titles only

Status: implemented

English | [中文](2026-07-31-resume-selector-batch-projection.zh.md)

## Problem

Opening the TUI `/resume` selector called `sessionQuery.readSession()` once per listed session under an unbounded `Promise.all`. Each call re-listed the whole persistence store inside `SessionCorpus.load()` (O(N²) listings), read and decompressed the complete log, replay-validated every event through the `Session` constructor, and deep-cloned the header and events up to three times — all to derive one selector row's title, last-activity time, last `turn/end` label, provider/model route, and goal phase. On a real store (185 sessions, 87 MB compressed, ~353k events) the selector took tens of seconds to open, and the cost grew with total log size rather than session count.

## Decision

Selector rows fold nothing but titles, and everything else a row shows comes from metadata:

- Titles come from the existing public batch `readTitleSnapshots` — one persistence listing, at most `persistedInspectConcurrency` concurrent inspections, per-id failure isolation. This is the selector's only per-log read; a rejected title read degrades to that row's disabled "Unreadable session" fallback.
- The activity timestamp never reads a log: a live session uses its last in-memory event time; a persisted session stats the artifact named by the optional `sessionPersistence.locate()` (mtime), falling back to the header's creation time when the backend locates no per-session artifact (SQLite) or the stat fails. Any append moves the mtime, so a mere pickup boundary now floats a browsed session up — accepted as the price of a metadata-only timestamp.
- The last-turn label, provider/model route, and goal phase columns are gone from rows. Route availability is now enforced by the Enter-time preflight, which fully reads and replay-validates the one chosen log through `readSession` before handoff.

The selector overlay opens synchronously when `/resume` dispatches, before the scan settles: an `undefined` candidate set renders a "Loading sessions…" placeholder, the picker owns terminal input from its first frame, Enter reports that sessions are still loading, and Escape cancels. Closing the overlay aborts the scan through the `AbortSignal` the query methods accept; a signal-ignoring backend's late settlement is dropped by a staleness check. The finished scan swaps rows in through `setCandidates` (clearing a stale still-loading error) without replacing the overlay; a queued activation behind a closing predecessor receives an already-scanned set at construction; one catch spans listing, titles, and mtimes, so any scan failure closes the overlay and reports a notice rather than stranding the loading placeholder.

The change is confined to the TUI package: no session-query or session-persistence surface changed.

## Alternatives considered

**Keep per-row route/turn/goal columns via a generic batch projection (`projectSessions`).** Implemented first, then rejected: it still decompressed and parsed every log on every `/resume`, so browsing cost stayed O(total log bytes), and it grew the session-query public API for one consumer. The public seam was reverted; `readTitleSnapshots` keeps using the internal `projectMany` unchanged.

**Fix only the O(N²) listing inside `SessionCorpus.load()`.** Rejected as the primary fix: the per-candidate full decompress, replay validation, and triple clone dominated on large logs. The redundant pre-listing in `load()` remains a candidate cleanup with error-semantics implications.

**Surface a last-modified time through `listSnapshots`/`SessionRecord`.** Cleanest seam-wise, but touches the persistence contract, both backends, and the query record shape for what the TUI can already derive from `locate()` plus one stat. Reintroduce if a second consumer needs metadata activity times.

**A persisted summary/title index.** Rejected for now: one bounded title pass is acceptable selector latency, and an index adds an invalidation contract. Reintroduce if title reads over large stores become the bottleneck.

## Consequences

Opening `/resume` performs one listing, one stat per persisted row, and one bounded title pass instead of N listings and N validated full copies. Rows show title, timestamp, status, and id only; route problems surface as an Enter-time preflight error instead of a disabled row, and a session that fails replay is caught by preflight rather than the listing. Browsed-then-abandoned sessions float up on their pickup mtime. Fake `sessionQuery` services in TUI tests provide `readTitleSnapshots` alongside `listSessions`/`readSession`, and the test harness forwards an optional `locate`. Because the picker takes focus immediately, starting a second scan requires dismissing the current overlay first — a second `/resume` typed during a scan lands in the search field, which is the intended input capture.
