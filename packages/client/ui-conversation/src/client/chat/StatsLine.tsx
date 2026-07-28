// Settled-node identity prevents stream-delta updates from rerendering this row.

import { memo, useMemo } from 'react'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import css from './StatsLine.module.css'

type SessionMetrics = NonNullable<ConversationSnapshot['metrics']>

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
 * @param metrics - Host-owned durable usage.
 * @returns rounded integer percent, or null when no input was billed.
 */
export function cacheHitPercent(metrics: SessionMetrics): number | null {
  const denominator = metrics.uncachedInputTokens + metrics.cacheReadTokens
  return denominator === 0
    ? null
    : Math.round(metrics.cacheReadTokens / denominator * 100)
}

/**
 * Current context occupancy using the TUI's integer rounding and upper clamp.
 * @param metrics - Host-owned current pressure and exact route capacity.
 * @returns occupancy percent, or null when either input is unavailable.
 */
export function contextPercent(metrics: SessionMetrics): number | null {
  if (metrics.contextTokens === undefined || metrics.contextWindow === undefined) return null
  return Math.min(100, Math.round(metrics.contextTokens / metrics.contextWindow * 100))
}

/** Props: the conversation-snapshot selector hook (handed down by ChatView). */
export interface StatsLineProps { useSession: SnapshotSelectorHook<ConversationSnapshot> }

export const StatsLine = memo(function StatsLine({ useSession }: StatsLineProps) {
  const nodes = useSession(s => s.nodes)
  const metrics = useSession(s => s.metrics)
  const counts = useMemo(() => deriveVisibleCounts(nodes), [nodes])
  if (counts.steps === 0 && (
    metrics === null
    || (
      metrics.uncachedInputTokens === 0
      && metrics.outputTokens === 0
      && metrics.cacheReadTokens === 0
      && (metrics.contextTokens ?? 0) === 0
    )
  )) return null
  const parts: string[] = []
  if (metrics === null) {
    parts.push('usage unknown')
    parts.push('context unknown')
  } else {
    parts.push(`${formatMetricTokens(metrics.uncachedInputTokens)} uncached input`)
    parts.push(`${formatMetricTokens(metrics.outputTokens)} output`)
    parts.push(`${formatMetricTokens(metrics.cacheReadTokens)} cache read`)
    const cacheHit = cacheHitPercent(metrics)
    if (cacheHit !== null) parts.push(`cache hit ${cacheHit}%`)
    const context = contextPercent(metrics)
    parts.push(context === null
      ? 'context unknown'
      : `context ${context}% of ${formatMetricTokens(metrics.contextWindow as number)}`)
  }
  parts.push(`${counts.turns} turns`)
  parts.push(`${counts.steps} steps`)
  return <div className={css.root}>{parts.join(' · ')}</div>
})
