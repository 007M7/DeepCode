import type { ToolSchema } from '@deepseek-ai/dsh-llm/types'
import type { HistoryEntry } from '@deepseek-ai/dsh-client-connection/client'
import type {
  CodeSubCall, ConversationNode, PartialAssistant, RunningToolCall,
} from './conversation.ts'
import type { ConversationContext } from './conversation-context.ts'
import { projectConversationHistory } from '../session-history/history-fold.ts'
import { inspectRequests, type RequestView } from './request-inspection.ts'

/** Lazily derived inspection data for one immutable session-history window. */
export interface SessionHistoryInspection {
  eventNodes: readonly ConversationNode[]
  contexts: readonly ConversationContext[]
  requests: readonly RequestView[]
  callSchemas: ReadonlyMap<string, ToolSchema>
  interruptedNodes: readonly ConversationNode[]
  partial: PartialAssistant | null
  runningCalls: readonly RunningToolCall[]
  codeDispatches: ReadonlyMap<string, readonly CodeSubCall[]>
}

/**
 * Create a lazy inspection projection over an immutable history window.
 * Conversation consumers retain the cheap wrapper; only Trajectory snapshots
 * the entries and replays event order and request lifecycle state.
 * @param loadEntries - Lazily snapshots contiguous raw entries in sequence order.
 * @returns Lazy, memoized inspection fields for that exact window.
 */
export function createHistoryInspection(
  loadEntries: () => readonly HistoryEntry[],
): SessionHistoryInspection {
  let entries: readonly HistoryEntry[] | undefined
  let conversation: ReturnType<typeof projectConversationHistory> | undefined
  let requests: ReturnType<typeof inspectRequests> | undefined
  const historyEntries = () => entries ??= loadEntries()
  const conversationProjection = () =>
    conversation ??= projectConversationHistory(historyEntries())
  const requestProjection = () =>
    requests ??= inspectRequests(historyEntries())
  return {
    get eventNodes() {
      return conversationProjection().eventNodes
    },
    get contexts() {
      return conversationProjection().contexts
    },
    get interruptedNodes() {
      return conversationProjection().interruptedNodes
    },
    get partial() {
      return conversationProjection().partial
    },
    get runningCalls() {
      return conversationProjection().runningCalls
    },
    get codeDispatches() {
      return conversationProjection().codeDispatches
    },
    get requests() {
      return requestProjection().requests
    },
    get callSchemas() {
      return requestProjection().callSchemas
    },
  }
}
