/**
 * Schema + load-time helpers for the SQLite session-persistence backend: the
 * DDL (a `sessions` metadata table and a 1:1 `events` row per `SessionEvent`),
 * the database open/configure step, and the last-`turn/end` cut that gives the
 * SQLite backend the SAME crash-tail-on-load semantics as the JSONL backend.
 *
 * @module dsh-session-persistence-sqlite/schema
 */

import { DatabaseSync } from 'node:sqlite'
import type { SessionEvent, SessionId, SessionMeta } from '@deepseek-ai/dsh-session'

/**
 * The on-disk schema version. Bumped only on a breaking change to the table
 * layout; orthogonal to a session's own `version` (which versions the EVENT
 * vocabulary, stored per session in the `sessions` row).
 */
export const SCHEMA_VERSION = 1

/**
 * A row of the `sessions` table — the out-of-log metadata (`SessionMeta`). The
 * row's EXISTENCE is the materialization signal: it is written only by the
 * first `append` (lazy materialization), so a created-but-never-appended
 * session has no row and is absent from `has`/`list`, mirroring the JSONL
 * backend's "no file until first append".
 */
export interface SessionRow {
  id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  updated_at: number
  title: string | null
  first_prompt: string | null
}

/** An `events` table row: one `SessionEvent` mapped 1:1 (`data` is JSON text). */
export interface EventRow {
  seq: number
  type: string
  time: number
  data: string
}

/**
 * Open the database at `path` and apply the schema + pragmas. `foreign_keys`
 * makes `ON DELETE CASCADE` drop a session's events with its row; `journal_mode
 * = WAL` matches the durability model the ADR records (the row shape maps 1:1
 * onto `SessionEvent`; opencode runs this exact shape on SQLite/WAL).
 *
 * The table-layout version is persisted in SQLite's `PRAGMA user_version` and
 * checked on open: a fresh database (user_version 0) is stamped with the
 * current {@link SCHEMA_VERSION}; an existing database with a NEWER version
 * (written by a future, incompatible build) is rejected rather than opened
 * against a layout this build does not understand. (An older-but-compatible
 * version would be migrated here when migrations exist; v1 has none.)
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  // `PRAGMA user_version` always returns exactly one row { user_version }.
  const { user_version: onDisk } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (onDisk > SCHEMA_VERSION) {
    db.close()
    throw new Error(`session database at "${path}" has schema version ${onDisk}, newer than this build supports (${SCHEMA_VERSION})`)
  }
  if (onDisk === 0) {
    // Fresh (or pre-versioning) database: stamp the current layout version.
    // PRAGMA does not accept bound parameters, so interpolate the integer
    // constant (SCHEMA_VERSION is a trusted in-code number, not user input).
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id             TEXT PRIMARY KEY,
      version        INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      cwd            TEXT,
      parent_session TEXT,
      updated_at     INTEGER NOT NULL,
      title          TEXT,
      first_prompt   TEXT
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq        INTEGER NOT NULL,
      type       TEXT NOT NULL,
      time       INTEGER NOT NULL,
      data       TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    ) STRICT
  `)
  return db
}

/** Reconstruct the full {@link SessionMeta} from a `sessions` row. */
export function rowToMeta(row: SessionRow): SessionMeta {
  return {
    version: row.version,
    id: row.id as SessionId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...row.cwd !== null ? { cwd: row.cwd } : {},
    ...row.parent_session !== null ? { parentSession: row.parent_session as SessionId } : {},
    ...row.title !== null ? { title: row.title } : {},
    ...row.first_prompt !== null ? { firstPrompt: row.first_prompt } : {},
  }
}

/** Reconstruct a {@link SessionEvent} from an `events` row (parses `data`). */
export function rowToEvent(row: EventRow): SessionEvent {
  return {
    type: row.type,
    seq: row.seq,
    time: row.time,
    data: JSON.parse(row.data) as SessionEvent['data'],
  } as SessionEvent
}

/**
 * The preserved prefix of an ordered event-row list (mirrors the JSONL
 * backend's `scanLog`): the longest prefix of complete, seq-contiguous,
 * parseable rows, PLUS the seq from which a never-committed torn tail must be
 * deleted (or `undefined` if the whole list is intact).
 *
 * A crash can leave a durable log whose final turn never closed: real,
 * fully-written rows sit after the last `turn/end`. Those are PRESERVED — a
 * single turn can be huge in a long-horizon task, so truncating it would
 * destroy real work; the backend closes the orphaned open turn with a synthetic
 * `turn/end {kind:'interrupted'}` on load (ADR 0018). The ONLY thing excluded is
 * a torn trailing fragment — a row whose `data` never parses, or a seq gap —
 * AFTER the last committed `turn/end`; that bounds the preserved region and its
 * seq is returned as `tornFrom` so `load` can physically delete it.
 *
 * The last `turn/end` is computed from the `type` COLUMN (never parsing tail
 * `data`), so a malformed `data` in an uncommitted tail row is discarded rather
 * than making the session unloadable. A parse error or seq gap AT OR BEFORE the
 * last committed `turn/end` is committed-data corruption and throws.
 *
 * This relies on the session-log invariant that every event lives inside a turn
 * (`Session.append` enforces it): only the final turn can be open, so the
 * preserved tail is at most one unclosed turn.
 */
export function scanRows(rows: readonly EventRow[]): { preserved: SessionEvent[]; tornFrom?: number } {
  // Pass 1: parse each row's data; a row whose data is not valid JSON is a hole.
  // (The seq/type COLUMNS are always present even when `data` is corrupt.)
  interface Parsed { ok: boolean; event?: SessionEvent }
  const parsed: Parsed[] = rows.map((row) => {
    try {
      return { ok: true, event: rowToEvent(row) }
    } catch {
      return { ok: false }
    }
  })

  // The last index that is a valid `turn/end` — the last fully-committed
  // boundary (the loop flushes only at turn/end).
  let lastTurnEnd = -1
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i]?.ok && rows[i]?.type === 'turn/end') { lastTurnEnd = i; break }
  }

  // Walk the longest PREFIX of complete, seq-contiguous, parseable rows
  // (row i has seq === i). This includes the fully-written rows of an
  // interrupted final turn AFTER the last turn/end — real work, never
  // truncated. The walk stops at the first hole:
  //   - at or before the last committed turn/end → committed corruption (throw);
  //   - after it (or no committed turn/end) → tolerated torn tail (stop).
  const preserved: SessionEvent[] = []
  for (let i = 0; i < rows.length; i++) {
    const p = parsed[i]
    if (!p?.ok || p.event === undefined) {
      if (i <= lastTurnEnd) throw new Error(`corrupt session log: unparsable committed event at seq ${rows[i]?.seq}`)
      break // torn tail fragment after the last turn/end — stop, tolerate
    }
    if (p.event.seq !== i) {
      if (i <= lastTurnEnd) throw new Error(`corrupt session log: seq gap in committed region (expected ${i}, got ${p.event.seq})`)
      break // gap after the last turn/end — torn tail, stop
    }
    preserved.push(p.event)
  }

  // Any rows past the preserved prefix are a never-committed torn tail; their
  // first seq is the deletion point for load's physical repair.
  return preserved.length < rows.length ? { preserved, tornFrom: preserved.length } : { preserved }
}
