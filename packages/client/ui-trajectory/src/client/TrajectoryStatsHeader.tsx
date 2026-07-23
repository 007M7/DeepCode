// TrajectoryStatsHeader: span totals row mounted as chrome.header on both
// placeholder views — the second chrome-attachment consumer (chat's
// StatsLine footer is the first), proving both mount points render.
// Subscribes to `nodes` only: chunk batches never swap that reference, so
// the row is quiet during streaming.

import { memo, useMemo } from 'react'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChromeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { deriveSpans, deriveSpanStats } from './spans.ts'
import css from './TrajectoryStatsHeader.module.css'

/** Per-view chrome extension (the view map entry's chromeProps slot). */
export interface TrajectoryChromeProps {
  /** Render the tool-calls segment; defaults to true (waterfall lanes already
   *  visualize calls, so that view may drop the redundant count). */
  showCalls?: boolean
}

export const TrajectoryStatsHeader = memo(function TrajectoryStatsHeader({ useSession, showCalls }: ChromeProps & TrajectoryChromeProps) {
  const nodes = (useSession as SnapshotSelectorHook<ConversationSnapshot>)((s) => s.nodes)
  const stats = useMemo(() => deriveSpanStats(deriveSpans(nodes)), [nodes])
  if (stats.turns === 0) return null
  const parts = [`${stats.turns} turns`, `${stats.steps} steps`]
  if (showCalls !== false) parts.push(`${stats.calls} tool calls`)
  return <div className={css.root}>{parts.join(' · ')}</div>
})
