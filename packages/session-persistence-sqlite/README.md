# @deepseek-ai/dsh-session-persistence-sqlite

A SQLite durable session-persistence backend — a second `SessionPersistence` implementation ([ADR 0018](../../docs/adr/0018-session-persistence.md)), built to validate that the abstract seam and the shared `runPersistenceContract` suite are genuinely backend-agnostic. It satisfies the SAME contract as `dsh-session-persistence-jsonl` (append-only, contiguous-seq, lazy materialization, interrupted-turn close on load), expressed over `node:sqlite` rows instead of file bytes.

> **TODO:** this backend talks to `node:sqlite` directly. If a cordis database service (`cordis/db` / a `@cordisjs` SQL driver plugin) is adopted, route through that instead of holding a raw `DatabaseSync` here — the contract surface (`SessionPersistence`) would not change, only the storage driver.

## Storage model

Each `SessionEvent` maps 1:1 onto a row in an `events` table `(session_id, seq, type, time, data)` — `data` is the event payload as JSON text, so the row shape is the event verbatim (including `assistant/chunk`, keeping `seq` contiguous). Out-of-log metadata (`SessionMeta`) lives in a `sessions` row, including the mutable `SessionSummary` fields (`updatedAt`, `title`, `firstPrompt`) that `update()` rewrites without touching the event log. A `sessions` row is written only by the first `append` — its existence is the lazy-materialization signal (`has`/`list` report exactly the sessions that have a row), so no separate column is needed.

The repo targets Node ≥ 24 (the root `engines` field), which includes the stable `node:sqlite` module. The database opens with `foreign_keys = ON` (so `ON DELETE CASCADE` drops a session's events with its row) and `journal_mode = WAL`. The table-layout version is stored in `PRAGMA user_version` and checked on open: a fresh database is stamped with the current `SCHEMA_VERSION`; a database written by a newer, incompatible build (higher `user_version`) is rejected rather than opened against an unknown layout.

## Contract semantics over rows

- **Append = a transaction.** `append` runs `BEGIN`/`COMMIT` around the batch: it materializes the `sessions` row (if still lazy) and INSERTs every event, asserting the contiguous-seq contract first (the first event's `seq` must equal the stored next-seq). A mid-batch failure (a UNIQUE violation on a duplicated seq) rolls back entirely, so the stored log and the in-memory cursor stay consistent. (`load()` already balanced the stored log, so `append` never has to repair a crash tail.)
- **Lazy materialization.** `create()` records intent in memory only — no row is written until the first `append`. A created-but-never-appended session has no `sessions` row, so it is absent from `has()`/`list()` (which report exactly the sessions that have a row).
- **Interrupted-turn close on load.** `load()` reads every stored event ordered by `seq` and finds the longest seq-contiguous, parseable prefix — INCLUDING the real events of an interrupted final turn after the last `turn/end` (the loop only flushes at `turn/end`, so a process killed mid-turn leaves real, fully-written rows past it). A single turn can be huge in a long-horizon task, so those events are **preserved, never truncated**: `load()` CLOSES the orphaned turn by durably appending the minimal synthetic boundary events (a `step/end` if a step was open, then a `turn/end` carrying `{ kind: 'interrupted' }`), inside one transaction that also DELETEs any never-fully-written torn tail row. `load()` is therefore mutating — after it the stored rows are balanced and the cursor is truthful, so the next `append` continues cleanly. The boundary (last `turn/end`, torn-tail detection) is computed from the `seq`/`type` columns so a malformed `data` in a torn tail row is never parsed (discarded, not unloadable). A parse error or `seq` gap inside the committed region (at or before the last real `turn/end`) makes the session unloadable. A session whose only turn never closed keeps its metadata row and stays present in `has()`/`list()` — the same as the JSONL backend, whose file likewise survives a first append that never reached `turn/end`.

## Configuration (schemastery)

```ts
interface Config {
  path: string   // SQLite database file path, or ':memory:' for an in-process DB
}
```

## Write path

Like the JSONL backend, the plugin also installs the `session/event` → buffer → `session/flush` drain: it snapshots each event when buffered (the live `session.events` object is mutable), persists a fork's seed once on `session/created`, keeps a per-session write cursor so a resumed session never re-appends stored events, and seeds existing live sessions on apply (HMR does not replay `session/created`). Dispose awaits every in-flight init + final drain and then closes the database, so no write lands after teardown.
