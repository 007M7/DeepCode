/** Trajectory view: compact summary over a turn-aware event ledger. */

import { useMemo, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TrajectoryTable } from './TrajectoryTable.tsx'
import { TrajectoryToolbar } from './TrajectoryToolbar.tsx'
import { deriveTrajectoryLayout } from './layout.ts'
import css from './views.module.css'

export function TrajectoryView({ useSession }: ConvViewProps) {
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(() => new Set())
  const [collapsedAssistants, setCollapsedAssistants] = useState<ReadonlySet<number>>(() => new Set())
  const nodes = useSession((s) => s.nodes)
  const partial = useSession((s) => s.partial)
  const runningCalls = useSession((s) => s.runningCalls)
  const callSchemas = useSession((s) => s.callSchemas)
  const codeDispatches = useSession((s) => s.codeDispatches)
  const turns = useMemo(
    () => deriveTrajectoryLayout({ nodes, partial, runningCalls, callSchemas, codeDispatches }),
    [nodes, partial, runningCalls, callSchemas, codeDispatches],
  )
  const collapsibleTurnIds = useMemo(
    () => turns
      .filter(turn => turn.groups.reduce((count, group) => count + group.cells.length, 0) > 1)
      .map(turn => turn.turn),
    [turns],
  )
  const allTurnsCollapsed = collapsibleTurnIds.length > 0
    && collapsibleTurnIds.every(turn => collapsedTurns.has(turn))
  const collapsibleAssistantIds = useMemo(() => {
    const ids: number[] = []
    for (const turn of turns) {
      const cells = turn.groups.flatMap(group => group.cells)
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i]
        if (cell?.kind !== 'message') continue
        const next = cells[i + 1]
        if (next?.kind === 'tool' || next?.kind === 'subtool') ids.push(cell.index)
      }
    }
    return ids
  }, [turns])
  const allAssistantsCollapsed = collapsibleAssistantIds.length > 0
    && collapsibleAssistantIds.every(index => collapsedAssistants.has(index))

  const toggleTurn = (turn: number) => {
    setCollapsedTurns((current) => {
      const next = new Set(current)
      if (next.has(turn)) next.delete(turn)
      else next.add(turn)
      return next
    })
  }

  const toggleAllTurns = () => {
    setCollapsedTurns((current) => {
      const next = new Set(current)
      if (allTurnsCollapsed) {
        for (const turn of collapsibleTurnIds) next.delete(turn)
      } else {
        for (const turn of collapsibleTurnIds) next.add(turn)
      }
      return next
    })
  }

  const toggleAssistant = (index: number) => {
    setCollapsedAssistants((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const toggleAllAssistants = () => {
    setCollapsedAssistants((current) => {
      const next = new Set(current)
      if (allAssistantsCollapsed) {
        for (const index of collapsibleAssistantIds) next.delete(index)
      } else {
        for (const index of collapsibleAssistantIds) next.add(index)
      }
      return next
    })
  }

  return (
    <div className={css.root}>
      <TrajectoryToolbar
        collapsibleTurns={collapsibleTurnIds.length}
        allTurnsCollapsed={allTurnsCollapsed}
        onToggleAllTurns={toggleAllTurns}
        collapsibleAssistants={collapsibleAssistantIds.length}
        allAssistantsCollapsed={allAssistantsCollapsed}
        onToggleAllAssistants={toggleAllAssistants}
      />
      {turns.length === 0 && <p className={css.empty}>No trajectory events</p>}
      {turns.length > 0 && (
        <TrajectoryTable
          turns={turns}
          collapsedTurns={collapsedTurns}
          onToggleTurn={toggleTurn}
          collapsedAssistants={collapsedAssistants}
          onToggleAssistant={toggleAssistant}
        />
      )}
    </div>
  )
}
