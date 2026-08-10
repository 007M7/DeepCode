import type { Context } from 'cordis'
import type {
  ConversationMatch, ConversationNodeDefinition, RequestView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-compact/types'
import { trajectoryNode } from './trajectory-definition-common.ts'

interface CompactionState {
  readonly start: ConversationMatch
  readonly summary?: ConversationMatch
  readonly end?: ConversationMatch
  readonly checkpoint?: ConversationMatch
}

function checkpointId(
  event: Parameters<ConversationNodeDefinition['match']>[0],
): string | undefined {
  if (event.type !== 'user/message') return undefined
  const source = event.data.source as unknown as {
    readonly kind?: unknown
    readonly plugin?: unknown
    readonly compactionId?: unknown
  }
  return source.kind === 'plugin' && source.plugin === 'compact'
    && typeof source.compactionId === 'string' && source.compactionId !== ''
    ? source.compactionId
    : undefined
}

function eventCompactionId(
  event: Parameters<ConversationNodeDefinition['match']>[0],
): string | undefined {
  if (event.type !== 'compact/start'
    && event.type !== 'compact/summary'
    && event.type !== 'compact/end') return undefined
  const value: unknown = event.data.compactionId
  return typeof value === 'string' && value !== '' ? value : undefined
}

function requestFromState(
  state: CompactionState,
): Extract<RequestView, { purpose: 'compaction' }> | undefined {
  const start = state.start.event
  if (start.type !== 'compact/start') return undefined
  const summary = state.summary?.event
  const end = state.end?.event
  const checkpoint = state.checkpoint?.event
  return {
    purpose: 'compaction',
    startSeq: start.seq,
    turn: start.data.turn,
    step: 0,
    startedAt: start.time,
    completedAt: end?.type === 'compact/end' ? end.time : null,
    status: end?.type !== 'compact/end'
      ? 'running'
      : end.data.error === undefined ? 'complete' : 'error',
    ...(end?.type === 'compact/end' && end.data.error !== undefined
      ? { error: end.data.error }
      : {}),
    ...(summary?.type !== 'compact/summary'
      ? {}
      : {
        resultSeq: summary.seq,
        summary: summary.data.summary,
        ...(summary.data.rawOutput === undefined ? {} : { rawOutput: summary.data.rawOutput }),
        provenance: { provider: summary.data.provider, model: summary.data.model },
        requestConfig: {
          provider: summary.data.provider,
          model: summary.data.model,
          purpose: 'compaction',
          ...(summary.data.maxTokens === undefined ? {} : { maxTokens: summary.data.maxTokens }),
        },
        ...(summary.data.usage === undefined ? {} : { usage: summary.data.usage }),
      }),
    ...(checkpoint?.type === 'user/message' ? { replacementSeq: checkpoint.seq } : {}),
  }
}

const trajectoryCompactionDefinition: ConversationNodeDefinition<CompactionState> = {
  kind: 'trajectory-compaction',
  target: 'trajectory',
  match: (event) => {
    const compactId = eventCompactionId(event)
    if (compactId !== undefined) {
      return { id: compactId, role: event.type === 'compact/start' ? 'start' : 'update' }
    }
    const checkpoint = checkpointId(event)
    return checkpoint === undefined ? null : { id: checkpoint, role: 'update' }
  },
  start: (_context, match) => {
    if (match.event.type !== 'compact/start') {
      throw new Error('trajectory-compaction start requires compact/start')
    }
    return { start: match }
  },
  update: (context, match) => {
    if (match.event.type === 'compact/summary') return { ...context.state, summary: match }
    if (match.event.type === 'compact/end') return { ...context.state, end: match }
    return checkpointId(match.event) === undefined
      ? context.state
      : { ...context.state, checkpoint: match }
  },
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    const request = requestFromState(context.state)
    return request === undefined
      ? null
      : trajectoryNode(context, request.startSeq, { kind: 'compaction', request })
  },
}

interface SessionEndState {
  readonly seq: number
  readonly time: number
}

const trajectorySessionEndDefinition: ConversationNodeDefinition<SessionEndState> = {
  kind: 'trajectory-session-end',
  target: 'trajectory',
  match: event => event.type === 'session/end-seed'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => ({ seq: match.event.seq, time: match.event.time }),
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : trajectoryNode(context, context.state.seq, {
      kind: 'session-end',
      seq: context.state.seq,
      time: context.state.time,
    }),
}

/**
 * Register Trajectory compaction requests and session boundaries.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
export function registerTrajectoryCompactionDefinitions(ctx: Context): void {
  ctx.conversationEvents.register(trajectoryCompactionDefinition)
  ctx.conversationEvents.register(trajectorySessionEndDefinition)
}
