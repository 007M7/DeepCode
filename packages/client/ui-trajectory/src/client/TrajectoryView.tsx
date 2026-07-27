/** Trajectory view: compact summary over a turn-aware event ledger. */

import { useMemo, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationContext } from '@deepseek-ai/dsh-client-runtime/client'
import { ContextsPanel, contextLabel } from './ContextsPanel.tsx'
import { TrajectoryTable } from './TrajectoryTable.tsx'
import { TrajectoryToolbar } from './TrajectoryToolbar.tsx'
import { deriveTrajectoryLayout } from './layout.ts'
import css from './views.module.css'

const EMPTY_IDS: ReadonlySet<number> = new Set()

function currentContextOf(contexts: readonly ConversationContext[]): ConversationContext {
  const context = contexts.at(-1)
  if (context === undefined) throw new Error('trajectory context projection must not be empty')
  return context
}

export function TrajectoryView({ useSession }: ConvViewProps) {
  const [selectedContextId, setSelectedContextId] = useState<number | null>(null)
  const [collapsedTurnsByContext, setCollapsedTurnsByContext] = useState<
    ReadonlyMap<number, ReadonlySet<number>>
  >(() => new Map())
  const [collapsedAssistantsByContext, setCollapsedAssistantsByContext] = useState<
    ReadonlyMap<number, ReadonlySet<number>>
  >(() => new Map())
  const nodes = useSession((s) => s.nodes)
  const projectedContexts = useSession((s) => s.contexts)
  const partial = useSession((s) => s.partial)
  const runningCalls = useSession((s) => s.runningCalls)
  const callSchemas = useSession((s) => s.callSchemas)
  const codeDispatches = useSession((s) => s.codeDispatches)
  const contexts = useMemo<readonly ConversationContext[]>(
    () => projectedContexts === undefined || projectedContexts.length === 0
      ? [{ id: 0, nodes }]
      : projectedContexts,
    [nodes, projectedContexts],
  )
  const currentContext = currentContextOf(contexts)
  const selectedContext = selectedContextId === null
    ? currentContext
    : contexts.find(context => context.id === selectedContextId) ?? currentContext
  const viewingCurrent = selectedContext.id === currentContext.id
  const selectedNodes = viewingCurrent ? nodes : selectedContext.nodes
  const collapsedTurns = collapsedTurnsByContext.get(selectedContext.id) ?? EMPTY_IDS
  const collapsedAssistants = collapsedAssistantsByContext.get(selectedContext.id) ?? EMPTY_IDS
  const turns = useMemo(
    () => deriveTrajectoryLayout({
      nodes: selectedNodes,
      partial: viewingCurrent ? partial : null,
      runningCalls: viewingCurrent ? runningCalls : [],
      callSchemas,
      codeDispatches,
    }),
    [
      selectedNodes, viewingCurrent, partial, runningCalls, callSchemas, codeDispatches,
    ],
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
    setCollapsedTurnsByContext((current) => {
      const next = new Map(current)
      const collapsed = new Set(current.get(selectedContext.id) ?? EMPTY_IDS)
      if (collapsed.has(turn)) collapsed.delete(turn)
      else collapsed.add(turn)
      next.set(selectedContext.id, collapsed)
      return next
    })
  }

  const toggleAllTurns = () => {
    setCollapsedTurnsByContext((current) => {
      const next = new Map(current)
      const collapsed = new Set(current.get(selectedContext.id) ?? EMPTY_IDS)
      if (allTurnsCollapsed) {
        for (const turn of collapsibleTurnIds) collapsed.delete(turn)
      } else {
        for (const turn of collapsibleTurnIds) collapsed.add(turn)
      }
      next.set(selectedContext.id, collapsed)
      return next
    })
  }

  const toggleAssistant = (index: number) => {
    setCollapsedAssistantsByContext((current) => {
      const next = new Map(current)
      const collapsed = new Set(current.get(selectedContext.id) ?? EMPTY_IDS)
      if (collapsed.has(index)) collapsed.delete(index)
      else collapsed.add(index)
      next.set(selectedContext.id, collapsed)
      return next
    })
  }

  const toggleAllAssistants = () => {
    setCollapsedAssistantsByContext((current) => {
      const next = new Map(current)
      const collapsed = new Set(current.get(selectedContext.id) ?? EMPTY_IDS)
      if (allAssistantsCollapsed) {
        for (const index of collapsibleAssistantIds) collapsed.delete(index)
      } else {
        for (const index of collapsibleAssistantIds) collapsed.add(index)
      }
      next.set(selectedContext.id, collapsed)
      return next
    })
  }

  const selectContext = (id: number) => {
    setSelectedContextId(id === currentContext.id ? null : id)
  }

  return (
    <div className={css.root}>
      <TrajectoryToolbar
        {...contexts.length > 1
          ? {
              contextLabel: contextLabel(selectedContext),
              contextCurrent: viewingCurrent,
            }
          : {}}
        collapsibleTurns={collapsibleTurnIds.length}
        allTurnsCollapsed={allTurnsCollapsed}
        onToggleAllTurns={toggleAllTurns}
        collapsibleAssistants={collapsibleAssistantIds.length}
        allAssistantsCollapsed={allAssistantsCollapsed}
        onToggleAllAssistants={toggleAllAssistants}
      />
      <div className={css.contextLayout}>
        {contexts.length > 1 && (
          <ContextsPanel
            contexts={contexts}
            selectedId={selectedContext.id}
            currentId={currentContext.id}
            onSelect={selectContext}
          />
        )}
        <div className={css.ledger}>
          {turns.length === 0 && <p className={css.empty}>No trajectory events</p>}
          {turns.length > 0 && (
            <TrajectoryTable
              key={selectedContext.id}
              turns={turns}
              collapsedTurns={collapsedTurns}
              onToggleTurn={toggleTurn}
              collapsedAssistants={collapsedAssistants}
              onToggleAssistant={toggleAssistant}
            />
          )}
        </div>
      </div>
    </div>
  )
}
