/**
 * Pure fold for the heuristic context-composition projection: system prompt
 * and tool schemas from the newest request envelope, conversation from the
 * live surface. Prices with the same shared estimator as the meter service,
 * so the three figures match `measure()`'s heuristic vocabulary exactly.
 */

import { z } from 'zod'
import { canonicalHeader, isSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TokenSurfaceNode } from './types.ts'
import { estimateSystemTokens, estimateToolsTokens } from './estimate.ts'
import { foldSurfaceTokens } from './surface-fold.ts'
// Import for the `contextBreakdown` SessionProjectionMap key merge.
import type {} from './projection.ts'

interface ContextBreakdownState {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
  /** Priced surface nodes (plain JSON for the persisted projection cache). */
  surface: TokenSurfaceNode[]
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
 * rides {@link foldSurfaceTokens} — the same fold the measurement service
 * replays — so it equals `measure().surfaceTokens` at every event boundary and
 * compaction shrinks it the way it shrinks the next request.
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
    const fold = foldSurfaceTokens(state.surface, event)
    return {
      ...state,
      messageTokens: state.messageTokens + fold.deltaTokens,
      surface: fold.nodes,
    }
  },
  view: ({ systemTokens, toolsTokens, messageTokens }) => ({ systemTokens, toolsTokens, messageTokens }),
  stateVersion: 1,
}
