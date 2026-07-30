// Settled-node identity prevents stream-delta updates from rerendering this row.
// Mounted on 'conversation.composer.dock' so it sticks with the composer in the
// active conversation scrollport (see ConversationRoot data-conversation-scroll).

import { memo, useMemo } from 'react'
import type {
  ConversationSnapshot, UseProjection,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import css from './StatsLine.module.css'

interface VisibleCounts {
  turns: number
  steps: number
}

/**
 * Count visible assistant turns and steps without treating the paged window
 * as an accounting source.
 * @param nodes - snapshot nodes.
 * @returns visible turn and step counts.
 */
export function deriveVisibleCounts(nodes: ConversationSnapshot['nodes']): VisibleCounts {
  const turns = new Set<number>()
  let steps = 0
  for (const node of nodes) {
    if (node.kind !== 'assistant') continue
    turns.add(node.turn)
    steps += 1
  }
  return { turns: turns.size, steps }
}

/**
 * Format large token values with the status surfaces' compact suffix style.
 * @param value - token count or model capacity.
 * @returns locale-formatted count.
 */
export function formatMetricTokens(value: number): string {
  if (value < 1_000) return value.toLocaleString('en-US')
  return value.toLocaleString('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).replace('K', 'k').replace('M', 'm').replace('B', 'b')
}

/**
 * Existing Web cache-hit formula over disjoint uncached and cache-read input.
 * @param usage - full-log token usage projection.
 * @returns rounded integer percent, or null when no input was billed.
 */
export function cacheHitPercent(usage: TokenUsageProjection): number | null {
  const denominator = usage.uncachedInputTokens + usage.cacheReadTokens
  return denominator === 0
    ? null
    : Math.round(usage.cacheReadTokens / denominator * 100)
}

/**
 * Approximate context occupancy, using the TUI's integer rounding and upper
 * clamp. The numerator and capacity are independent last-wins projection
 * fields, so this is a reference figure rather than an exact request
 * measurement (see the token-meter README).
 * @param pressure - the session's context-pressure projection value.
 * @returns occupancy percent, or null when no capacity is known.
 */
export function contextPercent(pressure: ContextPressureProjection | undefined): number | null {
  if (pressure?.contextWindow === undefined) return null
  return Math.min(100, Math.round(pressure.pressureTokens / pressure.contextWindow * 100))
}

/** Props: the framework's session snapshot and projection hook seats. */
export interface StatsLineProps {
  useSession: SnapshotSelectorHook<ConversationSnapshot>
  useProjection: UseProjection
}

export const StatsLine = memo(function StatsLine({ useSession, useProjection }: StatsLineProps) {
  const nodes = useSession(s => s.nodes)
  const usage = useProjection('tokenUsage')
  const pressure = useProjection('contextPressure')
  const counts = useMemo(() => deriveVisibleCounts(nodes), [nodes])
  const hasUsage = usage !== undefined && (
    usage.uncachedInputTokens !== 0
    || usage.outputTokens !== 0
    || usage.cacheReadTokens !== 0
    || usage.cacheWriteTokens !== 0
  )
  const context = contextPercent(pressure)
  if (counts.steps === 0 && !hasUsage && context === null) return null

  const parts: string[] = []
  if (usage !== undefined) {
    parts.push(`${formatMetricTokens(usage.uncachedInputTokens)} uncached input`)
    parts.push(`${formatMetricTokens(usage.outputTokens)} output`)
    parts.push(`${formatMetricTokens(usage.cacheReadTokens)} cache read`)
    const cacheHit = cacheHitPercent(usage)
    if (cacheHit !== null) parts.push(`cache hit ${cacheHit}%`)
  }
  // Capacity absent (no token-meter, or an adapter that advertises none) omits
  // the segment: an unknown denominator has no percentage worth a placeholder.
  if (context !== null && pressure?.contextWindow !== undefined) {
    parts.push(`context ${context}% of ${formatMetricTokens(pressure.contextWindow)}`)
  }
  parts.push(`${counts.turns} turns`)
  parts.push(`${counts.steps} steps`)
  return <div className={css.root}>{parts.join(' · ')}</div>
})
