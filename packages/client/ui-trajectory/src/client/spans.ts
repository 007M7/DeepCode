/**
 * Rough per-turn span derivation shared by the two placeholder views and the
 * header stats bar. P-I ships no timing data, so a span's weight is its node
 * count, not wall time (deviation ledger #3 — real spans land in P-III).
 */
import type { ConversationNode, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

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
