// WaterfallView: P-I placeholder body for the waterfall tab — span stats
// header over node-count bars per turn standing in for duration lanes (no
// timing data yet; deviation ledger #3 defers real rendering to P-III).

import { useMemo } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { deriveSpans } from './spans.ts'
import { TrajectoryStatsHeader } from './TrajectoryStatsHeader.tsx'
import css from './views.module.css'

/** Bar width scale: px per node, clamped so tiny windows still show a bar. */
const PX_PER_NODE = 14
const MIN_BAR_PX = 8

/** Optional density override (test/standalone knob; the register site passes nothing). */
export interface WaterfallExtraProps {
  /** Bar-lane density in px per node; defaults to 14. */
  pxPerNode?: number
}

export function WaterfallView({ useSession, pxPerNode }: ConvViewProps & WaterfallExtraProps) {
  const scale = pxPerNode ?? PX_PER_NODE
  const nodes = useSession((s) => s.nodes)
  const spans = useMemo(() => deriveSpans(nodes), [nodes])
  if (spans.length === 0) return <div className={css.root}><p className={css.empty}>暂无瀑布数据</p></div>
  return (
    <>
      <TrajectoryStatsHeader useSession={useSession} />
      <div className={css.root}>
        {spans.map((span, i) => (
          <div key={span.turn} className={css.row} style={{ paddingLeft: i * 12 }}>
            <span className={css.turnTag}>turn {span.turn}</span>
            <span
              className={css.bar}
              style={{ width: Math.max(span.nodes * scale, MIN_BAR_PX) }}
              title={`${span.nodes} nodes`}
            />
            {span.calls > 0 && (
              <span
                className={`${css.bar} ${css.barCalls}`}
                style={{ width: Math.max(span.calls * scale, MIN_BAR_PX) }}
                title={`${span.calls} tool calls`}
              />
            )}
          </div>
        ))}
      </div>
    </>
  )
}
