# Session Persistence

English | [中文](persistence.zh.md)

The **durability seam** for the event log. [session.md](session.md) describes the in-memory `Session` — the append-only `SessionEvent` log that is the source of truth. This page describes how that log is made durable: the abstract `SessionPersistence` service, its backends, the flush checkpoint, crash recovery, and the metadata header that travels alongside the log. The event vocabulary the log carries is enumerated, member by member, in the generated [persistence log event catalog](../persistence-catalog.md).

The seam is a textbook [capability seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md): one abstract service ([dsh-session-persistence](../../packages/session-persistence/session-persistence), `ctx.sessionPersistence`) defining locate/create/append, crash-repairing load, non-mutating inspect, and lightweight list/snapshot observation over the existing `SessionEvent` — **no parallel persisted type** — and two interchangeable backends that pass the same `runPersistenceContract` suite. See the [session-persistence Agent Note](../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md).

## The flush checkpoint

`session/event` is a *synchronous* notification; persistence plugins copy the event into a per-session controller and start an eager write without blocking the producer. Concurrent events share the current batch, and events admitted during that write trigger a follow-up batch. `session/flush` waits until no current or pending batch remains, so the loop still uses it as the ordering and error-observation checkpoint before claiming the next ordinary turn. A rejected eager write retains its events; an explicit flush retries them and reports failure through `agent/error` and the logger, never as a session event past the closed turn. Disposal performs the same final drain.

## Crash recovery preserves an interrupted turn

A backend that reloads a log crashed mid-turn finds an open `turn/start` with no `turn/end`. It does **not** truncate — a single turn can be huge in a long-horizon task (many steps, large tool output), and those events were durably appended before the crash. Instead it closes the orphaned turn with a synthetic `turn/end { reason: { kind: 'interrupted' } }`, keeping the interrupted execution balanced without changing any standalone events before or after it. `interrupted` is the one `TurnEndReason` no loop emits (see [session.md](session.md#why-a-turn-ended-turnendreasonmap)).

Repair applies only to cold sessions. For a live id, `SessionPersistence.load(id)` snapshots the in-memory log, waits until that snapshot is durable, and returns it with the stored header only when balanced; an open live turn rejects rather than receiving synthetic interruption boundaries. A coordinator-backed cold load reserves the id across backend reads and repair writes, so concurrent publication of a same-id live session rejects and rolls back. HMR also adopts a live prefix without closing its active turn.

`SessionPersistence.inspect(id)` is the observer counterpart to recovery: it returns a detached valid stored prefix without truncating a torn record, adding interruption closers, or publishing write state. Same-id serialization keeps it coherent with backend writes. Derived read models use `inspect`, never `load`, so observing a checkpointed open turn cannot mutate the log if live ownership begins concurrently.

## `SessionLocation` — optional per-session artifact target

`SessionPersistence.locate(meta)` synchronously resolves a backend-owned independent artifact without reading, creating, or flushing it. JSONL returns the absolute transcript path inside its project/session directory; SQLite returns `undefined` because sessions share one database. A returned path can therefore name a file that does not yet exist or lacks the current unflushed turn; it is a location hint, not authorization or a freshness guarantee.

```ts type-equiv
/**
 * A backend-resolved, per-session local artifact location. The path is an
 * absolute target path and can name an artifact that has not materialized yet.
 * Consumers must treat it as a location hint, never as an authorization token.
 */
interface SessionLocation {
  /** Backend-specific artifact kind, for example `jsonl`. */
  readonly kind: string
  /** Absolute path to this session's backend-owned artifact. */
  readonly path: string
}
```

## `SessionHeader` — metadata beside the log

Per-session metadata travels **separately** from the event log: format version, cwd, lineage, and the seed boundary are storage concerns, not conversation events, so they stay out of `SessionEventMap` and never reach `deriveMessages()`. The header is attached to a `Session` via `session.header`.

Source: [`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

```ts type-equiv
/**
 * Immutable validated storage metadata, kept outside the conversation event log.
 */
interface SessionHeader {
  /**
   * On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the
   * session is created. A persistence backend rejects any other version on load
   * (no migration — see the constant).
   */
  readonly version: number
  /** The session's id (mirrors the {@link Session}'s id). */
  readonly id: SessionId
  /** Non-negative safe-integer Unix epoch milliseconds when the session was created. */
  readonly createdAt: number
  /** Absolute working directory the session was created in (if any). */
  readonly cwd?: string
  /** The session this one was forked from (seed lineage), if any. */
  readonly parentSession?: SessionId
  /**
   * How many leading events were inherited through a seed. Persisting this
   * boundary lets resume and replay distinguish parent history from child work.
   */
  readonly seedLength?: number
  /**
   * Delegation depth: absent (zero) for a top-level session, parent depth + 1
   * for a subagent child. Persisted so a recursion budget survives restart and
   * resume — a runtime-only depth would reset a resumed child to top-level.
   */
  readonly delegationDepth?: number
}
```

## `CreateSessionOptions` — seeding and metadata

Creating a `Session` through the store takes a `seed` (initial replay or fork history) and `meta` (the storage-level fields the store folds into a `SessionHeader`). The store fills in `version`/`id` and defaults `createdAt`; the caller supplies the validated absolute `cwd`, the `parentSession` lineage, the `seedLength` seed boundary, the `delegationDepth`, and — only when reconstructing a persisted session — the original `createdAt` to preserve it.

```ts type-equiv
/**
 * Options for creating a {@link Session} via the store. `seed` replays/forks
 * an existing event log; `meta` carries the caller-supplied storage fields the
 * store folds into a {@link SessionHeader}.
 */
interface CreateSessionOptions {
  /** Initial replay or fork history supplied at construction. */
  readonly seed?: readonly SessionEvent[]
  /**
   * Storage metadata read once before publication. `seedLength` is explicit
   * because a resumed seed contains the full stored log, not only its inherited prefix.
   */
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly createdAt?: number
    readonly seedLength?: number
    readonly delegationDepth?: number
  }
}
```

Replay/fork is therefore `ctx.sessions.create(id, { seed: seedEvents })`; resuming a *persisted* session into a live agent is `ctx.agents.resume({ resumeSessionId })`.

## Lightweight source revisions

Consumers of derived state compare a cheap opaque revision before loading a full event log. The persistence backend owns its representation and changes it transactionally with append or mutating load repair; callers compare it only for equality.

```ts type-equiv
/**
 * Backend-owned token that identifies both one storage source and one revision
 * of a persisted session log.
 */
type SessionPersistenceRevision = Branded<'SessionPersistenceRevision'>
```

```ts type-equiv
/** Lightweight immutable source identity returned without loading a full log. */
interface SessionPersistenceSnapshot {
  /** Detached metadata for one materialized session. */
  header: SessionHeader
  /** Opaque source-qualified token that changes whenever this stored log changes. */
  revision: SessionPersistenceRevision
}
```

## The backends

Both implement the same abstract `SessionPersistence` (locate/create/append/load/inspect/list/listSnapshots over `SessionEvent`, with optional cancellation on observation methods) and pass `runPersistenceContract`, proving the seam is genuinely backend-agnostic:

- **[dsh-session-persistence-jsonl](../../packages/session-persistence/session-persistence-jsonl)** — an append-only logical JSONL log per session, stored as checksummed concatenated Zstandard frames by default or raw lines by configuration, with crash-safe atomic writes, interrupted-turn recovery, and a read/replay path.
- **[dsh-session-persistence-sqlite](../../packages/session-persistence/session-persistence-sqlite)** — `node:sqlite`, one row per `SessionEvent`. The row shape `(session_id, seq, type, time, data, source_event_seqs, surface_op)` maps 1:1 onto the event, including optional surface metadata, so there is no parallel persisted schema to keep in sync.
