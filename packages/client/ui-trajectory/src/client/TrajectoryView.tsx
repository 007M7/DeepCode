/** Trajectory view: compact summary over a turn-aware event ledger. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AssistantMessageNode, ConversationContext,
  SessionHistoryFace,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  deriveTrajectoryContextBranches, trajectoryBranchContainsRequest,
} from './context-branches.ts'
import {
  TrajectoryTable,
  type TrajectoryRequestNumber,
  type TrajectoryUsage,
} from './TrajectoryTable.tsx'
import { TrajectoryToolbar } from './TrajectoryToolbar.tsx'
import { TrajectoryTimeline } from './TrajectoryTimeline.tsx'
import { deriveTrajectoryLayout } from './layout.ts'
import {
  trajectoryTimelineFocusIndexes,
  type TrajectoryTimelineMode,
  type TrajectoryTimeRange,
} from './timeline.ts'
import css from './views.module.css'

const EMPTY_IDS: ReadonlySet<number> = new Set()

/** Session-history paging needed by the event-complete trajectory view. */
export interface TrajectoryViewInjected {
  hooks: { history: SessionHistoryFace }
  loadAllHistory: (signal: AbortSignal) => Promise<void>
}

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

function searchableJson(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function searchMatches(
  turns: ReturnType<typeof deriveTrajectoryLayout>,
  query: string,
): ReadonlySet<number> | null {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return null
  const matches = new Set<number>()
  for (const turn of turns) {
    for (const group of turn.groups) {
      for (const cell of group.cells) {
        if (cell.requestOnly === true) continue
        const blocks = [
          ...(cell.sourceBlocks ?? []),
          ...(cell.outputBlocks ?? []),
        ]
        const text = [
          turn.turn === null ? 'between turns' : `turn ${turn.turn}`,
          group.title,
          cell.kind,
          cell.kind === 'message' ? 'assistant' : undefined,
          cell.text,
          cell.inputDetail,
          cell.outputDetail,
          cell.thinkingDetail,
          cell.schemaDetail,
          cell.result,
          cell.callId,
          ...blocks.flatMap(block => [
            block.type,
            block.content,
            block.callId,
            block.toolName,
            block.imageAlt,
          ]),
          searchableJson(cell.messageSource),
          searchableJson(cell.promptDetail),
          searchableJson(cell.previousPromptDetail),
        ].filter((value): value is string => typeof value === 'string')
          .join('\n')
          .toLocaleLowerCase()
        if (terms.every(term => text.includes(term))) matches.add(cell.index)
      }
    }
  }
  return matches
}

export function TrajectoryView({
  useHistory, loadAllHistory, inspect, onInspectDone,
}: ConvViewProps & InjectFace<TrajectoryViewInjected>) {
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(EMPTY_IDS)
  const [collapsedAssistants, setCollapsedAssistants] =
    useState<ReadonlySet<number>>(EMPTY_IDS)
  const [timelineSelection, setTimelineSelection] = useState<{
    branchId: number
    range: TrajectoryTimeRange
  } | null>(null)
  const [actualDuration, setActualDuration] = useState(false)
  const [actualTime, setActualTime] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedTimelineIndex, setSelectedTimelineIndex] = useState<number | null>(null)
  const [timelineRecordSelection, setTimelineRecordSelection] = useState<{
    readonly index: number
  } | null>(null)
  const ledgerRef = useRef<HTMLDivElement>(null)
  const inspection = useHistory(snapshot => snapshot.inspection)
  const nodes = inspection.eventNodes
  const partial = inspection.partial
  const runningCalls = inspection.runningCalls
  const codeDispatches = inspection.codeDispatches
  const loadAllHistoryRef = useRef(loadAllHistory)
  loadAllHistoryRef.current = loadAllHistory
  useEffect(() => {
    const controller = new AbortController()
    void loadAllHistoryRef.current(controller.signal)
    return () => { controller.abort() }
  }, [])
  const requests = inspection.requests
  const callSchemas = inspection.callSchemas
  const contexts = useMemo<readonly ConversationContext[]>(
    () => inspection.contexts.length === 0
      ? [{ id: 0, nodes }]
      : inspection.contexts,
    [inspection, nodes],
  )
  const branches = useMemo(
    () => deriveTrajectoryContextBranches(contexts),
    [contexts],
  )
  const currentBranch = branches.at(-1)
  if (currentBranch === undefined) throw new Error('trajectory branch projection must not be empty')
  const selectedNodes = useMemo(() => {
    const selected = new Map(currentBranch.nodes.map(node => [node.seq, node]))
    for (const node of inspection.interruptedNodes) {
      selected.set(node.seq, node)
    }
    return [...selected.values()].sort((left, right) => left.seq - right.seq)
  }, [currentBranch, inspection])
  const selectedRequests = useMemo(
    () => requests.filter(request =>
      trajectoryBranchContainsRequest(currentBranch, request),
    ),
    [currentBranch, requests],
  )
  const globalRequestNumbers = useMemo<readonly TrajectoryRequestNumber[]>(() => {
    const assistantsByStep = new Map<string, AssistantMessageNode>()
    for (const context of contexts) {
      for (const node of context.nodes) {
        if (node.kind !== 'assistant' || node.step <= 0) continue
        assistantsByStep.set(`${node.turn}\u0000${node.step}`, node)
      }
    }
    for (const node of nodes) {
      if (node.kind !== 'assistant' || node.step <= 0) continue
      assistantsByStep.set(`${node.turn}\u0000${node.step}`, node)
    }
    const requestsByStep = new Map(
      requests
        .filter(request => request.purpose === 'assistant')
        .map(request => [
          `${request.turn}\u0000${request.step}`,
          request,
        ]),
    )
    const orderedRequests = [
      ...requests.map(request => ({
        seq: request.startSeq,
        request,
        node: request.purpose === 'assistant'
          ? assistantsByStep.get(`${request.turn}\u0000${request.step}`)
          : undefined,
      })),
      ...[...assistantsByStep.entries()].flatMap(([key, node]) =>
        requestsByStep.has(key)
          ? []
          : [{
            seq: node.seq,
            request: undefined,
            node,
          }],
      ),
    ].sort((left, right) => left.seq - right.seq)
    const numbered: TrajectoryRequestNumber[] = []
    let cumulativeUsage: TrajectoryUsage | undefined
    for (const [index, entry] of orderedRequests.entries()) {
      const usage = requestUsage(entry.request?.usage ?? entry.node?.usage)
      cumulativeUsage = addUsage(cumulativeUsage, usage)
      if (entry.request?.purpose !== 'compaction') {
        const request = entry.request
        const node = entry.node
        const turn = request?.turn ?? node?.turn
        const step = request?.step ?? node?.step
        if (turn === undefined || step === undefined) continue
        const provider = request?.provenance?.provider ?? node?.provenance?.provider
        const model = request?.provenance?.model ?? node?.provenance?.model
        const requestConfig = request?.requestConfig ?? node?.requestConfig
        numbered.push({
          seq: entry.seq,
          turn,
          step,
          group: `Step ${step}`,
          number: index + 1,
          ...(request?.status === undefined ? {} : { status: request.status }),
          ...(request?.startedAt === undefined ? {} : { startedAt: request.startedAt }),
          ...(request?.completedAt === undefined ? {} : { completedAt: request.completedAt }),
          ...(request?.error === undefined ? {} : { error: request.error }),
          ...(request?.resultSeq === undefined ? {} : { resultSeq: request.resultSeq }),
          ...(request?.retry === undefined ? {} : { retry: request.retry }),
          ...(request?.maxRetries === undefined ? {} : { maxRetries: request.maxRetries }),
          ...(request?.retryDelayMs === undefined
            ? {}
            : { retryDelayMs: request.retryDelayMs }),
          ...(provider === undefined ? {} : { provider }),
          ...(model === undefined ? {} : { model }),
          ...(requestConfig === undefined ? {} : { requestConfig }),
          ...(usage === undefined ? {} : { usage }),
          ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
        })
        continue
      }
      const request = entry.request
      numbered.push({
        seq: request.startSeq,
        turn: request.turn,
        step: 0,
        group: `Compaction ${request.startSeq}`,
        number: index + 1,
        purpose: 'compaction',
        status: request.status,
        startedAt: request.startedAt,
        completedAt: request.completedAt,
        ...(request.error === undefined ? {} : { error: request.error }),
        resultSeq: request.startSeq,
        ...(request.provenance?.provider === undefined
          ? {}
          : { provider: request.provenance.provider }),
        ...(request.provenance?.model === undefined
          ? {}
          : { model: request.provenance.model }),
        ...(request.requestConfig === undefined ? {} : { requestConfig: request.requestConfig }),
        ...(usage === undefined ? {} : { usage }),
        ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
      })
    }

    if (partial !== null && partial.step > 0) {
      const key = `${partial.turn}\u0000${partial.step}`
      const recorded = numbered.some(request =>
        `${request.turn}\u0000${request.step}` === key,
      )
      if (!recorded) {
        numbered.push({
          turn: partial.turn,
          step: partial.step,
          group: `Step ${partial.step}`,
          number: orderedRequests.length + 1,
          ...(currentBranch.latest.prompt?.config.provider === undefined
            ? {}
            : { provider: currentBranch.latest.prompt.config.provider }),
          ...(currentBranch.latest.prompt?.config.model === undefined
            ? {}
            : { model: currentBranch.latest.prompt.config.model }),
          ...(currentBranch.latest.prompt?.config === undefined
            ? {}
            : { requestConfig: currentBranch.latest.prompt.config }),
          ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
        })
      }
    }
    return numbered
  }, [
    contexts, currentBranch.latest.prompt, nodes, partial, requests,
  ])
  const requestNumbers = globalRequestNumbers
  const turns = useMemo(
    () => deriveTrajectoryLayout({
      nodes: selectedNodes,
      partial,
      runningCalls,
      requests: selectedRequests,
      callSchemas,
      codeDispatches,
    }),
    [
      selectedNodes, partial, runningCalls, selectedRequests, callSchemas, codeDispatches,
    ],
  )
  const timelineMode: TrajectoryTimelineMode = actualDuration
    ? actualTime ? 'actual' : 'duration'
    : actualTime ? 'time' : 'sequence'
  const searchMatchIndexes = useMemo(
    () => searchMatches(turns, searchQuery),
    [searchQuery, turns],
  )
  const timelineRange = timelineSelection?.branchId === currentBranch.id
    ? timelineSelection.range
    : null
  const timelineFocusIndexes = useMemo(
    () => timelineRange === null
      ? null
      : trajectoryTimelineFocusIndexes(turns, timelineRange, timelineMode),
    [timelineMode, timelineRange, turns],
  )
  const handleRecordSelect = useCallback((index: number) => {
    if (
      timelineFocusIndexes !== null
      && !timelineFocusIndexes.has(index)
    ) {
      setTimelineSelection(null)
    }
  }, [timelineFocusIndexes])
  useEffect(() => {
    if (timelineFocusIndexes === null || timelineFocusIndexes.size === 0) return
    const ledger = ledgerRef.current
    if (ledger === null) return
    const focusedRows = [
      ...ledger.querySelectorAll<HTMLElement>('tr[data-timeline-focus="inside"]'),
    ]
    const first = focusedRows.at(0)
    const last = focusedRows.at(-1)
    if (first === undefined || last === undefined) return
    const focusHeight =
      last.getBoundingClientRect().bottom - first.getBoundingClientRect().top
    if (focusHeight > ledger.clientHeight) {
      if (typeof first.scrollIntoView === 'function') {
        first.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      return
    }
    const middle = focusedRows[Math.floor((focusedRows.length - 1) / 2)]
    if (middle !== undefined && typeof middle.scrollIntoView === 'function') {
      middle.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [timelineFocusIndexes])
  const collapsibleTurnIds = useMemo(
    () => turns
      .filter(turn =>
        turn.turn !== null
        &&
        turn.groups.reduce(
          (count, group) =>
            count + group.cells.filter(cell =>
              cell.requestOnly !== true && cell.kind !== 'system').length,
          0,
        ) > 1)
      .flatMap(turn => turn.turn === null ? [] : [turn.turn]),
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
      const collapsed = new Set(current)
      if (collapsed.has(turn)) collapsed.delete(turn)
      else collapsed.add(turn)
      return collapsed
    })
  }

  const toggleAllTurns = () => {
    setCollapsedTurns((current) => {
      const collapsed = new Set(current)
      if (allTurnsCollapsed) {
        for (const turn of collapsibleTurnIds) collapsed.delete(turn)
      } else {
        for (const turn of collapsibleTurnIds) collapsed.add(turn)
      }
      return collapsed
    })
  }

  const toggleAssistant = (index: number) => {
    setCollapsedAssistants((current) => {
      const collapsed = new Set(current)
      if (collapsed.has(index)) collapsed.delete(index)
      else collapsed.add(index)
      return collapsed
    })
  }

  const toggleAllAssistants = () => {
    setCollapsedAssistants((current) => {
      const collapsed = new Set(current)
      if (allAssistantsCollapsed) {
        for (const index of collapsibleAssistantIds) collapsed.delete(index)
      } else {
        for (const index of collapsibleAssistantIds) collapsed.add(index)
      }
      return collapsed
    })
  }

  return (
    <div className={css.root}>
      <TrajectoryToolbar
        actualDuration={actualDuration}
        onActualDurationChange={(nextActualDuration) => {
          setActualDuration(nextActualDuration)
          setTimelineSelection(null)
        }}
        actualTime={actualTime}
        onActualTimeChange={(nextActualTime) => {
          setActualTime(nextActualTime)
          setTimelineSelection(null)
        }}
        collapsibleTurns={collapsibleTurnIds.length}
        allTurnsCollapsed={allTurnsCollapsed}
        onToggleAllTurns={toggleAllTurns}
        collapsibleAssistants={collapsibleAssistantIds.length}
        allAssistantsCollapsed={allAssistantsCollapsed}
        onToggleAllAssistants={toggleAllAssistants}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
      />
      <TrajectoryTimeline
        turns={turns}
        mode={timelineMode}
        range={timelineRange}
        selectedIndex={selectedTimelineIndex}
        searchMatchIndexes={searchMatchIndexes}
        onRangeChange={(range) => {
          setTimelineSelection(range === null ? null : {
            branchId: currentBranch.id,
            range,
          })
        }}
        onRecordSelect={(index) => {
          setTimelineSelection(null)
          setTimelineRecordSelection({ index })
          setSelectedTimelineIndex(index)
          const row = ledgerRef.current
            ?.querySelector<HTMLElement>(`tr[data-record-index="${index}"]`)
          if (row !== undefined && row !== null && typeof row.scrollIntoView === 'function') {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        }}
        onRecordFocus={(index) => {
          const row = ledgerRef.current
            ?.querySelector<HTMLElement>(`tr[data-record-index="${index}"]`)
          if (row !== undefined && row !== null && typeof row.scrollIntoView === 'function') {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        }}
      />
      <div ref={ledgerRef} className={css.ledger}>
        <TrajectoryTable
          key={currentBranch.id}
          requestNumbers={requestNumbers}
          turns={turns}
          timelineFocusIndexes={timelineFocusIndexes}
          searchMatchIndexes={searchMatchIndexes}
          onSelectedIndexChange={setSelectedTimelineIndex}
          onRecordSelect={handleRecordSelect}
          recordSelection={timelineRecordSelection}
          onClearSelection={() => { setTimelineSelection(null) }}
          collapsedTurns={collapsedTurns}
          onToggleTurn={toggleTurn}
          collapsedAssistants={collapsedAssistants}
          onToggleAssistant={toggleAssistant}
          inspectCallId={inspect?.callId ?? null}
          onInspectApplied={onInspectDone}
        />
      </div>
    </div>
  )
}
