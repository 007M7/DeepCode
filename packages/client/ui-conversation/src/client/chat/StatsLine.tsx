// Settled-node identity prevents stream-delta updates from rerendering this row.
// Mounted on 'conversation.composer.dock' so it sticks with the composer in the
// active conversation scrollport (see ConversationRoot data-conversation-scroll).

import { memo, useMemo } from 'react'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import css from './StatsLine.module.css'

interface UsageTotals {
  turns: number
  steps: number
  tokens: number
  cacheHitPct: number | null
}

/** Token accounting slice of assistant `usage` (typed upstream as unknown). */
interface UsageLike {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
}

/**
 * Fold assistant nodes into display totals.
 * @param nodes - snapshot nodes.
 * @returns totals; cacheHitPct null until any cache accounting arrives.
 */
export function deriveStats(nodes: ConversationSnapshot['nodes']): UsageTotals {
  const turns = new Set<number>()
  let steps = 0
  let tokens = 0
  let input = 0
  let cacheRead = 0
  for (const node of nodes) {
    if (node.kind !== 'assistant') continue
    turns.add(node.turn)
    steps += 1
    const usage = node.usage as UsageLike | undefined
    if (usage === undefined) continue
    input += usage.inputTokens ?? 0
    cacheRead += usage.cacheReadTokens ?? 0
    tokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
  }
  const denom = input + cacheRead
  return {
    turns: turns.size,
    steps,
    tokens,
    cacheHitPct: denom === 0 ? null : Math.round((cacheRead / denom) * 100),
  }
}

/** Props: the conversation-snapshot selector (dock registration or unit mount). */
export interface StatsLineProps { useSession: SnapshotSelectorHook<ConversationSnapshot> }

export const StatsLine = memo(function StatsLine({ useSession }: StatsLineProps) {
  const nodes = useSession(s => s.nodes)
  const stats = useMemo(() => deriveStats(nodes), [nodes])
  if (stats.steps === 0) return null
  const parts: string[] = []
  if (stats.cacheHitPct !== null) parts.push(`cache hit ${stats.cacheHitPct}%`)
  parts.push(`${stats.tokens.toLocaleString('en-US')} tokens`)
  parts.push(`${stats.turns} turns`)
  parts.push(`${stats.steps} steps`)
  return <div className={css.root}>{parts.join(' · ')}</div>
})
