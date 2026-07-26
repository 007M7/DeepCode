// WaterfallView: span stats header over per-turn node-count lanes (P-I
// stand-in for duration lanes; deviation ledger #3). run_code turns
// additionally draw TRUTHFUL sub-call lanes: the dispatch start/settle pair
// carries per-sub-call wall time, so each sub-span's width is its real
// duration against the parent turn's dispatch window.

import { useMemo } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { deriveSpans, deriveSubSpans } from './spans.ts'
import { TrajectoryStatsHeader } from './TrajectoryStatsHeader.tsx'
import css from './views.module.css'

/** Bar width scale: px per node, clamped so tiny windows still show a bar. */
const PX_PER_NODE = 14
const MIN_BAR_PX = 8
/** Sub-span lane width budget (the parent window scales into this). */
const SUB_LANE_PX = 220

/** Optional density override (test/standalone knob; the register site passes nothing). */
export interface WaterfallExtraProps {
  /** Bar-lane density in px per node; defaults to 14. */
  pxPerNode?: number
}

export function WaterfallView({ useSession, pxPerNode }: ConvViewProps & WaterfallExtraProps) {
  const scale = pxPerNode ?? PX_PER_NODE
  const nodes = useSession((s) => s.nodes)
  const codeDispatches = useSession((s) => s.codeDispatches)
  const spans = useMemo(() => deriveSpans(nodes), [nodes])
  const subSpans = useMemo(() => deriveSubSpans(nodes, codeDispatches), [nodes, codeDispatches])
  if (spans.length === 0) return <div className={css.root}><p className={css.empty}>暂无瀑布数据</p></div>
  return (
    <>
      <TrajectoryStatsHeader useSession={useSession} />
      <div className={css.root}>
        {spans.map((span, i) => (
          <div key={span.turn}>
            <div className={css.row} style={{ paddingLeft: i * 12 }}>
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
            {(subSpans.get(span.turn) ?? []).map((lane) => (
              <div key={lane.callId} className={css.subRow} data-subspan style={{ paddingLeft: i * 12 + 24 }}>
                <span className={css.subTag}>{lane.name}</span>
                <span
                  className={`${css.bar} ${css.barSub}`}
                  data-timing={lane.timing}
                  style={{
                    marginLeft: Math.round(lane.offsetFraction * SUB_LANE_PX),
                    width: Math.max(Math.round(lane.widthFraction * SUB_LANE_PX), 4),
                  }}
                  title={lane.timing === 'measured'
                    /* durationMs is non-null exactly when timing is measured. */
                    ? `${lane.name} · ${((lane.durationMs ?? 0) / 1000).toFixed(2)}s`
                    : lane.timing === 'running' ? `${lane.name} · running` : `${lane.name} · duration unknown`}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}
