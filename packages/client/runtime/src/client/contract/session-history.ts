import type {
  RpcError, SessionId,
} from '@deepseek-ai/dsh-client-connection/client'
import type { SessionHistoryInspection } from '../sessions/history.ts'
import type { ObservableSnapshot } from './store.ts'

/** Observable state of one independently loaded session history ledger. */
export interface SessionHistorySnapshot {
  state: 'cold' | 'loading' | 'ready' | 'error'
  error: RpcError | null
  hasMore: boolean
  inspection: SessionHistoryInspection
}

/** Read-only history source addressed by session id. */
export interface SessionHistoryFace
  extends ObservableSnapshot<SessionHistorySnapshot> {
  readonly sessionId: SessionId
  /**
   * Load the tail and exhaust every available older page.
   * @param signal - Consumer lifetime; abort is observed between page requests.
   * @returns When the available ledger is complete or stops advancing.
   */
  loadAll(signal?: AbortSignal): Promise<void>
}

/** Runtime service resolving independent history sources. */
export interface ISessionHistory {
  /**
   * Resolve the identity-stable source for a session.
   * @param sessionId - Host session identity.
   * @returns The source owned outside Session and SessionManager.
   */
  source(sessionId: SessionId): SessionHistoryFace
}
