/**
 * Tool-pairing balance over a session's SURFACE: is a given cut point in the
 * surface a safe edge for a collapsed region (e.g. compaction)?
 *
 * The invariant a consumer needs: a collapsed region must never separate an
 * `assistant/message`'s `tool-call` blocks from their answering `tool/result`s
 * — that would leave the rehydrated transcript with a dangling tool-call or an
 * orphaned tool-result, which every provider rejects. (This is the
 * compaction-time mirror of the crash-recovery imbalance that
 * {@link interruptedTurnClosers} repairs on load.) Steps were once used as a
 * proxy for this bracketing, but a compaction REWRITES the surface — it lands a
 * replacement node at a high log seq whose SURFACE position is the head — so a
 * scan over the LOG's `step/*` markers mis-reads such a node's neighbours. The
 * pairing the invariant actually protects lives in the surface nodes' own
 * content (a `tool-call` block's id, a `tool/result`'s `callId`), which travels
 * with the node through any reshaping, so alignment is decided over the surface
 * directly.
 *
 * A **cut** is a gap between two adjacent surface nodes (named by the node it
 * sits immediately before), or the after-tail gap (`null`). Walking the surface
 * head→tail and assigning each node a delta — `+1` per `tool-call` block on an
 * `assistant/message`, `-1` per `tool/result`, `0` otherwise — the depth at a
 * cut is the number of still-unanswered tool calls before it. A cut is
 * **balanced** when that depth is `0`. A region `[start..end]` is safe to
 * collapse iff BOTH its edges are balanced cuts: the cut before `start` and the
 * cut after `end`. Nodes that belong to no step (a pre-step `user/message`, an
 * inter-step `steering/message`, an injection `context/message`) carry no
 * pairing, contribute `0`, and so are free boundaries — exactly as before, but
 * now as a consequence of the balance rather than a special case. An open
 * trailing step (an assistant whose `tool/result`s have not landed yet) keeps
 * the depth positive through the tail, so no cut inside it is balanced — the
 * old explicit open-step check falls out of the same counter.
 *
 * @module @deepseek-ai/dsh-session/tool-pairing
 */

import type { SessionEvent } from './types.ts'
import type { SurfaceNode } from './surface.ts'

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
 * Whether the surface prefix ending at the given cut has BALANCED tool-call /
 * tool-result brackets — i.e. every `tool-call` block on the surface before the
 * cut has its answering `tool/result` before the cut too, so the cut is a safe
 * edge for a collapsed region (it cannot split an assistant↔result pair).
 *
 * `nodes` is the surface linked list in head→tail order (e.g.
 * `session.surface.nodes`); `events` is the session log, used to look each
 * node's event up by `seq`. `beforeSeq` names the cut by the surface node it
 * sits immediately before; the after-tail cut (the whole surface) is `null`,
 * as is any `beforeSeq` not present on the surface.
 *
 * A region `[start..end]` is collapsible iff both edges are balanced cuts: call
 * `isToolPairingBalanced(nodes, events, start)` for the cut before `start`, and
 * `isToolPairingBalanced(nodes, events, after)` — where `after` is `end`'s
 * surface successor (`SurfaceNode.next`), or `null` when `end` is the tail —
 * for the cut after `end`.
 *
 * @param nodes - the surface linked list in head→tail order.
 * @param events - the session log each node's `seq` indexes into.
 * @param beforeSeq - names the cut (the node it sits immediately before);
 *   `null` — or any seq not on the surface — means the after-tail cut.
 * @returns true when every `tool-call` before the cut is answered before it
 *   (the unanswered-call depth at the cut is zero).
 * @throws if the surface prefix drives the unanswered-call depth negative — a
 *   `tool/result` with no preceding open `tool-call` on the surface. That is a
 *   corrupt surface (a structural invariant violation), surfaced loudly here
 *   rather than silently mis-classifying a boundary.
 */
export function isToolPairingBalanced(
  nodes: readonly SurfaceNode[],
  events: readonly SessionEvent[],
  beforeSeq: number | null,
): boolean {
  let depth = 0
  for (const node of nodes) {
    if (node.seq === beforeSeq) return depth === 0
    // node.seq is a surface-node seq, always a valid log index by construction.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    depth += nodeDelta(events[node.seq]!)
    if (depth < 0) {
      throw new Error(`tool-pairing balance: tool/result at surface seq ${node.seq} has no matching tool-call (corrupt surface)`)
    }
  }
  // Reached the after-tail cut (beforeSeq === null, or a seq not on the
  // surface): the whole-surface prefix is balanced iff depth returned to 0.
  return depth === 0
}
