# Agent Note: Record the resume process boundary in the session log

Status: rejected — the boundary belongs at the seeded-`Session` constructor, which also covers fork and replay; superseded by [the end-seed boundary](../../implemented/architecture/2026-07-30-session-end-seed-log-boundary.md)

English | [中文](2026-07-29-session-resumed-log-boundary.zh.md)

## Problem

A session's durable log gave no evidence that it had changed processes. `session/created`, `session/disposed`, and `session/flush` are cordis runtime signals rather than `SessionEventMap` members, and `agent/session-start` carries a `SessionStartSource` but is emit-only and never logged. Reading a stored log therefore gave no hint that anything had been resumed.

That gap makes one class of question unanswerable. A plugin that owns a standalone open/close pair in the log — compaction's `compact/start` … `compact/end` is the only one today — must distinguish an unmatched opening marker left by a process that died mid-operation from one an operation is holding right now. Those two states are **byte-identical in stored history**. Without a boundary the owner has to choose between refusing forever (an unmatched marker wedges the operation permanently, and because automatic compaction failure is warn-and-continue the user-visible result is that compaction silently stops working until the context window overflows) and proceeding always (which defeats the point of holding a lock).

The pressure to fix this is immediate: moving `compact/start` to its real time point, before summarization, widens the crash window from a few microseconds of synchronous appends to the length of a whole model call, so orphaned brackets go from rare to routine.

## Proposal

`@deepseek-ai/dsh-session-persistence` declares one log-only `session/resumed` with an empty payload and appends exactly one at the end of every cold load, in the same `commitRepair` batch as any crash-repair closers and positioned after them — so every event before the boundary has a smaller seq and was written by a writer that is no longer tracking this log. Ownership lands narrowly on `loadCore()`, the cold-load path reached by `load()` and by `adopt()`. `loadLiveSnapshot()` appends nothing, and the non-mutating `inspect()`/`readFrom()` reads never write one.

The predicate a bracket owner evaluates is purely a function of the log: an unmatched opening marker with a `session/resumed` after it is stale, and one with no `session/resumed` after it is live.

`time` is `Date.now()` floored at the log's greatest `time`, deliberately unlike the synthetic closers, which reuse the last real event's timestamp so repair output stays a deterministic function of stored history. The wall clock is not monotonic — an NTP step, a VM restore, or a log copied from a machine that was ahead can put it behind events already stored — so the floor keeps every cross-boundary duration non-negative. The floor is durable, because the clamped boundary is stored and joins the log's maximum: one future-dated event pins every later boundary in that log to the same instant until wall time passes it.

**The predicate distinguishes process succession, not concurrent writers.** `load()`'s liveness guard is `ctx.sessions.get(id)`, which only sees sessions live in *this* runtime, and no backend takes a cross-process per-session lock. So process B cold-loading a session A currently owns writes a boundary after A's still-open bracket. A consumer that must tolerate concurrent writers still needs a liveness signal beyond the log.

## Why this was rejected

Two reasons, found while reviewing where the marker belonged.

**It covers no fork.** `sessions.fork()` and a subagent fork child construct a seeded session without touching persistence, so neither gets a boundary. A forked child inherits its parent's prefix verbatim — including an open `compact/start` the parent is still holding — which is the one case where the inherited bracket's owner is demonstrably alive. The predicate was unavailable exactly where it was most needed.

**Minting the marker at load made a read path a durable write.** Every consequence the review surfaced traced to that: a revision bump on every cold load, a `commitRepair` batch on a balanced log with nothing to repair, the durable time floor above, a load that fails against a read-only store, and a marked log after a resume the caller then cancelled. None of these are wrong given the placement; they are the placement's cost.

The successor keeps the problem statement and the concurrent-writer scope limit unchanged, and moves the write to `Session`'s constructor — the single waist all six seeded-start paths pass through, fork included. Because the marker then rides the ordinary seed-persistence path, the whole durable-write surface above disappears.

## Alternatives considered

**Use `Session.firstLiveSeq` as the staleness predicate.** Dismissed here on the grounds that it is documented as deliberately not persisted, so the same stored log yields different answers in different processes and a read-only reader cannot evaluate it at all. That reasoning was sound about the field and wrong about the conclusion: the fix is to persist a projection of it rather than to compute the boundary somewhere else. This is the alternative that became the successor.

**Declare the event in core (`dsh-session`).** Rejected here because "the constructor cannot distinguish resume from fork or replay." That is true and turned out not to matter — the distinction is not needed, since inherited history is dead history in all three cases.

**Teach `interruptedTurnClosers` to close `compact/*`.** Rejected: `compact/*` is plugin-owned vocabulary and core must not know it. Core closes turn, step, and tool boundaries — the relations it owns. The successor keeps this rejection.

**Lazy self-repair: the owner appends a synthetic closing marker when it finds an orphan.** A write inside a read-shaped check, and it needs an invariant exception for a numbered owner whose turn has already closed.

**A merge-extensible repair-contributor registry in core.** The right shape once a second consumer exists; with one consumer today, `packages/AGENTS.md` says not to split a seam preemptively.

**Write the boundary only when repair actually occurred.** Rejected: the predicate must hold for an orderly restart too, where there is nothing to repair. The successor keeps this rejection.

## Related

The cold-session `updatedAt` skew this proposal documented is scoped in [the last-activity-index Agent Note](../../proposed/architecture/2026-07-29-durable-last-activity-index.md). That defect predates this proposal and survives its rejection: it is caused by mtime counting every durable write, not by any one boundary.
