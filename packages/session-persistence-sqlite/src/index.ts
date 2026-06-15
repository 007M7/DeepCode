/**
 * SQLite durable session-persistence backend (`@deepseek-ai/dsh-session-persistence-sqlite`).
 *
 * A SECOND {@link SessionPersistence} implementation, built to validate that
 * the abstract seam + the shared `runPersistenceContract` suite are genuinely
 * backend-agnostic: the same append-only / contiguous-seq / lazy-materialization
 * / crash-tail-on-load semantics the JSONL backend expresses over file bytes,
 * expressed here over `node:sqlite` rows. Each `SessionEvent` maps 1:1 onto a
 * row `(session_id, seq, type, time, data)`; `append` is an INSERT inside a
 * transaction that asserts the contiguous-seq contract; the mutable
 * `SessionSummary` lives in the `sessions` metadata row.
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
import { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { isJsonValue } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId, SessionMeta, SessionSummary } from '@deepseek-ai/dsh-session'
import {
  cutAtLastTurnEnd, openDatabase, rowToEvent, rowToMeta, type EventRow, type SessionRow,
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
  meta: SessionMeta
  /** Next seq to write — equals the number of committed events. */
  cursor: number
  /** Whether the session has at least one persisted event (materialized). */
  materialized: boolean
  /**
   * If a load found a crash tail, the seq from which the next {@link append}
   * must DELETE before inserting (the one-time truncation-repair). load() stays
   * non-mutating w.r.t. the event log — it only records this marker — so the
   * public contract matches the JSONL backend: load returns the committed
   * prefix; the subsequent append performs the physical repair.
   */
  repairFrom?: number
  /** The live Session that owns this state (collision detection); see onCreated. */
  owner?: Session
}

/**
 * Whether a live session's `seed` reproduces a persisted `prefix` exactly (the
 * prefix is no longer than the seed and each event DEEP-equals the seed event
 * at the same index). Distinguishes a session legitimately continuing a
 * persisted log (HMR re-seeing its own session, or a resume) from a different
 * session that merely reuses the id. Mirrors the JSONL backend's check; both
 * sides are JSON-serializable by contract, so `JSON.stringify` is a sound
 * canonical form.
 */
function seedCoversPrefix(seed: readonly SessionEvent[], prefix: readonly SessionEvent[]): boolean {
  return prefix.length <= seed.length
    && prefix.every((e, i) => {
      const s = seed[i]
      return s !== undefined && JSON.stringify(s) === JSON.stringify(e)
    })
}

/** Reject non-JSON-serializable `event.data`, naming the offending type. */
function assertSerializable(events: readonly SessionEvent[]): void {
  for (const event of events) {
    if (!isJsonValue(event.data)) {
      throw new Error(`event "${event.type}" carries non-JSON-serializable data (seq ${event.seq})`)
    }
  }
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

  create(meta: SessionMeta): Promise<void> {
    const snapshot: SessionMeta = { ...meta }
    return this.serialize(snapshot.id, () => this.createCore(snapshot))
  }

  private async createCore(meta: SessionMeta): Promise<void> {
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

    // The transaction is the durability + atomicity boundary: run any deferred
    // crash-tail repair, materialize the sessions row (if lazy), and INSERT
    // every event, or roll back entirely. A BEGIN/COMMIT around the batch means
    // a mid-batch failure (a UNIQUE violation on a duplicated seq from a
    // concurrent writer) leaves the stored log untouched, so the cursor stays
    // truthful and a retry is clean.
    const insertEvent = this.db.prepare(
      'INSERT INTO events (session_id, seq, type, time, data) VALUES (?, ?, ?, ?, ?)',
    )
    this.db.exec('BEGIN')
    try {
      // One-time truncation-repair: a prior load() found a crash tail and
      // deferred its physical removal to here (load stays non-mutating). DELETE
      // the orphaned rows (seq >= repairFrom) before inserting, inside the same
      // transaction, so the repair + first new append commit atomically.
      if (state.repairFrom !== undefined) {
        this.db.prepare('DELETE FROM events WHERE session_id = ? AND seq >= ?').run(id, state.repairFrom)
      }
      if (!state.materialized) this.writeRow(state.meta)
      for (const event of events) {
        insertEvent.run(id, event.seq, event.type, event.time, JSON.stringify(event.data))
      }
      // Bump updatedAt on every append (the mutable summary lives in the row).
      const updatedAt = Date.now()
      this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(updatedAt, id)
      this.db.exec('COMMIT')
      state.meta = { ...state.meta, updatedAt }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    delete state.repairFrom
    state.materialized = true
    state.cursor += events.length
  }

  load(id: SessionId): Promise<{ meta: SessionMeta; events: SessionEvent[] }> {
    return this.serialize(id, () => this.loadCore(id))
  }

  private async loadCore(id: SessionId): Promise<{ meta: SessionMeta; events: SessionEvent[] }> {
    await this.ready
    const row = this.rowFor(id)
    if (row === undefined) throw new Error(`session "${id}" not found`)
    const meta = rowToMeta(row)
    this.assertVersion(meta)

    // Read every stored row ordered by seq, then cut at the last complete
    // turn/end — the same crash-tail semantics as the JSONL backend. The cut is
    // computed from seq+type COLUMNS only, so a malformed `data` in the
    // uncommitted tail is discarded (not unloadable); only `data` in the
    // COMMITTED prefix is parsed (rowToEvent), where a parse error correctly
    // surfaces. A row that landed without its closing turn/end is an
    // uncommitted tail and is excluded; a seq gap in the committed region makes
    // the session unloadable (cutAtLastTurnEnd throws).
    const eventRows = this.db
      .prepare('SELECT seq, type, time, data FROM events WHERE session_id = ? ORDER BY seq')
      .all(id) as unknown as EventRow[]
    const { committed, cutTail } = cutAtLastTurnEnd(eventRows)
    const events = committed.map(rowToEvent)

    // Do NOT delete the crash tail here: load() stays non-mutating w.r.t. the
    // event log, matching the abstract contract and the JSONL backend (load
    // returns the committed prefix; the next append performs the one-time
    // physical repair). Record the repair point so the next appendCore DELETEs
    // the orphaned tail inside its own transaction before inserting.
    const materialized = committed.length > 0
    if (committed.length === 0 && row.materialized === 1) {
      // All-tail discard: the only committed events were a crash tail, so the
      // session now has NO committed events. The metadata row, however, still
      // reads materialized = 1 from the prior append — which would make has()
      // and list() report a session that load() just emptied. Correct the
      // materialized FLAG (metadata, not the event log) so has()/list() are
      // immediately consistent. The orphaned tail rows are still removed by the
      // deferred repair on the next append.
      this.db.prepare('UPDATE sessions SET materialized = 0 WHERE id = ?').run(id)
    }

    // Record state so a later append continues at the committed length and runs
    // the deferred tail repair. The state keeps its OWN copy of the meta; the
    // returned value is separate so a consumer mutating loaded.meta cannot
    // corrupt the backend's row metadata.
    this.states.set(id, {
      meta: { ...meta },
      cursor: committed.length,
      materialized,
      ...cutTail ? { repairFrom: committed.length } : {},
    })
    return { meta, events }
  }

  async list(): Promise<SessionMeta[]> {
    await this.ready
    // Materialized rows only: a created-but-never-appended (lazy) session has no
    // row at all, and a load that cut every event back to zero leaves
    // materialized = 0. Both are excluded, matching has().
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE materialized = 1')
      .all() as unknown as SessionRow[]
    return rows.map(rowToMeta)
  }

  async has(id: SessionId): Promise<boolean> {
    await this.ready
    const state = this.states.get(id)
    if (state?.materialized) return true
    const row = this.rowFor(id)
    return row !== undefined && row.materialized === 1
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

  update(id: SessionId, summary: Partial<SessionSummary>): Promise<void> {
    return this.serialize(id, () => this.updateCore(id, summary))
  }

  private async updateCore(id: SessionId, summary: Partial<SessionSummary>): Promise<void> {
    await this.ready
    let state = this.states.get(id)
    if (state === undefined) state = await this.adopt(id)
    const nextMeta: SessionMeta = { ...state.meta, ...summary }
    // update's only durable effect is the summary fields; the event log is
    // untouched. If the row is not materialized yet (a lazy session updated
    // before its first append) there is nothing to write — keep the pending
    // summary in memory so the materializing append carries it.
    if (state.materialized) this.writeRow(nextMeta)
    state.meta = nextMeta
  }

  // --- row helpers ---

  /** Fetch a session's row, or undefined if absent. */
  private rowFor(id: SessionId): SessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined
    return row
  }

  /**
   * Insert-or-replace a session's metadata row, marked materialized. The only
   * callers are the first materializing `append` and a post-materialization
   * `update` — a row is written only once a session has durable events, so
   * `materialized` is always 1 (a never-appended session has no row at all).
   */
  private writeRow(meta: SessionMeta): void {
    this.db.prepare(`
      INSERT INTO sessions (id, version, created_at, cwd, parent_session, updated_at, title, first_prompt, materialized)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        created_at = excluded.created_at,
        cwd = excluded.cwd,
        parent_session = excluded.parent_session,
        updated_at = excluded.updated_at,
        title = excluded.title,
        first_prompt = excluded.first_prompt,
        materialized = excluded.materialized
    `).run(
      meta.id,
      meta.version,
      meta.createdAt,
      meta.cwd ?? null,
      meta.parentSession ?? null,
      meta.updatedAt,
      meta.title ?? null,
      meta.firstPrompt ?? null,
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

  private assertVersion(meta: SessionMeta): void {
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
      await Promise.allSettled([...this.inits.values()])
      await Promise.allSettled([...this.buffers.keys()].map(s => this.flush(s)))
      await Promise.allSettled([...this.chains.values()])
      await this.ready
      this.db.close()
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
    if (row !== undefined && row.materialized === 1) {
      const stored = this.eventsFor(id)
      if (!seedCoversPrefix(seed, stored)) {
        throw new Error(`session "${id}" already has a persisted log that does not match this live session (id collision)`)
      }
      await this.serialize(id, () => this.loadCore(id))
      const adopted = this.states.get(id)
      /* v8 ignore next -- loadCore always sets the state for the id */
      if (adopted !== undefined) adopted.owner = session
      const suffix = seed.slice(stored.length)
      if (suffix.length > 0) await this.append(id, suffix)
      return
    }

    // case 4: a genuinely new session.
    const meta: SessionMeta = { ...session.header, updatedAt: Date.now() }
    await this.create(meta)
    const created = this.states.get(id)
    /* v8 ignore next -- create() always sets the state for the id */
    if (created !== undefined) created.owner = session
    if (seed.length > 0) await this.append(id, seed)
  }

  /** The committed events for a session id (last-turn/end cut applied). */
  private eventsFor(id: SessionId): SessionEvent[] {
    const rows = this.db
      .prepare('SELECT seq, type, time, data FROM events WHERE session_id = ? ORDER BY seq')
      .all(id) as unknown as EventRow[]
    // Cut on seq+type columns, then parse `data` only for the committed prefix
    // (a malformed tail must not throw here — same as loadCore).
    return cutAtLastTurnEnd(rows).committed.map(rowToEvent)
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
