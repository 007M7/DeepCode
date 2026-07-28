// TrajectoryStatsHeader: span totals row rendered at the top of both
// placeholder view bodies (chrome dissolved into the views — the header is
// part of what these views ARE, not registration metadata). Subscribes to
// `nodes` only: chunk batches never swap that reference, so the row is quiet
// during streaming.

import { memo, useMemo } from 'react'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { deriveSpans, deriveSpanStats } from './spans.ts'
import css from './TrajectoryStatsHeader.module.css'

/** Props: the conversation-snapshot selector hook (handed down by the view body). */
export interface TrajectoryStatsHeaderProps { useSession: SnapshotSelectorHook<ConversationSnapshot> }

export const TrajectoryStatsHeader = memo(function TrajectoryStatsHeader({ useSession }: TrajectoryStatsHeaderProps) {
  const nodes = useSession(s => s.nodes)
  const stats = useMemo(() => deriveSpanStats(deriveSpans(nodes)), [nodes])
  if (stats.turns === 0) return null
  return <div className={css.root}>{`${stats.turns} turns · ${stats.steps} steps · ${stats.calls} tool calls`}</div>
})
