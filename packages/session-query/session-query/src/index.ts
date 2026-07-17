/**
 * Exact session-history reads and traces over live and optionally persisted logs.
 *
 * @module @deepseek-ai/dsh-session-query
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionEventReadRequest,
  SessionEventRecord,
  SessionEventTrace,
  SessionEventTraceRequest,
  SessionEventWindow,
  SessionLineageTrace,
  SessionRecord,
} from './types.ts'
import {
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
  type Config,
} from './config.ts'
import { SessionCorpus } from './corpus.ts'
import * as tracing from './tracing.ts'

export type * from './types.ts'
export type { Config, SessionQueryErrorCode } from './config.ts'
export { SESSION_QUERY_READ_WINDOW_MAX, SessionQueryError } from './config.ts'

declare module 'cordis' {
  interface Context {
    sessionQuery: SessionQueryService
  }
}

/** Live-preferred logical-corpus exact-read and relationship-tracing service. */
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
   * List lightweight raw-log event records for one logical session.
   * @param sessionId - live-preferred session id to read.
   * @returns event records in ascending seq order.
   */
  async listEvents(sessionId: SessionId): Promise<SessionEventRecord[]> {
    const loaded = await this._corpus.load(sessionId)
    return tracing.eventRecords(sessionId, loaded.events)
  }

  /**
   * Trace known ancestry and descendants from one corpus observation.
   * @param sessionId - logical session id to trace.
   * @returns a complete lineage or an explicit unresolved parent boundary.
   * @throws when corpus resolution fails, the target is absent, or its known ancestry cycles.
   */
  async traceSession(sessionId: SessionId): Promise<SessionLineageTrace> {
    const records = await this._corpus.listSessions()
    return tracing.traceSession(records, sessionId)
  }

  /**
   * Trace one event's direct positional and provenance relationships.
   * @param request - target session id and event seq.
   * @returns direct links plus the target's positional replacement chain.
   * @throws when source resolution fails, the target is absent, or surface/provenance validation fails.
   */
  async traceEvent(request: SessionEventTraceRequest): Promise<SessionEventTrace> {
    const loaded = await this._corpus.load(request.sessionId)
    return tracing.traceEvent(request.sessionId, loaded.events, request.seq)
  }

  /**
   * Read one full event plus a bounded raw-log context window.
   * @param request - target session/seq and context sizes.
   * @returns cloned target and neighboring events.
   */
  async readEvent(request: SessionEventReadRequest): Promise<SessionEventWindow> {
    const before = this._readWindow('before', request.before)
    const after = this._readWindow('after', request.after)
    const loaded = await this._corpus.load(request.sessionId)
    const target = loaded.events[request.seq]
    if (target === undefined || target.seq !== request.seq) {
      throw new SessionQueryError(
        `session "${request.sessionId}" has no event at seq ${request.seq}`,
        'SESSION_QUERY_EVENT_NOT_FOUND',
      )
    }
    const startSeq = Math.max(0, request.seq - before)
    const endSeq = Math.min(loaded.events.length - 1, request.seq + after)
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
