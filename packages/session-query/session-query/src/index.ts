/**
 * Exact session-history reads over live and optionally persisted logs.
 *
 * @module @deepseek-ai/dsh-session-query
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import { foldSurface } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionEventReadRequest,
  SessionEventRecord,
  SessionEventWindow,
  SessionRecord,
} from './types.ts'
import {
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
  type Config,
} from './config.ts'
import { SessionCorpus } from './corpus.ts'

export type * from './types.ts'
export type { Config, SessionQueryErrorCode } from './config.ts'
export { SESSION_QUERY_READ_WINDOW_MAX, SessionQueryError } from './config.ts'

declare module 'cordis' {
  interface Context {
    sessionQuery: SessionQueryService
  }
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
   * List lightweight raw-log event records for one logical session.
   * @param sessionId - live-preferred session id to read.
   * @returns event records in ascending seq order.
   */
  async listEvents(sessionId: SessionId): Promise<SessionEventRecord[]> {
    const loaded = await this._corpus.load(sessionId)
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

function eventRecords(sessionId: SessionId, events: readonly SessionEvent[]): SessionEventRecord[] {
  let folded: ReturnType<typeof foldSurface>
  try {
    folded = foldSurface(events)
  } catch (error: unknown) {
    throw new SessionQueryError(
      /* v8 ignore next -- foldSurface throws Error instances */
      `invalid session surface: ${error instanceof Error ? error.message : 'unknown error'}`,
      'SESSION_QUERY_INVALID_SURFACE',
      { cause: error },
    )
  }
  const current = new Set(folded.nodes.map(node => node.seq))
  const shadowed = new Set(folded.replacements.flatMap(replacement => replacement.shadowedSeqs))
  return events.map(event => ({
    sessionId,
    seq: event.seq,
    type: event.type,
    time: event.time,
    surface: current.has(event.seq) ? 'current' : shadowed.has(event.seq) ? 'shadowed' : 'log-only',
  }))
}

export default SessionQueryService
