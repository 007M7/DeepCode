/**
 * SQLite durable session-persistence backend. It maps each session header and
 * event to rows, and delegates write-path orchestration to
 * {@link PersistenceCoordinator}.
 * @module @deepseek-ai/dsh-session-persistence-sqlite
 */

import { Context } from 'cordis'
import z from 'schemastery'
import { statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  SessionPersistence, SessionPersistenceRevision, PersistenceCoordinator,
  type PersistenceBackend, type SessionPersistenceSnapshot, type StoredPrefix,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SurfaceEventType, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  type JournalMode, openDatabase, rowToMeta, scanRows, type EventRow, type SessionRow,
} from './schema.ts'

export { SCHEMA_VERSION } from './schema.ts'

/**
 * Serialize an event's surface-metadata fields for SQL binding. Both fields are
 * nullable TEXT columns — null when the event has no surface metadata (non-surface
 * events, events written before surface support).
 */
function surfaceBindings(event: SessionEvent): [string | null, string | null] {
  const se = event as SessionEvent<SurfaceEventType>
  return [
    se.sourceEventSeqs ? JSON.stringify(se.sourceEventSeqs) : null,
    se.surfaceOp !== undefined ? JSON.stringify(se.surfaceOp) : null,
  ]
}

/** Plugin configuration. */
export interface Config {
  /**
   * Filesystem path to the SQLite database file. The special value `:memory:`
   * opens an in-process database (tests); a file path is created (with parent
   * dirs) on construction.
   */
  path: string
  /**
   * SQLite `journal_mode` pragma. `wal` (the default) is the recorded
   * durability model; pick a rollback-journal mode (`delete`/`truncate`/
   * `persist`) on filesystems where WAL's shared-memory files do not work
   * (network mounts). See {@link JournalMode}.
   */
  journalMode?: JournalMode
}

/**
 * The SQLite persistence backend. Load as a plugin; it registers as
 * `ctx.sessionPersistence` and (via the coordinator) installs the write-path
 * listeners. Its torn-tail marker is the seq to delete from.
 */
export class SessionPersistenceSqlite extends SessionPersistence implements PersistenceBackend<number> {
  static inject = ['sessions']

  static Config: z<Config> = z.object({
    path: z.string().required(),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
  })

  /**
   * Backend label for the coordinator's dispose diagnostics. Intentionally
   * shadows cordis `Service.name` (set to `'sessionPersistence'` by the base);
   * see the JSONL backend for why this does not affect service resolution.
   */
  override readonly name = 'session-persistence-sqlite'

  private db!: DatabaseSync
  private storeIdentity!: string
  private ready: Promise<void>
  private coordinator: PersistenceCoordinator<number>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Open asynchronously so directory creation does not block plugin apply;
    // every storage hook awaits the same readiness promise.
    this.ready = this.openDb(config.path, (config as Required<Config>).journalMode)
    this.coordinator = new PersistenceCoordinator<number>(this.ctx, this)
  }

  private async openDb(path: string, journalMode: JournalMode): Promise<void> {
    const actual = path === ':memory:' ? path : resolve(path)
    if (actual !== ':memory:') await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    this.db = openDatabase(actual, journalMode)
    try {
      const row = this.db.prepare(
        'SELECT store_id FROM persistence_state WHERE singleton = 1',
      ).get() as { store_id: string } | undefined
      /* v8 ignore next -- openDatabase inserts the singleton before returning. */
      if (row === undefined) {
        throw new Error(`session database at "${actual}" has no store identity`)
      }
      if (row.store_id.length === 0) {
        throw new Error(`session database at "${actual}" has no valid store identity`)
      }
      if (actual !== ':memory:') {
        const identity = statSync(actual, { bigint: true })
        this.storeIdentity = `file:${identity.dev}:${identity.ino}:${identity.birthtimeNs}:store:${row.store_id}`
      } else {
        this.storeIdentity = `memory:store:${row.store_id}`
      }
    } catch (error: unknown) {
      this.db.close()
      throw error
    }
  }

  // --- SessionPersistence service surface (delegated to the coordinator) ---

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  load(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.load(id)
  }

  // One method serves both public `list` and the backend hook; delegating it to
  // the coordinator would call this hook recursively.

  // --- PersistenceBackend hooks (the SQLite storage primitives) ---

  /** Read a stored prefix by id (ids are globally unique — no scope to scan). */
  loadStored(id: SessionId): Promise<StoredPrefix<number> | undefined> {
    return this.readPrefix(id)
  }

  /** Read a stored prefix; `cwd` is ignored (the id is globally unique in SQLite). */
  loadLive(id: SessionId, _cwd: string | undefined): Promise<StoredPrefix<number> | undefined> {
    return this.readPrefix(id)
  }

  /**
   * Read a session's row + ordered events into a {@link StoredPrefix}. The
   * torn-tail marker is the seq from which a never-committed tail must be deleted
   * (`scanRows` already returns it as `number | undefined`).
   */
  private async readPrefix(id: SessionId): Promise<StoredPrefix<number> | undefined> {
    await this.ready
    const row = this.rowFor(id)
    if (row === undefined) return undefined
    const meta = rowToMeta(row)
    const eventRows = this.db
      .prepare('SELECT seq, type, time, data, source_event_seqs, surface_op FROM events WHERE session_id = ? ORDER BY seq')
      .all(id) as unknown as EventRow[]
    const { preserved, tornFrom } = scanRows(eventRows)
    return { meta, events: preserved, ...tornFrom !== undefined ? { tornMarker: tornFrom } : {} }
  }

  /**
   * Durably append a batch in ONE transaction: materialize the sessions row (if
   * lazy) and INSERT every event, or roll back entirely. The transaction is the
   * atomicity + durability boundary, so a mid-batch failure (a UNIQUE violation
   * on a duplicated seq) leaves the stored log untouched.
   */
  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    await this.ready
    const insertEvent = this.db.prepare(
      'INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    this.db.exec('BEGIN')
    try {
      if (!isMaterialized) this.writeRow(meta)
      for (const event of events) {
        const [surfaceSeqs, surfaceOp] = surfaceBindings(event)
        insertEvent.run(meta.id, event.seq, event.type, event.time, JSON.stringify(event.data), surfaceSeqs, surfaceOp)
      }
      this.db.prepare('UPDATE sessions SET revision = revision + 1 WHERE id = ?').run(meta.id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Make a crash repair durable in ONE transaction: DELETE the torn tail (from
   * `tornMarker`) and INSERT the synthetic `closers`. After COMMIT the stored rows
   * == the balanced log.
   */
  async commitRepair(meta: SessionHeader, tornMarker: number | undefined, closers: readonly SessionEvent[]): Promise<void> {
    await this.ready
    this.db.exec('BEGIN')
    try {
      if (tornMarker !== undefined) {
        this.db.prepare('DELETE FROM events WHERE session_id = ? AND seq >= ?').run(meta.id, tornMarker)
      }
      if (closers.length > 0) {
        const insertEvent = this.db.prepare(
          'INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        for (const event of closers) {
          const [surfaceSeqs, surfaceOp] = surfaceBindings(event)
          insertEvent.run(meta.id, event.seq, event.type, event.time, JSON.stringify(event.data), surfaceSeqs, surfaceOp)
        }
      }
      if (tornMarker !== undefined || closers.length > 0) {
        this.db.prepare('UPDATE sessions SET revision = revision + 1 WHERE id = ?').run(meta.id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      // The DELETE+INSERT cannot collide (a row at a closer's seq is preserved or
      // deleted as torn first); this rolls back a DB-level failure (disk full,
      // etc.), unreachable in test.
      /* v8 ignore start */
      this.db.exec('ROLLBACK')
      throw error
      /* v8 ignore stop */
    }
  }

  /** List all materialized sessions' metadata (every row is a materialized session). */
  async list(): Promise<SessionHeader[]> {
    await this.ready
    const rows = this.db
      .prepare('SELECT * FROM sessions')
      .all() as unknown as SessionRow[]
    return rows.map(rowToMeta)
  }

  /** List metadata with a source-qualified monotonic revision per session. */
  async listSnapshots(): Promise<SessionPersistenceSnapshot[]> {
    await this.ready
    const rows = this.db.prepare('SELECT * FROM sessions').all() as unknown as SessionRow[]
    return rows.map(row => ({
      header: rowToMeta(row),
      revision: SessionPersistenceRevision(`${this.storeIdentity}:revision:${row.revision}`),
    }))
  }

  /** Close the database handle (awaited by the coordinator's dispose, post-drain). */
  async close(): Promise<void> {
    await this.ready
    this.db.close()
  }

  // --- row helpers ---

  /** Fetch a session's row, or undefined if absent. */
  private rowFor(id: SessionId): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined
  }

  /**
   * Insert-or-replace a session's metadata row. The only caller is the first
   * materializing `appendBatch`, so writing the row IS the materialization (its
   * existence is the signal `list` reads).
   */
  private writeRow(meta: SessionHeader): void {
    this.db.prepare(`
      INSERT INTO sessions (id, version, created_at, cwd, parent_session, seed_length, revision)
      VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        created_at = excluded.created_at,
        cwd = excluded.cwd,
        parent_session = excluded.parent_session,
        seed_length = excluded.seed_length
    `).run(
      meta.id,
      meta.version,
      meta.createdAt,
      meta.cwd ?? null,
      meta.parentSession ?? null,
      meta.seedLength ?? null,
    )
  }
}

export default SessionPersistenceSqlite
