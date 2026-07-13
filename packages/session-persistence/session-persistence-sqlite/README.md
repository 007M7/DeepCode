# @deepseek-ai/dsh-session-persistence-sqlite

A SQLite durable session-persistence backend — a second `SessionPersistence` implementation ([session persistence](../../../docs/rfc/implemented/architecture/2026-06-14-session-persistence.md)), built to validate that the abstract seam and the shared `runPersistenceContract` suite are genuinely backend-agnostic. It satisfies the SAME contract as `dsh-session-persistence-jsonl` (append-only, contiguous-seq, lazy materialization, interrupted-turn close on load), expressed over `node:sqlite` rows instead of file bytes.

> **TODO:** this backend talks to `node:sqlite` directly. If a cordis database service (`cordis/db` / a `@cordisjs` SQL driver plugin) is adopted, route through that instead of holding a raw `DatabaseSync` here — the contract surface (`SessionPersistence`) would not change, only the storage driver.

## Storage model

Each `SessionEvent` maps 1:1 onto a row in an `events` table `(session_id, seq, type, time, data, source_event_seqs, surface_op)` — `data` is the event payload as JSON text, so the row shape is the event verbatim (including `assistant/chunk`, keeping `seq` contiguous). The two `TEXT` columns `source_event_seqs` and `surface_op` are nullable; they store the event's optional surface-metadata fields (see [session surface](../../../docs/rfc/implemented/architecture/2026-06-18-session-surface.md)). Out-of-log metadata (`SessionHeader`) lives in a `sessions` row. A `sessions` row is written only by the first `append` — its existence is the lazy-materialization signal (`list` reports exactly the sessions that have a row), so no separate column is needed.

The repository's Node range supports unflagged `node:sqlite`. The database enables foreign keys and uses the configured journal mode (`wal` by default; use a rollback mode where WAL shared-memory files are unsuitable). `PRAGMA user_version` stores the table-layout version; databases with any other version are rejected because this unreleased format has no migrations.

## Contract semantics over rows

- **Append = a transaction.** `append` runs `BEGIN`/`COMMIT` around the batch: it materializes the `sessions` row (if still lazy) and INSERTs every event, asserting the contiguous-seq contract first (the first event's `seq` must equal the stored next-seq). A mid-batch failure (a UNIQUE violation on a duplicated seq) rolls back entirely, so the stored log and the in-memory cursor stay consistent. (`load()` already balanced the stored log, so `append` never has to repair a crash tail.)
- **Lazy materialization.** `create()` records intent in memory only — no row is written until the first `append`. A created-but-never-appended session has no `sessions` row, so it is absent from `list()` (which reports exactly the sessions that have a row).
- **Interrupted-turn close on load.** `load()` implements the shared [crash-recovery contract](../../../docs/rfc/implemented/architecture/2026-06-14-session-persistence.md): preserve the valid interrupted turn, append its synthetic closing events in one transaction, and remove only a torn tail row. Committed parse errors or sequence gaps make the session unloadable. Because recovery mutates stored rows, the next append starts from a balanced log and accurate cursor.

## Configuration (schemastery)

```ts
interface Config {
  path: string   // SQLite database file path, or ':memory:' for an in-process DB
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'   // journal_mode pragma; default 'wal'
}
```

## Write path

Like the JSONL backend, the plugin also installs the `session/event` → buffer → `session/flush` drain: it copies each already-frozen event into a persistence-owned buffer, persists a fork's seed once on `session/created`, keeps a per-session write cursor so a resumed session never re-appends stored events, and seeds existing live sessions on apply (HMR does not replay `session/created`). Dispose awaits every in-flight init + final drain and then closes the database, so no write lands after teardown.
