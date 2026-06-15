# @deepseek-ai/dsh-session-persistence-sqlite

A SQLite durable session-persistence backend — a second `SessionPersistence` implementation ([ADR 0016](../../docs/adr/0016-session-persistence.md)), built to validate that the abstract seam and the shared `runPersistenceContract` suite are genuinely backend-agnostic. It satisfies the SAME contract as `dsh-session-persistence-jsonl` (append-only, contiguous-seq, lazy materialization, crash-tail-on-load), expressed over `node:sqlite` rows instead of file bytes.

## Storage model

Each `SessionEvent` maps 1:1 onto a row in an `events` table `(session_id, seq, type, time, data)` — `data` is the event payload as JSON text, so the row shape is the event verbatim (including `assistant/chunk`, keeping `seq` contiguous). Out-of-log metadata (`SessionMeta`) lives in a `sessions` row, including the mutable `SessionSummary` fields (`updatedAt`, `title`, `firstPrompt`) that `update()` rewrites without touching the event log.

`node:sqlite` requires Node ≥ 22.5 (this repo runs Node ≥ 24); the database opens with `foreign_keys = ON` (so `ON DELETE CASCADE` drops a session's events with its row) and `journal_mode = WAL`.

## Contract semantics over rows

- **Append = a transaction.** `append` runs `BEGIN`/`COMMIT` around the batch: it materializes the `sessions` row (if still lazy) and INSERTs every event, asserting the contiguous-seq contract first (the first event's `seq` must equal the stored next-seq). A mid-batch failure (a UNIQUE violation on a duplicated seq) rolls back entirely, so the stored log and the in-memory cursor stay consistent.
- **Lazy materialization.** `create()` records intent in memory only — no row is written until the first `append`. A created-but-never-appended session is absent from `has()`/`list()` (a `materialized` flag on the row, set inside the first append transaction; `has`/`list` filter to materialized rows).
- **Crash-tail-on-load.** `load()` reads every stored event ordered by `seq` and returns only the prefix through the **last complete `turn/end`** (the `SessionPersistence.load` contract). A batch that landed without its closing `turn/end` (a process killed mid-turn) is an uncommitted tail and is deleted on load; a `seq` gap inside the committed region makes the session unloadable.

## Configuration (schemastery)

```ts
interface Config {
  path: string   // SQLite database file path, or ':memory:' for an in-process DB
}
```

## Write path

Like the JSONL backend, the plugin also installs the `session/event` → buffer → `session/flush` drain: it snapshots each event when buffered (the live `session.events` object is mutable), persists a fork's seed once on `session/created`, keeps a per-session write cursor so a resumed session never re-appends stored events, and seeds existing live sessions on apply (HMR does not replay `session/created`). Dispose awaits every in-flight init + final drain and then closes the database, so no write lands after teardown.
