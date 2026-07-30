/**
 * Pure folds for durable provider-reported token usage and context occupancy.
 */

import { z } from 'zod'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ContextPressureProjection, TokenUsageProjection } from './projection.ts'

interface UsageSample {
  turn: number
  step: number
  buckets: TokenUsageProjection
}

interface TokenUsageState {
  totals: TokenUsageProjection
  last: UsageSample | null
}

const zeroBuckets = (): TokenUsageProjection => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

const bucketsFrom = (usage: TokenUsage): TokenUsageProjection => ({
  uncachedInputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
})

const bucketsEqual = (left: TokenUsageProjection, right: TokenUsageProjection): boolean =>
  left.uncachedInputTokens === right.uncachedInputTokens
  && left.outputTokens === right.outputTokens
  && left.cacheReadTokens === right.cacheReadTokens
  && left.cacheWriteTokens === right.cacheWriteTokens

const addReplacing = (
  totals: TokenUsageProjection,
  previous: TokenUsageProjection | undefined,
  next: TokenUsageProjection,
): TokenUsageProjection => ({
  uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
  outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
  cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
  cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
})

const projectionSchema = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
}).strict()

// Cast for the optional values: under exactOptionalPropertyTypes zod infers
// `number | undefined` where the interface declares absent-or-number fields.
const pressureSchema = z.object({
  pressureTokens: z.number().int().nonnegative().optional(),
  contextWindow: z.number().int().positive().optional(),
}).strict() as unknown as z.ZodType<ContextPressureProjection>

/** Prompt-side pressure of one request: input plus cache traffic, no output. */
const pressureFrom = (usage: TokenUsage): number =>
  usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)

/**
 * Token-meter's session projection unit.
 *
 * Usage chunks provide an early sample that survives a later request failure;
 * an assistant message provides the final sample for the same turn/step. A
 * repeated sample replaces that step's earlier value instead of double
 * counting it. The single `last` slot relies on the session-log invariant
 * that usage reports for one turn/step are adjacent: once a later step begins,
 * a legal log never reports usage for an earlier step again.
 */
export const tokenUsageProjectionDefinition:
ProjectionDefinition<'tokenUsage', TokenUsageState> = {
  key: 'tokenUsage',
  schema: projectionSchema,
  init: () => ({ totals: zeroBuckets(), last: null }),
  apply: (state, event) => {
    let turn: number
    let step: number
    let usage: TokenUsage
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
      ;({ turn, step } = event.data)
      usage = event.data.chunk.usage
    } else if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      ;({ turn, step, usage } = event.data)
    } else {
      return state
    }

    const buckets = bucketsFrom(usage)
    const previous = state.last !== null
      && state.last.turn === turn
      && state.last.step === step
      ? state.last.buckets
      : undefined
    if (previous !== undefined && bucketsEqual(previous, buckets)) return state

    return {
      totals: addReplacing(state.totals, previous, buckets),
      last: { turn, step, buckets },
    }
  },
  view: state => state.totals,
  stateVersion: 1,
}

/**
 * Token-meter's context-occupancy projection unit.
 *
 * Two independent last-wins slots: the newest usage sample supplies the
 * numerator, the newest `request/context` record the denominator. Both are
 * whole values, so replay order alone decides the result and no cross-field
 * consistency is claimed — the pair is explicitly not one atomic request
 * observation (see {@link ContextPressureProjection}).
 *
 * The numerator is prompt-side only, so it holds still while a turn streams
 * and steps forward once the next request reports its usage.
 */
export const contextPressureProjectionDefinition:
ProjectionDefinition<'contextPressure', ContextPressureProjection> = {
  key: 'contextPressure',
  schema: pressureSchema,
  init: () => ({}),
  apply: (state, event) => {
    if (event.type === 'request/context') {
      const contextWindow = event.data.contextWindow
      if (contextWindow === state.contextWindow) return state
      if (contextWindow !== undefined) return { ...state, contextWindow }
      const { contextWindow: _removed, ...withoutContextWindow } = state
      return withoutContextWindow
    }
    const usage = event.type === 'assistant/chunk' && event.data.chunk.type === 'usage'
      ? event.data.chunk.usage
      : event.type === 'assistant/message'
        ? event.data.usage
        : undefined
    if (usage === undefined) return state
    const pressureTokens = pressureFrom(usage)
    return pressureTokens === state.pressureTokens
      ? state
      : { ...state, pressureTokens }
  },
  view: state => state,
  stateVersion: 2,
}
