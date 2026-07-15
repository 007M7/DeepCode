/**
 * Exact session-history reads over live and optionally persisted logs.
 *
 * @module @deepseek-ai/dsh-session-query
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionEventResultFilter,
  SessionEventReadRequest,
  SessionEventRecord,
  SessionEventSearchHit,
  SessionEventSearchDocument,
  SessionEventSearchRequest,
  SessionEventWindow,
  SessionRecord,
  SessionResultFilter,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from './types.ts'
import {
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
  type Config,
} from './config.ts'
import { SessionCorpus } from './corpus.ts'
import { buildSessionEventRecords, buildSessionEventSearchDocuments } from './documents.ts'
import {
  filterSessionEventDocuments,
  filterSessionResults,
  materializeSessionEventResultFilters,
  materializeSessionResultFilters,
} from './filters.ts'

export type * from './types.ts'
export { SessionSearchCursor } from './cursor.ts'
export type { Config, SessionQueryErrorCode } from './config.ts'
export { SESSION_QUERY_READ_WINDOW_MAX, SessionQueryError } from './config.ts'
export { extractSessionEventText } from './extraction.ts'
export { buildSessionEventRecords, buildSessionEventSearchDocuments } from './documents.ts'
export {
  compileSessionTextFilter,
  filterSessionEventDocuments,
  filterSessionResults,
  materializeSessionEventResultFilters,
  materializeSessionResultFilters,
} from './filters.ts'
export { assertSessionHeadersCompatible } from './sources.ts'

declare module 'cordis' {
  interface Context {
    sessionQuery: SessionQueryService
    sessionSearch: SessionSearchService
  }
}

/**
 * Abstract full-text search service implemented by one concrete backend.
 *
 * The implementation owns source observation, reconciliation, cursor
 * generations, ranking, and query execution as one lifecycle.
 */
export abstract class SessionSearchService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionSearch')
  }

  /**
   * Search the live-preferred logical corpus and group by session.
   * @param request - query text, metadata filters, page size, and cursor.
   * @param exec - optional cancellation control.
   * @returns session hits ranked by their strongest matching event.
   */
  abstract searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>>

  /**
   * Search events within one live-preferred logical session.
   * @param request - target session, query text, filters, page size, and cursor.
   * @param exec - optional cancellation control.
   * @returns matching event hits in deterministic relevance order.
   */
  abstract searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionEventSearchHit>>
}

/** Live-preferred logical-corpus and exact-event read service. */
export class SessionQueryService extends Service {
  static inject = ['sessions']
  static Config: z<Config> = z.object({
    readWindowMax: z.number().step(1).min(0).default(SESSION_QUERY_READ_WINDOW_MAX),
  })

  private readonly _readWindowMax: number
  private readonly _corpus: SessionCorpus

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessionQuery')
    this._readWindowMax = config.readWindowMax ?? SESSION_QUERY_READ_WINDOW_MAX
    if (!Number.isInteger(this._readWindowMax) || this._readWindowMax < 0) {
      throw new SessionQueryError(
        'session-query: readWindowMax must be a non-negative integer',
        'SESSION_QUERY_INVALID_CONFIG',
      )
    }
    this._corpus = new SessionCorpus(ctx)
  }

  /**
   * List the complete logical corpus using live-preferred records.
   * @returns deterministic newest-first cloned session records.
   */
  listSessions(): Promise<SessionRecord[]> {
    return this._corpus.listSessions()
  }

  /**
   * Filter the complete logical corpus with provider-independent predicates.
   * @param filters - ANDed session metadata and availability clauses.
   * @returns matching cloned records in deterministic newest-first order.
   */
  async filterSessions(filters: readonly SessionResultFilter[]): Promise<SessionRecord[]> {
    const ownedFilters = materializeSessionResultFilters(filters)
    return this._filterSessions(ownedFilters)
  }

  /**
   * List lightweight raw-log event records for one logical session.
   * @param sessionId - live-preferred session id to read.
   * @returns event records in ascending seq order.
   */
  async listEvents(sessionId: SessionId): Promise<SessionEventRecord[]> {
    const loaded = await this._corpus.load(sessionId)
    return buildSessionEventRecords(sessionId, loaded.events)
  }

  /**
   * Scan first-party semantic event documents with provider-independent filters.
   * @param sessionId - live-preferred session id to scan.
   * @param filters - ANDed metadata and literal-text predicates.
   * @returns matching semantic documents in ascending seq order.
   */
  async filterEvents(
    sessionId: SessionId,
    filters: readonly SessionEventResultFilter[],
  ): Promise<SessionEventSearchDocument[]> {
    const ownedFilters = materializeSessionEventResultFilters(filters)
    return this._filterEvents(sessionId, ownedFilters)
  }

  private async _filterSessions(filters: readonly SessionResultFilter[]): Promise<SessionRecord[]> {
    return filterSessionResults(await this._corpus.listSessions(), filters)
  }

  private async _filterEvents(
    sessionId: SessionId,
    filters: readonly SessionEventResultFilter[],
  ): Promise<SessionEventSearchDocument[]> {
    const loaded = await this._corpus.load(sessionId)
    const documents = buildSessionEventSearchDocuments(sessionId, loaded.events)
    return filterSessionEventDocuments(documents, filters)
  }

  /**
   * Read one full event plus a bounded raw-log context window.
   * @param request - target session/seq and context sizes.
   * @returns cloned target and neighboring events.
   */
  async readEvent(request: SessionEventReadRequest): Promise<SessionEventWindow> {
    const before = this._readWindow('before', request.before)
    const after = this._readWindow('after', request.after)
    const sessionId = request.sessionId
    const seq = request.seq
    return this._readEvent(sessionId, seq, before, after)
  }

  private async _readEvent(
    sessionId: SessionId,
    seq: number,
    before: number,
    after: number,
  ): Promise<SessionEventWindow> {
    const loaded = await this._corpus.load(sessionId)
    const target = loaded.events[seq]
    if (target === undefined || target.seq !== seq) {
      throw new SessionQueryError(
        `session "${sessionId}" has no event at seq ${seq}`,
        'SESSION_QUERY_EVENT_NOT_FOUND',
      )
    }
    const startSeq = Math.max(0, seq - before)
    const endSeq = Math.min(loaded.events.length - 1, seq + after)
    return {
      session: loaded.header,
      target,
      events: loaded.events.slice(startSeq, endSeq + 1),
      startSeq,
      endSeq,
    }
  }

  private _readWindow(name: 'before' | 'after', value: number | undefined): number {
    if (value === undefined) return 0
    if (!Number.isInteger(value) || value < 0 || value > this._readWindowMax) {
      throw new SessionQueryError(
        `${name} must be an integer between 0 and ${this._readWindowMax}`,
        'SESSION_QUERY_INVALID_WINDOW',
      )
    }
    return value
  }
}

export default SessionQueryService
