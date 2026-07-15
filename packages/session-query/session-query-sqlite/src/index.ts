/**
 * SQLite FTS5 search over the live-preferred logical session corpus.
 *
 * @module @deepseek-ai/dsh-session-query-sqlite
 */

import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Context } from 'cordis'
import z from 'schemastery'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import {
  SessionQueryError,
  SessionSearchService,
  assertSessionHeadersCompatible,
  buildSessionEventSearchDocuments,
} from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchDocument,
  SessionEventSearchHit,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import {
  type JournalMode,
  openSearchDatabase,
} from './schema.ts'
import {
  type NormalizedEventRequest,
  type NormalizedSessionRequest,
  buildEventWhere,
  buildSessionWhere,
  makeSnippet,
  normalizeEventRequest,
  normalizeSessionRequest,
  quoteFtsData,
  requestFingerprint,
} from './query.ts'

export {
  SESSION_QUERY_SQLITE_APPLICATION_ID,
  SESSION_QUERY_SQLITE_SCHEMA_VERSION,
  type JournalMode,
} from './schema.ts'

/** Default result page size. */
export const SESSION_QUERY_SQLITE_DEFAULT_LIMIT = 20
/** Maximum accepted result page size. */
export const SESSION_QUERY_SQLITE_MAX_LIMIT = 100
/** Default maximum snippet length in Unicode code points. */
export const SESSION_QUERY_SQLITE_SNIPPET_CHARS = 240

/** SQLite session-search configuration. */
export interface Config {
  /** Dedicated derived-index path; `:memory:` is supported for tests. */
  path: string
  /** SQLite journal mode. Defaults to `wal`. */
  journalMode?: JournalMode
  /** Page size when a request omits `limit`. Defaults to 20. */
  defaultLimit?: number
  /** Largest accepted page size. Defaults to 100. */
  maxLimit?: number
  /** Maximum snippet length in Unicode code points. Defaults to 240. */
  snippetChars?: number
}

interface ResolvedConfig {
  path: string
  journalMode: JournalMode
  defaultLimit: number
  maxLimit: number
  snippetChars: number
}

interface ObservedSession {
  header: SessionHeader
  events: SessionEvent[]
  documents: SessionEventSearchDocument[]
  fingerprint: string
}

interface Observation {
  persistence: SessionPersistence | undefined
  persistenceRevision: number
  persisted: Map<SessionId, ObservedSession>
  live: Map<SessionId, ObservedSession>
}

interface IndexedRow {
  id: string
  fingerprint: string
  generation: number
}

interface SearchRow {
  session_id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  live: number
  persisted: number
  seq: number
  type: string
  time: number
  surface: string
  text: string
  score: number
}

interface CursorPayload {
  version: 1
  instance: string
  scope: 'sessions' | 'events'
  fingerprint: string
  generation: string
  offset: number
}

/** Concrete SQLite owner of `ctx.sessionSearch`. */
export class SessionSearchSqlite extends SessionSearchService {
  static inject = ['sessions']

  static Config: z<Config> = z.object({
    path: z.string().required(),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    defaultLimit: z.number().step(1).min(1).default(SESSION_QUERY_SQLITE_DEFAULT_LIMIT),
    maxLimit: z.number().step(1).min(1).default(SESSION_QUERY_SQLITE_MAX_LIMIT),
    snippetChars: z.number().step(1).min(1).default(SESSION_QUERY_SQLITE_SNIPPET_CHARS),
  })

  /** Validated and defaulted backend configuration. */
  readonly config: ResolvedConfig

  private readonly _instance = randomUUID()
  private readonly _ready: Promise<void>
  private _db: DatabaseSync | undefined
  private _persistence: SessionPersistence | undefined
  private _persistenceBinding: object | undefined
  private _persistenceRevision = 0
  private _lastPersistenceRevision: number | undefined
  private _persistenceEpoch = 0
  private _globalGeneration = 0
  private _localGeneration = 0
  private _tail: Promise<void> = Promise.resolve()
  private _closed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = resolveConfig(config)
    this._ready = this._open()
    ctx.effect(() => {
      const fiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
        const service = childCtx.sessionPersistence
        const binding = {}
        this._persistenceBinding = binding
        this._persistence = service
        this._persistenceRevision += 1
        childCtx.effect(() => () => {
          /* v8 ignore next -- a stale optional-service disposer cannot clear a replacement */
          if (this._persistenceBinding !== binding) return
          this._persistenceBinding = undefined
          this._persistence = undefined
          this._persistenceRevision += 1
        }, 'sessionSearchSqlite.persistenceBinding')
      })
      return () => void fiber.dispose()
    }, 'sessionSearchSqlite.optionalPersistence')
    ctx.effect(() => async () => this.close(), 'sessionSearchSqlite.close')
  }

  override async searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    const normalized = normalizeSessionRequest(request, this.config)
    return this._serialized(exec?.signal, async () => {
      await this._ensureReady(exec?.signal)
      await this._reconcile(exec?.signal)
      assertNotAborted(exec?.signal)
      const generation = String(this._globalGeneration)
      const fingerprint = requestFingerprint(normalized)
      const offset = normalized.cursor === undefined
        ? 0
        : decodeCursor(normalized.cursor, this._instance, 'sessions', fingerprint, generation)
      const rows = this._querySessions(normalized, offset)
      return page(rows, normalized.limit, row => this._sessionHit(row, normalized.query), cursorOffset => encodeCursor({
        version: 1,
        instance: this._instance,
        scope: 'sessions',
        fingerprint,
        generation,
        offset: cursorOffset,
      }), offset)
    })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionEventSearchHit>> {
    const normalized = normalizeEventRequest(request, this.config)
    return this._serialized(exec?.signal, async () => {
      await this._ensureReady(exec?.signal)
      await this._reconcile(exec?.signal)
      assertNotAborted(exec?.signal)
      const generation = this._targetGeneration(normalized.sessionId)
      const fingerprint = requestFingerprint(normalized)
      const offset = normalized.cursor === undefined
        ? 0
        : decodeCursor(normalized.cursor, this._instance, 'events', fingerprint, generation)
      const rows = this._queryEvents(normalized, offset)
      return page(rows, normalized.limit, row => this._eventHit(row, normalized.query), cursorOffset => encodeCursor({
        version: 1,
        instance: this._instance,
        scope: 'events',
        fingerprint,
        generation,
        offset: cursorOffset,
      }), offset)
    })
  }

  /** Close the database after every accepted operation reaches quiescence. */
  async close(): Promise<void> {
    if (this._closed) return
    this._closed = true
    await this._tail
    try {
      await this._ready
    } catch {
      // Opening already closed a partially-created handle; disposal only waits.
    }
    this._db?.close()
    this._db = undefined
  }

  private async _open(): Promise<void> {
    this._db = await openSearchDatabase(this.config.path, this.config.journalMode)
    const state = this._db.prepare(
      'SELECT global_generation FROM search_state WHERE singleton = 1',
    ).get() as { global_generation: number }
    this._globalGeneration = state.global_generation
    this._localGeneration = state.global_generation
  }

  private async _ensureReady(signal: AbortSignal | undefined): Promise<void> {
    try {
      await waitWithAbort(this._ready, signal)
    } catch (error: unknown) {
      if (isAbort(error)) throw error
      throw new SessionQueryError(
        `session-search SQLite index failed to open: ${errorMessage(error)}`,
        'SESSION_QUERY_INDEX_FAILED',
        { cause: error },
      )
    }
  }

  private async _serialized<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (this._isClosed()) throw indexClosed()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const prior = this._tail
    this._tail = prior.then(() => gate)
    try {
      await waitWithAbort(prior, signal)
    } catch (error: unknown) {
      release()
      throw error
    }
    if (this._isClosed()) {
      release()
      throw indexClosed()
    }
    try {
      assertNotAborted(signal)
      return await operation()
    } finally {
      release()
    }
  }

  private async _reconcile(signal: AbortSignal | undefined): Promise<void> {
    const observation = await this._observeStable(signal)
    assertNotAborted(signal)
    const db = this._requireDb()
    const persistedRows = db.prepare(
      'SELECT id, fingerprint, generation FROM persisted_sessions',
    ).all() as unknown as IndexedRow[]
    const liveRows = db.prepare(
      'SELECT id, fingerprint, generation FROM temp.live_sessions',
    ).all() as unknown as IndexedRow[]
    const persistedById = new Map(persistedRows.map(row => [row.id as SessionId, row]))
    const liveById = new Map(liveRows.map(row => [row.id as SessionId, row]))
    const persistentChanges = observation.persistence === undefined
      ? []
      : [...observation.persisted.values()].filter(entry => persistedById.get(entry.header.id)?.fingerprint !== entry.fingerprint)
    const persistentDeletes = observation.persistence === undefined
      ? []
      : persistedRows.filter(row => !observation.persisted.has(row.id as SessionId))
    const liveChanges = [...observation.live.values()].filter(entry => liveById.get(entry.header.id)?.fingerprint !== entry.fingerprint)
    const liveDeletes = liveRows.filter(row => !observation.live.has(row.id as SessionId))
    const pointerChanged = this._lastPersistenceRevision !== undefined
      && this._lastPersistenceRevision !== observation.persistenceRevision
    const hasWrites = persistentChanges.length > 0
      || persistentDeletes.length > 0
      || liveChanges.length > 0
      || liveDeletes.length > 0

    let nextMainGeneration = this._mainGeneration()
    let nextLocalGeneration = this._localGeneration
    if (persistentChanges.length > 0 || persistentDeletes.length > 0) nextMainGeneration += 1
    const liveReplacements = liveChanges.map((entry) => {
      nextLocalGeneration = Math.max(nextLocalGeneration, nextMainGeneration) + 1
      return { entry, generation: nextLocalGeneration }
    })

    if (hasWrites) {
      let began = false
      try {
        db.exec('BEGIN IMMEDIATE')
        began = true
        for (const row of persistentDeletes) this._deleteSession('persisted', row.id as SessionId)
        for (const entry of persistentChanges) this._replaceSession('persisted', entry, nextMainGeneration)
        if (persistentChanges.length > 0 || persistentDeletes.length > 0) {
          db.prepare('UPDATE search_state SET global_generation = ? WHERE singleton = 1').run(nextMainGeneration)
        }
        for (const row of liveDeletes) this._deleteSession('live', row.id as SessionId)
        for (const { entry, generation } of liveReplacements) {
          this._replaceSession('live', entry, generation)
        }
        db.exec('COMMIT')
      } catch (error: unknown) {
        /* v8 ignore next -- a BEGIN failure has no transaction to roll back; the common wrapper still reports it. */
        if (began) {
          /* v8 ignore next 5 -- ROLLBACK failure requires a SQLite double fault; the original failure remains actionable. */
          try {
            db.exec('ROLLBACK')
          } catch {
            // The original SQLite failure remains the actionable cause.
          }
        }
        throw new SessionQueryError(
          `session-search reconciliation failed: ${errorMessage(error)}`,
          'SESSION_QUERY_INDEX_FAILED',
          { cause: error },
        )
      }
    }

    if (hasWrites || pointerChanged) this._globalGeneration += 1
    if (pointerChanged) this._persistenceEpoch += 1
    this._localGeneration = nextLocalGeneration
    this._lastPersistenceRevision = observation.persistenceRevision
  }

  private async _observeStable(signal: AbortSignal | undefined): Promise<Observation> {
    for (;;) {
      assertNotAborted(signal)
      const persistence = this._persistence
      const persistenceRevision = this._persistenceRevision
      const persisted = new Map<SessionId, ObservedSession>()
      if (persistence !== undefined) {
        try {
          const headers = await waitWithAbort(persistence.list(), signal)
          for (const listed of headers) {
            const loaded = await waitWithAbort(persistence.load(listed.id), signal)
            assertSessionHeadersCompatible(listed, loaded.meta)
            persisted.set(listed.id, observeSession(loaded.meta, loaded.events))
          }
        } catch (error: unknown) {
          if (error instanceof SessionQueryError) throw error
          throw new SessionQueryError(
            `session-search persistence observation failed: ${errorMessage(error)}`,
            'SESSION_QUERY_PERSISTENCE_FAILED',
            { cause: error },
          )
        }
      }
      const live = new Map<SessionId, ObservedSession>()
      for (const session of this.ctx.sessions.list()) {
        const observed = observeLive(session)
        const durable = persisted.get(session.id)
        if (durable !== undefined) assertSessionHeadersCompatible(observed.header, durable.header)
        live.set(session.id, observed)
      }
      if (this._persistenceRevision === persistenceRevision) {
        return { persistence, persistenceRevision, persisted, live }
      }
    }
  }

  private _mainGeneration(): number {
    const row = this._requireDb().prepare(
      'SELECT global_generation FROM search_state WHERE singleton = 1',
    ).get() as { global_generation: number }
    return row.global_generation
  }

  private _deleteSession(source: 'persisted' | 'live', id: SessionId): void {
    const db = this._requireDb()
    if (source === 'persisted') {
      db.prepare('DELETE FROM persisted_docs WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM persisted_sessions WHERE id = ?').run(id)
    } else {
      db.prepare('DELETE FROM temp.live_docs WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM temp.live_sessions WHERE id = ?').run(id)
    }
  }

  private _replaceSession(source: 'persisted' | 'live', entry: ObservedSession, generation: number): void {
    this._deleteSession(source, entry.header.id)
    const db = this._requireDb()
    const sessionTable = source === 'persisted' ? 'persisted_sessions' : 'temp.live_sessions'
    const docsTable = source === 'persisted' ? 'persisted_docs' : 'temp.live_docs'
    db.prepare(`
      INSERT INTO ${sessionTable}
        (id, version, created_at, cwd, parent_session, seed_length, fingerprint, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.header.id,
      entry.header.version,
      entry.header.createdAt,
      entry.header.cwd ?? null,
      entry.header.parentSession ?? null,
      entry.header.seedLength ?? null,
      entry.fingerprint,
      generation,
    )
    const insert = db.prepare(`
      INSERT INTO ${docsTable} (text, session_id, seq, type, time, surface)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const document of entry.documents) {
      insert.run(document.text, document.sessionId, document.seq, document.type, document.time, document.surface)
    }
  }

  private _querySessions(request: NormalizedSessionRequest, offset: number): SearchRow[] {
    const selected = selectedDocumentsSql()
    const sessionWhere = buildSessionWhere(request.sessionFilters)
    const eventWhere = buildEventWhere(request.eventFilters)
    const where = [sessionWhere.sql, eventWhere.sql].filter(Boolean).join(' AND ')
    return this._requireDb().prepare(`
      ${selected.sql},
      filtered AS (
        SELECT * FROM matched ${where.length === 0 ? '' : `WHERE ${where}`}
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY session_id
          ORDER BY score ASC, time DESC, seq DESC
        ) AS event_rank
        FROM filtered
      )
      SELECT * FROM ranked
      WHERE event_rank = 1
      ORDER BY score ASC, time DESC, session_id ASC, seq DESC
      LIMIT ? OFFSET ?
    `).all(
      quoteFtsData(request.query),
      this._persistence === undefined ? 0 : 1,
      this._persistence === undefined ? 0 : 1,
      quoteFtsData(request.query),
      ...sessionWhere.params,
      ...eventWhere.params,
      request.limit + 1,
      offset,
    ) as unknown as SearchRow[]
  }

  private _queryEvents(request: NormalizedEventRequest, offset: number): SearchRow[] {
    const selected = selectedDocumentsSql()
    const eventWhere = buildEventWhere(request.filters)
    const where = ['session_id = ?', eventWhere.sql].filter(Boolean).join(' AND ')
    return this._requireDb().prepare(`
      ${selected.sql}
      SELECT * FROM matched
      WHERE ${where}
      ORDER BY score ASC, time DESC, seq DESC
      LIMIT ? OFFSET ?
    `).all(
      quoteFtsData(request.query),
      this._persistence === undefined ? 0 : 1,
      this._persistence === undefined ? 0 : 1,
      quoteFtsData(request.query),
      request.sessionId,
      ...eventWhere.params,
      request.limit + 1,
      offset,
    ) as unknown as SearchRow[]
  }

  private _targetGeneration(sessionId: SessionId): string {
    const db = this._requireDb()
    const live = db.prepare(
      'SELECT generation FROM temp.live_sessions WHERE id = ?',
    ).get(sessionId) as { generation: number } | undefined
    if (live !== undefined) return `live:${live.generation}`
    if (this._persistence !== undefined) {
      const persisted = db.prepare(
        'SELECT generation FROM persisted_sessions WHERE id = ?',
      ).get(sessionId) as { generation: number } | undefined
      if (persisted !== undefined) return `persisted:${this._persistenceEpoch}:${persisted.generation}`
    }
    throw new SessionQueryError(
      `session "${sessionId}" not found`,
      'SESSION_QUERY_SESSION_NOT_FOUND',
    )
  }

  private _sessionHit(row: SearchRow, query: string): SessionSearchHit {
    return {
      header: rowHeader(row),
      live: row.live === 1,
      persisted: row.persisted === 1,
      bestMatch: this._eventHit(row, query),
    }
  }

  private _eventHit(row: SearchRow, query: string): SessionEventSearchHit {
    return {
      sessionId: row.session_id as SessionId,
      seq: row.seq,
      type: row.type as SessionEventSearchHit['type'],
      time: row.time,
      surface: row.surface as SessionEventSearchHit['surface'],
      snippet: makeSnippet(row.text, query, this.config.snippetChars),
    }
  }

  private _requireDb(): DatabaseSync {
    /* v8 ignore next -- callers await `_ready`; this guards lifecycle misuse */
    if (this._db === undefined) throw indexClosed()
    return this._db
  }

  private _isClosed(): boolean {
    return this._closed
  }
}

function selectedDocumentsSql(): { sql: string } {
  return {
    sql: `WITH matched AS (
      SELECT
        pd.session_id AS session_id,
        ps.version AS version,
        ps.created_at AS created_at,
        ps.cwd AS cwd,
        ps.parent_session AS parent_session,
        ps.seed_length AS seed_length,
        0 AS live,
        1 AS persisted,
        CAST(pd.seq AS INTEGER) AS seq,
        pd.type AS type,
        CAST(pd.time AS INTEGER) AS time,
        pd.surface AS surface,
        pd.text AS text,
        bm25(persisted_docs) AS score
      FROM persisted_docs AS pd
      JOIN persisted_sessions AS ps ON ps.id = pd.session_id
      WHERE persisted_docs MATCH ?
        AND ? = 1
        AND NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = pd.session_id)
      UNION ALL
      SELECT
        ld.session_id AS session_id,
        ls.version AS version,
        ls.created_at AS created_at,
        ls.cwd AS cwd,
        ls.parent_session AS parent_session,
        ls.seed_length AS seed_length,
        1 AS live,
        CASE WHEN ? = 1 AND EXISTS (
          SELECT 1 FROM persisted_sessions AS ps WHERE ps.id = ld.session_id
        ) THEN 1 ELSE 0 END AS persisted,
        CAST(ld.seq AS INTEGER) AS seq,
        ld.type AS type,
        CAST(ld.time AS INTEGER) AS time,
        ld.surface AS surface,
        ld.text AS text,
        bm25(live_docs) AS score
      FROM temp.live_docs AS ld
      JOIN temp.live_sessions AS ls ON ls.id = ld.session_id
      WHERE live_docs MATCH ?
    )`,
  }
}

function observeLive(session: Session): ObservedSession {
  return observeSession(
    structuredClone(session.header),
    session.events.map(event => structuredClone(event)),
  )
}

function observeSession(header: SessionHeader, events: readonly SessionEvent[]): ObservedSession {
  const detachedHeader = structuredClone(header)
  const detachedEvents = events.map(event => structuredClone(event))
  return {
    header: detachedHeader,
    events: detachedEvents,
    documents: buildSessionEventSearchDocuments(detachedHeader.id, detachedEvents),
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ header: detachedHeader, events: detachedEvents }))
      .digest('base64url'),
  }
}

function rowHeader(row: SearchRow): SessionHeader {
  return {
    version: row.version,
    id: row.session_id as SessionId,
    createdAt: row.created_at,
    ...row.cwd === null ? {} : { cwd: row.cwd },
    ...row.parent_session === null ? {} : { parentSession: row.parent_session as SessionId },
    ...row.seed_length === null ? {} : { seedLength: row.seed_length },
  }
}

function page<Row, Item>(
  rows: readonly Row[],
  limit: number,
  convert: (row: Row) => Item,
  nextCursor: (offset: number) => string,
  offset: number,
): SessionSearchPage<Item> {
  const hasMore = rows.length > limit
  return {
    items: rows.slice(0, limit).map(convert),
    ...hasMore ? { nextCursor: nextCursor(offset + limit) } : {},
  }
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeCursor(
  cursor: string,
  instance: string,
  scope: CursorPayload['scope'],
  fingerprint: string,
  generation: string,
): number {
  let decoded: Partial<CursorPayload>
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>
  } catch (error: unknown) {
    throw invalidCursor(error)
  }
  if (
    decoded.version !== 1
    || decoded.instance !== instance
    || decoded.scope !== scope
    || decoded.fingerprint !== fingerprint
    || !Number.isInteger(decoded.offset)
    || decoded.offset === undefined
    || decoded.offset < 0
  ) {
    throw invalidCursor(new Error('cursor does not belong to this normalized request'))
  }
  if (decoded.generation !== generation) {
    throw new SessionQueryError(
      'session-search cursor is stale because its relevant corpus changed',
      'SESSION_QUERY_STALE_CURSOR',
    )
  }
  return decoded.offset
}

function invalidCursor(cause: unknown): SessionQueryError {
  return new SessionQueryError(
    'session-search cursor is invalid',
    'SESSION_QUERY_INVALID_CURSOR',
    { cause },
  )
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    path: config.path,
    journalMode: config.journalMode ?? 'wal',
    defaultLimit: config.defaultLimit ?? SESSION_QUERY_SQLITE_DEFAULT_LIMIT,
    maxLimit: config.maxLimit ?? SESSION_QUERY_SQLITE_MAX_LIMIT,
    snippetChars: config.snippetChars ?? SESSION_QUERY_SQLITE_SNIPPET_CHARS,
  }
  if (typeof resolved.path !== 'string' || resolved.path.trim().length === 0) {
    throw invalidConfig('path must not be blank')
  }
  assertPositiveInteger('defaultLimit', resolved.defaultLimit)
  assertPositiveInteger('maxLimit', resolved.maxLimit)
  assertPositiveInteger('snippetChars', resolved.snippetChars)
  if (resolved.defaultLimit > resolved.maxLimit) {
    throw invalidConfig('defaultLimit must be less than or equal to maxLimit')
  }
  const journalModes: readonly string[] = ['wal', 'delete', 'truncate', 'persist']
  if (!journalModes.includes(resolved.journalMode)) throw invalidConfig('journalMode is not supported')
  return resolved
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw invalidConfig(`${name} must be a positive integer`)
}

function invalidConfig(detail: string): SessionQueryError {
  return new SessionQueryError(
    `session-search SQLite config: ${detail}`,
    'SESSION_QUERY_INVALID_CONFIG',
  )
}

function indexClosed(): SessionQueryError {
  return new SessionQueryError('session-search SQLite index is closed', 'SESSION_QUERY_INDEX_FAILED')
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED')
  }
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(error))
      },
    )
  })
}

function isAbort(error: unknown): boolean {
  return error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED'
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('session-search dependency rejected with a non-Error value', { cause: error })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

export default SessionSearchSqlite
