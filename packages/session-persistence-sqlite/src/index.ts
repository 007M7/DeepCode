/**
 * SQLite durable session-persistence backend (`@deepseek-ai/dsh-session-persistence-sqlite`).
 *
 * A SECOND {@link SessionPersistence} implementation, built to validate that
 * the abstract seam + the shared `runPersistenceContract` suite are genuinely
 * backend-agnostic: the same append-only / contiguous-seq / lazy-materialization
 * / interrupted-turn-close-on-load semantics the JSONL backend expresses over
 * file bytes, expressed here over `node:sqlite` rows. Each `SessionEvent` maps
 * 1:1 onto a row `(session_id, seq, type, time, data)`; `append` is an INSERT
 * inside a transaction that asserts the contiguous-seq contract.
 *
 * Like the JSONL backend it is also the write-path plugin: it installs the
 * `session/event` → buffer → `session/flush` drain, persists a fork's seed once
 * on `session/created`, keeps a per-session write cursor so a resumed session
 * never re-appends stored events, and seeds existing live sessions on apply
 * (HMR does not replay `session/created`).
 *
 * @module @deepseek-ai/dsh-session-persistence-sqlite
 */

import { Context } from 'cordis'
import z from 'schemastery'
import { DatabaseSync } from 'node:sqlite'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  SessionPersistence, assertSerializable, seedCoversPrefix,
} from '@deepseek-ai/dsh-session-persistence'
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  openDatabase, rowToMeta, scanRows, type EventRow, type SessionRow,
} from './schema.ts'

export { SCHEMA_VERSION } from './schema.ts'

/** Plugin configuration. */
export interface Config {
  /**
   * Filesystem path to the SQLite database file. The special value `:memory:`
   * opens an in-process database (tests); a file path is created (with parent
   * dirs) on construction.
   */
  path: string
}

/** Backend bookkeeping for a session id (NOT the live Session object). */
interface SessionState {
  meta: SessionHeader
  /** Next seq to write — equals the number of committed events. */
  cursor: number
  /** Whether the session has at least one persisted event (materialized). */
  materialized: boolean
  /** The live Session that owns this state (collision detection); see onCreated. */
  owner?: Session
}

async function settledErrors(promises: Iterable<Promise<unknown>>): Promise<unknown[]> {
  const settled = await Promise.allSettled([...promises])
  const errors: unknown[] = []
  for (const result of settled) {
    if (result.status === 'rejected') errors.push(result.reason)
  }
  return errors
}

/**
 * The SQLite persistence backend. Load as a plugin; it registers as
 * `ctx.sessionPersistence` and installs the write-path listeners.
 */
export class SessionPersistenceSqlite extends SessionPersistence {
  static inject = ['sessions']

  static Config: z<Config> = z.object({
    path: z.string().required(),
  })

  private db!: DatabaseSync
  private ready: Promise<void>
  /** Backend bookkeeping keyed by session id (NOT the live Session object). */
  private states = new Map<string, SessionState>()
  /** Write-behind buffers keyed by the live Session (write path). */
  private buffers = new Map<Session, SessionEvent[]>()
  /** Per-session serialization chain (keyed by session id). */
  private chains = new Map<string, Promise<unknown>>()
  /** Per-session init promise (onCreated), keyed by the LIVE Session object. */
  private inits = new Map<Session, Promise<void>>()

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Open the database asynchronously (the parent directory may need creating);
    // every backend op awaits `ready` first. Opening synchronously in the ctor
    // would force a sync mkdir and block plugin apply.
    this.ready = this.openDb(config.path)
    this.installWritePath()
  }

  private async openDb(path: string): Promise<void> {
    if (path !== ':memory:') {
      const abs = resolve(path)
      await mkdir(dirname(abs), { recursive: true, mode: 0o700 })
      this.db = openDatabase(abs)
    } else {
      this.db = openDatabase(path)
    }
  }

  // --- SessionPersistence backend surface (all serialized per session id) ---

  create(meta: SessionHeader): Promise<void> {
    const snapshot: SessionHeader = { ...meta }
    return this.serialize(snapshot.id, () => this.createCore(snapshot))
  }

  private async createCore(meta: SessionHeader): Promise<void> {
    await this.ready
    if (this.states.has(meta.id)) {
      throw new Error(`session "${meta.id}" already exists in this backend`)
    }
    if (this.rowFor(meta.id) !== undefined) {
      throw new Error(`session "${meta.id}" already has a persisted row; load/resume it instead of creating`)
    }
    // Lazy: record intent in memory only. No row until the first append, so an
    // abandoned (never-appended) session leaves nothing behind and stays absent
    // from has()/list().
    this.states.set(meta.id, { meta, cursor: 0, materialized: false })
  }

  // `async` so the synchronous validate/clone below reject (not throw) per the
  // Promise<void> contract — callers use `await expect(...).rejects`.
  async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    // Validate serializability BEFORE cloning so a bad event surfaces the typed
    // "non-JSON-serializable" error rather than an opaque DataCloneError from
    // structuredClone. Then deep-snapshot the batch HERE, before the op waits
    // behind the per-session chain: a caller that passes a live array (e.g.
    // session.events) and mutates it — OR mutates an event inside it — before
    // the op runs would otherwise have those changes persisted, or advance the
    // cursor past what was written. The clone is taken at call time (before the
    // first await), matching the JSONL backend.
    assertSerializable(events)
    const batch = events.map(e => structuredClone(e))
    return this.serialize(id, () => this.appendCore(id, batch))
  }

  private async appendCore(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    await this.ready
    if (events.length === 0) return
    let state = this.states.get(id)
    if (state === undefined) state = await this.adopt(id)

    // Contiguity contract: each event's seq must continue the stored log.
    for (const [i, event] of events.entries()) {
      if (event.seq !== state.cursor + i) {
        throw new Error(`append seq mismatch for "${id}": expected ${state.cursor + i} at index ${i}, got ${event.seq}`)
      }
    }

    // The transaction is the durability + atomicity boundary: materialize the
    // sessions row (if lazy) and INSERT every event, or roll back entirely. A
    // BEGIN/COMMIT around the batch means a mid-batch failure (a UNIQUE
    // violation on a duplicated seq from a concurrent writer) leaves the stored
    // log untouched, so the cursor stays truthful and a retry is clean. (A crash
    // tail is already gone: load() physically deletes the torn fragment and
    // durably closes the interrupted turn before returning, so by the time any
    // append runs the stored log is balanced and contiguous.)
    const insertEvent = this.db.prepare(
      'INSERT INTO events (session_id, seq, type, time, data) VALUES (?, ?, ?, ?, ?)',
    )
    this.db.exec('BEGIN')
    try {
      if (!state.materialized) this.writeRow(state.meta)
      for (const event of events) {
        insertEvent.run(id, event.seq, event.type, event.time, JSON.stringify(event.data))
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    state.materialized = true
    state.cursor += events.length
  }

  load(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.serialize(id, () => this.loadCore(id))
  }

  private async loadCore(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    await this.ready
    const row = this.rowFor(id)
    if (row === undefined) throw new Error(`session "${id}" not found`)
    const meta = rowToMeta(row)
    this.assertVersion(meta)

    // Read every stored row ordered by seq, then scan for the preserved prefix:
    // the longest seq-contiguous, parseable run, INCLUDING the real events of an
    // interrupted final turn after the last turn/end (a turn can be huge — they
    // are never truncated). scanRows works off the seq+type COLUMNS for the
    // last-turn/end boundary, so a malformed `data` in a torn tail row is
    // discarded (not unloadable); only a parse error / seq gap in the COMMITTED
    // region (at or before the last turn/end) throws (genuine corruption).
    const eventRows = this.db
      .prepare('SELECT seq, type, time, data FROM events WHERE session_id = ? ORDER BY seq')
      .all(id) as unknown as EventRow[]
    const { preserved, tornFrom } = scanRows(eventRows)

    // Crash-recovery (mutating load, same as the JSONL backend): if the log ended
    // mid-turn, close it DURING load so disk, the returned log, and the cursor all
    // agree — both append routes then continue with no special-casing. Synthesize
    // the boundary events (a step/end if a step was open, then a
    // turn/end {kind:'interrupted'}); the interrupted turn's real events are
    // preserved, never truncated (the session-persistence RFC).
    const closers = interruptedTurnClosers(preserved)
    const balanced = [...preserved, ...closers]

    // Physically repair the stored log inside one transaction: DELETE the torn
    // tail fragment (if any), then INSERT the synthetic closers. After COMMIT the
    // stored rows == balanced, so the cursor is truthful and the next append
    // continues cleanly with no deferred repair. The metadata row stays as-is
    // even when preserved.length === 0 (an all-tail crash): the session WAS
    // materialized by the partial append, so has()/list() still report it — the
    // same as the JSONL backend, whose file likewise survives a first append that
    // never reached turn/end.
    if (tornFrom !== undefined || closers.length > 0) {
      this.db.exec('BEGIN')
      try {
        if (tornFrom !== undefined) {
          this.db.prepare('DELETE FROM events WHERE session_id = ? AND seq >= ?').run(id, tornFrom)
        }
        if (closers.length > 0) {
          const insertEvent = this.db.prepare('INSERT INTO events (session_id, seq, type, time, data) VALUES (?, ?, ?, ?, ?)')
          for (const event of closers) {
            insertEvent.run(id, event.seq, event.type, event.time, JSON.stringify(event.data))
          }
        }
        this.db.exec('COMMIT')
      } catch (error) {
        // The DELETE+INSERT cannot collide (a row at a closer's seq is preserved
        // or deleted as torn first); this rolls back a DB-level failure (disk
        // full, etc.), unreachable in test.
        /* v8 ignore start */
        this.db.exec('ROLLBACK')
        throw error
        /* v8 ignore stop */
      }
    }

    // Record state at the balanced length. The state keeps its OWN copy of the
    // meta; the returned value is separate so a consumer mutating loaded.meta
    // cannot corrupt the backend's row metadata.
    this.states.set(id, {
      meta: { ...meta },
      cursor: balanced.length,
      materialized: true,
    })
    return { meta, events: balanced }
  }

  private async adoptLiveStoredPrefix(session: Session, seed: readonly SessionEvent[]): Promise<void> {
    await this.ready
    const row = this.rowFor(session.header.id)
    /* v8 ignore next -- caller checked row existence */
    if (row === undefined) throw new Error(`session "${session.header.id}" not found`)
    const meta = rowToMeta(row)
    this.assertVersion(meta)

    const rows = this.db
      .prepare('SELECT seq, type, time, data FROM events WHERE session_id = ? ORDER BY seq')
      .all(session.header.id) as unknown as EventRow[]
    const { preserved, tornFrom } = scanRows(rows)
    if (!seedCoversPrefix(seed, preserved)) {
      throw new Error(`session "${session.header.id}" already has a persisted log that does not match this live session (id collision)`)
    }

    if (tornFrom !== undefined) {
      this.db.prepare('DELETE FROM events WHERE session_id = ? AND seq >= ?').run(session.header.id, tornFrom)
    }
    this.states.set(session.header.id, {
      meta: { ...meta },
      cursor: preserved.length,
      materialized: true,
      owner: session,
    })
    const suffix = seed.slice(preserved.length)
    if (suffix.length > 0) await this.appendCore(session.header.id, suffix)
  }

  async list(): Promise<SessionHeader[]> {
    await this.ready
    // Every metadata row is a materialized session: the row is written only by
    // the first append (a created-but-never-appended session has no row), so
    // listing all rows is exactly the materialized set.
    const rows = this.db
      .prepare('SELECT * FROM sessions')
      .all() as unknown as SessionRow[]
    return rows.map(rowToMeta)
  }

  async has(id: SessionId): Promise<boolean> {
    await this.ready
    const state = this.states.get(id)
    if (state?.materialized) return true
    // A metadata row exists iff the session was materialized by a first append.
    return this.rowFor(id) !== undefined
  }

  delete(id: SessionId): Promise<void> {
    return this.serialize(id, () => this.deleteCore(id))
  }

  private async deleteCore(id: SessionId): Promise<void> {
    await this.ready
    // ON DELETE CASCADE drops the session's events with its row.
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    this.states.delete(id)
  }

  // --- row helpers ---

  /** Fetch a session's row, or undefined if absent. */
  private rowFor(id: SessionId): SessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined
    return row
  }

  /**
   * Insert-or-replace a session's metadata row. The only caller is the first
   * materializing `append`, so writing the row IS the materialization (its
   * existence is the signal `has`/`list` read); a never-appended session has no
   * row at all.
   */
  private writeRow(meta: SessionHeader): void {
    this.db.prepare(`
      INSERT INTO sessions (id, version, created_at, cwd, parent_session)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        created_at = excluded.created_at,
        cwd = excluded.cwd,
        parent_session = excluded.parent_session
    `).run(
      meta.id,
      meta.version,
      meta.createdAt,
      meta.cwd ?? null,
      meta.parentSession ?? null,
    )
  }

  /** Build a state for a session present in the DB but not yet in memory. */
  private async adopt(id: SessionId): Promise<SessionState> {
    await this.loadCore(id) // sets the state; load (serialized) would deadlock
    const state = this.states.get(id)
    /* v8 ignore next -- loadCore always sets the state for the id */
    if (!state) throw new Error(`failed to adopt session "${id}"`)
    return state
  }

  private assertVersion(meta: SessionHeader): void {
    if (meta.version !== 1) {
      throw new Error(`unsupported session format version ${meta.version} for "${meta.id}" (only v1 is supported)`)
    }
  }

  /**
   * Run `op` after any in-flight operation for the same session id, so writes
   * for one session never interleave. Errors do not poison the chain. NOTE:
   * serialized public methods must NOT call each other (deadlock); they call
   * the unserialized `*Core` helpers instead.
   */
  private serialize<T>(id: SessionId, op: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(id) ?? Promise.resolve()
    const next = prior.then(op, op)
    this.chains.set(id, next.then(() => undefined, () => undefined))
    return next
  }

  // --- write path (session/event → flush drain) ---

  private installWritePath(): void {
    const ctx = this.ctx

    ctx.on('session/created', (session) => { void this.initFor(session) })

    // Snapshot + buffer every event (the live object is mutable; clone so a
    // later in-place mutation cannot rewrite a buffered event). Serializability
    // is guaranteed at the source (Session.append), so structuredClone is safe.
    ctx.on('session/event', (session, event) => {
      let buffer = this.buffers.get(session)
      if (!buffer) this.buffers.set(session, buffer = [])
      buffer.push(structuredClone(event))
    })

    ctx.on('session/flush', session => this.flush(session))

    // Dispose must reach quiescence: await every init + final drain, then close
    // the database, BEFORE returning, so no write lands after teardown.
    ctx.effect(() => async () => {
      let disposeError: unknown
      try {
        const errors = [
          ...await settledErrors(this.inits.values()),
          ...await settledErrors([...this.buffers.keys()].map(s => this.flush(s))),
          ...await settledErrors(this.chains.values()),
        ]
        if (errors.length > 0) {
          throw new AggregateError(errors, 'session-persistence-sqlite dispose failed')
        }
      } catch (error: unknown) {
        disposeError = error
        throw error
      } finally {
        try {
          await this.ready
          this.db.close()
        } catch (error: unknown) {
          /* v8 ignore next -- open/close failure racing disposal is a defensive teardown edge */
          if (disposeError === undefined) throw error
          // Opening/closing the database can only add teardown context here; keep
          // the already-captured init/flush/chain AggregateError as the primary
          // disposal failure instead of masking it from callers.
        }
      }
    }, 'session-persistence-sqlite write path')

    // HMR: a hot reload does not replay session/created, so seed existing live
    // sessions (mirrors dsh-invariants and the JSONL backend).
    for (const session of ctx.sessions.list()) void this.initFor(session)
  }

  /** Start (once) the async init for a session and remember its promise. */
  private initFor(session: Session): Promise<void> {
    const existing = this.inits.get(session)
    if (existing) return existing
    const seed = session.events.map(e => structuredClone(e))
    const p = this.onCreated(session, seed)
    p.catch(() => { /* observed by flush/dispose via the stored promise */ })
    this.inits.set(session, p)
    return p
  }

  /**
   * On session/created: sync the backend's state to a live Session. Cases
   * mirror the JSONL backend:
   *   1. Already tracked → no-op (or claim ownerless state if the seed matches).
   *   2. A row EXISTS and is a seq-aligned PREFIX of the live events → adopt
   *      (HMR/resume), persisting any live suffix beyond the stored prefix.
   *   3. A row EXISTS but is NOT a prefix → reject (id collision).
   *   4. No row → a genuinely new session: register meta (lazy) + persist seed.
   */
  private async onCreated(session: Session, seed: readonly SessionEvent[]): Promise<void> {
    await this.ready
    const id = session.header.id
    const tracked = this.states.get(id)
    if (tracked !== undefined) {
      /* v8 ignore next -- initFor dedupes per session object; same-object re-entry can't occur */
      if (tracked.owner === session) return
      if (tracked.owner === undefined) {
        // Ownerless state from a public create()/load(). The first live session
        // claims it ONLY if its seed reproduces the persisted prefix.
        if (!await this.seedMatchesPersisted(id, seed, tracked.cursor)) {
          throw new Error(`session "${id}" is already persisted with ${tracked.cursor} event(s) that do not match this live session (id collision)`)
        }
        tracked.owner = session
        const suffix = seed.slice(tracked.cursor)
        if (suffix.length > 0) await this.append(id, suffix)
        return
      }
      // Owned by a DIFFERENT live session. Reclaim ONLY a truly-abandoned id
      // (never materialized, no pending buffer); else it is a real collision.
      const ownerBuffer = this.buffers.get(tracked.owner)
      if (!tracked.materialized && !ownerBuffer?.length) {
        this.states.delete(id)
      } else {
        throw new Error(`session "${id}" is already bound to a different live session in this backend (id collision)`)
      }
    }

    const row = this.rowFor(id)
    if (row !== undefined) {
      // Adopt a LIVE prefix without crash-repairing an open turn as interrupted;
      // HMR may still append the real completion from the live Session.
      await this.serialize(id, () => this.adoptLiveStoredPrefix(session, seed))
      return
    }

    // case 4: a genuinely new session.
    const meta: SessionHeader = { ...session.header }
    await this.create(meta)
    const created = this.states.get(id)
    /* v8 ignore next -- create() always sets the state for the id */
    if (created !== undefined) created.owner = session
    if (seed.length > 0) await this.append(id, seed)
  }

  /** The preserved events for a session id (torn tail excluded, turn NOT yet closed). */
  private eventsFor(id: SessionId): SessionEvent[] {
    const rows = this.db
      .prepare('SELECT seq, type, time, data FROM events WHERE session_id = ? ORDER BY seq')
      .all(id) as unknown as EventRow[]
    // Scan on seq+type columns, parsing `data` only for the preserved prefix (a
    // malformed torn tail must not throw here — same as loadCore). Returns the
    // preserved events WITHOUT the synthetic closers, so a collision check
    // compares a live seed against the real on-disk events, mirroring the JSONL
    // backend's scanLog use in onCreated.
    return scanRows(rows).preserved
  }

  /** Whether a live session's seed reproduces the first `cursor` stored events. */
  private async seedMatchesPersisted(id: SessionId, seed: readonly SessionEvent[], cursor: number): Promise<boolean> {
    await this.ready
    if (cursor === 0) return true
    return seedCoversPrefix(seed, this.eventsFor(id).slice(0, cursor))
  }

  private async flush(session: Session): Promise<void> {
    await this.inits.get(session)
    await this.serialize(session.header.id, () => this.drain(session))
  }

  /** Drain a session's write buffer to the database. Caller serializes per id. */
  private async drain(session: Session): Promise<void> {
    const buffer = this.buffers.get(session)
    if (!buffer?.length) return
    const batch = buffer.slice()
    const state = this.states.get(session.header.id)
    /* v8 ignore next -- state is always set by the awaited init before flush */
    const cursor = state?.cursor ?? 0
    const fresh = batch.filter(e => e.seq >= cursor)
    if (fresh.length > 0) await this.appendCore(session.header.id, fresh)
    buffer.splice(0, batch.length)
  }
}

export default SessionPersistenceSqlite
