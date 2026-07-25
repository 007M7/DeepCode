import SessionQueryService from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchHit,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'

/** Test-only concrete query service for backend-independent behavior. */
export class TestSessionQueryService extends SessionQueryService {
  override searchSessions(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    return Promise.resolve({ items: [] })
  }

  override searchEvents(
    _request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionEventSearchHit>> {
    return Promise.resolve({ items: [] })
  }
}
