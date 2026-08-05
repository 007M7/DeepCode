/**
 * Pure fold for the heuristic context-composition projection: system prompt
 * and tool schemas from the newest request envelope, conversation from the
 * live surface. Prices with the same shared estimator as the meter service,
 * so the three figures match `measure()`'s heuristic vocabulary exactly.
 */

import { z } from 'zod'
import { canonicalHeader, deriveEventMessage, isSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { estimateMessage, estimateSystemTokens, estimateToolsTokens } from './estimate.ts'
// Import for the `contextBreakdown` SessionProjectionMap key merge.
import type {} from './projection.ts'

/** One priced surface node (plain JSON for the persisted projection cache). */
interface BreakdownSurfaceNode {
  seq: number
  tokens: number
}

interface ContextBreakdownState {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
  surface: BreakdownSurfaceNode[]
}

const breakdownSchema = z.object({
  systemTokens: z.number().int().nonnegative(),
  toolsTokens: z.number().int().nonnegative(),
  messageTokens: z.number().int().nonnegative(),
}).strict()

/**
 * Token-meter's context-composition projection unit.
 *
 * Envelope figures are last-wins per `request/header`; the message figure
 * folds surface appends and positional replacements, so compaction shrinks it
 * the same way it shrinks the next request. Committed logs are
 * surface-validated at append time, so an unresolvable replace range here is
 * log corruption and fails loud rather than skipping the event.
 */
export const contextBreakdownProjectionDefinition:
ProjectionDefinition<'contextBreakdown', ContextBreakdownState> = {
  key: 'contextBreakdown',
  schema: breakdownSchema,
  init: () => ({ systemTokens: 0, toolsTokens: 0, messageTokens: 0, surface: [] }),
  apply: (state, event) => {
    if (event.type === 'request/header') {
      const header = canonicalHeader(event.data.header)
      const systemTokens = estimateSystemTokens(header)
      const toolsTokens = estimateToolsTokens(header)
      if (systemTokens === state.systemTokens && toolsTokens === state.toolsTokens) return state
      return { ...state, systemTokens, toolsTokens }
    }
    if (!isSurfaceEvent(event)) return state
    const message = deriveEventMessage(event)
    const tokens = message === null ? 0 : estimateMessage(message)
    const op = event.surfaceOp
    if (op === 'append') {
      return {
        ...state,
        messageTokens: state.messageTokens + tokens,
        surface: [...state.surface, { seq: event.seq, tokens }],
      }
    }
    const startIdx = state.surface.findIndex(node => node.seq === op.start)
    const endIdx = state.surface.findIndex(node => node.seq === op.end)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
      throw new Error(
        `context breakdown: replace at seq ${event.seq} has invalid current range ${op.start}-${op.end}`,
      )
    }
    const removed = state.surface
      .slice(startIdx, endIdx + 1)
      .reduce((total, node) => total + node.tokens, 0)
    const surface = [...state.surface]
    surface.splice(startIdx, endIdx - startIdx + 1, { seq: event.seq, tokens })
    return {
      ...state,
      messageTokens: state.messageTokens + tokens - removed,
      surface,
    }
  },
  view: ({ systemTokens, toolsTokens, messageTokens }) => ({ systemTokens, toolsTokens, messageTokens }),
  stateVersion: 1,
}
