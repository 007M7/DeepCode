// Settled-node identity prevents stream-delta updates from rerendering this row.
// Mounted on 'conversation.composer.dock' so it sticks with the composer in the
// active conversation scrollport (see ConversationRoot data-conversation-scroll).

import { Fragment, memo, useMemo } from 'react'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import css from './StatsLine.module.css'

interface UsageTotals {
  turns: number
  steps: number
  /** Summed request wall time (step/start → assistant/message); 0 when no node carries timing. */
  llmMs: number
  /** Summed tool wall time (tool/call → tool/result); 0 when no pair is in-window. */
  toolMs: number
  /** Prompt-side tokens: inputTokens + cacheReadTokens. */
  inputTokens: number
  outputTokens: number
  cacheHitPct: number | null
}

/** Token accounting slice of assistant `usage` (typed upstream as unknown). */
interface UsageLike {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
}

/**
 * Fold assistant and tool-result nodes into display totals.
 * @param nodes - snapshot nodes.
 * @returns totals; cacheHitPct null until any cache accounting arrives.
 */
export function deriveStats(nodes: ConversationSnapshot['nodes']): UsageTotals {
  const turns = new Set<number>()
  let steps = 0
  let llmMs = 0
  let toolMs = 0
  let input = 0
  let output = 0
  let cacheRead = 0
  for (const node of nodes) {
    if (node.kind === 'tool-result') {
      if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime)
      continue
    }
    if (node.kind !== 'assistant') continue
    turns.add(node.turn)
    steps += 1
    if (node.timing !== undefined && node.timing.stepStartTime !== null) {
      llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime)
    }
    const usage = node.usage as UsageLike | undefined
    if (usage === undefined) continue
    input += usage.inputTokens ?? 0
    output += usage.outputTokens ?? 0
    cacheRead += usage.cacheReadTokens ?? 0
  }
  const denom = input + cacheRead
  return {
    turns: turns.size,
    steps,
    llmMs,
    toolMs,
    inputTokens: input + cacheRead,
    outputTokens: output,
    cacheHitPct: denom === 0 ? null : Math.round((cacheRead / denom) * 100),
  }
}

/**
 * Compact token count: 517 / 12.2K / 517K / 1.2M (one decimal under three digits).
 * @param n - token count.
 * @returns display string.
 */
export function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/**
 * Compact duration: 45.2s under a minute, 2m42s from there on.
 * @param ms - duration in milliseconds.
 * @returns display string.
 */
export function formatDuration(ms: number): string {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/** Props: the conversation-snapshot selector (dock registration or unit mount). */
export interface StatsLineProps { useSession: SnapshotSelectorHook<ConversationSnapshot> }

export const StatsLine = memo(function StatsLine({ useSession }: StatsLineProps) {
  const nodes = useSession(s => s.nodes)
  const stats = useMemo(() => deriveStats(nodes), [nodes])
  if (stats.steps === 0) return null
  // Pipe-separated groups (figma stats strip); a group with no data drops out whole.
  const groups: string[] = [`${stats.turns} turns · ${stats.steps} steps`]
  const durations: string[] = []
  if (stats.llmMs > 0) durations.push(`LLM ${formatDuration(stats.llmMs)}`)
  if (stats.toolMs > 0) durations.push(`Tool call ${formatDuration(stats.toolMs)}`)
  if (durations.length > 0) groups.push(durations.join(' · '))
  if (stats.cacheHitPct !== null) groups.push(`Cache hit ${stats.cacheHitPct}%`)
  groups.push(`Input ${formatTokens(stats.inputTokens)} tok · Output ${formatTokens(stats.outputTokens)} tok`)
  return (
    <div className={css.root}>
      {groups.map((group, i) => (
        <Fragment key={group}>
          {i > 0 && <span className={css.sep} aria-hidden>|</span>}
          <span>{group}</span>
        </Fragment>
      ))}
    </div>
  )
})
