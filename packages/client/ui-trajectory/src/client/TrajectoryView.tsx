// TrajectoryView: P-I placeholder body for the trajectory tab — per-turn
// span list with node-count weights (no timing data exists yet; deviation
// ledger #3 defers real rendering to P-III).

import { useMemo } from 'react'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { deriveSpans } from './spans.ts'
import css from './views.module.css'

export function TrajectoryView({ useSession }: ConvViewProps) {
  const nodes = (useSession as SnapshotSelectorHook<ConversationSnapshot>)((s) => s.nodes)
  const spans = useMemo(() => deriveSpans(nodes), [nodes])
  if (spans.length === 0) return <div className={css.root}><p className={css.empty}>暂无轨迹数据</p></div>
  return (
    <div className={css.root}>
      {spans.map((span) => (
        <div key={span.turn} className={css.row}>
          <span className={css.turnTag}>turn {span.turn}</span>
          <span className={css.meta}>
            {span.steps} steps · {span.calls} calls · {span.nodes} nodes
          </span>
        </div>
      ))}
    </div>
  )
}
