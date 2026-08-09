import type { Context } from 'cordis'
import type {
  ConversationLocation, ConversationNodeDefinition, ModelRetryNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { RetryChatData } from '../contract/chat-nodes.ts'
import { chatNode } from './common.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Producer-correlated model retry chain. */
    'model-retry': RetryChatData
  }
}

type WithoutRetryProjection<Node> = Node extends unknown
  ? Omit<Node, 'kind' | 'seq' | 'time' | 'retryState'>
  : never
type RetryEventData = WithoutRetryProjection<ModelRetryNode>

/** Accumulated retry attempts sharing one producer-owned RetryId. */
export interface RetryState {
  readonly turn: number
  readonly step: number
  readonly attempts: readonly ModelRetryNode[]
}

function retryData(value: unknown): RetryEventData | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const data = value as Record<string, unknown>
  if (typeof data.retryId !== 'string' || data.retryId === ''
    || !Number.isSafeInteger(data.turn) || (data.turn as number) < 0
    || !Number.isSafeInteger(data.step) || (data.step as number) < 0
    || !Number.isSafeInteger(data.retry) || (data.retry as number) <= 0
    || typeof data.delayMs !== 'number' || !Number.isFinite(data.delayMs) || data.delayMs < 0
    || typeof data.provider !== 'string' || typeof data.policyKey !== 'string'
    || (data.mode !== 'normal' && data.mode !== 'always')
    || data.failure === null || typeof data.failure !== 'object') return undefined
  if (data.mode === 'normal' && (!Number.isSafeInteger(data.maxRetries) || (data.maxRetries as number) <= 0)) {
    return undefined
  }
  return data as unknown as RetryEventData
}

function scheduledNode(event: { seq: number; time: number; data: unknown }): ModelRetryNode | undefined {
  const data = retryData(event.data)
  return data === undefined ? undefined : {
    kind: 'model-retry',
    seq: event.seq,
    time: event.time,
    retryState: 'scheduled',
    ...data,
  }
}

function isClosed(location: ConversationLocation): boolean {
  return (location.kind === 'step' && location.step.status === 'closed')
    || ((location.kind === 'step' || location.kind === 'turn') && location.turn.status === 'closed')
}

/** Producer-correlated model retry chain Definition. */
export const retryDefinition: ConversationNodeDefinition<RetryState> = {
  kind: 'model-retry',
  match: (event) => {
    if ((event.type as string) === 'llm/retry') {
      const data = retryData(event.data)
      if (data === undefined) return null
      return { id: String(data.retryId), role: data.retry === 1 ? 'start' : 'update' }
    }
    if ((event.type as string) === 'llm/retry-started') {
      const data = event.data as unknown as { retryId?: unknown }
      return typeof data.retryId === 'string' ? { id: data.retryId, role: 'update' } : null
    }
    return null
  },
  start: (_context, match) => {
    const node = scheduledNode(match.event)
    if (node === undefined) throw new Error('model-retry start requires a valid llm/retry event')
    return { turn: node.turn, step: node.step, attempts: [node] }
  },
  update: (context, match) => {
    if ((match.event.type as string) === 'llm/retry') {
      const node = scheduledNode(match.event)
      return node === undefined ? context.state : { ...context.state, attempts: [...context.state.attempts, node] }
    }
    if ((match.event.type as string) !== 'llm/retry-started') return context.state
    const data = match.event.data as unknown as { retry: number }
    return {
      ...context.state,
      attempts: context.state.attempts.map(attempt =>
        attempt.retry === data.retry ? { ...attempt, retryState: 'started' } : attempt),
    }
  },
  buildViewNode: (context, target) => {
    if (target !== 'chat' || context.state === undefined || context.state.attempts.length === 0) return null
    const location = context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' as const }
    const stateAttempts = context.state.attempts
    const attempts = stateAttempts.map((attempt, index) =>
      index === stateAttempts.length - 1
        && attempt.retryState === 'scheduled'
        && isClosed(location)
        ? { ...attempt, retryState: 'cancelled' as const }
        : attempt)
    const current = attempts.at(-1)
    if (current === undefined) return null
    const data: RetryChatData = { attempts, current }
    return chatNode(context, 'model-retry', attempts[0]?.seq ?? current.seq, data)
  },
}

/**
 * Register the correlated model-retry business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerRetryConversationNode(ctx: Context): void {
  ctx.conversationEvents.register(retryDefinition)
}
