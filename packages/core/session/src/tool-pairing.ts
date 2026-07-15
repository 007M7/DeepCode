/**
 * Tool-pairing balance over a session surface. Compaction changes surface
 * positions, so safe cuts are derived from tool-call/result content on the
 * surface rather than step markers in the append-only log.
 * @module @deepseek-ai/dsh-session/tool-pairing
 */

import type { SessionEvent } from './types.ts'

/**
 * The tool-pairing delta of a surface node: how it shifts the count of
 * unanswered tool calls. An `assistant/message` opens one bracket per
 * `tool-call` block; a `tool/result` closes one; every other surface node
 * (`user/message`, `context/message`, `steering/message`, a usage-only
 * `assistant/message` with no tool-call blocks) is pairing-neutral.
 */
function nodeDelta(event: SessionEvent): number {
  switch (event.type) {
    case 'assistant/message':
      return event.data.content.filter(block => block.type === 'tool-call').length
    case 'tool/result':
      return -1
    // Non-pairing surface nodes and every non-surface event contribute nothing.
    default:
      return 0
  }
}

/**
 * Check that a surface cut does not split a tool call from its result. A region
 * is safe to collapse only when both edge cuts return true.
 *
 * @param nodes - surface event sequence numbers in head-to-tail order.
 * @param events - the session log indexed by those sequence numbers.
 * @param beforeSeq - event immediately after the cut; null or an absent seq means after-tail.
 * @returns whether every call before the cut is answered before it.
 * @throws if a result appears without a preceding open call.
 */
export function isToolPairingBalanced(
  nodes: readonly number[],
  events: readonly SessionEvent[],
  beforeSeq: number | null,
): boolean {
  let depth = 0
  for (const seq of nodes) {
    if (seq === beforeSeq) return depth === 0
    // seq is a surface event sequence, always a valid log index by construction.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    depth += nodeDelta(events[seq]!)
    if (depth < 0) {
      throw new Error(`tool-pairing balance: tool/result at surface seq ${seq} has no matching tool-call (corrupt surface)`)
    }
  }
  // A missing cut sequence means the after-tail boundary.
  return depth === 0
}
