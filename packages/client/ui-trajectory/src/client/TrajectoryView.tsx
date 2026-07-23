// TrajectoryView: P-I placeholder body for the trajectory tab — span stats
// header over a per-turn span list with node-count weights (no timing data
// exists yet; deviation ledger #3 defers real rendering to P-III).

import { useMemo } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { deriveSpans } from './spans.ts'
import { TrajectoryStatsHeader } from './TrajectoryStatsHeader.tsx'
import css from './views.module.css'

export function TrajectoryView({ useSession }: ConvViewProps) {
  const nodes = useSession((s) => s.nodes)
  const spans = useMemo(() => deriveSpans(nodes), [nodes])
  if (spans.length === 0) return <div className={css.root}><p className={css.empty}>暂无轨迹数据</p></div>
  return (
    <>
      <TrajectoryStatsHeader useSession={useSession} />
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
    </>
  )
}
