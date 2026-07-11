/**
 * Provider-neutral session-history retrieval over live and optionally
 * persisted session logs. The public service composes logical-corpus reads,
 * pure filters and tracing, semantic extraction, and provider coordination.
 *
 * @module @deepseek-ai/dsh-session-query
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import type { ContentBlockType } from '@deepseek-ai/dsh-llm'
import type { SessionEventType, SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionContentTextExtractor,
  SessionEventReadRequest,
  SessionEventRecord,
  SessionEventSearchHit,
  SessionEventSearchRequest,
  SessionEventTextExtractor,
  SessionEventTrace,
  SessionEventWindow,
  SessionLineageTrace,
  SessionRecord,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchProvider,
  SessionSearchRequest,
  SessionQueryExecContext,
} from './types.ts'
import {
  SESSION_QUERY_DEFAULT_LIMIT,
  SESSION_QUERY_MAX_LIMIT,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
  type Config,
} from './config.ts'
import { SessionTextExtractors } from './extraction.ts'
import { SessionCorpus } from './corpus.ts'
import { SessionProviderCoordinator } from './provider.ts'
import { eventRecords, traceEventLog, traceLineage } from './tracing.ts'

export type * from './types.ts'
export type { Config, SessionQueryErrorCode } from './config.ts'
export {
  SESSION_QUERY_DEFAULT_LIMIT,
  SESSION_QUERY_MAX_LIMIT,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
} from './config.ts'
export { filterEventResults, filterSessionResults } from './filters.ts'

declare module 'cordis' {
  interface Context {
    sessionQuery: SessionQueryService
  }
}

/** Session-history retrieval and provider coordination service. */
export class SessionQueryService extends Service {
  static inject = ['sessions']
  static Config: z<Config> = z.object({
    searchProvider: z.string(),
    defaultLimit: z.number().step(1).min(1).default(SESSION_QUERY_DEFAULT_LIMIT),
    maxLimit: z.number().step(1).min(1).default(SESSION_QUERY_MAX_LIMIT),
    readWindowMax: z.number().step(1).min(0).default(SESSION_QUERY_READ_WINDOW_MAX),
  })

  private readonly _readWindowMax: number
  private readonly _extractors: SessionTextExtractors
  private readonly _providers: SessionProviderCoordinator
  private readonly _corpus: SessionCorpus

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessionQuery')
    const defaultLimit = config.defaultLimit ?? SESSION_QUERY_DEFAULT_LIMIT
    const maxLimit = config.maxLimit ?? SESSION_QUERY_MAX_LIMIT
    this._readWindowMax = config.readWindowMax ?? SESSION_QUERY_READ_WINDOW_MAX
    if (defaultLimit > maxLimit) {
      throw new SessionQueryError('session-query: defaultLimit must be <= maxLimit', 'SESSION_QUERY_INVALID_CONFIG')
    }
    this._extractors = new SessionTextExtractors()
    this._providers = new SessionProviderCoordinator({
      ...config.searchProvider !== undefined ? { searchProvider: config.searchProvider } : {},
      defaultLimit,
      maxLimit,
    }, () => this._corpus, this._extractors)
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
   * List lightweight raw-log event records for one logical session.
   * @param sessionId - live-preferred session id to read.
   * @returns event records in ascending seq order.
   */
  async listEvents(sessionId: SessionId): Promise<SessionEventRecord[]> {
    const loaded = await this._corpus.loadLogical(sessionId)
    return eventRecords(sessionId, loaded.events)
  }

  /**
   * Read one full event plus a bounded raw-log context window.
   * @param request - target session/seq and context sizes.
   * @returns cloned target and neighboring events.
   */
  async readEvent(request: SessionEventReadRequest): Promise<SessionEventWindow> {
    const before = this._readWindow('before', request.before)
    const after = this._readWindow('after', request.after)
    const loaded = await this._corpus.loadLogical(request.sessionId)
    const target = loaded.events[request.seq]
    if (target === undefined || target.seq !== request.seq) {
      throw new SessionQueryError(`session "${request.sessionId}" has no event at seq ${request.seq}`, 'SESSION_QUERY_EVENT_NOT_FOUND')
    }
    const startSeq = Math.max(0, request.seq - before)
    const endSeq = Math.min(loaded.events.length - 1, request.seq + after)
    return {
      session: cloneRecord(loaded.record),
      target: structuredClone(target),
      events: loaded.events.slice(startSeq, endSeq + 1).map(event => structuredClone(event)),
      startSeq,
      endSeq,
    }
  }

  /**
   * Trace parent ancestry and the complete known descendant tree of a session.
   * @param sessionId - logical session id to trace.
   * @returns complete or explicitly partial lineage.
   */
  async traceSession(sessionId: SessionId): Promise<SessionLineageTrace> {
    return traceLineage(await this._corpus.listSessions(), sessionId)
  }

  /**
   * Trace direct provenance and surface replacement relationships for any event.
   * @param sessionId - logical session containing the target.
   * @param seq - target event seq.
   * @returns lightweight trace with related seq links.
   */
  async traceEvent(sessionId: SessionId, seq: number): Promise<SessionEventTrace> {
    return traceEventLog(sessionId, (await this._corpus.loadLogical(sessionId)).events, seq)
  }

  /**
   * Register one full-text provider with effect-scoped disposal.
   * @param provider - provider and synchronization implementation.
   * @returns async disposer that immediately unregisters selection and awaits accepted provider work.
   */
  registerSearchProvider(provider: SessionSearchProvider): () => Promise<void> {
    return this._providers.register(this.ctx, provider)
  }

  /**
   * Register semantic text extraction for one event type.
   * @param type - declaration-merged event discriminant.
   * @param extractor - stable version and typed extraction callback.
   * @returns disposer that removes the extractor.
   */
  registerEventTextExtractor<K extends SessionEventType>(
    type: K,
    extractor: SessionEventTextExtractor<K>,
  ): () => void {
    return this._extractors.registerEvent(this.ctx, type, extractor)
  }

  /**
   * Register semantic text extraction for one content block type.
   * @param type - declaration-merged content-block discriminant.
   * @param extractor - stable version and typed extraction callback.
   * @returns disposer that removes the extractor.
   */
  registerContentTextExtractor<K extends ContentBlockType>(
    type: K,
    extractor: SessionContentTextExtractor<K>,
  ): () => void {
    return this._extractors.registerContent(this.ctx, type, extractor)
  }

  /**
   * Search the complete logical corpus and rank one result per session.
   * @param request - query, pre-ranking filters, and pagination.
   * @param exec - optional cancellation context.
   * @returns ranked provider page.
   */
  searchSessions(
    request: SessionSearchRequest,
    exec?: SessionQueryExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    return this._providers.searchSessions(request, exec)
  }

  /**
   * Search events within one logical session.
   * @param request - target session, query, filters, and pagination.
   * @param exec - optional cancellation context.
   * @returns ranked provider page.
   */
  searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionQueryExecContext,
  ): Promise<SessionSearchPage<SessionEventSearchHit>> {
    return this._providers.searchEvents(request, exec)
  }

  private _readWindow(name: 'before' | 'after', value: number | undefined): number {
    if (value === undefined) return 0
    if (!Number.isInteger(value) || value < 0 || value > this._readWindowMax) {
      throw new SessionQueryError(`${name} must be an integer between 0 and ${this._readWindowMax}`, 'SESSION_QUERY_INVALID_WINDOW')
    }
    return value
  }
}

function cloneRecord(record: SessionRecord): SessionRecord {
  return { ...record, header: structuredClone(record.header) }
}

export default SessionQueryService
