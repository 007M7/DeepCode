/**
 * Pure session projection for subagent active-turn duration.
 *
 * @module @deepseek-ai/dsh-subagent/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SubagentTimingProjection } from './projection-types.ts'

interface TimingState extends SubagentTimingProjection {
  /** Latest pre-descriptor turn start, promoted when the child's own descriptor arrives. */
  pendingTurnStart?: number
  /** Whether the fold has crossed a descriptor in this logical log. */
  descriptorSeen: boolean
}

const projectionSchema = z.object({
  settledMs: z.number().int().nonnegative(),
  activeSince: z.number().int().nonnegative().optional(),
}).strict() as unknown as z.ZodType<SubagentTimingProjection>

/**
 * Fold turn boundaries around the child's own durable descriptor.
 *
 * A fork seed may contain an ancestor descriptor and completed turns. Every
 * descriptor therefore resets the accumulated state; the healthy catalog
 * admits only a child with exactly one descriptor in its own suffix, making
 * the final reset the child's authoritative timing origin.
 */
export const subagentTimingProjectionDefinition:
ProjectionDefinition<'subagentTiming', TimingState> = {
  key: 'subagentTiming',
  schema: projectionSchema,
  init: () => ({ descriptorSeen: false, settledMs: 0 }),
  apply: (state, event) => {
    if (event.type === 'turn/start') {
      return state.descriptorSeen
        ? { ...state, activeSince: event.time }
        : { ...state, pendingTurnStart: event.time }
    }
    if (event.type === 'subagent/descriptor') {
      const activeSince = state.activeSince ?? state.pendingTurnStart
      return {
        descriptorSeen: true,
        settledMs: 0,
        ...(activeSince === undefined ? {} : { activeSince }),
      }
    }
    if (event.type !== 'turn/end') return state
    if (!state.descriptorSeen) {
      if (state.pendingTurnStart === undefined) return state
      const { pendingTurnStart: _closed, ...next } = state
      return next
    }
    if (state.activeSince === undefined) return state
    const { activeSince, ...rest } = state
    return {
      ...rest,
      settledMs: state.settledMs + Math.max(0, event.time - activeSince),
    }
  },
  view: state => ({
    settledMs: state.settledMs,
    ...(state.activeSince === undefined ? {} : { activeSince: state.activeSince }),
  }),
  stateVersion: 1,
}
