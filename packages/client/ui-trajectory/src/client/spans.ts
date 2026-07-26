/**
 * Rough per-turn span derivation shared by the two placeholder views and the
 * header stats bar. P-I ships no timing data, so a span's weight is its node
 * count, not wall time (deviation ledger #3 — real spans land in P-III).
 */
import type { ConversationNode, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

/** One run_code sub-dispatch lane in the waterfall: real timing off the start/settle pair. */
export interface SubSpanLane {
  callId: string
  name: string
  /** Wall duration in ms; null unless both endpoints were observed (`timing: 'measured'`). */
  durationMs: number | null
  /**
   * Timing provenance: `measured` = start/settle pair observed; `running` =
   * start seen, settle pending; `unknown` = settle-only replay window (the
   * start fell outside), so no duration claim is possible.
   */
  timing: 'measured' | 'running' | 'unknown'
  /** Start offset as a fraction of the parent turn's dispatch window [0, 1). */
  offsetFraction: number
  /** Width as a fraction of the window (running lanes extend to the window end). */
  widthFraction: number
}

/** One turn's worth of activity, folded from the snapshot node window. */
export interface TurnSpan {
  turn: number
  /** Assistant step messages inside the turn. */
  steps: number
  /** Tool results inside the turn (running calls are not folded in P-I). */
  calls: number
  /** Total nodes attributed to the turn (span weight stand-in). */
  nodes: number
}

/** Aggregate totals for the header stats bar. */
export interface SpanStats {
  turns: number
  steps: number
  calls: number
}

/**
 * Fold snapshot nodes into per-turn spans. Only assistant nodes carry a turn
 * number; user/steering/context/tool nodes attach to the turn last seen in
 * sequence order (turn 0 collects the pre-assistant prologue).
 * @param nodes - snapshot nodes in surface order.
 * @returns spans ordered by first appearance.
 */
export function deriveSpans(nodes: ConversationSnapshot['nodes']): readonly TurnSpan[] {
  const spans = new Map<number, TurnSpan>()
  let currentTurn = 0
  const spanFor = (turn: number): TurnSpan => {
    let span = spans.get(turn)
    if (span === undefined) {
      span = { turn, steps: 0, calls: 0, nodes: 0 }
      spans.set(turn, span)
    }
    return span
  }
  for (const node of nodes) {
    if (hasTurn(node)) currentTurn = node.turn
    const span = spanFor(currentTurn)
    span.nodes += 1
    if (node.kind === 'assistant') span.steps += 1
    if (node.kind === 'tool-result') span.calls += 1
  }
  return [...spans.values()]
}

/**
 * Aggregate spans into the header totals.
 * @param spans - deriveSpans product.
 * @returns turn/step/call totals.
 */
export function deriveSpanStats(spans: readonly TurnSpan[]): SpanStats {
  let steps = 0
  let calls = 0
  for (const span of spans) {
    steps += span.steps
    calls += span.calls
  }
  return { turns: spans.length, steps, calls }
}

function hasTurn(node: ConversationNode): node is ConversationNode & { turn: number } {
  return node.kind === 'assistant' || node.kind === 'steering'
}

/**
 * Fold the dispatch index into per-turn sub-span lanes with REAL timing: each
 * lane's offset/width scale against its parent turn's dispatch window (first
 * start → last settle). Running (unsettled) lanes extend to the window end
 * with a null duration.
 * @param nodes - snapshot nodes (locates each parent run_code call's turn).
 * @param codeDispatches - the snapshot's dispatch index.
 * @returns lanes keyed by turn, in start order.
 */
export function deriveSubSpans(
  nodes: ConversationSnapshot['nodes'],
  codeDispatches: ConversationSnapshot['codeDispatches'],
): ReadonlyMap<number, readonly SubSpanLane[]> {
  const out = new Map<number, SubSpanLane[]>()
  if (codeDispatches.size === 0) return out
  const turnByCall = new Map<string, number>()
  let currentTurn = 0
  for (const node of nodes) {
    if (node.kind === 'assistant' || node.kind === 'steering') currentTurn = node.turn
    if (node.kind === 'tool-result') turnByCall.set(node.callId, currentTurn)
  }
  for (const [parent, subs] of codeDispatches) {
    if (subs.length === 0) continue
    const turn = turnByCall.get(parent) ?? currentTurn
    // A settle-only entry (callTime null: its start fell outside the replay
    // window) anchors the window by its settle time — a real observation —
    // but must never masquerade as a measured zero-duration span.
    const starts: number[] = []
    const ends: number[] = []
    for (const sub of subs) {
      const settled = 'kind' in sub
      const start = settled ? sub.callTime ?? sub.time : sub.time
      starts.push(start)
      ends.push(settled ? sub.time : start)
    }
    const windowStart = Math.min(...starts)
    const windowEnd = Math.max(...ends, windowStart + 1)
    const windowSpan = windowEnd - windowStart
    const lanes: SubSpanLane[] = subs.map((sub, i) => {
      const settled = 'kind' in sub
      const timing = settled ? (sub.callTime === null ? 'unknown' as const : 'measured' as const) : 'running' as const
      const start = starts[i] ?? windowStart
      const end = settled ? sub.time : windowEnd
      return {
        callId: sub.callId,
        name: settled ? sub.call?.name ?? sub.callId : sub.name,
        durationMs: timing === 'measured' ? Math.max(0, end - start) : null,
        timing,
        offsetFraction: (start - windowStart) / windowSpan,
        widthFraction: Math.max((end - start) / windowSpan, 0.02),
      }
    })
    const existing = out.get(turn) ?? []
    out.set(turn, [...existing, ...lanes])
  }
  return out
}
