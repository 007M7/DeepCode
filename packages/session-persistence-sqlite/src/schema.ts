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
 * A row of the `sessions` table — the out-of-log metadata (`SessionMeta`) plus
 * the `materialized` flag that implements lazy materialization (a created-but-
 * never-appended session has `materialized = 0` and is excluded from
 * `has`/`list`, mirroring the JSONL backend's "no file until first append").
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
  materialized: number
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
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id             TEXT PRIMARY KEY,
      version        INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      cwd            TEXT,
      parent_session TEXT,
      updated_at     INTEGER NOT NULL,
      title          TEXT,
      first_prompt   TEXT,
      materialized   INTEGER NOT NULL DEFAULT 0
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
 * The committed prefix of an ordered event list: everything up to and including
 * the LAST `turn/end`, plus whether a crash tail (items after it) was cut.
 *
 * Generic over anything carrying `seq` + `type` (an {@link EventRow} or a
 * {@link SessionEvent}) so the cut is computed from those COLUMNS alone — the
 * caller parses each row's `data` only for the committed items it returns,
 * never for the tail. This matters for the contract: a malformed `data` in an
 * uncommitted crash tail must be discarded, not make the session unloadable —
 * only a parse error / gap in the COMMITTED region is unloadable (see
 * `SessionPersistence.load`). Mirrors the JSONL backend's `scanLog`, which
 * likewise tolerates a corrupt tail after the last committed `turn/end`.
 *
 * The loop only flushes at `turn/end`, so the last `turn/end` is the last
 * durable boundary; anything after it is a never-committed crash tail (a batch
 * that landed without its closing `turn/end`, e.g. a process killed mid-turn).
 * The committed region MUST be contiguous (`item.seq === i`); a gap there means
 * committed data was lost and the session is unloadable.
 */
export function cutAtLastTurnEnd<T extends { seq: number; type: string }>(
  items: readonly T[],
): { committed: T[]; cutTail: boolean } {
  let lastTurnEnd = -1
  items.forEach((item, i) => {
    if (item.type === 'turn/end') lastTurnEnd = i
  })
  // No committed turn/end anywhere: the whole list is an uncommitted first-turn
  // tail. Nothing is committed (mirrors scanLog returning zero events).
  if (lastTurnEnd < 0) {
    return { committed: [], cutTail: items.length > 0 }
  }
  const committed = items.slice(0, lastTurnEnd + 1)
  committed.forEach((item, i) => {
    if (item.seq !== i) {
      throw new Error(`corrupt session log: seq gap in committed region at index ${i} (expected ${i}, got ${item.seq})`)
    }
  })
  return { committed, cutTail: lastTurnEnd < items.length - 1 }
}
