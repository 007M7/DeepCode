/**
 * Trajectory list fold: expand assistant blocks, attach usage to Message,
 * own-duration times, in-flight partial/runningCalls, and group descriptions.
 */
import type {
  AssistantMessageNode,
  CodeSubCall,
  ConversationSnapshot,
  ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { TrajectoryCellProps } from './TrajectoryCell.tsx'

/** One Message or Step group inside a turn. */
export interface TrajectoryGroupModel {
  title: string
  description?: string
  cells: readonly TrajectoryCellProps[]
}

/** One sticky-turn section. */
export interface TrajectoryTurnModel {
  turn: number
  groups: readonly TrajectoryGroupModel[]
}

/** Snapshot slice the trajectory view folds. */
export interface TrajectoryLayoutInput {
  nodes: ConversationSnapshot['nodes']
  partial: ConversationSnapshot['partial']
  runningCalls: ConversationSnapshot['runningCalls']
  /** run_code sub-dispatches by parent callId (sub-cells nest under the parent Tool cell). */
  codeDispatches: ConversationSnapshot['codeDispatches']
}

interface UsageLike {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

/** Cell plus absolute ms for group wall-span descriptions. */
interface LaidCell {
  cell: TrajectoryCellProps
  absTime: number | null
  toolName?: string
  callId?: string
}

/**
 * Fold a snapshot into turn → Message/Step groups with expanded cells.
 * @param input - nodes plus in-flight partial/runningCalls.
 * @returns turns ordered by first appearance.
 */
export function deriveTrajectoryLayout(input: TrajectoryLayoutInput): readonly TrajectoryTurnModel[] {
  const { nodes, partial, runningCalls, codeDispatches } = input
  const resultByCall = indexResults(nodes)
  const turns = new Map<number, { message: LaidCell[]; steps: Map<number, LaidCell[]> }>()
  let index = 0
  let prevAbsTime: number | null = null
  let lastAssistantTurn: number | null = null

  const bucket = (turn: number) => {
    let entry = turns.get(turn)
    if (entry === undefined) {
      entry = { message: [], steps: new Map() }
      turns.set(turn, entry)
    }
    return entry
  }

  const pushMessage = (turn: number, laid: LaidCell) => {
    bucket(turn).message.push(laid)
  }
  const pushStep = (turn: number, step: number, laid: LaidCell) => {
    const steps = bucket(turn).steps
    const list = steps.get(step) ?? []
    list.push(laid)
    steps.set(step, list)
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    /* v8 ignore next -- dense-array guard: i stays within nodes.length, so the undefined arm needs a sparse array no caller builds. */
    if (node === undefined) continue
    if (node.kind === 'user' || node.kind === 'steering') {
      // user/message has no turn on the wire; enclose it in the next assistant
      // (or partial) turn, else open the turn after the last assistant.
      const turn = node.kind === 'steering'
        ? node.turn
        : enclosingUserTurn(nodes, i, partial, lastAssistantTurn)
      pushMessage(turn, {
        absTime: finiteTime(node.time),
        cell: {
          index: ++index, kind: 'user', text: summarizeContent(node.content),
          timeSeconds: 0,
        },
      })
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      continue
    }
    if (node.kind === 'assistant') {
      const laidList = withSubCalls(expandAssistant(node, index + 1, prevAbsTime, resultByCall), codeDispatches)
      for (const laid of laidList) {
        if (node.step > 0) pushStep(node.turn, node.step, laid)
        else pushMessage(node.turn, laid)
      }
      const last = laidList[laidList.length - 1]
      if (last !== undefined) index = last.cell.index
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      lastAssistantTurn = node.turn
      continue
    }
    if (node.kind === 'context') {
      // No trajectory cell, but the surface still advances the duration cursor.
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      continue
    }
    if (node.kind === 'tool-result') {
      if (!callEmittedInAssistant(nodes, node.callId)) {
        const toolName = node.call?.name
        pushStep(0, 1, {
          absTime: finiteTime(node.callTime ?? node.time),
          ...(toolName !== undefined ? { toolName } : {}),
          callId: node.callId,
          cell: {
            index: ++index,
            kind: 'tool',
            text: node.call !== null
              ? summarizeCall(node.call.name, node.call.argsRaw)
              : summarizeResult(node),
            timeSeconds: durationSeconds(node.time, node.callTime),
          },
        })
        for (const laid of expandSubCalls(codeDispatches.get(node.callId), index)) {
          pushStep(0, 1, laid)
          index = laid.cell.index
        }
      }
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
    }
  }

  if (partial !== null) {
    const fake: AssistantMessageNode = {
      kind: 'assistant', seq: Number.MAX_SAFE_INTEGER, time: 0,
      turn: partial.turn, step: partial.step, blocks: partial.blocks,
    }
    const laidList = expandAssistant(fake, index + 1, prevAbsTime, resultByCall, { streaming: true })
    for (const laid of laidList) {
      if (partial.step > 0) pushStep(partial.turn, partial.step, laid)
      else pushMessage(partial.turn, laid)
    }
    const last = laidList[laidList.length - 1]
    if (last !== undefined) index = last.cell.index
  }

  const seenCalls = collectCallIds(turns)
  for (const call of runningCalls) {
    if (seenCalls.has(call.callId)) continue
    pushStep(call.turn, call.step > 0 ? call.step : 1, {
      absTime: null,
      toolName: call.name,
      callId: call.callId,
      cell: {
        index: ++index,
        kind: 'tool',
        text: summarizeCall(call.name, call.argsRaw),
        timeSeconds: null,
      },
    })
    for (const laid of expandSubCalls(codeDispatches.get(call.callId), index)) {
      pushStep(call.turn, call.step > 0 ? call.step : 1, laid)
      index = laid.cell.index
    }
  }

  // Orphan turn-0 cells (orphaned tools / steering turn 0) fold into Turn 1.
  const prologue = turns.get(0)
  if (prologue !== undefined) {
    turns.delete(0)
    const emptyTurn = (): { message: LaidCell[]; steps: Map<number, LaidCell[]> } => ({
      message: [],
      steps: new Map(),
    })
    const first = turns.get(1) ?? emptyTurn()
    first.message = [...prologue.message, ...first.message]
    for (const [step, cells] of prologue.steps) {
      const existing = first.steps.get(step) ?? []
      first.steps.set(step, [...cells, ...existing])
    }
    turns.set(1, first)
  }

  return [...turns.entries()]
    .sort(([a], [b]) => a - b)
    .map(([turn, entry]) => toTurnModel(turn, entry))
}

function toTurnModel(
  turn: number,
  entry: { message: LaidCell[]; steps: Map<number, LaidCell[]> },
): TrajectoryTurnModel {
  const groups: TrajectoryGroupModel[] = []
  if (entry.message.length > 0) {
    const description = groupDescription(entry.message)
    groups.push({
      title: 'Message',
      ...(description !== undefined ? { description } : {}),
      cells: entry.message.map(l => l.cell),
    })
  }
  for (const step of [...entry.steps.keys()].sort((a, b) => a - b)) {
    const laid = entry.steps.get(step) ?? []
    const description = groupDescription(laid)
    groups.push({
      title: `Step ${step}`,
      ...(description !== undefined ? { description } : {}),
      cells: laid.map(l => l.cell),
    })
  }
  return { turn, groups }
}

/** Wall-span duration + tool histogram, e.g. `1.5s bash×6`. */
function groupDescription(laid: readonly LaidCell[]): string | undefined {
  const parts: string[] = []
  // Tool rows contribute start (absTime) and end (start + own duration) so a
  // single Tool cell still spans call→result for the group wall clock.
  const times: number[] = []
  for (const l of laid) {
    if (l.absTime === null || !Number.isFinite(l.absTime)) continue
    times.push(l.absTime)
    if (l.cell.kind === 'tool' && l.cell.timeSeconds !== null && Number.isFinite(l.cell.timeSeconds)) {
      times.push(l.absTime + l.cell.timeSeconds * 1000)
    }
  }
  if (times.length >= 2) {
    const span = formatGroupDuration((Math.max(...times) - Math.min(...times)) / 1000)
    if (span !== undefined) parts.push(span)
  } else if (times.length === 1) {
    const own = laid.find(l => l.absTime === times[0])?.cell.timeSeconds
    const span = own !== null && own !== undefined ? formatGroupDuration(own) : undefined
    if (span !== undefined) parts.push(span)
  }
  const tools = new Map<string, number>()
  for (const l of laid) {
    if (l.toolName === undefined || l.cell.kind !== 'tool') continue
    tools.set(l.toolName, (tools.get(l.toolName) ?? 0) + 1)
  }
  for (const [name, count] of tools) {
    parts.push(count > 1 ? `${name}×${count}` : name)
  }
  return parts.length === 0 ? undefined : parts.join(' ')
}

function formatGroupDuration(seconds: number): string | undefined {
  if (!Number.isFinite(seconds)) return undefined
  const rounded = Math.round(seconds * 10) / 10
  if (Number.isInteger(rounded)) return `${rounded}s`
  return `${rounded.toFixed(1)}s`
}

/** Own-duration seconds from two epoch-ms stamps; null when either is unusable. */
function durationSeconds(later: number, earlier: number | null): number | null {
  if (earlier === null || !Number.isFinite(later) || !Number.isFinite(earlier)) return null
  return Math.max(0, (later - earlier) / 1000)
}

/** Epoch-ms usable as an absolute time, else null. */
function finiteTime(time: number): number | null {
  return Number.isFinite(time) ? time : null
}

function expandAssistant(
  node: AssistantMessageNode,
  startIndex: number,
  prevAbsTime: number | null,
  results: Map<string, ToolResultNode>,
  opts?: { streaming?: boolean },
): LaidCell[] {
  const out: LaidCell[] = []
  let index = startIndex - 1
  const usage = node.usage as UsageLike | undefined
  const streaming = opts?.streaming === true
  const messageDuration = streaming ? null : durationSeconds(node.time, prevAbsTime)
  const nodeAbs = streaming ? null : finiteTime(node.time)
  let usageAttached = false

  for (const block of node.blocks) {
    // Reasoning blocks are skipped: no block-level clock, so no Think cell.
    if (block.kind === 'reasoning') continue
    if (block.kind === 'text') {
      if (block.text === '' && streaming) continue
      const cell: TrajectoryCellProps = {
        index: ++index, kind: 'message', text: summarizeText(block.text),
        timeSeconds: messageDuration,
      }
      if (!usageAttached) {
        attachUsage(cell, usage)
        usageAttached = usage !== undefined
      }
      out.push({ absTime: nodeAbs, cell })
      continue
    }
    if (block.kind === 'tool-call') {
      const result = results.get(block.callId)
      const toolDuration = streaming || result === undefined
        ? null
        : durationSeconds(result.time, result.callTime)
      const callAbs = streaming
        ? null
        : (result?.callTime !== null && result?.callTime !== undefined && Number.isFinite(result.callTime)
          ? result.callTime
          : nodeAbs)
      out.push({
        absTime: callAbs,
        toolName: block.name,
        callId: block.callId,
        cell: {
          index: ++index, kind: 'tool',
          text: summarizeCall(block.name, block.argsRaw),
          timeSeconds: toolDuration,
        },
      })
    }
  }

  if (out.length === 0 && !streaming) {
    // Reasoning-only / empty success still owns provider usage on the Message row.
    const cell: TrajectoryCellProps = {
      index: ++index, kind: 'message', text: '', timeSeconds: messageDuration,
    }
    attachUsage(cell, usage)
    out.push({ absTime: nodeAbs, cell })
  }
  return out
}

/**
 * Turn that encloses a user/message: next assistant/steering turn, else the
 * in-flight partial, else the turn after the last finalized assistant (or 1).
 */
function enclosingUserTurn(
  nodes: ConversationSnapshot['nodes'],
  userIndex: number,
  partial: ConversationSnapshot['partial'],
  lastAssistantTurn: number | null,
): number {
  for (let i = userIndex + 1; i < nodes.length; i++) {
    const n = nodes[i]
    /* v8 ignore next -- dense-array guard: i stays within nodes.length, so the undefined arm needs a sparse array no caller builds. */
    if (n === undefined) continue
    if (n.kind === 'assistant' || n.kind === 'steering') return n.turn
  }
  if (partial !== null) return partial.turn
  if (lastAssistantTurn !== null) return lastAssistantTurn + 1
  return 1
}

/** Copy provider usage onto a Message cell when present. */
function attachUsage(cell: TrajectoryCellProps, usage: UsageLike | undefined): void {
  if (usage === undefined) return
  if (usage.inputTokens !== undefined) cell.input = usage.inputTokens
  if (usage.outputTokens !== undefined) cell.output = usage.outputTokens
  if (usage.reasoningTokens !== undefined) cell.think = usage.reasoningTokens
}

function indexResults(nodes: ConversationSnapshot['nodes']): Map<string, ToolResultNode> {
  const map = new Map<string, ToolResultNode>()
  for (const node of nodes) {
    if (node.kind === 'tool-result') map.set(node.callId, node)
  }
  return map
}

function callEmittedInAssistant(nodes: ConversationSnapshot['nodes'], callId: string): boolean {
  for (const node of nodes) {
    if (node.kind !== 'assistant') continue
    if (node.blocks.some(b => b.kind === 'tool-call' && b.callId === callId)) return true
  }
  return false
}

function collectCallIds(
  turns: Map<number, { message: LaidCell[]; steps: Map<number, LaidCell[]> }>,
): Set<string> {
  const ids = new Set<string>()
  for (const entry of turns.values()) {
    for (const laid of entry.message) {
      if (laid.callId !== undefined) ids.add(laid.callId)
    }
    for (const list of entry.steps.values()) {
      for (const laid of list) {
        if (laid.callId !== undefined) ids.add(laid.callId)
      }
    }
  }
  return ids
}



/** Interleave each tool cell's run_code sub-dispatch cells right after it, reindexing followers. */
function withSubCalls(laidList: LaidCell[], codeDispatches: ConversationSnapshot['codeDispatches']): LaidCell[] {
  if (codeDispatches.size === 0) return laidList
  const out: LaidCell[] = []
  let index = laidList[0] !== undefined ? laidList[0].cell.index - 1 : 0
  for (const laid of laidList) {
    out.push({ ...laid, cell: { ...laid.cell, index: ++index } })
    if (laid.callId === undefined) continue
    for (const sub of expandSubCalls(codeDispatches.get(laid.callId), index)) {
      out.push(sub)
      index = sub.cell.index
    }
  }
  return out
}

/** Sub-dispatch cells for one run_code parent, in start order (running = null duration). */
function expandSubCalls(
  subs: readonly CodeSubCall[] | undefined,
  startIndex: number,
): LaidCell[] {
  if (subs === undefined || subs.length === 0) return []
  const out: LaidCell[] = []
  let index = startIndex
  for (const sub of subs) {
    const settled = 'kind' in sub
    out.push({
      absTime: settled ? finiteTime(sub.callTime ?? sub.time) : finiteTime(sub.time),
      toolName: settled ? sub.call?.name ?? sub.callId : sub.name,
      callId: sub.callId,
      cell: {
        index: ++index,
        kind: 'subtool',
        text: settled
          ? (sub.call !== null ? summarizeCall(sub.call.name, sub.call.argsRaw) : summarizeResult(sub))
          : summarizeCall(sub.name, sub.argsRaw),
        // PR3's start/settle pair carries per-sub-call wall time; a running
        // (unsettled) or pre-pair log entry shows the em dash.
        timeSeconds: settled ? durationSeconds(sub.time, sub.callTime) : null,
      },
    })
  }
  return out
}

function summarizeCall(name: string, argsRaw: string): string {
  const args = argsRaw.replace(/\s+/g, ' ').trim()
  if (args === '') return name
  const clipped = args.length > 72 ? `${args.slice(0, 71)}…` : args
  return `${name} · ${clipped}`
}

function summarizeResult(node: ToolResultNode): string {
  if (node.isError) {
    return node.error?.code ?? 'error'
  }
  for (const block of node.content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      return summarizeText(block.text)
    }
  }
  return node.call?.name ?? node.callId
}

function summarizeContent(content: readonly { type: string; text?: string }[]): string {
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') return summarizeText(block.text)
  }
  return ''
}

function summarizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
