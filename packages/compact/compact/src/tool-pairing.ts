/**
 * Tool-pairing balance over a session surface. Compaction changes surface
 * positions, so safe cuts are derived from tool-call/result content in current
 * surface order rather than step markers or linked-list fields supplied by a
 * caller.
 * @module @deepseek-ai/dsh-compact/tool-pairing
 */

import type { Session, SessionEvent, SurfaceNode } from '@deepseek-ai/dsh-session'

/** Incremental balance state for one session surface generation. */
interface BalanceCache {
  /** Surface rewrite generation this state describes. */
  generation: number
  /** Number of surface nodes already folded into the state. */
  processedNodes: number
  /** Balance of the cut immediately before each current surface node. */
  beforeSeq: Map<number, boolean>
  /** Current positional successor of each surface node. */
  successorBySeq: Map<number, number | null>
  /** Unanswered tool-call count after the processed surface tail. */
  depth: number
}

const balanceCacheBySession = new WeakMap<Session, BalanceCache>()

/** Return how one surface event changes the unanswered tool-call count. */
function nodeDelta(event: SessionEvent): number {
  switch (event.type) {
    case 'assistant/message':
      return event.data.content.filter(block => block.type === 'tool-call').length
    case 'tool/result':
      return -1
    default:
      return 0
  }
}

/** Read and validate the event named by a surface node. */
function eventForNode(events: readonly SessionEvent[], node: SurfaceNode): SessionEvent {
  const event = events[node.seq]
  if (event === undefined || event.seq !== node.seq) {
    throw new Error(`tool-pairing balance: surface seq ${node.seq} has no matching session event (corrupt surface)`)
  }
  return event
}

/** Build balance state for a complete current surface. */
function rebuildCache(
  session: Session,
  nodes: readonly SurfaceNode[],
  generation: number,
): BalanceCache {
  const beforeSeq = new Map<number, boolean>()
  const successorBySeq = new Map<number, number | null>()
  const events = session.events
  let depth = 0
  let previousSeq: number | undefined

  for (const node of nodes) {
    beforeSeq.set(node.seq, depth === 0)
    successorBySeq.set(node.seq, null)
    if (previousSeq !== undefined) successorBySeq.set(previousSeq, node.seq)
    depth += nodeDelta(eventForNode(events, node))
    if (depth < 0) {
      throw new Error(`tool-pairing balance: tool/result at surface seq ${node.seq} has no matching tool-call (corrupt surface)`)
    }
    previousSeq = node.seq
  }

  return { generation, processedNodes: nodes.length, beforeSeq, successorBySeq, depth }
}

/** Fold a pure surface tail append into existing balance state. */
function extendCache(
  session: Session,
  cache: BalanceCache,
  nodes: readonly SurfaceNode[],
): BalanceCache {
  const tail = nodes.slice(cache.processedNodes)
  // Validate the unseen tail before mutating the live cache, so a corrupt
  // append cannot leave a partially advanced state behind.
  const events = session.events
  const pending: Array<{ seq: number; before: boolean }> = []
  let depth = cache.depth
  for (const node of tail) {
    pending.push({ seq: node.seq, before: depth === 0 })
    depth += nodeDelta(eventForNode(events, node))
    if (depth < 0) {
      throw new Error(`tool-pairing balance: tool/result at surface seq ${node.seq} has no matching tool-call (corrupt surface)`)
    }
  }

  let previousSeq = nodes[cache.processedNodes - 1]?.seq
  for (const entry of pending) {
    if (previousSeq !== undefined) cache.successorBySeq.set(previousSeq, entry.seq)
    cache.beforeSeq.set(entry.seq, entry.before)
    cache.successorBySeq.set(entry.seq, null)
    previousSeq = entry.seq
  }
  cache.processedNodes = nodes.length
  cache.depth = depth
  return cache
}

/** Return balance state synchronized with the current session surface. */
function balanceCache(session: Session): BalanceCache {
  const surface = session.surface
  const nodes = surface.nodes
  const generation = surface.replaceGeneration
  const cached = balanceCacheBySession.get(session)

  if (cached === undefined || cached.generation !== generation || cached.processedNodes > nodes.length) {
    const rebuilt = rebuildCache(session, nodes, generation)
    balanceCacheBySession.set(session, rebuilt)
    return rebuilt
  }
  if (cached.processedNodes < nodes.length) return extendCache(session, cached, nodes)
  return cached
}

/**
 * Whether the cut immediately before a current surface node is tool-pairing balanced.
 * @param session - session whose surface is checked.
 * @param node - surface node whose leading cut is checked; only its seq identifies it.
 * @returns true when no unanswered tool call crosses the cut.
 * @throws when the seq is absent from the current surface, a surface node has no
 * matching log event, or a tool result has no preceding open call.
 */
export function toolPairingBalancedBefore(session: Session, node: SurfaceNode): boolean {
  const cache = balanceCache(session)
  const balanced = cache.beforeSeq.get(node.seq)
  if (balanced === undefined) {
    throw new Error(`tool-pairing balance: surface seq ${node.seq} not found`)
  }
  return balanced
}

/**
 * Whether the cut immediately after a current surface node is tool-pairing balanced.
 * @param session - session whose surface is checked.
 * @param node - surface node whose trailing cut is checked; only its seq identifies it.
 * @returns true when no unanswered tool call crosses the cut.
 * @throws when the seq is absent from the current surface, a surface node has no
 * matching log event, or a tool result has no preceding open call.
 */
export function toolPairingBalancedAfter(session: Session, node: SurfaceNode): boolean {
  const cache = balanceCache(session)
  const successor = cache.successorBySeq.get(node.seq)
  if (successor === undefined) {
    throw new Error(`tool-pairing balance: surface seq ${node.seq} not found`)
  }
  if (successor === null) return cache.depth === 0
  // Current membership and positional successors are cache-owned. A caller may
  // retain a node across surface changes, so its mutable-looking `next` field is
  // never authoritative for this query.
  // The successor map and balance map are committed together.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return cache.beforeSeq.get(successor)!
}
