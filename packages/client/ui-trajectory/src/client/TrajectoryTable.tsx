/** Turn-aware trajectory event ledger with a local record inspector. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  IconChevronRightOutline14,
  IconSettingsOutline16,
  IconSparkle16,
  IconUserOutline16,
  JsonTree,
  MarkdownText,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { structuredPatch } from 'diff'
import type {
  AssistantRequestConfig, ConversationPromptSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  AssistantMetricDetail, TrajectoryCellKind, TrajectoryCellProps, TrajectorySourceBlock,
} from './trajectory-record.ts'
import { formatElapsedSeconds } from './trajectory-record.ts'
import { trajectoryPreviewText, type TrajectoryTurnModel } from './layout.ts'
import css from './TrajectoryTable.module.css'

const BOTTOM_FOLLOW_THRESHOLD_PX = 2

const KIND_LABEL: Record<TrajectoryCellKind, string> = {
  system: 'SYSTEM',
  user: 'USER',
  context: 'CONTEXT',
  compacted: 'COMPACTED',
  message: 'ASSISTANT',
  tool: 'TOOL',
  subtool: 'SUBTOOL',
}

function ToolWrenchIcon(): ReactNode {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-role-icon="wrench"
      aria-hidden="true"
    >
      <path d="M14 3.3a3.8 3.8 0 0 1-4.8 4.8l-5.1 5.1a1.6 1.6 0 1 1-2.3-2.3l5.1-5.1A3.8 3.8 0 0 1 11.7 1l-2.3 2.3 2.3 2.3L14 3.3Z" />
    </svg>
  )
}

function InformationIcon(): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      data-role-icon="information"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.7" />
      <circle cx="8" cy="5.5" r=".85" fill="currentColor" stroke="none" />
      <path d="M8 7.75v3.4" strokeWidth="1.8" />
    </svg>
  )
}

function CompactedIcon(): ReactNode {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-role-icon="compacted"
      aria-hidden="true"
    >
      <path d="m2.5 2.5 3.75 3.75M3 6.25h3.25V3" />
      <path d="m13.5 2.5-3.75 3.75M13 6.25H9.75V3" />
      <path d="m2.5 13.5 3.75-3.75M3 9.75h3.25V13" />
      <path d="m13.5 13.5-3.75-3.75M13 9.75H9.75V13" />
    </svg>
  )
}

const KIND_ICON: Record<TrajectoryCellKind, ReactNode> = {
  system: <IconSettingsOutline16 size={13} />,
  user: <IconUserOutline16 size={13} />,
  context: <InformationIcon />,
  compacted: <CompactedIcon />,
  message: <IconSparkle16 size={13} />,
  tool: <ToolWrenchIcon />,
  subtool: <ToolWrenchIcon />,
}

interface TableRecord {
  turn: number | null
  section: number
  group: string
  groupStart: boolean
  turnStart: boolean
  cell: TrajectoryCellProps
  turnEnd: boolean
  collapsedSummary?: string
  collapsedSummaryKind?: 'turn' | 'assistant'
}

type DetailTab =
  | 'system-prompt'
  | 'tools'
  | 'overview'
  | 'rendered'
  | 'source'
  | 'origin'
  | 'input'
  | 'output'
  | 'schema'
  | 'options'
  | 'usage'
  | 'timing'
  | 'diff'
type RecordState = 'complete' | 'running' | 'error'

interface DetailTabItem {
  id: DetailTab
  label: string
}

interface ParentRecords {
  message?: TableRecord
  tool?: TableRecord
}

interface ToolCallTextParts {
  name: string
  args?: string
}

interface SelectedRequest {
  turn: number | null
  section: number
  number: number
  group: string
}

interface DetailsResizeDrag {
  pointerId: number
  startX: number
  startWidth: number
  splitWidth: number
  startToolRequestOffset: number
}

const DETAILS_MIN_WIDTH = 320
const DETAILS_MAX_WIDTH = 720
const TABLE_MIN_WIDTH = 280
const DETAILS_RESIZE_STEP = 16
const TOOL_REQUEST_SHARE = 0.58
const TOOL_REQUEST_MIN_WIDTH = 180
const TOOL_REQUEST_MAX_WIDTH = 480
const DEFAULT_TOOL_REQUEST_SHARE = 0.36
const DEFAULT_TOOL_REQUEST_OFFSET = 56
const SYSTEM_PROMPT_TABS: readonly DetailTabItem[] = [
  { id: 'system-prompt', label: 'System Prompt' },
  { id: 'tools', label: 'Tools' },
]
const SYSTEM_UPDATE_TABS: readonly DetailTabItem[] = [
  { id: 'diff', label: 'Diff' },
  ...SYSTEM_PROMPT_TABS,
]
const REQUEST_TABS: readonly DetailTabItem[] = [
  { id: 'overview', label: 'Summary' },
  { id: 'options', label: 'Options' },
  { id: 'usage', label: 'Usage' },
  { id: 'timing', label: 'Timing' },
]

type TrajectorySplitStyle = CSSProperties & {
  '--trajectory-tool-request-width': string
}

type RequestBoundaryStyle = CSSProperties & {
  '--request-boundary-offset': string
}

function clampDetailsWidth(width: number, splitWidth: number): number {
  const maxWidth = Math.max(
    DETAILS_MIN_WIDTH,
    Math.min(DETAILS_MAX_WIDTH, splitWidth - TABLE_MIN_WIDTH),
  )
  return Math.round(Math.min(Math.max(width, DETAILS_MIN_WIDTH), maxWidth))
}

function defaultToolRequestWidth(splitWidth: number): number {
  return Math.min(
    Math.max(
      splitWidth * DEFAULT_TOOL_REQUEST_SHARE - DEFAULT_TOOL_REQUEST_OFFSET,
      TOOL_REQUEST_MIN_WIDTH,
    ),
    TOOL_REQUEST_MAX_WIDTH,
  )
}

function formatDurationMs(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`
}

function formatStartedAt(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return 'Not available'
  const date = new Date(timestamp)
  const two = (value: number) => String(value).padStart(2, '0')
  const three = (value: number) => String(value).padStart(3, '0')
  const time = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${three(date.getMilliseconds())}`
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
  return `${day} ${time}`
}

function StartedAtValue({ timestamp }: { timestamp: number | null }) {
  const [showUnix, setShowUnix] = useState(false)
  if (timestamp === null || !Number.isFinite(timestamp)) return <dd>Not available</dd>
  return (
    <dd>
      <button
        type="button"
        className={css.timestampToggle}
        title={showUnix ? 'Show local time' : 'Show Unix timestamp'}
        onClick={(event) => {
          const selection = window.getSelection()
          if (
            selection !== null
            && !selection.isCollapsed
            && selection.rangeCount > 0
            && selection.getRangeAt(0).intersectsNode(event.currentTarget)
          ) return
          setShowUnix(current => !current)
        }}
      >
        {showUnix ? (timestamp / 1_000).toFixed(3) : formatStartedAt(timestamp)}
      </button>
    </dd>
  )
}

function totalTime(metrics: AssistantMetricDetail): string {
  if (!metrics.timingRecorded) return 'Not recorded'
  if (metrics.stepStartTime === null) return 'Step start unavailable'
  if (metrics.completedTime === null) return 'Pending'
  return formatDurationMs(Math.max(0, metrics.completedTime - metrics.stepStartTime))
}

function ttft(metrics: AssistantMetricDetail): string {
  if (!metrics.timingRecorded) return 'Not recorded'
  if (metrics.stepStartTime === null) return 'Step start unavailable'
  if (metrics.firstTokenTime === null) return 'First token unavailable'
  return formatDurationMs(Math.max(0, metrics.firstTokenTime - metrics.stepStartTime))
}

function generationTime(metrics: AssistantMetricDetail): string {
  if (!metrics.timingRecorded || metrics.firstTokenTime === null) return 'First token unavailable'
  if (metrics.completedTime === null) return 'Pending'
  return formatDurationMs(Math.max(0, metrics.completedTime - metrics.firstTokenTime))
}

function throughput(metrics: AssistantMetricDetail): string {
  if (!metrics.usageProvided) return 'Usage unavailable'
  if (metrics.outputTokens === null) return 'Output tokens unavailable'
  if (!metrics.timingRecorded || metrics.firstTokenTime === null) return 'First token unavailable'
  if (metrics.completedTime === null) return 'Pending'
  const generationSeconds = (metrics.completedTime - metrics.firstTokenTime) / 1_000
  if (generationSeconds <= 0) return 'Duration too short'
  return `${(metrics.outputTokens / generationSeconds).toFixed(1)} tok/s`
}

function AssistantTimingPanel({ metrics }: { metrics: AssistantMetricDetail }) {
  return (
    <dl className={css.overview}>
      <div><dt>Started</dt><StartedAtValue timestamp={metrics.stepStartTime} /></div>
      <div><dt>Total duration</dt><dd>{totalTime(metrics)}</dd></div>
      <div><dt>TTFT</dt><dd>{ttft(metrics)}</dd></div>
      <div><dt>Generation</dt><dd>{generationTime(metrics)}</dd></div>
      <div><dt>Throughput</dt><dd>{throughput(metrics)}</dd></div>
    </dl>
  )
}

/** Props for the trajectory ledger. */
export interface TrajectoryTableProps {
  /** Session-global request numbers for the request groups visible in this context. */
  requestNumbers?: readonly TrajectoryRequestNumber[]
  /** Grouped records in display order. */
  turns: readonly TrajectoryTurnModel[]
  /** Record indexes emphasized by the active timeline focus. */
  timelineFocusIndexes?: ReadonlySet<number> | null
  /** Record indexes retained by the active live search, or null without a query. */
  searchMatchIndexes?: ReadonlySet<number> | null
  /** Report the record currently selected in the local inspector. */
  onSelectedIndexChange?: (index: number | null) => void
  /** Report a direct user selection from a ledger row. */
  onRecordSelect?: (index: number) => void
  /** One externally requested record selection; a new object repeats the request. */
  recordSelection?: { readonly index: number } | null
  /** Clear selection state owned by the ledger host. */
  onClearSelection?: () => void
  /** Turn ids whose rows after the first are folded into a summary. */
  collapsedTurns: ReadonlySet<number>
  /** Toggle one turn between folded and expanded. */
  onToggleTurn: (turn: number) => void
  /** Assistant record indexes whose tool calls are folded. */
  collapsedAssistants: ReadonlySet<number>
  /** Toggle tool calls under one assistant record. */
  onToggleAssistant: (index: number) => void
  /** One-shot cross-view inspect: open and scroll to this call's record. */
  inspectCallId?: string | null
  /** Acknowledge a consumed (or unresolvable) inspect request. */
  onInspectApplied?: (() => void) | undefined
}

/** Request-inspector fields shared by ordinary generation and compaction. */
interface TrajectoryRequestNumberBase {
  /** Request anchor event sequence; absent for the currently streaming ordinary request. */
  seq?: number
  group: string
  number: number
  status?: 'complete' | 'running' | 'error'
  startedAt?: number
  completedAt?: number | null
  error?: string
  retry?: number
  maxRetries?: number
  retryDelayMs?: number
  resultSeq?: number
  provider?: string
  model?: string
  requestConfig?: AssistantRequestConfig
  usage?: TrajectoryUsage
  cumulativeUsage?: TrajectoryUsage
}

/** One purpose-discriminated request identity paired with its session-global number. */
export type TrajectoryRequestNumber = TrajectoryRequestNumberBase & (
  | {
    purpose?: 'assistant'
    turn: number
    step: number
  }
  | {
    purpose: 'compaction'
    turn: number | null
    step: 0
  }
)

/** Disjoint provider token buckets for one request or a session prefix. */
export interface TrajectoryUsage {
  input?: number
  cacheRead?: number
  cacheWrite?: number
  output?: number
  reasoning?: number
}

function flattenRecords(turns: readonly TrajectoryTurnModel[]): TableRecord[] {
  return turns.flatMap((turn, section) => {
    let firstInSection = true
    const records = turn.groups.flatMap((group) => {
      return group.cells.map((cell, index) => {
        const turnStart = firstInSection
          && cell.requestOnly !== true
          && cell.kind !== 'system'
          && (cell.kind !== 'compacted' || turn.turn === null)
        if (turnStart) firstInSection = false
        return {
          turn: turn.turn,
          section,
          group: group.title,
          groupStart: index === 0,
          turnStart,
          cell,
          turnEnd: false,
        }
      })
    })
    const last = records.at(-1)
    if (last !== undefined) last.turnEnd = true
    return records
  })
}

function filterRecords(
  records: readonly TableRecord[],
  matches: ReadonlySet<number>,
): TableRecord[] {
  const filtered = records
    .filter(record =>
      record.cell.requestOnly !== true && matches.has(record.cell.index),
    )
    .map(record => ({ ...record, groupStart: false, turnStart: false, turnEnd: false }))
  const startedSections = new Set<number>()
  for (const [index, record] of filtered.entries()) {
    const previous = filtered[index - 1]
    const next = filtered[index + 1]
    record.groupStart = previous === undefined
      || previous.section !== record.section
      || previous.group !== record.group
    record.turnStart = !startedSections.has(record.section)
      && record.cell.kind !== 'system'
      && (record.cell.kind !== 'compacted' || record.turn === null)
    if (record.turnStart) startedSections.add(record.section)
    record.turnEnd = next === undefined || next.section !== record.section
  }
  return filtered
}

function requestStep(group: string): number | undefined {
  if (!group.startsWith('Step ')) return undefined
  const value = Number(group.slice('Step '.length))
  return Number.isInteger(value) && value > 0 ? value : undefined
}

function requestKey(turn: number | null, group: string): string {
  return `${turn}\u0000${group}`
}

function sectionLabel(turn: number | null): string {
  return turn === null ? 'Between turns' : `Turn ${turn}`
}

function indexRequestNumbers(
  records: readonly TableRecord[],
  sessionNumbers: readonly TrajectoryRequestNumber[] | undefined,
): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>()
  for (const request of sessionNumbers ?? []) {
    numbers.set(requestKey(request.turn, request.group), request.number)
  }
  let next = Math.max(0, ...numbers.values()) + 1
  const boundaries = records
    .filter(record => record.groupStart && requestStep(record.group) !== undefined)
    .sort((left, right) => left.cell.index - right.cell.index)
  for (const record of boundaries) {
    const key = requestKey(record.turn, record.group)
    if (!numbers.has(key)) numbers.set(key, next++)
  }
  return numbers
}

function indexRequestBoundaryRuns(records: readonly TableRecord[]): ReadonlyMap<number, number> {
  const indexes = new Map<number, number>()
  let runLength = 0
  for (const record of records) {
    if (record.cell.requestOnly === true) {
      indexes.set(record.cell.index, runLength++)
      continue
    }
    if (runLength > 0 && record.groupStart && requestStep(record.group) !== undefined) {
      indexes.set(record.cell.index, runLength)
    }
    runLength = 0
  }
  return indexes
}

function summarizeTurn(records: readonly TableRecord[]): string {
  const steps = new Set(
    records
      .map(record => record.group)
      .filter(group => group.startsWith('Step ')),
  ).size
  const toolCalls = records.filter(record =>
    record.cell.kind === 'tool' || record.cell.kind === 'subtool',
  ).length
  return [
    `${steps} ${steps === 1 ? 'step' : 'steps'}`,
    `${toolCalls} tool ${toolCalls === 1 ? 'call' : 'calls'}`,
  ].join(' · ')
}

function collapseTurnRecords(
  records: readonly TableRecord[],
  collapsedTurns: ReadonlySet<number>,
): TableRecord[] {
  if (collapsedTurns.size === 0) return [...records]
  const recordsByTurn = new Map<number, TableRecord[]>()
  for (const record of records) {
    if (record.turn === null) continue
    const turnRecords = recordsByTurn.get(record.turn) ?? []
    turnRecords.push(record)
    recordsByTurn.set(record.turn, turnRecords)
  }
  return records.flatMap((record) => {
    if (record.turn === null || !collapsedTurns.has(record.turn)) return [record]
    const turnRecords = recordsByTurn.get(record.turn) ?? [record]
    if (record.cell.requestOnly === true || record.cell.kind === 'system') return [record]
    const contentRecords = turnRecords.filter(candidate =>
      candidate.cell.requestOnly !== true && candidate.cell.kind !== 'system')
    if (contentRecords.length <= 1) return [record]
    if (record.cell.index !== contentRecords[0]?.cell.index) return []
    return [
      { ...record, turnEnd: false },
      {
        ...record,
        groupStart: false,
        turnStart: false,
        turnEnd: true,
        collapsedSummary: summarizeTurn(contentRecords.slice(1)),
        collapsedSummaryKind: 'turn',
      },
    ]
  })
}

function assistantToolCalls(
  records: readonly TableRecord[],
  assistantIndex: number,
): readonly TableRecord[] {
  const at = records.findIndex(record => record.cell.index === assistantIndex)
  if (at === -1 || records[at]?.cell.kind !== 'message') return []
  const calls: TableRecord[] = []
  for (let i = at + 1; i < records.length; i++) {
    const record = records[i]
    if (record === undefined) break
    if (record.cell.kind !== 'tool' && record.cell.kind !== 'subtool') break
    calls.push(record)
  }
  return calls
}

function summarizeAssistantTools(records: readonly TableRecord[]): string {
  const names = [...new Set(records.map((record) => {
    const separator = record.cell.text.indexOf(' · ')
    return separator === -1 ? record.cell.text : record.cell.text.slice(0, separator)
  }).filter(name => name !== ''))]
  const count = records.length
  const summary = `${count} tool ${count === 1 ? 'call' : 'calls'}`
  return names.length > 0 ? `${summary} · ${names.join(', ')}` : summary
}

function collapseAssistantRecords(
  records: readonly TableRecord[],
  collapsedAssistants: ReadonlySet<number>,
): TableRecord[] {
  if (collapsedAssistants.size === 0) return [...records]
  const out: TableRecord[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (record === undefined) continue
    out.push(record)
    if (record.cell.kind !== 'message' || !collapsedAssistants.has(record.cell.index)) continue
    const calls: TableRecord[] = []
    for (let j = i + 1; j < records.length; j++) {
      const candidate = records[j]
      if (
        candidate === undefined
        || candidate.collapsedSummary !== undefined
        || (candidate.cell.kind !== 'tool' && candidate.cell.kind !== 'subtool')
      ) break
      calls.push(candidate)
    }
    if (calls.length === 0) continue
    const last = calls.at(-1)
    out[out.length - 1] = { ...record, turnEnd: false }
    out.push({
      ...record,
      groupStart: false,
      turnStart: false,
      turnEnd: last?.turnEnd ?? false,
      collapsedSummary: summarizeAssistantTools(calls),
      collapsedSummaryKind: 'assistant',
    })
    i += calls.length
  }
  return out
}

function stateOf(record: TableRecord): RecordState {
  if (record.cell.isError) return 'error'
  if (record.cell.kind === 'compacted' && record.cell.timeSeconds === null) return 'running'
  if (
    (record.cell.kind === 'tool' || record.cell.kind === 'subtool')
    && record.cell.outputDetail === undefined
  ) return 'running'
  return 'complete'
}

function statusLabel(state: RecordState): string {
  if (state === 'error') return 'Failed'
  if (state === 'running') return 'Pending'
  return 'Completed'
}

function TokenRows({ cell }: { cell: TrajectoryCellProps }) {
  const content = cell.output !== undefined && cell.think !== undefined
    ? Math.max(0, cell.output - cell.think)
    : undefined
  return (
    <>
      <div>
        <dt>Tokens</dt>
        <dd>{cell.output === undefined ? '—' : `${cell.output} tok`}</dd>
      </div>
      {cell.think !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>Reasoning</dt>
          <dd>{cell.think} tok</dd>
        </div>
      )}
      {content !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>Content</dt>
          <dd>{content} tok</dd>
        </div>
      )}
    </>
  )
}

function inputTotal(usage: TrajectoryUsage): number | undefined {
  if (
    usage.input === undefined
    && usage.cacheRead === undefined
    && usage.cacheWrite === undefined
  ) return undefined
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
}

function UsageRows({ usage }: { usage: TrajectoryUsage | undefined }) {
  if (usage === undefined) return <p className={css.noPayload}>Usage not reported</p>
  const totalInput = inputTotal(usage)
  const otherOutput = usage.output !== undefined && usage.reasoning !== undefined
    ? usage.output - usage.reasoning
    : undefined
  return (
    <dl className={css.overview}>
      {totalInput !== undefined && (
        <div><dt>Input</dt><dd>{totalInput} tok</dd></div>
      )}
      {usage.cacheRead !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>Cached</dt>
          <dd>{usage.cacheRead} tok</dd>
        </div>
      )}
      {usage.cacheWrite !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>Cache created</dt>
          <dd>{usage.cacheWrite} tok</dd>
        </div>
      )}
      {usage.input !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>Other</dt>
          <dd>{usage.input} tok</dd>
        </div>
      )}
      {usage.output !== undefined && (
        <div><dt>Output</dt><dd>{usage.output} tok</dd></div>
      )}
      {usage.reasoning !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>Reasoning</dt>
          <dd>{usage.reasoning} tok</dd>
        </div>
      )}
      {otherOutput !== undefined && (
        <div className={css.requestTokenDetail}>
          <dt>Content</dt>
          <dd>{otherOutput} tok</dd>
        </div>
      )}
    </dl>
  )
}

function RequestUsagePanel({
  usage,
  cumulative,
}: {
  usage: TrajectoryUsage | undefined
  cumulative: TrajectoryUsage | undefined
}) {
  return (
    <div className={css.usagePanel}>
      <section className={css.usageGroup}>
        <h4 className={css.usageHeading}>This request</h4>
        <UsageRows usage={usage} />
      </section>
      <section className={css.usageGroup}>
        <h4 className={css.usageHeading}>Session cumulative</h4>
        <UsageRows usage={cumulative} />
      </section>
    </div>
  )
}

function RequestOptions({
  options,
  preview = false,
}: {
  options: AssistantRequestConfig | undefined
  preview?: boolean
}) {
  if (options === undefined) {
    return <p className={css.noPayload}>Options not recorded</p>
  }
  return (
    <JsonTree
      data={options}
      label="Request options JSON"
      className={preview ? css.jsonPreview : css.jsonPayload}
    />
  )
}

function messageOriginLabel(source: unknown): string {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    return 'Unknown'
  }
  const properties = source as Record<string, unknown>
  const kind = properties.kind
  if (kind === 'user') return 'User'
  if (kind === 'plugin') {
    const plugin = properties.plugin
    return typeof plugin === 'string' && plugin !== ''
      ? `Plugin · ${plugin}`
      : 'Plugin'
  }
  if (kind === 'goal') {
    const round = properties.round
    return typeof round === 'number' && round > 0
      ? `Goal · Round ${round}`
      : 'Goal'
  }
  if (typeof kind !== 'string' || kind === '') return 'Unknown'
  return `${kind[0]?.toUpperCase() ?? ''}${kind.slice(1)}`
}

function MessageOrigin({ record }: { record: TableRecord }) {
  const source = record.cell.messageSource
  if (source === undefined) return <p className={css.noPayload}>Origin not recorded</p>
  const data = typeof source === 'object' && source !== null
    ? source
    : { value: source }
  return (
    <JsonTree
      data={data}
      label="Message origin JSON"
      className={css.jsonPayload}
    />
  )
}

function isMarkdownRecord(record: TableRecord): boolean {
  return record.cell.kind === 'user'
    || record.cell.kind === 'context'
    || record.cell.kind === 'message'
}

function parentRecords(
  records: readonly TableRecord[],
  record: TableRecord,
): ParentRecords {
  if (record.cell.kind !== 'tool' && record.cell.kind !== 'subtool') return {}
  const at = records.findIndex(candidate => candidate.cell.index === record.cell.index)
  if (at === -1) return {}
  let tool: TableRecord | undefined
  if (record.cell.kind === 'subtool') {
    for (let i = at - 1; i >= 0; i--) {
      const candidate = records[i]
      if (
        candidate === undefined
        || candidate.turn !== record.turn
        || candidate.group !== record.group
      ) break
      if (candidate.cell.kind === 'tool') {
        tool = candidate
        break
      }
    }
  }
  const parentCallId = tool?.cell.callId ?? record.cell.callId
  let message: TableRecord | undefined
  if (parentCallId !== undefined) {
    message = records.find(candidate =>
      candidate.turn === record.turn
      && candidate.cell.kind === 'message'
      && candidate.cell.sourceBlocks?.some(block => block.callId === parentCallId) === true,
    )
  }
  return { ...(message === undefined ? {} : { message }), ...(tool === undefined ? {} : { tool }) }
}

function markdownSource(record: TableRecord): string | undefined {
  if (record.cell.kind === 'user' || record.cell.kind === 'context') {
    return record.cell.inputDetail
  }
  if (record.cell.kind === 'message' || record.cell.kind === 'compacted') {
    return record.cell.outputDetail
  }
  return undefined
}

function detailTabs(record: TableRecord): readonly DetailTabItem[] {
  if (record.cell.kind === 'system') {
    return record.cell.previousPromptDetail === undefined
      ? SYSTEM_PROMPT_TABS
      : SYSTEM_UPDATE_TABS
  }
  if (record.cell.kind === 'compacted') {
    return [
      { id: 'overview', label: 'Summary' },
      { id: 'source', label: 'Raw Output' },
    ]
  }
  if (isMarkdownRecord(record)) {
    return [
      { id: 'overview', label: 'Summary' },
      { id: 'rendered', label: 'Preview' },
      { id: 'source', label: 'Source' },
      ...(record.cell.messageSource === undefined
        ? []
        : [{ id: 'origin', label: 'Origin' } as const]),
    ]
  }
  return [
    { id: 'overview', label: 'Summary' },
    ...(record.cell.inputDetail ? [{ id: 'input', label: 'Payload' } as const] : []),
    ...(record.cell.outputDetail ? [{ id: 'output', label: 'Result' } as const] : []),
    { id: 'schema', label: 'Schema' },
    { id: 'timing', label: 'Timing' },
  ]
}

function recordDisplayText(cell: TrajectoryCellProps): string {
  if (isToolCallOnly(cell)) return ''
  if (cell.text !== '') return cell.text
  const markdown = cell.kind === 'user' || cell.kind === 'context'
    ? cell.inputDetail
    : cell.kind === 'message'
      ? cell.outputDetail ?? cell.thinkingDetail
      : undefined
  return markdown === undefined ? '' : trajectoryPreviewText(markdown)
}

function toolCallTextParts(
  kind: TrajectoryCellKind,
  text: string,
): ToolCallTextParts | undefined {
  if (kind !== 'tool' && kind !== 'subtool') return undefined
  const separator = text.indexOf(' · ')
  if (separator === -1) return { name: text }
  return {
    name: text.slice(0, separator),
    args: text.slice(separator + 3),
  }
}

function isToolCallOnly(cell: TrajectoryCellProps): boolean {
  return cell.kind === 'message'
    && !cell.outputDetail
    && !cell.thinkingDetail
    && cell.text === 'Tool call only'
}

function MarkdownFragment({
  text,
  rendered,
  preview,
}: {
  text: string
  rendered: boolean
  preview: boolean
}) {
  if (rendered) {
    return (
      <div className={preview ? css.markdownPreview : css.markdownPayload}>
        <MarkdownText text={text} />
      </div>
    )
  }
  return (
    <pre className={`${css.payload} ${preview ? css.payloadPreview : ''}`}>
      {text}
    </pre>
  )
}

function SourceBlocks({
  blocks,
  onOpenCall,
}: {
  blocks: readonly TrajectorySourceBlock[]
  onOpenCall: (callId: string) => void
}) {
  return (
    <div className={css.sourceBlocks}>
      {blocks.map((block, index) => (
        <section className={css.sourceBlock} key={index}>
          {block.callId !== undefined
            ? (
              <button
                type="button"
                className={css.sourceBlockJumpTarget}
                aria-label={`Open Block #${index + 1} tool call summary`}
                title="Open tool call summary"
                onClick={() => {
                  if (block.callId !== undefined) onOpenCall(block.callId)
                }}
              >
                <span className={css.sourceBlockLabel}>
                  {`Block #${index + 1} ${block.type}`}
                </span>
                <IconChevronRightOutline14 className={css.sourceBlockJumpIcon} size={12} />
              </button>
            )
            : (
              <div className={css.sourceBlockHeader}>
                <span className={css.sourceBlockLabel}>
                  {`Block #${index + 1} ${block.type}`}
                </span>
              </div>
            )}
          {block.imageSrc !== undefined
            ? <PanelImage block={block} />
            : <pre className={css.sourceBlockContent}>{block.content}</pre>}
        </section>
      ))}
    </div>
  )
}

function PanelImage({
  block,
  preview = false,
}: {
  block: TrajectorySourceBlock
  preview?: boolean
}) {
  if (block.imageSrc === undefined) return null
  return (
    <a
      className={preview ? `${css.panelImageLink} ${css.panelImageLinkPreview}` : css.panelImageLink}
      href={block.imageSrc}
      target="_blank"
      rel="noopener noreferrer"
      title="Open image"
    >
      <img
        className={css.panelImage}
        src={block.imageSrc}
        alt={block.imageAlt ?? ''}
      />
    </a>
  )
}

function MessageImages({
  blocks,
  preview,
}: {
  blocks: readonly TrajectorySourceBlock[] | undefined
  preview: boolean
}) {
  const images = blocks?.filter(block => block.imageSrc !== undefined) ?? []
  if (images.length === 0) return null
  return (
    <div className={preview ? `${css.messageImages} ${css.messageImagesPreview}` : css.messageImages}>
      {images.map((block, index) => <PanelImage block={block} preview={preview} key={index} />)}
    </div>
  )
}

function AssistantToolCalls({
  blocks,
  preview,
  onOpenCall,
}: {
  blocks: readonly TrajectorySourceBlock[] | undefined
  preview: boolean
  onOpenCall: (callId: string) => void
}) {
  const calls = blocks?.filter(block => block.type === 'tool-call') ?? []
  if (calls.length === 0) return null
  return (
    <ul className={preview
      ? `${css.assistantToolCalls} ${css.assistantToolCallsPreview}`
      : css.assistantToolCalls}
    >
      {calls.map((call, index) => (
        <li key={call.callId ?? index}>
          <button
            type="button"
            className={css.assistantToolCallButton}
            title="Open tool call summary"
            onClick={() => {
              if (call.callId !== undefined) onOpenCall(call.callId)
            }}
          >
            <svg
              className={css.assistantToolCallIcon}
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className={css.assistantToolCallText}>
              <span className={css.assistantToolCallName}>
                {call.toolName ?? 'tool-call'}
              </span>
              {call.content !== '' && (
                <span className={css.assistantToolCallArgs}>{call.content}</span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function ToolGlyph() {
  return (
    <svg
      className={css.toolCatalogIcon}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ToolCatalog({ tools }: { tools: ConversationPromptSnapshot['tools'] }) {
  if (tools.length === 0) return <p className={css.noPayload}>No tools in this request</p>
  return (
    <div className={css.toolCatalog}>
      {tools.map((tool, index) => (
        <details className={css.toolCatalogItem} key={`${tool.name}:${index}`}>
          <summary className={css.toolCatalogSummary}>
            <IconChevronRightOutline14 className={css.toolCatalogChevron} size={12} />
            <ToolGlyph />
            <span className={css.toolCatalogName}>{tool.name}</span>
            <span className={css.toolCatalogDescription}>{tool.description}</span>
          </summary>
          <div className={css.toolCatalogDefinition}>
            {tool.description !== '' && (
              <p className={css.toolCatalogFullDescription}>{tool.description}</p>
            )}
            <JsonTree
              data={tool.parameters}
              label={`${tool.name} parameters JSON`}
              className={css.toolCatalogTree}
            />
          </div>
        </details>
      ))}
    </div>
  )
}

interface PromptDiffLine {
  kind: 'meta' | 'context' | 'added' | 'removed'
  text: string
}

function promptDiffLines(before: string, after: string): readonly PromptDiffLine[] {
  const patch = structuredPatch('', '', before, after, undefined, undefined, { context: 3 })
  return patch.hunks.flatMap((hunk, hunkIndex) => [
    ...(hunkIndex === 0 ? [] : [{ kind: 'meta' as const, text: '' }]),
    {
      kind: 'meta' as const,
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    },
    ...hunk.lines.flatMap((line): PromptDiffLine[] => {
      if (line.startsWith('\\')) return []
      if (line.startsWith('+')) return [{ kind: 'added', text: line }]
      if (line.startsWith('-')) return [{ kind: 'removed', text: line }]
      return [{ kind: 'context', text: line }]
    }),
  ])
}

function PromptDiffSection({
  title,
  before,
  after,
}: {
  title: string
  before: string
  after: string
}) {
  const lines = promptDiffLines(before, after)
  if (lines.length === 0) return null
  return (
    <section className={css.promptDiffSection}>
      <h3 className={css.promptDiffTitle}>{title}</h3>
      <pre className={css.promptDiff}>
        {lines.map((line, index) => (
          <span className={css[`promptDiffLine${line.kind}`]} key={index}>
            {line.text || ' '}
            {'\n'}
          </span>
        ))}
      </pre>
    </section>
  )
}

function SystemPromptDiff({
  before,
  after,
}: {
  before: ConversationPromptSnapshot
  after: ConversationPromptSnapshot
}) {
  const toolsBefore = JSON.stringify(before.tools, null, 2)
  const toolsAfter = JSON.stringify(after.tools, null, 2)
  return (
    <div className={css.promptDiffSections}>
      {before.system !== after.system && (
        <PromptDiffSection
          title="System Prompt"
          before={before.system}
          after={after.system}
        />
      )}
      {toolsBefore !== toolsAfter && (
        <PromptDiffSection
          title="Tools"
          before={toolsBefore}
          after={toolsAfter}
        />
      )}
    </div>
  )
}

function ToolOutputBlocks({
  blocks,
  error,
  preview,
}: {
  blocks: readonly TrajectorySourceBlock[]
  error: boolean
  preview: boolean
}) {
  return (
    <div className={[
      css.resultBlocks,
      preview ? css.resultBlocksPreview : undefined,
      error ? css.errorPayload : undefined,
    ].filter((value): value is string => value !== undefined).join(' ')}
    >
      {blocks.map((block, index) => (
        block.imageSrc !== undefined
          ? <PanelImage block={block} preview={preview} key={index} />
          : block.content !== ''
            ? <pre className={css.resultBlockText} key={index}>{block.content}</pre>
            : null
      ))}
    </div>
  )
}

function MarkdownRecordContent({
  record,
  rendered,
  preview = false,
  thinkingExpanded,
  onThinkingExpandedChange,
  onOpenCall,
}: {
  record: TableRecord
  rendered: boolean
  preview?: boolean
  thinkingExpanded: boolean
  onThinkingExpandedChange: (expanded: boolean) => void
  onOpenCall: (callId: string) => void
}) {
  if (!rendered && record.cell.sourceBlocks && record.cell.sourceBlocks.length > 0) {
    return <SourceBlocks blocks={record.cell.sourceBlocks} onOpenCall={onOpenCall} />
  }
  if (record.cell.thinkingDetail) {
    if (!rendered) {
      const source = [
        record.cell.thinkingDetail,
        record.cell.outputDetail,
      ].filter((value): value is string => value !== undefined && value !== '').join('\n\n')
      return <MarkdownFragment text={source} rendered={false} preview={preview} />
    }
    return (
      <div className={`${css.assistantContent} ${css.assistantContentRendered}`}>
        <div className={
          preview && !record.cell.outputDetail
            ? `${css.thinkingQuote} ${css.thinkingQuoteOnlyPreview}`
            : css.thinkingQuote
        }
        >
          <button
            type="button"
            className={css.thinkingToggle}
            aria-expanded={thinkingExpanded}
            onClick={() => { onThinkingExpandedChange(!thinkingExpanded) }}
          >
            Thinking
            <IconChevronRightOutline14 className={css.thinkingChevron} size={12} />
          </button>
          {thinkingExpanded && (
            <MarkdownFragment
              text={record.cell.thinkingDetail}
              rendered={rendered}
              preview={preview}
            />
          )}
        </div>
        {record.cell.outputDetail && (
          <div className={css.assistantOutput}>
            <MarkdownFragment
              text={record.cell.outputDetail}
              rendered={rendered}
              preview={preview}
            />
          </div>
        )}
        <AssistantToolCalls
          blocks={record.cell.sourceBlocks}
          preview={preview}
          onOpenCall={onOpenCall}
        />
        <MessageImages
          blocks={record.cell.sourceBlocks}
          preview={preview}
        />
      </div>
    )
  }
  const source = markdownSource(record)
  const hasImages = record.cell.sourceBlocks?.some(block => block.imageSrc !== undefined) === true
  const hasToolCalls = record.cell.kind === 'message'
    && record.cell.sourceBlocks?.some(block => block.type === 'tool-call') === true
  if (!source && !hasImages && !hasToolCalls) {
    const emptyLabel = isToolCallOnly(record.cell)
      ? 'Tool call only'
      : record.cell.text || 'No content'
    return <p className={css.noPayload}>{emptyLabel}</p>
  }
  if (!rendered || (!hasImages && !hasToolCalls)) {
    return <MarkdownFragment text={source ?? ''} rendered={rendered} preview={preview} />
  }
  return (
    <div>
      {source && <MarkdownFragment text={source} rendered preview={preview} />}
      {record.cell.kind === 'message' && (
        <AssistantToolCalls
          blocks={record.cell.sourceBlocks}
          preview={preview}
          onOpenCall={onOpenCall}
        />
      )}
      <MessageImages blocks={record.cell.sourceBlocks} preview={preview} />
    </div>
  )
}

function RecordTiming({ record }: { record: TableRecord }) {
  return record.cell.kind === 'message' && record.cell.assistantMetrics !== undefined
    ? <AssistantTimingPanel metrics={record.cell.assistantMetrics} />
    : (
      <dl className={css.overview}>
        <div><dt>Started</dt><StartedAtValue timestamp={record.cell.startedAt ?? null} /></div>
        <div><dt>Duration</dt><dd>{formatElapsedSeconds(record.cell.timeSeconds)}</dd></div>
        <div><dt>Timing source</dt><dd>{record.cell.timeSeconds === null ? 'Not available' : 'Session timestamps'}</dd></div>
      </dl>
    )
}

function RequestTiming({
  assistant,
  anchor,
  request,
}: {
  assistant: TableRecord | undefined
  anchor: TableRecord | undefined
  request: TrajectoryRequestNumber | undefined
}) {
  if (assistant !== undefined) return <RecordTiming record={assistant} />
  if (request?.startedAt !== undefined) {
    const duration = request.completedAt === null || request.completedAt === undefined
      ? null
      : Math.max(0, (request.completedAt - request.startedAt) / 1000)
    return (
      <dl className={css.overview}>
        <div><dt>Started</dt><StartedAtValue timestamp={request.startedAt} /></div>
        <div><dt>Duration</dt><dd>{formatElapsedSeconds(duration)}</dd></div>
        <div>
          <dt>Timing source</dt>
          <dd>{duration === null ? 'Session timestamps (running)' : 'Session timestamps'}</dd>
        </div>
      </dl>
    )
  }
  return (
    <dl className={css.overview}>
      <div>
        <dt>Started</dt>
        <StartedAtValue timestamp={anchor?.cell.startedAt ?? null} />
      </div>
      <div><dt>Duration</dt><dd>—</dd></div>
    </dl>
  )
}

function RecordPayload({
  record,
  direction,
  preview = false,
}: {
  record: TableRecord
  direction: 'input' | 'output'
  preview?: boolean
}) {
  const value = direction === 'input' ? record.cell.inputDetail : record.cell.outputDetail
  const missing = direction === 'input'
    ? 'No payload captured'
    : 'No result captured'
  if (!value) return <p className={css.noPayload}>{missing}</p>
  const error = direction === 'output' && record.cell.isError === true
  const payloadClass = preview ? css.jsonPreview : css.jsonPayload
  const payloadClassName = error ? `${payloadClass} ${css.errorPayload}` : payloadClass

  const json = parseJsonContainer(value)
  const singleTextResult = direction === 'output'
    && record.cell.outputBlocks?.length === 1
    && record.cell.outputBlocks[0]?.type === 'text'
  if (singleTextResult && json !== undefined) {
    return (
      <JsonTree
        data={json}
        label="Result JSON"
        className={payloadClassName}
      />
    )
  }

  if (
    direction === 'output'
    && record.cell.outputBlocks?.some(block =>
      block.imageSrc !== undefined || block.content !== '') === true
  ) {
    return (
      <ToolOutputBlocks
        blocks={record.cell.outputBlocks}
        error={error}
        preview={preview}
      />
    )
  }

  const markdown = (
    direction === 'input'
    && (record.cell.kind === 'user' || record.cell.kind === 'context')
  ) || (
    direction === 'output' && record.cell.kind === 'message'
  )
  if (markdown) {
    return (
      <div className={[
        preview ? css.markdownPreview : css.markdownPayload,
        error ? css.errorPayload : undefined,
      ].filter((className): className is string => className !== undefined).join(' ')}
      >
        <MarkdownText text={value} />
      </div>
    )
  }
  if (json !== undefined) {
    return (
      <JsonTree
        data={json}
        label={`${direction === 'input' ? 'Payload' : 'Result'} JSON`}
        className={payloadClassName}
      />
    )
  }
  return (
    <pre className={[
      css.payload,
      preview ? css.payloadPreview : undefined,
      error ? css.errorPayload : undefined,
      value === 'No output' ? css.noOutputText : undefined,
    ].filter((value): value is string => value !== undefined).join(' ')}
    >
      {value}
    </pre>
  )
}

function RecordSchema({
  record,
  preview = false,
}: {
  record: TableRecord
  preview?: boolean
}) {
  if (!record.cell.schemaDetail) {
    return <p className={css.noPayload}>Schema unavailable</p>
  }
  const schema = parseToolSchema(record.cell.schemaDetail)
  if (schema !== undefined) {
    return (
      <div className={preview ? `${css.schema} ${css.schemaPreview}` : css.schema}>
        <header className={css.schemaIntro}>
          <h3 className={css.schemaName}>{schema.name}</h3>
          <p className={css.schemaDescription}>{schema.description}</p>
        </header>
        <section className={css.schemaParameters}>
          <h4 className={css.schemaParametersTitle}>Parameters</h4>
          <JsonTree
            data={schema.parameters}
            label={`${schema.name} parameters JSON`}
            className={css.schemaTree}
          />
        </section>
      </div>
    )
  }
  return (
    <pre className={`${css.payload} ${preview ? css.payloadPreview : ''}`}>
      {record.cell.schemaDetail}
    </pre>
  )
}

interface ParsedToolSchema {
  name: string
  description: string
  parameters: object
}

function parseToolSchema(value: string): ParsedToolSchema | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const schema = parsed as Record<string, unknown>
    if (
      typeof schema.name !== 'string'
      || typeof schema.description !== 'string'
      || typeof schema.parameters !== 'object'
      || schema.parameters === null
      || Array.isArray(schema.parameters)
    ) return undefined
    return {
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
    }
  } catch {
    return undefined
  }
}

function parseJsonContainer(value: string): object | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

function OverviewSection({
  label,
  onOpen,
  children,
}: {
  label: string
  onOpen: () => void
  children: ReactNode
}) {
  return (
    <section className={css.overviewSection}>
      <h3 className={css.overviewHeading}>
        <button
          type="button"
          className={css.overviewTitle}
          onClick={onOpen}
        >
          <span>{label}</span>
          <IconChevronRightOutline14 className={css.overviewTitleIcon} size={12} />
        </button>
      </h3>
      <div className={css.overviewPreview}>{children}</div>
    </section>
  )
}

/**
 * Render trajectory events as a dense ledger with turn and step separators.
 * Clicking ledger whitespace clears the active record or request selection.
 * @param props - Grouped trajectory data and whole-ledger fold state.
 * @returns The ledger and an optional local record inspector.
 */
export function TrajectoryTable({
  requestNumbers: sessionRequestNumbers,
  turns,
  timelineFocusIndexes = null,
  searchMatchIndexes = null,
  onSelectedIndexChange,
  onRecordSelect,
  recordSelection = null,
  onClearSelection,
  collapsedTurns,
  onToggleTurn,
  collapsedAssistants,
  onToggleAssistant,
  inspectCallId = null,
  onInspectApplied,
}: TrajectoryTableProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [selectedRequest, setSelectedRequest] = useState<SelectedRequest | null>(null)
  const [activeTab, setActiveTab] = useState<DetailTab>('overview')
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const [detailsWidth, setDetailsWidth] = useState<number | null>(null)
  const [toolRequestOffset, setToolRequestOffset] = useState<number | null>(null)
  const detailsResizeDrag = useRef<DetailsResizeDrag | null>(null)
  const appliedRecordSelection = useRef<TrajectoryTableProps['recordSelection']>(null)
  const tabHistory = useRef<Set<DetailTab>>(new Set(['overview']))
  useEffect(() => {
    onSelectedIndexChange?.(selectedIndex)
  }, [onSelectedIndexChange, selectedIndex])
  const allRecords = useMemo(() => flattenRecords(turns), [turns])
  const requestNumbers = indexRequestNumbers(allRecords, sessionRequestNumbers)
  const records = searchMatchIndexes === null
    ? collapseAssistantRecords(
      collapseTurnRecords(allRecords, collapsedTurns),
      collapsedAssistants,
    )
    : filterRecords(allRecords, searchMatchIndexes)
  const requestBoundaryRuns = indexRequestBoundaryRuns(records)
  const selected = allRecords.find(record => record.cell.index === selectedIndex)
  const selectedPrompt = selected?.cell.kind === 'system'
    ? selected.cell.promptDetail
    : undefined
  const selectedPreviousPrompt = selected?.cell.kind === 'system'
    ? selected.cell.previousPromptDetail
    : undefined
  const promptSelected = selectedPrompt !== undefined
  const selectedState = selected === undefined ? undefined : stateOf(selected)
  const selectedRequestRecords = selectedRequest === null
    ? []
    : allRecords.filter(record =>
      record.turn === selectedRequest.turn
        && record.section === selectedRequest.section
        && record.group === selectedRequest.group,
    )
  const selectedRequestAssistant = selectedRequestRecords.find(
    record => record.cell.kind === 'message',
  )
  const selectedRequestAnchor = selectedRequestAssistant ?? selectedRequestRecords[0]
  const selectedRequestInfo = selectedRequest === null
    ? undefined
    : sessionRequestNumbers?.find(request => request.number === selectedRequest.number)
  const selectedRequestState: RecordState | undefined = selectedRequest === null
    ? undefined
    : selectedRequestInfo?.status
      ?? (selectedRequestAssistant?.cell.assistantMetrics?.completedTime === null
        ? 'running'
        : selectedRequestAssistant === undefined
          && selectedRequestRecords.some(record => stateOf(record) === 'running')
          ? 'running'
          : 'complete')
  const selectedRequestToolCalls = selectedRequestRecords.filter(
    record => record.cell.kind === 'tool',
  ).length
  const selectedRequestSubtoolCalls = selectedRequestRecords.filter(
    record => record.cell.kind === 'subtool',
  ).length
  const selectedRequestResult = selectedRequestInfo?.resultSeq === undefined
    ? selectedRequestAssistant
    : allRecords.find(record => record.cell.sourceSeq === selectedRequestInfo.resultSeq)
  const selectedRequestUsage = selectedRequestInfo?.usage ?? (
    selectedRequestAssistant === undefined
      ? undefined
      : {
        ...(selectedRequestAssistant.cell.input === undefined
          ? {}
          : { input: selectedRequestAssistant.cell.input }),
        ...(selectedRequestAssistant.cell.cacheRead === undefined
          ? {}
          : { cacheRead: selectedRequestAssistant.cell.cacheRead }),
        ...(selectedRequestAssistant.cell.cacheWrite === undefined
          ? {}
          : { cacheWrite: selectedRequestAssistant.cell.cacheWrite }),
        ...(selectedRequestAssistant.cell.output === undefined
          ? {}
          : { output: selectedRequestAssistant.cell.output }),
        ...(selectedRequestAssistant.cell.think === undefined
          ? {}
          : { reasoning: selectedRequestAssistant.cell.think }),
      }
  )
  const selectedRequestCumulativeUsage =
    selectedRequestInfo?.cumulativeUsage ?? selectedRequestUsage
  const selectedRequestOptions = selectedRequestInfo?.requestConfig
  const activeTurn = selectedRequest === null ? selected?.turn : selectedRequest.turn
  const activeSection = selectedRequest === null ? selected?.section : selectedRequest.section
  const selectedTabs = selectedRequest !== null
    ? REQUEST_TABS.filter(tab => tab.id !== 'options' || selectedRequestOptions !== undefined)
    : selected === undefined ? [] : detailTabs(selected)
  const selectedParents: ParentRecords = selected === undefined
    ? {}
    : parentRecords(allRecords, selected)
  const selectedParentMessage = selectedParents.message
  const selectedParentTool = selectedParents.tool
  const selectedAssistantRequest = selected?.cell.kind === 'message'
    ? requestNumbers.get(requestKey(selected.turn, selected.group))
    : undefined
  const selectedAssistantRequestTarget: SelectedRequest | undefined =
    selected !== undefined && selectedAssistantRequest !== undefined
      ? {
        turn: selected.turn,
        section: selected.section,
        number: selectedAssistantRequest,
        group: selected.group,
      }
      : undefined
  const hasSelectedHierarchy = selectedAssistantRequestTarget !== undefined
    || selectedParents.message !== undefined
    || selectedParents.tool !== undefined
  const splitStyle: TrajectorySplitStyle | undefined = toolRequestOffset === null
    ? undefined
    : {
      '--trajectory-tool-request-width': `calc(58cqw - ${toolRequestOffset}px)`,
    }

  const activateTab = (tab: DetailTab) => {
    tabHistory.current.delete(tab)
    tabHistory.current.add(tab)
    setActiveTab(tab)
  }

  const clearInspectorSelection = () => {
    setSelectedIndex(null)
    setSelectedRequest(null)
  }

  const clearAllSelections = () => {
    clearInspectorSelection()
    onClearSelection?.()
  }

  const selectRecord = useCallback((index: number) => {
    const record = allRecords.find(candidate => candidate.cell.index === index)
    onRecordSelect?.(index)
    setSelectedRequest(null)
    setSelectedIndex(index)
    if (record === undefined) return
    const tabs = detailTabs(record)
    const available = new Set(tabs.map(tab => tab.id))
    const recent = [...tabHistory.current].reverse().find(tab => available.has(tab))
    setActiveTab(recent ?? tabs[0]?.id ?? 'overview')
  }, [allRecords, onRecordSelect])
  useEffect(() => {
    if (
      recordSelection === null
      || appliedRecordSelection.current === recordSelection
    ) return
    appliedRecordSelection.current = recordSelection
    selectRecord(recordSelection.index)
  }, [recordSelection, selectRecord])

  const selectRequest = (
    request: SelectedRequest,
    tab: 'overview' | 'timing' = 'overview',
  ) => {
    setSelectedIndex(null)
    setSelectedRequest(request)
    activateTab(tab)
  }

  const openRecordSummary = (target: TableRecord) => {
    const targetAt = allRecords.findIndex(record => record.cell.index === target.cell.index)
    if (target.turn !== null && collapsedTurns.has(target.turn)) onToggleTurn(target.turn)
    if (target.cell.kind === 'tool' || target.cell.kind === 'subtool') {
      for (let i = targetAt - 1; i >= 0; i--) {
        const candidate = allRecords[i]
        if (candidate === undefined || candidate.turn !== target.turn) break
        if (candidate.cell.kind !== 'message') continue
        if (collapsedAssistants.has(candidate.cell.index)) onToggleAssistant(candidate.cell.index)
        break
      }
    }
    setSelectedRequest(null)
    setSelectedIndex(target.cell.index)
    activateTab('overview')
  }

  const openCallSummary = (callId: string) => {
    const target = allRecords.find(record => record.cell.callId === callId)
    if (target !== undefined) openRecordSummary(target)
  }

  // Cross-view inspect handoff: resolve the requested call to its record,
  // open its summary, and remember the row to scroll once the un-collapsed
  // ledger has rendered. Not-found leaves the request pending (`turns` in the
  // deps retries as history pages in); the ack clears the store field.
  const rootRef = useRef<HTMLDivElement>(null)
  const tablePaneRef = useRef<HTMLDivElement>(null)
  const followsTableTail = useRef(false)
  const tableScrollInitialized = useRef(false)
  const pendingScrollIndex = useRef<number | null>(null)
  const openRecordSummaryRef = useRef(openRecordSummary)
  openRecordSummaryRef.current = openRecordSummary
  useEffect(() => {
    if (inspectCallId === null) return
    const target = flattenRecords(turns).find(record => record.cell.callId === inspectCallId)
    if (target === undefined) return
    openRecordSummaryRef.current(target)
    pendingScrollIndex.current = target.cell.index
    onInspectApplied?.()
  }, [inspectCallId, turns, onInspectApplied])
  useEffect(() => {
    const index = pendingScrollIndex.current
    if (index === null) return
    const row = rootRef.current
      ?.querySelector<HTMLElement>(`tr[data-record-index="${index}"]`)
    if (row === undefined || row === null) return
    pendingScrollIndex.current = null
    /* v8 ignore next -- jsdom lacks scrollIntoView; browsers always have it. */
    if (typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  })
  useLayoutEffect(() => {
    const pane = tablePaneRef.current
    if (pane === null) return
    if (!tableScrollInitialized.current) {
      tableScrollInitialized.current = true
      followsTableTail.current =
        pane.scrollHeight - pane.clientHeight - pane.scrollTop
          <= BOTTOM_FOLLOW_THRESHOLD_PX
      return
    }
    if (followsTableTail.current) pane.scrollTop = pane.scrollHeight
  }, [turns])

  return (
    <div ref={rootRef} className={css.split} style={splitStyle}>
      <div
        ref={tablePaneRef}
        className={css.tablePane}
        onScroll={(event) => {
          const pane = event.currentTarget
          followsTableTail.current =
            pane.scrollHeight - pane.clientHeight - pane.scrollTop
              <= BOTTOM_FOLLOW_THRESHOLD_PX
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) clearAllSelections()
        }}
      >
        <table className={css.table}>
          <colgroup>
            <col className={css.eventColumn} />
            <col className={css.contentColumn} />
          </colgroup>
          <tbody>
            {records.map((record) => {
              const displayText = recordDisplayText(record.cell)
              const toolCallText = toolCallTextParts(record.cell.kind, displayText)
              const listDisplayText = toolCallText === undefined
                ? displayText
                : [toolCallText.name, toolCallText.args].filter(Boolean).join(' ')
              const isCollapsedSummary = record.collapsedSummary !== undefined
              const isRequestOnly = record.cell.requestOnly === true
              const isInitialSystem = record.cell.kind === 'system'
                && record.cell.index === allRecords[0]?.cell.index
              const request = record.groupStart
                && !isCollapsedSummary
                && (record.turn === null || !collapsedTurns.has(record.turn))
                ? requestNumbers.get(requestKey(record.turn, record.group))
                : undefined
              const requestInfo = request === undefined
                ? undefined
                : sessionRequestNumbers?.find(candidate => candidate.number === request)
              const requestStatus = requestInfo?.status
                ?? (record.cell.isError === true ? 'error' : undefined)
              const requestRunIndex = requestBoundaryRuns.get(record.cell.index) ?? 0
              const requestBoundaryStyle: RequestBoundaryStyle = {
                '--request-boundary-offset': `${requestRunIndex * 8}px`,
              }
              const requestLabel = request === undefined
                ? undefined
                : `Request #${request}${requestInfo?.purpose === 'compaction' ? ' · Compaction' : ''}`
              const requestSelected = request !== undefined
                && selectedRequest?.turn === record.turn
                && selectedRequest.section === record.section
                && selectedRequest.number === request
              const sectionActive = record.turn === null
                ? activeSection === record.section
                : activeTurn === record.turn
              return (
                <tr
                  key={`${record.cell.index}:${record.collapsedSummaryKind ?? 'record'}`}
                  tabIndex={isRequestOnly ? -1 : 0}
                  aria-label={isCollapsedSummary
                    ? `Collapsed ${record.collapsedSummaryKind} summary, ${record.collapsedSummary}`
                    : isRequestOnly
                      ? `Request ${request ?? ''}, compaction`
                      : `${request === undefined ? '' : `Request ${request}, `}${KIND_LABEL[record.cell.kind]}, ${listDisplayText || 'no content'}`}
                  aria-selected={!isCollapsedSummary && !isRequestOnly && selectedIndex === record.cell.index}
                  data-kind={record.cell.kind}
                  data-record-index={!isCollapsedSummary && !isRequestOnly
                    ? record.cell.index
                    : undefined}
                  data-request-only={isRequestOnly || undefined}
                  data-group-start={record.groupStart || undefined}
                  data-turn-start={record.turnStart || undefined}
                  data-error={record.cell.isError || undefined}
                  data-running={stateOf(record) === 'running' || undefined}
                  data-turn-end={record.turnEnd || undefined}
                  data-collapsed-summary={record.collapsedSummaryKind}
                  data-selected={!isCollapsedSummary && selectedIndex === record.cell.index || undefined}
                  data-timeline-focus={isCollapsedSummary || timelineFocusIndexes === null
                    ? undefined
                    : timelineFocusIndexes.has(record.cell.index) ? 'inside' : 'outside'}
                  onClick={isRequestOnly
                    ? undefined
                    : isCollapsedSummary
                      ? () => {
                        if (record.collapsedSummaryKind === 'turn' && record.turn !== null) {
                          onToggleTurn(record.turn)
                        } else onToggleAssistant(record.cell.index)
                      }
                      : () => { selectRecord(record.cell.index) }}
                  onDoubleClick={(event) => {
                    if (isCollapsedSummary || isRequestOnly) return
                    if (record.turn !== null && collapsedTurns.has(record.turn)) {
                      event.preventDefault()
                      onToggleTurn(record.turn)
                      return
                    }
                    if (
                      record.cell.kind === 'message'
                      && assistantToolCalls(allRecords, record.cell.index).length > 0
                    ) {
                      event.preventDefault()
                      onToggleAssistant(record.cell.index)
                      return
                    }
                    if (!record.turnStart) return
                    if (record.turn === null) return
                    if (allRecords.filter(candidate =>
                      candidate.turn === record.turn
                      && candidate.cell.requestOnly !== true
                      && candidate.cell.kind !== 'system').length <= 1) return
                    event.preventDefault()
                    onToggleTurn(record.turn)
                  }}
                  onKeyDown={(event) => {
                    if (isRequestOnly) return
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    if (isCollapsedSummary) {
                      if (record.collapsedSummaryKind === 'turn' && record.turn !== null) {
                        onToggleTurn(record.turn)
                      } else onToggleAssistant(record.cell.index)
                      return
                    }
                    selectRecord(record.cell.index)
                  }}
                >
                  <td className={css.event}>
                    {request !== undefined && (
                      <button
                        type="button"
                        className={requestSelected
                          ? `${css.requestBoundaryControl} ${css.requestBoundaryControlActive}`
                          : css.requestBoundaryControl}
                        aria-label={requestLabel}
                        aria-pressed={requestSelected}
                        data-label={requestLabel}
                        data-request-run-index={requestRunIndex}
                        data-request-status={requestStatus}
                        style={requestBoundaryStyle}
                        onClick={(event) => {
                          event.stopPropagation()
                          selectRequest({
                            turn: record.turn,
                            section: record.section,
                            number: request,
                            group: record.group,
                          })
                        }}
                        onDoubleClick={(event) => { event.stopPropagation() }}
                      />
                    )}
                    {record.turn !== null
                    && activeTurn === record.turn
                    && !isInitialSystem && (
                      <span className={css.turnRail} aria-hidden="true" />
                    )}
                    {!isCollapsedSummary && selectedIndex === record.cell.index && (
                      <span className={css.selectionRail} aria-hidden="true" />
                    )}
                    {!isCollapsedSummary
                    && !isRequestOnly
                    && record.turnStart && (
                      <span
                        className={sectionActive
                          ? `${css.turnLabel} ${css.turnLabelActive}`
                          : css.turnLabel}
                        aria-label={sectionLabel(record.turn)}
                      >
                        {record.turn === null
                          ? sectionLabel(record.turn)
                          : (
                            <>
                              <span className={css.turnLabelFull} aria-hidden="true">
                                {sectionLabel(record.turn)}
                              </span>
                              <span className={css.turnLabelCompact} aria-hidden="true">
                                #{record.turn}
                              </span>
                            </>
                          )}
                      </span>
                    )}
                    <div className={css.eventInner}>
                      {!isCollapsedSummary && !isRequestOnly && (
                        <span
                          className={css.kindSlot}
                        >
                          <span
                            className={`${css.kindTag} ${
                              record.cell.kind === 'system'
                                ? css.systemNeutral
                                : record.cell.kind === 'context'
                                  ? css.contextGreen
                                  : record.cell.kind === 'compacted'
                                    ? css.compacted
                                    : record.cell.kind === 'tool'
                                      ? css.toolAmber
                                      : record.cell.kind === 'message'
                                        ? css.assistantVioletBright
                                        : record.cell.kind === 'subtool'
                                          ? css.subtoolAmber
                                          : css[record.cell.kind]
                            }`}
                            data-role-kind={record.cell.kind}
                          >
                            <Tooltip
                              label={KIND_LABEL[record.cell.kind]}
                              side="right"
                            >
                              <span className={css.kindTagIcon} aria-hidden="true">
                                {KIND_ICON[record.cell.kind]}
                              </span>
                            </Tooltip>
                            <span className={css.kindTagLabel}>
                              {KIND_LABEL[record.cell.kind]}
                            </span>
                          </span>
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={css.content}>
                    {isRequestOnly
                      ? null
                      : record.collapsedSummary !== undefined
                        ? (
                          <span className={css.collapsedTurnContent} title={record.collapsedSummary}>
                            <span className={css.collapsedTurnEllipsis}>…</span>
                            <span className={css.collapsedTurnText}>{record.collapsedSummary}</span>
                          </span>
                        )
                        : (
                          <span
                            className={record.cell.result === undefined ? css.contentText : css.resultPreview}
                            title={record.cell.result === undefined
                              ? listDisplayText
                              : `${listDisplayText} → ${record.cell.result}`}
                          >
                            <span className={record.cell.result === undefined ? undefined : css.resultRequest}>
                              {isToolCallOnly(record.cell)
                                ? null
                                : toolCallText === undefined
                                  ? listDisplayText || '—'
                                  : (
                                    <>
                                      <span className={css.toolCallNameTypeface}>
                                        {toolCallText.name || '—'}
                                      </span>
                                      {toolCallText.args !== undefined && (
                                        <span className={css.toolCallPayload}>
                                          {toolCallText.args}
                                        </span>
                                      )}
                                    </>
                                  )}
                            </span>
                            {record.cell.result !== undefined && (
                              <span className={record.cell.isError ? `${css.inlineResult} ${css.error}` : css.inlineResult}>
                                <span className={css.arrow}>→</span>
                                <span className={record.cell.result === 'No output'
                                  ? `${css.inlineResultText} ${css.noOutputText}`
                                  : css.inlineResultText}
                                >
                                  {record.cell.result}
                                </span>
                              </span>
                            )}
                          </span>
                        )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {(selectedRequest !== null
        || promptSelected
        || (selected !== undefined && selectedState !== undefined)) && (
        <aside
          className={css.details}
          aria-label="Event details"
          style={detailsWidth === null ? undefined : { width: detailsWidth }}
        >
          <div
            className={css.detailsResizeHandle}
            role="separator"
            aria-label="Resize event details"
            aria-controls="trajectory-detail-panel"
            aria-orientation="vertical"
            tabIndex={0}
            title="Drag to resize. Double-click to reset."
            onDoubleClick={() => {
              setDetailsWidth(null)
              setToolRequestOffset(null)
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              const details = event.currentTarget.parentElement
              if (details === null) return
              const split = details.parentElement
              if (split === null) return
              const splitWidth = split.getBoundingClientRect().width
              detailsResizeDrag.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startWidth: details.getBoundingClientRect().width,
                splitWidth,
                startToolRequestOffset: toolRequestOffset ?? (
                  splitWidth * TOOL_REQUEST_SHARE - defaultToolRequestWidth(splitWidth)
                ),
              }
              event.currentTarget.setPointerCapture(event.pointerId)
              event.preventDefault()
            }}
            onPointerMove={(event) => {
              const drag = detailsResizeDrag.current
              if (drag === null || drag.pointerId !== event.pointerId) return
              const nextDetailsWidth = clampDetailsWidth(
                drag.startWidth + drag.startX - event.clientX,
                drag.splitWidth,
              )
              setDetailsWidth(nextDetailsWidth)
              setToolRequestOffset(
                drag.startToolRequestOffset
                + (nextDetailsWidth - drag.startWidth) * TOOL_REQUEST_SHARE,
              )
            }}
            onPointerUp={(event) => {
              if (detailsResizeDrag.current?.pointerId !== event.pointerId) return
              detailsResizeDrag.current = null
              event.currentTarget.releasePointerCapture(event.pointerId)
            }}
            onPointerCancel={() => {
              detailsResizeDrag.current = null
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              const details = event.currentTarget.parentElement
              if (details === null) return
              const split = details.parentElement
              if (split === null) return
              const direction = event.key === 'ArrowLeft' ? 1 : -1
              const currentDetailsWidth = details.getBoundingClientRect().width
              const splitWidth = split.getBoundingClientRect().width
              const nextDetailsWidth = clampDetailsWidth(
                currentDetailsWidth + direction * DETAILS_RESIZE_STEP,
                splitWidth,
              )
              const currentToolRequestOffset = toolRequestOffset ?? (
                splitWidth * TOOL_REQUEST_SHARE - defaultToolRequestWidth(splitWidth)
              )
              setDetailsWidth(nextDetailsWidth)
              setToolRequestOffset(
                currentToolRequestOffset
                + (nextDetailsWidth - currentDetailsWidth) * TOOL_REQUEST_SHARE,
              )
              event.preventDefault()
            }}
          />
          <div className={css.detailsHeader}>
            <div className={css.detailsTitle}>
              {selectedRequest !== null
                ? (
                  <>
                    <span className={css.requestDetailsDot} aria-hidden="true" />
                    <span className={css.requestDetailsName}>
                      Request #{selectedRequest.number}
                    </span>
                    <span className={css.detailsLocation}>
                      {selectedRequestInfo?.purpose === 'compaction'
                        ? `Compaction · ${sectionLabel(selectedRequest.turn)}`
                        : sectionLabel(selectedRequest.turn)}
                    </span>
                  </>
                )
                : promptSelected
                  ? (
                    <>
                      <span className={`${css.kindTag} ${css.systemNeutral}`}>SYSTEM</span>
                      <span className={css.detailsLocation}>{selected?.cell.text}</span>
                    </>
                  )
                  : selected !== undefined && (
                    <>
                      <span className={`${css.kindTag} ${
                        selected.cell.kind === 'context'
                          ? css.contextGreen
                          : selected.cell.kind === 'compacted'
                            ? css.compacted
                            : selected.cell.kind === 'tool'
                              ? css.toolAmber
                              : selected.cell.kind === 'message'
                                ? css.assistantVioletBright
                                : selected.cell.kind === 'subtool'
                                  ? css.subtoolAmber
                                  : css[selected.cell.kind]
                      }`}
                      >
                        {KIND_LABEL[selected.cell.kind]}
                      </span>
                      <span className={css.detailsLocation}>
                        {selected.cell.kind === 'compacted'
                          ? sectionLabel(selected.turn)
                          : `${sectionLabel(selected.turn)} · ${selected.group}`}
                      </span>
                    </>
                  )}
            </div>
            <button
              type="button"
              className={css.close}
              aria-label="Close details"
              onClick={clearInspectorSelection}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <div className={css.detailTabs} role="tablist" aria-label="Event details">
            {selectedTabs.map(tab => (
              <button
                key={tab.id}
                id={`trajectory-detail-${tab.id}`}
                type="button"
                role="tab"
                aria-controls="trajectory-detail-panel"
                aria-selected={activeTab === tab.id}
                className={activeTab === tab.id ? `${css.detailTab} ${css.detailTabActive}` : css.detailTab}
                onClick={() => { activateTab(tab.id) }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div
            id="trajectory-detail-panel"
            className={activeTab === 'overview'
              ? `${css.detailBody} ${css.detailBodySummary}`
              : css.detailBody}
            role="tabpanel"
            aria-labelledby={`trajectory-detail-${activeTab}`}
          >
            {selectedRequest !== null
              && selectedRequestState !== undefined
              && activeTab === 'overview' && (
              <>
                <dl className={css.overview}>
                  <div>
                    <dt>Status</dt>
                    <dd className={selectedRequestState === 'error' ? css.error : undefined}>
                      {statusLabel(selectedRequestState)}
                    </dd>
                  </div>
                  {selectedRequestInfo?.purpose === 'compaction' && (
                    <div>
                      <dt>Purpose</dt>
                      <dd>Compaction</dd>
                    </div>
                  )}
                  {(selectedRequestInfo?.provider
                    ?? selectedRequestInfo?.requestConfig?.provider) !== undefined && (
                    <div>
                      <dt>Provider</dt>
                      <dd>
                        {selectedRequestInfo?.provider
                          ?? selectedRequestInfo?.requestConfig?.provider}
                      </dd>
                    </div>
                  )}
                  {(selectedRequestInfo?.model
                    ?? selectedRequestInfo?.requestConfig?.model) !== undefined && (
                    <div>
                      <dt>Model</dt>
                      <dd>
                        {selectedRequestInfo?.model
                          ?? selectedRequestInfo?.requestConfig?.model}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Tool calls</dt>
                    <dd>{selectedRequestToolCalls}</dd>
                  </div>
                  {selectedRequestSubtoolCalls > 0 && (
                    <div>
                      <dt>Subtool calls</dt>
                      <dd>{selectedRequestSubtoolCalls}</dd>
                    </div>
                  )}
                  {selectedRequestInfo?.error !== undefined && (
                    <div>
                      <dt>Error</dt>
                      <dd className={css.error}>{selectedRequestInfo.error}</dd>
                    </div>
                  )}
                  {selectedRequestInfo?.retry !== undefined && (
                    <div>
                      <dt>Retry</dt>
                      <dd>
                        Scheduled {selectedRequestInfo.retry}
                        {selectedRequestInfo.maxRetries === undefined
                          ? ''
                          : ` of ${selectedRequestInfo.maxRetries}`}
                      </dd>
                    </div>
                  )}
                  {selectedRequestInfo?.retryDelayMs !== undefined && (
                    <div>
                      <dt>Retry delay</dt>
                      <dd>{formatDurationMs(selectedRequestInfo.retryDelayMs)}</dd>
                    </div>
                  )}
                  {selectedRequestResult !== undefined && (
                    <div>
                      <dt>Result</dt>
                      <dd className={css.overviewParentLinks}>
                        <button
                          type="button"
                          className={css.overviewHierarchyNavLink}
                          onClick={() => {
                            openRecordSummary(selectedRequestResult)
                          }}
                        >
                          <span>
                            {selectedRequestInfo?.purpose === 'compaction'
                              ? 'Compacted'
                              : 'Assistant Message'}
                          </span>
                          <IconChevronRightOutline14
                            className={css.overviewHierarchyJumpIconTight}
                            size={11}
                          />
                        </button>
                      </dd>
                    </div>
                  )}
                </dl>
                <div className={css.overviewSections}>
                  {selectedRequestOptions !== undefined && (
                    <OverviewSection label="Options" onOpen={() => { activateTab('options') }}>
                      <RequestOptions options={selectedRequestOptions} preview />
                    </OverviewSection>
                  )}
                  <OverviewSection label="Usage" onOpen={() => { activateTab('usage') }}>
                    <UsageRows usage={selectedRequestUsage} />
                  </OverviewSection>
                  <OverviewSection label="Timing" onOpen={() => { activateTab('timing') }}>
                    <RequestTiming
                      assistant={selectedRequestAssistant}
                      anchor={selectedRequestAnchor}
                      request={selectedRequestInfo}
                    />
                  </OverviewSection>
                </div>
              </>
            )}
            {selectedRequest !== null && activeTab === 'options' && (
              <RequestOptions options={selectedRequestOptions} />
            )}
            {selectedRequest !== null && activeTab === 'usage' && (
              <RequestUsagePanel
                usage={selectedRequestUsage}
                cumulative={selectedRequestCumulativeUsage}
              />
            )}
            {selectedRequest !== null && activeTab === 'timing' && (
              <RequestTiming
                assistant={selectedRequestAssistant}
                anchor={selectedRequestAnchor}
                request={selectedRequestInfo}
              />
            )}
            {promptSelected
              && selectedPreviousPrompt !== undefined
              && activeTab === 'diff' && (
              <SystemPromptDiff
                before={selectedPreviousPrompt}
                after={selectedPrompt}
              />
            )}
            {promptSelected && activeTab === 'system-prompt' && (
              selectedPrompt.system === ''
                ? <p className={css.noPayload}>No system prompt in this request</p>
                : (
                  <div className={`${css.markdownPayload} ${css.systemPrompt}`}>
                    <MarkdownText text={selectedPrompt.system} />
                  </div>
                )
            )}
            {promptSelected && activeTab === 'tools' && (
              <ToolCatalog tools={selectedPrompt.tools} />
            )}
            {!promptSelected
              && selected?.cell.kind === 'compacted'
              && selectedState !== undefined
              && activeTab === 'overview' && (
              <>
                <dl className={css.overview}>
                  <div>
                    <dt>Status</dt>
                    <dd className={selectedState === 'error' ? css.error : undefined}>
                      {statusLabel(selectedState)}
                    </dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>{formatElapsedSeconds(selected.cell.timeSeconds)}</dd>
                  </div>
                  <div>
                    <dt>Tokens</dt>
                    <dd>—</dd>
                  </div>
                </dl>
                {selected.cell.outputDetail !== undefined && (
                  <div className={css.compactedSummary}>
                    <MarkdownRecordContent
                      record={selected}
                      rendered
                      thinkingExpanded={thinkingExpanded}
                      onThinkingExpandedChange={setThinkingExpanded}
                      onOpenCall={openCallSummary}
                    />
                  </div>
                )}
              </>
            )}
            {!promptSelected
              && selected !== undefined
              && selected.cell.kind !== 'compacted'
              && selectedState !== undefined
              && activeTab === 'overview' && (
              <>
                <dl className={css.overview}>
                  {selected.cell.messageSource !== undefined && (
                    <div>
                      <dt>Origin</dt>
                      <dd className={css.overviewParentLinks}>
                        <button
                          type="button"
                          className={css.overviewHierarchyNavLink}
                          onClick={() => { activateTab('origin') }}
                        >
                          <span>{messageOriginLabel(selected.cell.messageSource)}</span>
                          <IconChevronRightOutline14
                            className={css.overviewHierarchyJumpIconTight}
                            size={11}
                          />
                        </button>
                      </dd>
                    </div>
                  )}
                  {hasSelectedHierarchy && (
                    <div>
                      <dt>
                        {selectedAssistantRequestTarget !== undefined
                          ? 'Origin'
                          : 'Hierarchy'}
                      </dt>
                      <dd className={css.overviewParentLinks}>
                        {selectedAssistantRequestTarget !== undefined && (
                          <button
                            type="button"
                            className={css.overviewHierarchyNavLink}
                            onClick={() => {
                              selectRequest(selectedAssistantRequestTarget)
                            }}
                          >
                            <span>Request #{selectedAssistantRequestTarget.number}</span>
                            <IconChevronRightOutline14
                              className={css.overviewHierarchyJumpIconTight}
                              size={11}
                            />
                          </button>
                        )}
                        {selectedParentMessage !== undefined && (
                          <button
                            type="button"
                            className={css.overviewHierarchyNavLink}
                            onClick={() => { openRecordSummary(selectedParentMessage) }}
                          >
                            <span>Assistant Message</span>
                            <IconChevronRightOutline14
                              className={css.overviewHierarchyJumpIconTight}
                              size={11}
                            />
                          </button>
                        )}
                        {selectedParentTool !== undefined && (
                          <button
                            type="button"
                            className={css.overviewHierarchyNavLink}
                            onClick={() => { openRecordSummary(selectedParentTool) }}
                          >
                            <span>Tool Call</span>
                            <IconChevronRightOutline14
                              className={css.overviewHierarchyJumpIconTight}
                              size={11}
                            />
                          </button>
                        )}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Status</dt>
                    <dd className={selectedState === 'error' ? css.error : undefined}>
                      {statusLabel(selectedState)}
                    </dd>
                  </div>
                  {selected.cell.kind === 'message' && (
                    <TokenRows cell={selected.cell} />
                  )}
                  {(selected.cell.kind === 'user' || selected.cell.kind === 'context') && (
                    <div>
                      <dt>Duration</dt>
                      <dd>{formatElapsedSeconds(selected.cell.timeSeconds)}</dd>
                    </div>
                  )}
                </dl>
                <div className={css.overviewSections}>
                  {isMarkdownRecord(selected)
                    ? (
                      <>
                        <OverviewSection label="Preview" onOpen={() => { activateTab('rendered') }}>
                          <MarkdownRecordContent
                            record={selected}
                            rendered
                            preview
                            thinkingExpanded={thinkingExpanded}
                            onThinkingExpandedChange={setThinkingExpanded}
                            onOpenCall={openCallSummary}
                          />
                        </OverviewSection>
                      </>
                    )
                    : (
                      <>
                        {selected.cell.inputDetail && (
                          <OverviewSection label="Payload" onOpen={() => { activateTab('input') }}>
                            <RecordPayload record={selected} direction="input" preview />
                          </OverviewSection>
                        )}
                        {selected.cell.outputDetail && (
                          <OverviewSection label="Result" onOpen={() => { activateTab('output') }}>
                            <RecordPayload record={selected} direction="output" preview />
                          </OverviewSection>
                        )}
                        <OverviewSection label="Schema" onOpen={() => { activateTab('schema') }}>
                          <RecordSchema record={selected} preview />
                        </OverviewSection>
                      </>
                    )}
                  {selectedAssistantRequestTarget !== undefined && (
                    <OverviewSection
                      label="Request Timing"
                      onOpen={() => {
                        selectRequest(selectedAssistantRequestTarget, 'timing')
                      }}
                    >
                      <RecordTiming record={selected} />
                    </OverviewSection>
                  )}
                  {(selected.cell.kind === 'tool' || selected.cell.kind === 'subtool') && (
                    <OverviewSection label="Timing" onOpen={() => { activateTab('timing') }}>
                      <RecordTiming record={selected} />
                    </OverviewSection>
                  )}
                </div>
              </>
            )}
            {!promptSelected && selected !== undefined && activeTab === 'rendered' && (
              <MarkdownRecordContent
                record={selected}
                rendered
                thinkingExpanded={thinkingExpanded}
                onThinkingExpandedChange={setThinkingExpanded}
                onOpenCall={openCallSummary}
              />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'source' && (
              <MarkdownRecordContent
                record={selected}
                rendered={false}
                thinkingExpanded={thinkingExpanded}
                onThinkingExpandedChange={setThinkingExpanded}
                onOpenCall={openCallSummary}
              />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'origin' && (
              <MessageOrigin record={selected} />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'input' && (
              <RecordPayload record={selected} direction="input" />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'output' && (
              <RecordPayload record={selected} direction="output" />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'schema' && (
              <RecordSchema record={selected} />
            )}
            {!promptSelected && selected !== undefined && activeTab === 'timing' && (
              <RecordTiming record={selected} />
            )}
          </div>
        </aside>
      )}
    </div>
  )
}
