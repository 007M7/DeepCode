/** Live/persisted logical-corpus resolution for session-query. */

import type { Context } from 'cordis'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { SessionRecord } from './types.ts'
import type { LoadedSession } from './extraction.ts'
import { canonicalJson } from './extraction.ts'
import { SessionQueryError } from './config.ts'

interface PersistenceBinding {
  token: symbol
  service: SessionPersistence
  headers: Map<SessionId, SessionHeader>
  error?: unknown
  refreshing: Promise<void> | undefined
}

/** Active persistence view used by provider reconciliation. */
export interface PersistenceView {
  /** Canonical headers in deterministic creation order. */
  headers: SessionHeader[]
  /** Load one canonical persisted source. */
  load(id: SessionId): Promise<LoadedSession>
}

/** Resolves one live-preferred corpus while containing optional persistence lifecycle. */
export class SessionCorpus {
  private _persistence: PersistenceBinding | undefined

  constructor(
    private readonly _ctx: Context,
    private readonly _onPersistenceChange: (active: boolean) => void,
  ) {
    _ctx.effect(() => {
      const fiber = _ctx.inject(['sessionPersistence'], (childCtx: Context) => {
        this._attachPersistence(childCtx, childCtx.sessionPersistence)
      })
      return () => void fiber.dispose()
    }, 'sessionQuery.optionalPersistence')
  }

  /**
   * List the complete logical corpus with live precedence and cloned headers.
   * @returns logical records in deterministic newest-first order.
   */
  async listSessions(): Promise<SessionRecord[]> {
    const binding = await this._ensurePersistence()
    const records = new Map<SessionId, SessionRecord>()
    if (binding !== undefined) {
      for (const header of binding.headers.values()) {
        records.set(header.id, { header: structuredClone(header), live: false, persisted: true })
      }
    }
    for (const session of this._ctx.sessions.list()) {
      const persisted = binding?.headers.get(session.id)
      if (persisted !== undefined) this._assertCompatibleHeaders(session.header, persisted)
      records.set(session.id, {
        header: structuredClone(session.header),
        live: true,
        persisted: persisted !== undefined,
      })
    }
    return [...records.values()].sort(compareSessions)
  }

  /**
   * Load one logical source, preferring a detached live snapshot.
   * @param sessionId - session to resolve.
   * @returns detached live-preferred metadata and events.
   */
  async loadLogical(sessionId: SessionId): Promise<LoadedSession> {
    const live = this._ctx.sessions.get(sessionId)
    if (live !== undefined) return this.snapshotLive(live)
    const binding = await this._ensurePersistence()
    if (binding === undefined || !binding.headers.has(sessionId)) {
      throw new SessionQueryError(`session "${sessionId}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND')
    }
    return this._loadPersisted(binding, sessionId)
  }

  /**
   * Return a detached live source with current availability flags.
   * @param session - live session to snapshot.
   * @returns detached metadata and events.
   */
  snapshotLive(session: Session): LoadedSession {
    const persistedHeader = this._persistence?.headers.get(session.id)
    if (persistedHeader !== undefined) this._assertCompatibleHeaders(session.header, persistedHeader)
    return {
      record: {
        header: structuredClone(session.header),
        live: true,
        persisted: persistedHeader !== undefined,
      },
      events: session.events.map(event => structuredClone(event)),
    }
  }

  /**
   * Get one live session without consulting persistence.
   * @param sessionId - live id to resolve.
   * @returns current store object, or undefined.
   */
  getLive(sessionId: SessionId): Session | undefined {
    return this._ctx.sessions.get(sessionId)
  }

  /**
   * List live sessions in store order.
   * @returns fresh array of current store objects.
   */
  listLive(): Session[] {
    return this._ctx.sessions.list()
  }

  /**
   * Resolve an authoritative persisted view.
   * @returns cloned headers and loader, or undefined while unmounted.
   */
  async persistenceView(): Promise<PersistenceView | undefined> {
    const binding = await this._ensurePersistence()
    if (binding === undefined) return undefined
    return {
      headers: [...binding.headers.values()].map(header => structuredClone(header)).sort(compareHeadersAscending),
      load: id => this._loadPersisted(binding, id),
    }
  }

  private _attachPersistence(ctx: Context, service: SessionPersistence): void {
    const binding: PersistenceBinding = {
      token: Symbol('session-query-persistence'),
      service,
      headers: new Map(),
      refreshing: undefined,
    }
    this._persistence = binding
    this._onPersistenceChange(true)
    void this._refreshPersistence(binding)
    ctx.on('session/persisted', (header) => {
      /* v8 ignore next -- a stale notification can race optional-service disposal */
      if (this._persistence?.token !== binding.token) return
      binding.headers.set(header.id, structuredClone(header))
      this._onPersistenceChange(true)
    })
    ctx.effect(() => () => { this._detachPersistence(binding) }, 'sessionQuery.persistenceBinding')
  }

  private _detachPersistence(binding: PersistenceBinding): void {
    /* v8 ignore next -- duplicate optional-service disposal is a Cordis teardown edge */
    if (this._persistence?.token !== binding.token) return
    this._persistence = undefined
    this._onPersistenceChange(false)
  }

  private _refreshPersistence(binding: PersistenceBinding): Promise<void> {
    if (binding.refreshing !== undefined) return binding.refreshing
    const refresh = binding.service.list().then((headers) => {
      /* v8 ignore next -- a list completion can race optional-service disposal */
      if (this._persistence?.token !== binding.token) return
      binding.headers = new Map(headers.map(header => [header.id, structuredClone(header)]))
      binding.error = undefined
      this._onPersistenceChange(true)
    }).catch((error: unknown) => {
      /* v8 ignore next -- a failed list can race optional-service disposal */
      if (this._persistence?.token !== binding.token) return
      binding.error = error
    }).finally(() => {
      /* v8 ignore next -- a newer refresh may already own the slot */
      if (binding.refreshing === refresh) binding.refreshing = undefined
    })
    binding.refreshing = refresh
    return refresh
  }

  private async _ensurePersistence(): Promise<PersistenceBinding | undefined> {
    const binding = this._persistence
    if (binding === undefined) return undefined
    await this._refreshPersistence(binding)
    if (binding.error !== undefined) {
      const cause = binding.error
      throw new SessionQueryError(`session persistence listing failed: ${errorMessage(cause)}`, 'SESSION_QUERY_PERSISTENCE_FAILED', { cause })
    }
    return binding
  }

  private async _loadPersisted(binding: PersistenceBinding, sessionId: SessionId): Promise<LoadedSession> {
    try {
      const loaded = await binding.service.load(sessionId)
      const listed = binding.headers.get(sessionId)
      /* v8 ignore else -- every internal persisted load starts from a listed header */
      if (listed !== undefined) this._assertCompatibleHeaders(loaded.meta, listed)
      return {
        record: { header: structuredClone(loaded.meta), live: false, persisted: true },
        events: loaded.events.map(event => structuredClone(event)),
      }
    } catch (error: unknown) {
      if (error instanceof SessionQueryError) throw error
      throw new SessionQueryError(`failed to load session "${sessionId}": ${errorMessage(error)}`, 'SESSION_QUERY_PERSISTENCE_FAILED', { cause: error })
    }
  }

  private _assertCompatibleHeaders(a: SessionHeader, b: SessionHeader): void {
    if (canonicalJson(a) !== canonicalJson(b)) {
      throw new SessionQueryError(`live and persisted headers conflict for session "${a.id}"`, 'SESSION_QUERY_SOURCE_CONFLICT')
    }
  }
}

function compareSessions(a: SessionRecord, b: SessionRecord): number {
  return b.header.createdAt - a.header.createdAt || a.header.id.localeCompare(b.header.id)
}

function compareHeadersAscending(a: SessionHeader, b: SessionHeader): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id)
}

function errorMessage(error: unknown): string {
  /* v8 ignore next -- persistence service contracts reject Error instances */
  return error instanceof Error ? error.message : 'unknown error'
}
