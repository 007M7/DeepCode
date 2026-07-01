# Session Persistence

The **durability seam** for the event log. [session.md](session.md) describes the in-memory `Session` — the append-only `SessionEvent` log that is the source of truth. This page describes how that log is made durable: the abstract `SessionPersistence` service, its backends, the flush checkpoint, crash recovery, and the metadata header that travels alongside the log.

The seam is a textbook [capability seam](../rfc/implemented/architecture/2026-06-13-capability-seams.md): one abstract service ([dsh-session-persistence](../../packages/session-persistence/session-persistence), `ctx.sessionPersistence`) defining create/append/load/list over the existing `SessionEvent` — **no parallel persisted type** — and two interchangeable backends that pass the same `runPersistenceContract` suite. See the [session-persistence RFC](../rfc/implemented/architecture/2026-06-14-session-persistence.md).

## The flush checkpoint

`session/event` is a *synchronous* notification; persistence plugins buffer it (write-behind) and drain at the awaited `session/flush` checkpoint the loop fires at every turn end. Flush is `ctx.parallel` (awaited): a turn's events are durably committed before the next turn starts, and the turn boundary is the commit boundary. A rejecting flush is reported via `agent/error` and the logger — never as a session event (it would land past the commit boundary), so the backend keeps its buffered events for the next flush.

## Crash recovery preserves an interrupted turn

A backend that reloads a log crashed mid-turn finds an open `turn/start` with no `turn/end`. It does **not** truncate — a single turn can be huge in a long-horizon task (many steps, large tool output), and those events were durably appended before the crash. Instead it closes the orphaned turn with a synthetic `turn/end { reason: { kind: 'interrupted' } }`, keeping the log balanced and the turn-enclosure invariant intact. `interrupted` is the one `TurnEndReason` no loop emits (see [session.md](session.md#why-a-turn-ended-turnendreasonmap)).

## `SessionHeader` — metadata beside the log

Per-session metadata travels **separately** from the event log: format version, cwd, lineage, and the seed boundary are storage concerns, not conversation events, so they stay out of `SessionEventMap` and never reach `deriveMessages()`. The header is attached to a `Session` via `session.header`.

Source: [`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

```ts type-equiv
interface SessionHeader {
  /**
   * On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the
   * session is created. A persistence backend rejects any other version on load
   * (no migration — see the constant).
   */
  version: number
  /** The session's id (mirrors the {@link Session}'s id). */
  id: SessionId
  /** Unix epoch milliseconds when the session was created. */
  createdAt: number
  /** Absolute working directory the session was created in (if any). */
  cwd?: string
  /** The session this one was forked from (seed lineage), if any. */
  parentSession?: SessionId
  /**
   * How many leading events were INHERITED via a seed rather than produced by
   * this session — the seed boundary. Set when a fork seeds a child with a
   * prefix of the parent's log (= the seeded prefix length); absent/0 means the
   * session produced all its own events. Persisted so a reload reconstructs the
   * boundary instead of re-deriving it from the full stored log, and so a replay
   * harness can skip the inherited prefix when deriving the child's OWN script
   * (the seeded events are the parent's, not this child's model calls).
   */
  seedLength?: number
}
```

## `CreateSessionOptions` — seeding and metadata

Creating a `Session` through the store takes a `seed` (replay/fork an existing event log) and `meta` (the storage-level fields the store folds into a `SessionHeader`). The store fills in `version`/`id` and defaults `createdAt`; the caller supplies the validated absolute `cwd`, the `parentSession` lineage, the `seedLength` seed boundary, and — only when reconstructing a persisted session — the original `createdAt` to preserve it.

```ts type-equiv
interface CreateSessionOptions {
  /** Events to seed the new session with (replay/fork). */
  seed?: SessionEvent[]
  /**
   * Creation metadata. The store fills in `version`/`id` and defaults
   * `createdAt` to now; the caller supplies the storage-level fields (validated
   * absolute `cwd`, `parentSession` lineage, the seed boundary `seedLength`, and
   * — when reconstructing a persisted session — the original `createdAt` to
   * preserve it).
   *
   * `seedLength` is EXPLICIT, not inferred from `seed.length`: a reconstruction
   * (resume/load) seeds the WHOLE stored log, so its `seed.length` is the full
   * length, not the original boundary — the caller must pass the persisted
   * boundary back. A fresh fork passes its actual seeded-prefix length.
   */
  meta?: { cwd?: string; parentSession?: SessionId; createdAt?: number; seedLength?: number }
}
```

Replay/fork is therefore `ctx.sessions.create(id, { seed: seedEvents })`; resuming a *persisted* session into a live agent is `ctx.agents.resume({ resumeSessionId })`.

## The backends

Both implement the same abstract `SessionPersistence` (create/append/load/list over `SessionEvent`) and pass `runPersistenceContract`, proving the seam is genuinely backend-agnostic:

- **[dsh-session-persistence-jsonl](../../packages/session-persistence/session-persistence-jsonl)** — an append-only JSONL log per session with crash-safe atomic writes, the interrupted-turn crash recovery above, and a read/replay path.
- **[dsh-session-persistence-sqlite](../../packages/session-persistence/session-persistence-sqlite)** — `node:sqlite`, one row per `SessionEvent`. The row shape `(session_id, seq, type, time, data, source_event_seqs, surface_op)` maps 1:1 onto the event, including optional surface metadata, so there is no parallel persisted schema to keep in sync.

Multiple backends sharing one on-disk session coordinate writes through the [shared persistence write-coordinator](../rfc/implemented/architecture/2026-06-18-shared-persistence-write-coordinator.md).
