// TrajectoryView: sticky Turn sections with Message/Step groups and step cells.

import { useMemo } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TrajectoryCell } from './TrajectoryCell.tsx'
import { TrajectoryGroupHeader } from './TrajectoryGroupHeader.tsx'
import { TrajectoryTurn } from './TrajectoryTurn.tsx'
import { deriveTrajectoryLayout } from './layout.ts'
import css from './views.module.css'

export function TrajectoryView({ useSession }: ConvViewProps) {
  const nodes = useSession(s => s.nodes)
  const partial = useSession(s => s.partial)
  const runningCalls = useSession(s => s.runningCalls)
  const codeDispatches = useSession(s => s.codeDispatches)
  const turns = useMemo(
    () => deriveTrajectoryLayout({ nodes, partial, runningCalls, codeDispatches }),
    [nodes, partial, runningCalls, codeDispatches],
  )
  if (turns.length === 0) {
    return <div className={css.root}><p className={css.empty}>暂无轨迹数据</p></div>
  }
  return (
    <div className={css.root}>
      {turns.map(turn => (
        <TrajectoryTurn key={turn.turn} turn={turn.turn}>
          {turn.groups.flatMap(group => [
            <TrajectoryGroupHeader
              key={`${group.title}-h`}
              title={group.title}
              {...(group.description !== undefined ? { description: group.description } : {})}
            />,
            ...group.cells.map(cell => (
              <TrajectoryCell key={cell.index} {...cell} />
            )),
          ])}
        </TrajectoryTurn>
      ))}
    </div>
  )
}
