/**
 * Schema + load-time helpers for the SQLite session-persistence backend: the
 * DDL (a `sessions` metadata table and a 1:1 `events` row per `SessionEvent`),
 * the database open/configure step, and the last-`turn/end` cut that gives the
 * SQLite backend the SAME crash-tail-on-load semantics as the JSONL backend.
 *
 * @module dsh-session-persistence-sqlite/schema
 */

import { DatabaseSync } from 'node:sqlite'
import type { SessionEvent, SessionId, SessionHeader, SurfaceOp } from '@deepseek-ai/dsh-session'

/**
 * The on-disk schema version. Bumped only on a breaking change to the table
 * layout; orthogonal to a session's own `version` (which versions the EVENT
 * vocabulary, stored per session in the `sessions` row).
 */
export const SCHEMA_VERSION = 4

/**
 * A row of the `sessions` table — the out-of-log metadata ({@link SessionHeader}).
 * The row's EXISTENCE is the materialization signal: it is written only by the
 * first `append` (lazy materialization), so a created-but-never-appended
 * session has no row and is absent from `list`, mirroring the JSONL
 * backend's "no file until first append".
 */
export interface SessionRow {
  id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
}

/** An `events` table row: one `SessionEvent` mapped 1:1 (`data` is JSON text). */
export interface EventRow {
  seq: number
  type: string
  time: number
  data: string
  /** JSON-encoded `number[]` — the event's sourceEventSeqs, or null. */
  source_event_seqs: string | null
  /** JSON-encoded `SurfaceOp` — how the event entered the surface, or null. */
  surface_op: string | null
}

/**
 * Journal modes the backend will run under. `wal` is the default and the
 * durability model the persistence ADR records; the rollback-journal modes
 * (`delete`/`truncate`/`persist`) exist for filesystems where WAL's
 * shared-memory files do not work (network mounts). `memory`/`off` are
 * excluded: dropping journal durability silently contradicts what this
 * backend promises.
 */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

/**
 * Open the database at `path` and apply the schema + pragmas. `foreign_keys`
 * makes `ON DELETE CASCADE` drop a session's events with its row; the
 * `journal_mode` pragma is set from the plugin's `journalMode` config (`wal`
 * default — the durability model the ADR records; the row shape maps 1:1
 * onto `SessionEvent`; opencode runs this exact shape on SQLite/WAL).
 *
 * The table-layout version is persisted in SQLite's `PRAGMA user_version` and
 * checked on open: a fresh database (user_version 0) is stamped with the
 * current {@link SCHEMA_VERSION}; an existing database whose version is NOT the
 * current one (written by a different, incompatible build — older or newer) is
 * REJECTED rather than opened against a layout this build does not understand.
 * There are no migrations: an earlier layout is not upgraded in place — it is
 * rejected. v1 had a different `sessions` shape; v2 lacked all of
 * `seed_length`/`source_event_seqs`/`surface_op`. v3 is SKIPPED: two unmerged
 * branches each shipped a DISTINCT v3 (one adding only `seed_length`, the other
 * adding only the surface columns), so an on-disk v3 is ambiguous — it could be
 * either sibling layout, neither of which has all of this build's columns. v4
 * is the merged layout carrying every column; bumping past the collided v3
 * makes the version check reject both sibling v3 databases instead of opening
 * one against columns it does not have.
 * @param path - the SQLite database file to open (created when absent).
 * @param journalMode - the journal pragma to apply — a closed in-code union, validated by the plugin Config.
 * @returns the open handle with pragmas applied and both tables ensured.
 */
export function openDatabase(path: string, journalMode: JournalMode): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  // journalMode is a closed in-code union (validated by the plugin Config), not
  // user-controlled SQL — safe to interpolate (PRAGMA takes no bound params).
  db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
  // `PRAGMA user_version` always returns exactly one row { user_version }.
  const { user_version: onDisk } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (onDisk !== 0 && onDisk !== SCHEMA_VERSION) {
    db.close()
    throw new Error(`session database at "${path}" has schema version ${onDisk}, incompatible with this build (${SCHEMA_VERSION})`)
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
      seed_length    INTEGER
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq               INTEGER NOT NULL,
      type              TEXT NOT NULL,
      time              INTEGER NOT NULL,
      data              TEXT NOT NULL,
      source_event_seqs TEXT,
      surface_op        TEXT,
      PRIMARY KEY (session_id, seq)
    ) STRICT
  `)
  return db
}

/**
 * Reconstruct the {@link SessionHeader} from a `sessions` row.
 * @param row - the `sessions` table row.
 * @returns the header, `NULL` columns mapped to omitted optional fields.
 */
export function rowToMeta(row: SessionRow): SessionHeader {
  return {
    version: row.version,
    id: row.id as SessionId,
    createdAt: row.created_at,
    ...row.cwd !== null ? { cwd: row.cwd } : {},
    ...row.parent_session !== null ? { parentSession: row.parent_session as SessionId } : {},
    ...row.seed_length !== null ? { seedLength: row.seed_length } : {},
  }
}

/**
 * Reconstruct a {@link SessionEvent} from an `events` row (parses `data`).
 * @param row - the `events` table row; `data` and the surface columns hold JSON text.
 * @returns the reconstructed event; throws when a JSON column fails to parse
 *   ({@link scanRows} treats that as a hole, not corruption, in the tail).
 */
export function rowToEvent(row: EventRow): SessionEvent {
  // Surface-metadata fields are conditional on the event type in the type
  // system; spread them so each variant gets only the fields it declares.
  const surfaceFields = {
    ...row.source_event_seqs !== null ? { sourceEventSeqs: JSON.parse(row.source_event_seqs) as number[] } : {},
    ...row.surface_op !== null ? { surfaceOp: JSON.parse(row.surface_op) as SurfaceOp } : {},
  }
  return {
    type: row.type as SessionEvent['type'],
    seq: row.seq,
    time: row.time,
    data: JSON.parse(row.data) as SessionEvent['data'],
    ...surfaceFields,
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
 * `turn/end {kind:'interrupted'}` on load (the session-persistence RFC). The ONLY thing excluded is
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
 * @param rows - one session's event rows, ordered by seq ascending.
 * @returns the preserved event prefix, plus `tornFrom` — the seq the physical
 *   delete starts at — when a torn tail exists.
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
