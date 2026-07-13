# @deepseek-ai/dsh-session-persistence-sqlite

A SQLite durable session-persistence backend — a second `SessionPersistence` implementation ([session persistence](../../../docs/rfc/implemented/architecture/2026-06-14-session-persistence.md)), built to validate that the abstract seam and the shared `runPersistenceContract` suite are genuinely backend-agnostic. It satisfies the SAME contract as `dsh-session-persistence-jsonl` (append-only, contiguous-seq, lazy materialization, interrupted-turn close on load), expressed over `node:sqlite` rows instead of file bytes.

> **TODO:** this backend talks to `node:sqlite` directly. If a cordis database service (`cordis/db` / a `@cordisjs` SQL driver plugin) is adopted, route through that instead of holding a raw `DatabaseSync` here — the contract surface (`SessionPersistence`) would not change, only the storage driver.

## Storage model

Each `SessionEvent` maps 1:1 onto a row in an `events` table `(session_id, seq, type, time, data, source_event_seqs, surface_op)` — `data` is the event payload as JSON text, so the row shape is the event verbatim (including `assistant/chunk`, keeping `seq` contiguous). The two `TEXT` columns `source_event_seqs` and `surface_op` are nullable; they store the event's optional surface-metadata fields (see [session surface](../../../docs/rfc/implemented/architecture/2026-06-18-session-surface.md)). Out-of-log metadata (`SessionHeader`) lives in a `sessions` row. A `sessions` row is written only by the first `append` — its existence is the lazy-materialization signal (`list` reports exactly the sessions that have a row), so no separate column is needed.

The repo's `engines.node` is `^22.19.0 || >=24.0.0` (Node 22.19+ or 24+), matching the LTS floor required by the installed Pi adapter dependency; `node:sqlite` itself ships without the `--experimental-sqlite` flag from Node 22.13 (LTS) and 23.4 / 24 (Current) on. The range deliberately excludes Node 23 because that line is non-LTS/EOL and still has flagged runtime features before 23.6. The database opens with `foreign_keys = ON` (so `ON DELETE CASCADE` drops a session's events with its row) and the configured `journal_mode` (default `wal`; pick a rollback-journal mode like `delete` on filesystems where WAL's shared-memory files do not work, e.g. network mounts). The table-layout version is stored in `PRAGMA user_version` and checked on open: a fresh database is stamped with the current `SCHEMA_VERSION`; a database written by any other, incompatible build (a non-current `user_version`, older or newer) is rejected rather than opened against an unknown layout — there is no migration (unreleased software).

## Contract semantics over rows

- **Append = a transaction.** `append` runs `BEGIN`/`COMMIT` around the batch: it materializes the `sessions` row (if still lazy) and INSERTs every event, asserting the contiguous-seq contract first (the first event's `seq` must equal the stored next-seq). A mid-batch failure (a UNIQUE violation on a duplicated seq) rolls back entirely, so the stored log and the in-memory cursor stay consistent. (`load()` already balanced the stored log, so `append` never has to repair a crash tail.)
- **Lazy materialization.** `create()` records intent in memory only — no row is written until the first `append`. A created-but-never-appended session has no `sessions` row, so it is absent from `list()` (which reports exactly the sessions that have a row).
- **Interrupted-turn close on load.** `load()` reads every stored event ordered by `seq` and finds the longest seq-contiguous, parseable prefix — INCLUDING the real events of an interrupted final turn after the last `turn/end` (the loop only flushes at `turn/end`, so a process killed mid-turn leaves real, fully-written rows past it). A single turn can be huge in a long-horizon task, so those events are **preserved, never truncated**: `load()` CLOSES the orphaned turn by durably appending the minimal synthetic boundary events (an error `tool/result` for every assistant tool call left unanswered, a `step/end` if a step was open, then a `turn/end` carrying `{ kind: 'interrupted' }`), inside one transaction that also DELETEs any never-fully-written torn tail row. `load()` is therefore mutating — after it the stored rows are balanced and the cursor is truthful, so the next `append` continues cleanly. The boundary (last `turn/end`, torn-tail detection) is computed from the `seq`/`type` columns so a malformed `data` in a torn tail row is never parsed (discarded, not unloadable). A parse error or `seq` gap inside the committed region (at or before the last real `turn/end`) makes the session unloadable. A session whose only turn never closed keeps its metadata row and stays present in `list()` — the same as the JSONL backend, whose file likewise survives a first append that never reached `turn/end`.

## Configuration (schemastery)

```ts
interface Config {
  path: string   // SQLite database file path, or ':memory:' for an in-process DB
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'   // journal_mode pragma; default 'wal'
}
```

## Write path

Like the JSONL backend, the plugin also installs the `session/event` → buffer → `session/flush` drain: it copies each already-frozen event into a persistence-owned buffer, persists a fork's seed once on `session/created`, keeps a per-session write cursor so a resumed session never re-appends stored events, and seeds existing live sessions on apply (HMR does not replay `session/created`). Dispose awaits every in-flight init + final drain and then closes the database, so no write lands after teardown.

## Model Experience

### Resumed conversation history

**What the model sees**: SQLite storage contributes no live prompt or schema. Loading restores the same surface history as JSONL and preserves prior headers for reconstruction; the new loop composes its current envelope. Each unanswered call in interrupted rows is balanced with the exact error text `Tool call interrupted by a crash; no result was recorded.` Row metadata and raw chunks are not messages.

**Token effect**: Zero live-request tokens. Resume restores retained history and pays the current envelope, plus the quoted repair result for each interrupted call.

## Known Limitations and Deferred Work

- **Raw `node:sqlite`, pending a cordis database service** — the backend holds a `DatabaseSync` directly; if a `cordis/db` / `@cordisjs` SQL driver is adopted, the storage driver routes through it (the `SessionPersistence` contract would not change) — a marked TODO.
- **`DatabaseSync` is synchronous** — every append transaction blocks the event loop for its duration; acceptable for local stores, a throughput ceiling for busy multi-session servers.
- **Write contention has no wait or retry policy** — the backend sets no busy timeout and retries no locked-database error, so another connection holding a write transaction makes the operation reject immediately.
- **Only the current `SCHEMA_VERSION` opens** — a database with any other schema version is rejected rather than migrated (unreleased software; no persisted user data to preserve).
- **Nothing deletes stored sessions** — rows accumulate until removed externally (the seam has no deletion surface; `ON DELETE CASCADE` is wired for such out-of-band cleanup).
