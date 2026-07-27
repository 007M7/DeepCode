/** Trajectory view: compact summary over a turn-aware event ledger. */

import { useMemo, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  AssistantMessageNode, ConversationContext,
} from '@deepseek-ai/dsh-client-runtime/client'
import { ContextsPanel, contextLabel } from './ContextsPanel.tsx'
import {
  TrajectoryTable,
  type TrajectoryRequestNumber,
  type TrajectoryUsage,
} from './TrajectoryTable.tsx'
import { TrajectoryToolbar } from './TrajectoryToolbar.tsx'
import { deriveTrajectoryLayout } from './layout.ts'
import css from './views.module.css'

const EMPTY_IDS: ReadonlySet<number> = new Set()

interface UsageLike {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

function requestUsage(value: unknown): TrajectoryUsage | undefined {
  const usage = value as UsageLike | undefined
  if (usage === undefined) return undefined
  return {
    ...(usage.inputTokens === undefined ? {} : { input: usage.inputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheRead: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWrite: usage.cacheWriteTokens }),
    ...(usage.outputTokens === undefined ? {} : { output: usage.outputTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens }),
  }
}

function addUsage(
  total: TrajectoryUsage | undefined,
  usage: TrajectoryUsage | undefined,
): TrajectoryUsage | undefined {
  if (usage === undefined) return total
  return {
    ...(total?.input === undefined && usage.input === undefined
      ? {}
      : { input: (total?.input ?? 0) + (usage.input ?? 0) }),
    ...(total?.cacheRead === undefined && usage.cacheRead === undefined
      ? {}
      : { cacheRead: (total?.cacheRead ?? 0) + (usage.cacheRead ?? 0) }),
    ...(total?.cacheWrite === undefined && usage.cacheWrite === undefined
      ? {}
      : { cacheWrite: (total?.cacheWrite ?? 0) + (usage.cacheWrite ?? 0) }),
    ...(total?.output === undefined && usage.output === undefined
      ? {}
      : { output: (total?.output ?? 0) + (usage.output ?? 0) }),
    ...(total?.reasoning === undefined && usage.reasoning === undefined
      ? {}
      : { reasoning: (total?.reasoning ?? 0) + (usage.reasoning ?? 0) }),
  }
}

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
  const requestNumbers = useMemo<readonly TrajectoryRequestNumber[]>(() => {
    const requestsBySeq = new Map<number, AssistantMessageNode>()
    for (const context of contexts) {
      for (const node of context.nodes) {
        if (node.kind !== 'assistant' || node.step <= 0) continue
        requestsBySeq.set(node.seq, node)
      }
    }
    for (const node of nodes) {
      if (node.kind !== 'assistant' || node.step <= 0) continue
      requestsBySeq.set(node.seq, node)
    }
    const orderedRequests = [...requestsBySeq.values()]
      .sort((left, right) => left.seq - right.seq)
    const requestBySeq = new Map<number, TrajectoryRequestNumber>()
    let cumulativeUsage: TrajectoryUsage | undefined
    for (const [index, node] of orderedRequests.entries()) {
      const usage = requestUsage(node.usage)
      cumulativeUsage = addUsage(cumulativeUsage, usage)
      requestBySeq.set(node.seq, {
        turn: node.turn,
        step: node.step,
        number: index + 1,
        ...(node.provenance?.provider === undefined
          ? {}
          : { provider: node.provenance.provider }),
        ...(node.provenance?.model === undefined
          ? {}
          : { model: node.provenance.model }),
        ...(node.requestConfig === undefined ? {} : { requestConfig: node.requestConfig }),
        ...(usage === undefined ? {} : { usage }),
        ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
      })
    }

    const selected: TrajectoryRequestNumber[] = []
    const selectedKeys = new Set<string>()
    for (const node of selectedNodes) {
      if (node.kind !== 'assistant' || node.step <= 0) continue
      const request = requestBySeq.get(node.seq)
      if (request === undefined) continue
      selected.push(request)
      selectedKeys.add(`${node.turn}\u0000${node.step}`)
    }
    if (viewingCurrent && partial !== null && partial.step > 0) {
      const key = `${partial.turn}\u0000${partial.step}`
      if (!selectedKeys.has(key)) {
        selected.push({
          turn: partial.turn,
          step: partial.step,
          number: orderedRequests.length + 1,
          ...(currentContext.prompt?.config?.provider === undefined
            ? {}
            : { provider: currentContext.prompt.config.provider }),
          ...(currentContext.prompt?.config?.model === undefined
            ? {}
            : { model: currentContext.prompt.config.model }),
          ...(currentContext.prompt?.config === undefined
            ? {}
            : { requestConfig: currentContext.prompt.config }),
          ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
        })
      }
    }
    return selected
  }, [contexts, currentContext.prompt, nodes, partial, selectedNodes, viewingCurrent])
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
          <TrajectoryTable
            key={selectedContext.id}
            {...selectedContext.prompt === undefined ? {} : { prompt: selectedContext.prompt }}
            requestNumbers={requestNumbers}
            turns={turns}
            collapsedTurns={collapsedTurns}
            onToggleTurn={toggleTurn}
            collapsedAssistants={collapsedAssistants}
            onToggleAssistant={toggleAssistant}
          />
        </div>
      </div>
    </div>
  )
}
