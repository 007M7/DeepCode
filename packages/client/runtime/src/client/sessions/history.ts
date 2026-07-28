import type {
  HistoryEntry, RpcError, SessionId,
} from '@deepseek-ai/dsh-client-connection/client'
import type { ObservableSnapshot } from '../contract/store.ts'
import type { OpenState } from './conversation.ts'

/**
 * Immutable read window over one session's durable event log.
 *
 * The conversation snapshot is a chat projection. Consumers that need event
 * order or request lifecycle data read this source instead of widening that
 * projection with inspection-only fields.
 */
export interface SessionHistorySnapshot {
  sessionId: SessionId
  /** Contiguous raw log entries in ascending sequence order. */
  entries: readonly HistoryEntry[]
  /** Sequence of the first entry, or zero while the window is empty. */
  baseSeq: number
  openState: OpenState
  openError: RpcError | null
  hasMore: boolean
  loadingOlder: boolean
}

/** Read-only observable history plus explicit full-ledger paging. */
export interface SessionHistory extends ObservableSnapshot<SessionHistorySnapshot> {
  /**
   * Load every earlier page currently available.
   * @returns When paging is exhausted or cannot advance.
   */
  loadAll(): Promise<void>
}
