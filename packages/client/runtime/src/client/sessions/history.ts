import type { ToolSchema } from '@deepseek-ai/dsh-llm/types'
import type { HistoryEntry } from '@deepseek-ai/dsh-client-connection/client'
import type { ConversationNode } from './conversation.ts'
import type { ConversationContext } from './conversation-context.ts'
import { projectConversationHistory } from './fold-adapter.ts'
import { inspectRequests, type RequestView } from './request-inspection.ts'

/** Lazily derived inspection data for one immutable session-history window. */
export interface SessionHistoryInspection {
  eventNodes: readonly ConversationNode[]
  contexts: readonly ConversationContext[]
  requests: readonly RequestView[]
  callSchemas: ReadonlyMap<string, ToolSchema>
}

/**
 * Create a lazy inspection projection over an immutable history window.
 * Conversation consumers retain the cheap wrapper; only Trajectory reads the
 * getters that replay event order and request lifecycle state.
 * @param entries - Contiguous raw history entries in sequence order.
 * @returns Lazy, memoized inspection fields for that exact window.
 */
export function createHistoryInspection(
  entries: readonly HistoryEntry[],
): SessionHistoryInspection {
  let conversation: ReturnType<typeof projectConversationHistory> | undefined
  let requests: ReturnType<typeof inspectRequests> | undefined
  const conversationProjection = () =>
    conversation ??= projectConversationHistory(entries)
  const requestProjection = () =>
    requests ??= inspectRequests(entries)
  return {
    get eventNodes() {
      return conversationProjection().eventNodes
    },
    get contexts() {
      return conversationProjection().contexts
    },
    get requests() {
      return requestProjection().requests
    },
    get callSchemas() {
      return requestProjection().callSchemas
    },
  }
}
