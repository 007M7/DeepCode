/** Turn-aware trajectory event ledger with a local record inspector. */

import { useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  extractMarkdownPlainText, IconChevronRightOutline14, JsonTree, MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AssistantMetricDetail, TrajectoryCellKind, TrajectoryCellProps, TrajectorySourceBlock,
} from './trajectory-record.ts'
import { formatElapsedSeconds } from './trajectory-record.ts'
import type { TrajectoryTurnModel } from './layout.ts'
import css from './TrajectoryTable.module.css'

const KIND_LABEL: Record<TrajectoryCellKind, string> = {
  user: 'USER',
  message: 'ASSISTANT',
  tool: 'TOOL',
  subtool: 'SUBTOOL',
}

interface TableRecord {
  turn: number
  group: string
  groupStart: boolean
  turnStart: boolean
  cell: TrajectoryCellProps
  turnEnd: boolean
  collapsedSummary?: string
  collapsedSummaryKind?: 'turn' | 'assistant'
}

type DetailTab = 'overview' | 'rendered' | 'source' | 'input' | 'output' | 'schema' | 'timing'
type RecordState = 'complete' | 'running' | 'error'

interface DetailTabItem {
  id: DetailTab
  label: string
}

interface ParentRecords {
  message?: TableRecord
  tool?: TableRecord
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

type TrajectorySplitStyle = CSSProperties & {
  '--trajectory-tool-request-width': string
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

function formatStartedAt(timestamp: number | null): { label: string; title?: string } {
  if (timestamp === null || !Number.isFinite(timestamp)) return { label: 'Not available' }
  const date = new Date(timestamp)
  const two = (value: number) => String(value).padStart(2, '0')
  const three = (value: number) => String(value).padStart(3, '0')
  const time = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${three(date.getMilliseconds())}`
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
  return { label: time, title: `${day} ${time}` }
}

function StartedAtValue({ timestamp }: { timestamp: number | null }) {
  const formatted = formatStartedAt(timestamp)
  return <dd title={formatted.title}>{formatted.label}</dd>
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
      <div>
        <dt>Output tokens</dt>
        <dd>
          {!metrics.usageProvided
            ? 'Usage unavailable'
            : metrics.outputTokens ?? 'Output tokens unavailable'}
        </dd>
      </div>
    </dl>
  )
}

/** Props for the trajectory ledger. */
export interface TrajectoryTableProps {
  /** Grouped records in display order. */
  turns: readonly TrajectoryTurnModel[]
  /** Turn ids whose rows after the first are folded into a summary. */
  collapsedTurns: ReadonlySet<number>
  /** Toggle one turn between folded and expanded. */
  onToggleTurn(turn: number): void
  /** Assistant record indexes whose tool calls are folded. */
  collapsedAssistants: ReadonlySet<number>
  /** Toggle tool calls under one assistant record. */
  onToggleAssistant(index: number): void
}

function flattenRecords(turns: readonly TrajectoryTurnModel[]): TableRecord[] {
  return turns.flatMap((turn) => {
    let firstInTurn = true
    const records = turn.groups.flatMap((group) => {
      return group.cells.map((cell, index) => {
        const turnStart = firstInTurn && index === 0
        if (turnStart) firstInTurn = false
        return {
          turn: turn.turn,
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

function summarizeTurn(records: readonly TableRecord[]): string {
  const userText = records
    .filter(record => record.cell.kind === 'user')
    .map(record => recordDisplayText(record.cell))
    .find(text => text !== '')
  const assistantText = records
    .filter(record => record.cell.kind === 'message')
    .map(record => recordDisplayText(record.cell))
    .find(text => text !== '')
  const steps = new Set(
    records
      .map(record => record.group)
      .filter(group => group.startsWith('Step ')),
  ).size
  const toolCalls = records.filter(record =>
    record.cell.kind === 'tool' || record.cell.kind === 'subtool',
  ).length
  const parts: string[] = []
  const message = userText ?? assistantText
  if (message !== undefined) parts.push(message)
  parts.push(
    `${steps} ${steps === 1 ? 'step' : 'steps'}`,
    `${toolCalls} tool ${toolCalls === 1 ? 'call' : 'calls'}`,
  )
  return parts.join(' · ')
}

function collapseTurnRecords(
  records: readonly TableRecord[],
  collapsedTurns: ReadonlySet<number>,
): TableRecord[] {
  if (collapsedTurns.size === 0) return [...records]
  const recordsByTurn = new Map<number, TableRecord[]>()
  for (const record of records) {
    const turnRecords = recordsByTurn.get(record.turn) ?? []
    turnRecords.push(record)
    recordsByTurn.set(record.turn, turnRecords)
  }
  return records.flatMap((record) => {
    if (!collapsedTurns.has(record.turn)) return [record]
    const turnRecords = recordsByTurn.get(record.turn) ?? [record]
    if (turnRecords.length <= 1) return [record]
    if (!record.turnStart) return []
    return [
      { ...record, turnEnd: false },
      {
        ...record,
        groupStart: false,
        turnStart: false,
        turnEnd: true,
        collapsedSummary: summarizeTurn(turnRecords.slice(1)),
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

function tokenSummary(cell: TrajectoryCellProps): string {
  if (cell.kind !== 'message') return '—'
  return `${cell.input ?? '—'} / ${cell.output ?? '—'} / ${cell.think ?? '—'}`
}

function isMarkdownRecord(record: TableRecord): boolean {
  return record.cell.kind === 'user' || record.cell.kind === 'message'
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
  if (record.cell.kind === 'user') return record.cell.inputDetail
  if (record.cell.kind === 'message') return record.cell.outputDetail
  return undefined
}

function detailTabs(record: TableRecord): readonly DetailTabItem[] {
  if (isMarkdownRecord(record)) {
    return [
      { id: 'overview', label: 'Summary' },
      { id: 'rendered', label: 'Preview' },
      { id: 'source', label: 'Source' },
      { id: 'timing', label: 'Timing' },
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
  const markdown = cell.kind === 'user'
    ? cell.inputDetail
    : cell.kind === 'message'
      ? cell.outputDetail ?? cell.thinkingDetail
      : undefined
  if (!markdown) return cell.text
  const plainText = extractMarkdownPlainText(markdown)
  return plainText.replace(/\s+/g, ' ').trim()
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
  onOpenCall(callId: string): void
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
  onOpenCall(callId: string): void
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

function ToolOutputBlocks({
  blocks,
  preview,
}: {
  blocks: readonly TrajectorySourceBlock[]
  preview: boolean
}) {
  return (
    <div className={preview ? `${css.resultBlocks} ${css.resultBlocksPreview}` : css.resultBlocks}>
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
  onThinkingExpandedChange(expanded: boolean): void
  onOpenCall(callId: string): void
}) {
  if (!rendered && record.cell.sourceBlocks && record.cell.sourceBlocks.length > 0) {
    return <SourceBlocks blocks={record.cell.sourceBlocks} onOpenCall={onOpenCall} />
  }
  if (record.cell.kind === 'message' && record.cell.thinkingDetail) {
    if (!rendered) {
      const source = [
        record.cell.thinkingDetail,
        record.cell.outputDetail,
      ].filter((value): value is string => value !== undefined && value !== '').join('\n\n')
      return <MarkdownFragment text={source} rendered={false} preview={preview} />
    }
    return (
      <div className={rendered
        ? `${css.assistantContent} ${css.assistantContentRendered}`
        : css.assistantContent}
      >
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
            {thinkingExpanded ? 'Thinking' : 'Thinking ...'}
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

  if (direction === 'output' && record.cell.outputBlocks && record.cell.outputBlocks.length > 0) {
    return (
      <ToolOutputBlocks
        blocks={record.cell.outputBlocks}
        preview={preview}
      />
    )
  }

  const markdown = (
    direction === 'input' && record.cell.kind === 'user'
  ) || (
    direction === 'output' && record.cell.kind === 'message'
  )
  if (markdown) {
    return (
      <div className={preview ? css.markdownPreview : css.markdownPayload}>
        <MarkdownText text={value} />
      </div>
    )
  }
  const json = parseJsonContainer(value)
  if (json !== undefined) {
    return (
      <JsonTree
        data={json}
        label={`${direction === 'input' ? 'Payload' : 'Result'} JSON`}
        className={preview ? css.jsonPreview! : css.jsonPayload!}
      />
    )
  }
  return (
    <pre className={[
      css.payload,
      preview ? css.payloadPreview : undefined,
      record.cell.isError ? css.error : undefined,
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
  onOpen(): void
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
 * @param props - Grouped trajectory data and whole-ledger fold state.
 * @returns The ledger and an optional local record inspector.
 */
export function TrajectoryTable({
  turns,
  collapsedTurns,
  onToggleTurn,
  collapsedAssistants,
  onToggleAssistant,
}: TrajectoryTableProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<DetailTab>('overview')
  const [thinkingExpanded, setThinkingExpanded] = useState(true)
  const [detailsWidth, setDetailsWidth] = useState<number | null>(null)
  const [toolRequestOffset, setToolRequestOffset] = useState<number | null>(null)
  const detailsResizeDrag = useRef<DetailsResizeDrag | null>(null)
  const tabHistory = useRef<Set<DetailTab>>(new Set(['overview']))
  const allRecords = flattenRecords(turns)
  const turnRecords = collapseTurnRecords(allRecords, collapsedTurns)
  const records = collapseAssistantRecords(turnRecords, collapsedAssistants)
  const selected = allRecords.find(record => record.cell.index === selectedIndex)
  const selectedState = selected === undefined ? undefined : stateOf(selected)
  const selectedTabs = selected === undefined ? [] : detailTabs(selected)
  const selectedParents: ParentRecords = selected === undefined
    ? {}
    : parentRecords(allRecords, selected)
  const hasSelectedParents = selectedParents.message !== undefined
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

  const selectRecord = (index: number) => {
    const record = allRecords.find(candidate => candidate.cell.index === index)
    setSelectedIndex(index)
    if (record === undefined) return
    const available = new Set(detailTabs(record).map(tab => tab.id))
    const recent = [...tabHistory.current].reverse().find(tab => available.has(tab))
    setActiveTab(recent ?? 'overview')
  }

  const openRecordSummary = (target: TableRecord) => {
    const targetAt = allRecords.findIndex(record => record.cell.index === target.cell.index)
    if (collapsedTurns.has(target.turn)) onToggleTurn(target.turn)
    if (target.cell.kind === 'tool' || target.cell.kind === 'subtool') {
      for (let i = targetAt - 1; i >= 0; i--) {
        const candidate = allRecords[i]
        if (candidate === undefined || candidate.turn !== target.turn) break
        if (candidate.cell.kind !== 'message') continue
        if (collapsedAssistants.has(candidate.cell.index)) onToggleAssistant(candidate.cell.index)
        break
      }
    }
    setSelectedIndex(target.cell.index)
    activateTab('overview')
  }

  const openCallSummary = (callId: string) => {
    const target = allRecords.find(record => record.cell.callId === callId)
    if (target !== undefined) openRecordSummary(target)
  }

  return (
    <div className={css.split} style={splitStyle}>
      <div className={css.tablePane}>
        <table className={css.table}>
          <colgroup>
            <col className={css.eventColumn} />
            <col className={css.contentColumn} />
          </colgroup>
          <tbody>
            {records.map((record) => {
              const displayText = recordDisplayText(record.cell)
              const isCollapsedSummary = record.collapsedSummary !== undefined
              return (
                <tr
                  key={`${record.cell.index}:${record.collapsedSummaryKind ?? 'record'}`}
                  tabIndex={0}
                  aria-label={isCollapsedSummary
                    ? `Collapsed ${record.collapsedSummaryKind} summary, ${record.collapsedSummary}`
                    : `${KIND_LABEL[record.cell.kind]}, ${displayText || 'no content'}`}
                  aria-selected={!isCollapsedSummary && selectedIndex === record.cell.index}
                  data-kind={record.cell.kind}
                  data-group-start={record.groupStart || undefined}
                  data-turn-start={record.turnStart || undefined}
                  data-error={record.cell.isError || undefined}
                  data-running={stateOf(record) === 'running' || undefined}
                  data-turn-end={record.turnEnd || undefined}
                  data-collapsed-summary={record.collapsedSummaryKind}
                  data-selected={!isCollapsedSummary && selectedIndex === record.cell.index || undefined}
                  onClick={isCollapsedSummary
                    ? () => {
                        if (record.collapsedSummaryKind === 'turn') onToggleTurn(record.turn)
                        else onToggleAssistant(record.cell.index)
                      }
                    : () => { selectRecord(record.cell.index) }}
                  onDoubleClick={(event) => {
                    if (isCollapsedSummary) return
                    if (collapsedTurns.has(record.turn)) {
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
                    if (allRecords.filter(candidate => candidate.turn === record.turn).length <= 1) return
                    event.preventDefault()
                    onToggleTurn(record.turn)
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    if (isCollapsedSummary) {
                      if (record.collapsedSummaryKind === 'turn') onToggleTurn(record.turn)
                      else onToggleAssistant(record.cell.index)
                      return
                    }
                    selectRecord(record.cell.index)
                  }}
                >
                <td className={css.event}>
                  {selected?.turn === record.turn && (
                    <span className={css.turnRail} aria-hidden="true" />
                  )}
                  {!isCollapsedSummary && selectedIndex === record.cell.index && (
                    <span className={css.selectionRail} aria-hidden="true" />
                  )}
                  <div className={css.eventInner}>
                    {!isCollapsedSummary && (
                      <span
                        className={
                          record.cell.kind === 'user' || record.cell.kind === 'message'
                            ? `${css.kindSlot} ${css.kindSlotLeft}`
                            : `${css.kindSlot} ${css.kindSlotRight}`
                        }
                      >
                        <span className={`${css.kindTag} ${css[record.cell.kind]}`}>
                          {KIND_LABEL[record.cell.kind]}
                        </span>
                        {record.turnStart && record.cell.opensTurn && (
                          <span
                            className={selected?.turn === record.turn
                              ? `${css.turnLabel} ${css.turnLabelActive}`
                              : css.turnLabel}
                          >
                            Turn {record.turn}
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                </td>
                <td className={css.content}>
                  {record.collapsedSummary !== undefined
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
                            ? displayText
                            : `${displayText} → ${record.cell.result}`}
                        >
                          <span className={record.cell.result === undefined ? undefined : css.resultRequest}>
                            {isToolCallOnly(record.cell) ? null : displayText || '—'}
                          </span>
                          {record.cell.result !== undefined && (
                            <span className={record.cell.isError ? `${css.inlineResult} ${css.error}` : css.inlineResult}>
                              <span className={css.arrow}>→</span>
                              <span className={css.inlineResultText}>{record.cell.result}</span>
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
      {selected !== undefined && selectedState !== undefined && (
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
              const split = details?.parentElement
              if (details === null || details === undefined || split === null || split === undefined) return
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
              const split = details?.parentElement
              if (details === null || details === undefined || split === null || split === undefined) return
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
              <span className={`${css.kindTag} ${css[selected.cell.kind]}`}>
                {KIND_LABEL[selected.cell.kind]}
              </span>
              <span className={css.detailsLocation}>{`Turn ${selected.turn} · ${selected.group}`}</span>
            </div>
            <button
              type="button"
              className={css.close}
              aria-label="Close details"
              onClick={() => { setSelectedIndex(null) }}
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
            className={css.detailBody}
            role="tabpanel"
            aria-labelledby={`trajectory-detail-${activeTab}`}
          >
            {activeTab === 'overview' && (
              <>
                <dl className={css.overview}>
                  {hasSelectedParents && (
                    <div>
                      <dt>Hierarchy</dt>
                      <dd className={css.overviewParentLinks}>
                        {selectedParents.message !== undefined && (
                          <button
                            type="button"
                            className={css.overviewHierarchyLink}
                            onClick={() => { openRecordSummary(selectedParents.message!) }}
                          >
                            Parent Message
                          </button>
                        )}
                        {selectedParents.tool !== undefined && (
                          <button
                            type="button"
                            className={css.overviewHierarchyLink}
                            onClick={() => { openRecordSummary(selectedParents.tool!) }}
                          >
                            Parent Tool Call
                          </button>
                        )}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Status</dt>
                    <dd>{statusLabel(selectedState)}</dd>
                  </div>
                  {selected.cell.kind === 'message' && (
                    <div><dt>Tokens</dt><dd>{tokenSummary(selected.cell)}</dd></div>
                  )}
                  <div><dt>Duration</dt><dd>{formatElapsedSeconds(selected.cell.timeSeconds)}</dd></div>
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
                  <OverviewSection label="Timing" onOpen={() => { activateTab('timing') }}>
                    <RecordTiming record={selected} />
                  </OverviewSection>
                </div>
              </>
            )}
            {activeTab === 'rendered' && (
              <MarkdownRecordContent
                record={selected}
                rendered
                thinkingExpanded={thinkingExpanded}
                onThinkingExpandedChange={setThinkingExpanded}
                onOpenCall={openCallSummary}
              />
            )}
            {activeTab === 'source' && (
              <MarkdownRecordContent
                record={selected}
                rendered={false}
                thinkingExpanded={thinkingExpanded}
                onThinkingExpandedChange={setThinkingExpanded}
                onOpenCall={openCallSummary}
              />
            )}
            {activeTab === 'input' && (
              <RecordPayload record={selected} direction="input" />
            )}
            {activeTab === 'output' && (
              <RecordPayload record={selected} direction="output" />
            )}
            {activeTab === 'schema' && (
              <RecordSchema record={selected} />
            )}
            {activeTab === 'timing' && (
              <RecordTiming record={selected} />
            )}
          </div>
        </aside>
      )}
    </div>
  )
}
