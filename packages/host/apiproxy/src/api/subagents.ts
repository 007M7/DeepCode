/**
 * Browser-safe subagent domain contract. Persisted transcript reads never
 * activate an Agent, while prompts route through the direct parent's
 * Activation-backed continuation owner.
 */

import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'
import type { HistoryEntry } from './sessions.ts'

/** Complete durable direct-child catalog row. */
export type SubagentListEntry =
  | {
    kind: 'child'
    id: SessionId
    label: string
    activity: 'running' | 'inactive'
  }
  | {
    kind: 'diagnostic'
    id: SessionId
    reason: 'corrupt' | 'unsupported' | 'unavailable'
  }

/** Inbox identity returned once the continuation accepts one human message. */
export interface SubagentPromptReceipt {
  messageId: MessageId
}

/** Durable parent/child address that selects subagent transport in the client. */
export interface SubagentAddress {
  parentSessionId: SessionId
  childSessionId: SessionId
}

/** Complete direct-child catalog plus the delivery-time parent availability hint. */
export interface SubagentCatalog {
  entries: SubagentListEntry[]
  parentAvailable: boolean
}

/** Subagent-domain unary methods. */
export interface SubagentsApi {
  /**
   * Lists direct continuable children without loading either side. Parent
   * availability is a hint; prompt performs the authoritative check.
   */
  list(
    request: RpcRequest<{ parentSessionId: SessionId }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<SubagentCatalog>>

  /**
   * Reads one healthy catalog child's persisted raw log with ordinary
   * message-aligned pagination and render intents, without Agent activation.
   */
  history(
    request: RpcRequest<SubagentAddress & { beforeSeq?: number; maxMessages?: number }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<{ events: HistoryEntry[]; hasMore: boolean }>>

  /**
   * Delivers human content through the exact live parent's continuation
   * owner. Success identifies the accepted inbox message.
   */
  prompt(
    request: RpcRequest<SubagentAddress & { content: ContentBlock[] }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<SubagentPromptReceipt>>
}
