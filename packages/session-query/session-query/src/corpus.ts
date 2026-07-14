/** Live/persisted logical-corpus resolution for session-query. */

import type { Context } from 'cordis'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { SessionRecord } from './types.ts'
import { SessionQueryError } from './config.ts'

/** Detached source selected for one exact read. */
export interface LogicalSession {
  /** Cloned source header. */
  header: SessionHeader
  /** Cloned raw event log. */
  events: SessionEvent[]
}

/** Resolves a live-preferred corpus against the persistence service mounted now. */
export class SessionCorpus {
  private _persistence: SessionPersistence | undefined

  constructor(private readonly _ctx: Context) {
    _ctx.effect(() => {
      const fiber = _ctx.inject(['sessionPersistence'], (childCtx: Context) => {
        const service = childCtx.sessionPersistence
        this._persistence = service
        childCtx.effect(() => () => {
          /* v8 ignore next -- a stale optional-service disposer cannot clear a replacement */
          if (this._persistence === service) this._persistence = undefined
        }, 'sessionQuery.persistenceBinding')
      })
      return () => void fiber.dispose()
    }, 'sessionQuery.optionalPersistence')
  }

  /**
   * List the complete logical corpus with live precedence and cloned headers.
   * @returns records in deterministic newest-first order.
   */
  async listSessions(): Promise<SessionRecord[]> {
    const persistence = this._persistence
    const persisted = persistence === undefined ? [] : await listPersisted(persistence)
    const records = new Map<SessionId, SessionRecord>()
    for (const header of persisted) {
      records.set(header.id, { header: structuredClone(header), live: false, persisted: true })
    }
    for (const session of this._ctx.sessions.list()) {
      const durable = records.get(session.id)
      if (durable !== undefined) assertCompatibleHeaders(session.header, durable.header)
      records.set(session.id, {
        header: structuredClone(session.header),
        live: true,
        persisted: durable !== undefined,
      })
    }
    return [...records.values()].sort(compareSessions)
  }

  /**
   * Load one logical source, preferring a detached live snapshot.
   *
   * A known live target never consults persistence, so an optional backend's
   * failure cannot make current in-memory history unreadable.
   * @param sessionId - session to resolve.
   * @returns detached live-preferred header and events.
   */
  async load(sessionId: SessionId): Promise<LogicalSession> {
    const live = this._ctx.sessions.get(sessionId)
    if (live !== undefined) return snapshotLive(live)
    const persistence = this._persistence
    if (persistence === undefined) throw notFound(sessionId)
    const listed = (await listPersisted(persistence)).find(header => header.id === sessionId)
    if (listed === undefined) throw notFound(sessionId)
    let loaded: Awaited<ReturnType<SessionPersistence['load']>>
    try {
      loaded = await persistence.load(sessionId)
    } catch (error: unknown) {
      throw new SessionQueryError(
        `failed to load session "${sessionId}": ${errorMessage(error)}`,
        'SESSION_QUERY_PERSISTENCE_FAILED',
        { cause: error },
      )
    }
    assertCompatibleHeaders(loaded.meta, listed)
    return {
      header: structuredClone(loaded.meta),
      events: loaded.events.map(event => structuredClone(event)),
    }
  }
}

async function listPersisted(persistence: SessionPersistence): Promise<SessionHeader[]> {
  try {
    return await persistence.list()
  } catch (error: unknown) {
    throw new SessionQueryError(
      `session persistence listing failed: ${errorMessage(error)}`,
      'SESSION_QUERY_PERSISTENCE_FAILED',
      { cause: error },
    )
  }
}

function snapshotLive(session: Session): LogicalSession {
  return {
    header: structuredClone(session.header),
    events: session.events.map(event => structuredClone(event)),
  }
}

function assertCompatibleHeaders(a: SessionHeader, b: SessionHeader): void {
  if (
    a.version !== b.version
    || a.id !== b.id
    || a.createdAt !== b.createdAt
    || a.cwd !== b.cwd
    || a.parentSession !== b.parentSession
    || a.seedLength !== b.seedLength
  ) {
    throw new SessionQueryError(
      `live and persisted headers conflict for session "${a.id}"`,
      'SESSION_QUERY_SOURCE_CONFLICT',
    )
  }
}

function compareSessions(a: SessionRecord, b: SessionRecord): number {
  return b.header.createdAt - a.header.createdAt || a.header.id.localeCompare(b.header.id)
}

function notFound(sessionId: SessionId): SessionQueryError {
  return new SessionQueryError(`session "${sessionId}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
