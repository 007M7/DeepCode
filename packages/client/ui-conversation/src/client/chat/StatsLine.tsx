// Settled-node identity prevents stream-delta updates from rerendering this row.
// Mounted on 'conversation.composer.dock' so it sticks with the composer in the
// active conversation scrollport (see ConversationRoot data-conversation-scroll).

import { Fragment, memo, useMemo } from 'react'
import type { ConversationSnapshot, UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import css from './StatsLine.module.css'

interface WindowStats {
  turns: number
  steps: number
  /** Summed request wall time (step/start → assistant/message); 0 when no node carries timing. */
  llmMs: number
  /** Summed tool wall time (tool/call → tool/result); 0 when no pair is in-window. */
  toolMs: number
}

/**
 * Fold assistant and tool-result nodes into the window-scoped display totals.
 *
 * Counts and wall times describe the loaded window on purpose — they answer
 * "what is on screen". Token accounting deliberately does NOT come from here:
 * the window is paged and compaction rewrites it, so billing rides the durable
 * `tokenUsage` projection instead.
 * @param nodes - snapshot nodes.
 * @returns visible counts and summed wall times.
 */
export function deriveStats(nodes: ConversationSnapshot['nodes']): WindowStats {
  const turns = new Set<number>()
  let steps = 0
  let llmMs = 0
  let toolMs = 0
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
  }
  return { turns: turns.size, steps, llmMs, toolMs }
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

/**
 * Cache-hit share of prompt-side input over the whole durable log.
 * @param usage - the session's token-usage projection value.
 * @returns rounded integer percent, or null when no input was billed.
 */
export function cacheHitPercent(usage: TokenUsageProjection): number | null {
  const denominator = billedInputTokens(usage)
  return denominator === 0
    ? null
    : Math.round(usage.cacheReadTokens / denominator * 100)
}

/** Sum the three disjoint prompt-side billing buckets. */
function billedInputTokens(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

interface ContextOccupancy {
  percent: number
  contextWindow: number
}

/**
 * Approximate context occupancy, using the TUI's integer rounding and upper
 * clamp. The numerator and capacity are independent last-wins projection
 * fields, so this is a reference figure rather than an exact measurement of one
 * request (see the token-meter README).
 * @param pressure - the session's context-pressure projection value.
 * @returns occupancy and its denominator, or null until both values are known.
 */
export function contextOccupancy(
  pressure: ContextPressureProjection | undefined,
): ContextOccupancy | null {
  if (pressure?.pressureTokens === undefined || pressure.contextWindow === undefined) return null
  return {
    percent: Math.min(100, Math.round(pressure.pressureTokens / pressure.contextWindow * 100)),
    contextWindow: pressure.contextWindow,
  }
}

/** Props: the conversation-snapshot selector plus the projection read seat. */
export interface StatsLineProps {
  useSession: SnapshotSelectorHook<ConversationSnapshot>
  useProjection: UseProjection
}

export const StatsLine = memo(function StatsLine({ useSession, useProjection }: StatsLineProps) {
  const nodes = useSession(s => s.nodes)
  const usage = useProjection('tokenUsage')
  const pressure = useProjection('contextPressure')
  const stats = useMemo(() => deriveStats(nodes), [nodes])
  // Pipe-separated groups (figma stats strip); a group with no data drops out whole.
  const groups: string[] = []
  if (stats.steps > 0) {
    groups.push(`${stats.turns} turns · ${stats.steps} steps`)
    const durations: string[] = []
    if (stats.llmMs > 0) durations.push(`LLM ${formatDuration(stats.llmMs)}`)
    if (stats.toolMs > 0) durations.push(`Tool call ${formatDuration(stats.toolMs)}`)
    if (durations.length > 0) groups.push(durations.join(' · '))
  }
  const context = contextOccupancy(pressure)
  if (context !== null) {
    groups.push(`Context ${context.percent}% of ${formatTokens(context.contextWindow)}`)
  }
  // Billing rides the durable projection, so these survive paging and
  // compaction. Suppress the empty projection on a brand-new session.
  if (usage !== undefined
    && (stats.steps > 0 || billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
    const cacheHit = cacheHitPercent(usage)
    if (cacheHit !== null) groups.push(`Cache hit ${cacheHit}%`)
    groups.push(
      `Input ${formatTokens(billedInputTokens(usage))} tok`
      + ` · Output ${formatTokens(usage.outputTokens)} tok`,
    )
  }
  if (groups.length === 0) return null
  return (
    <div className={css.root}>
      {groups.map((group, i) => (
        <Fragment key={group}>
          {i > 0 && <><span className={css.sep} aria-hidden>|</span>{' '}</>}
          <span>{group}</span>
        </Fragment>
      ))}
    </div>
  )
})
