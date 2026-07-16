/**
 * Surface layer on top of the session event log: a derived, cached linked list
 * of events that produce LLM messages. Rebuilt deterministically from
 * `surfaceOp` markers in the log — the log is the source of truth; the surface
 * is a view.
 *
 * @module @deepseek-ai/dsh-session/surface
 */

import type { SessionEvent, SurfaceEvent, SurfaceEventType, SurfaceOp } from './types.ts'

/**
 * The set of event type strings that are eligible for the surface linked list.
 * Mirrors the {@link SurfaceEventType} union; kept as a runtime set so the
 * type guard can check membership without a chain of string comparisons.
 */
const SURFACE_EVENT_TYPES = new Set<string>([
  'user/message',
  'assistant/message',
  'tool/result',
  'context/message',
  'steering/message',
])

/**
 * Check only whether a type may enter the message surface; it does not require `surfaceOp`. This
 * detects eligible seed/load events missing their mandatory marker. Use {@link isSurfaceEvent} to
 * narrow a fully formed event whose marker is present.
 * @param type - the event type string to test.
 * @returns true when the type is one of the five message-producing types.
 */
export function isSurfaceEligibleType(type: string): boolean {
  return SURFACE_EVENT_TYPES.has(type)
}

/**
 * Narrow a {@link SessionEvent} to {@link SurfaceEvent}: checks that the
 * event's `type` is surface-eligible AND that `surfaceOp` is present.
 * The narrowed type has mandatory {@link SurfaceOp}.
 * @param event - the event to narrow.
 * @returns true when the event is surface-eligible and carries its `surfaceOp` marker.
 */
export function isSurfaceEvent(event: SessionEvent): event is SurfaceEvent {
  if (!SURFACE_EVENT_TYPES.has(event.type)) return false
  // surfaceOp is optional on SessionEvent (even for surface-eligible types)
  // but mandatory on SurfaceEvent — this check is the narrowing gate.
  if ((event as SessionEvent<SurfaceEventType>).surfaceOp === undefined) return false
  return true
}

/** One node in the surface linked list. */
export interface SurfaceNode {
  /** The event seq of this surface node. */
  seq: number
  /** The previous surface node's seq, or null if this is the head. */
  prev: number | null
  /** The next surface node's seq, or null if this is the tail. */
  next: number | null
}

/** One replacement operation observed while folding a session surface. */
export interface SurfaceFoldReplacement {
  /** Seq of the event that replaced the prior surface range. */
  seq: number
  /** Declared inclusive start seq of the replaced surface range. */
  start: number
  /** Declared inclusive end seq of the replaced surface range. */
  end: number
  /** Actual surface nodes removed by the operation, in surface order. */
  shadowedSeqs: number[]
}

/** Complete result of replaying the surface operations in a session log. */
export interface SurfaceFoldResult {
  /** Current surface nodes in linked-list order. */
  nodes: SurfaceNode[]
  /** Replacement operations in event order. */
  replacements: SurfaceFoldReplacement[]
}

/** Mutable state shared by the incremental manager and the full-log fold. */
interface SurfaceFoldState {
  nodes: SurfaceNode[]
  nodeBySeq: Map<number, SurfaceNode>
  replaceGeneration: number
}

/** Create an empty surface fold state. */
function createFoldState(replaceGeneration = 0): SurfaceFoldState {
  return {
    nodes: [],
    nodeBySeq: new Map(),
    replaceGeneration,
  }
}

/** Apply one event and return replacement metadata only when one occurred. */
function applySurfaceEvent(
  state: SurfaceFoldState,
  event: SessionEvent,
): SurfaceFoldReplacement | undefined {
  if (!isSurfaceEligibleType(event.type)) return
  if (!isSurfaceEvent(event)) {
    throw new Error(`surface event "${event.type}" (seq ${event.seq}) carries no surfaceOp marker`)
  }

  if (event.surfaceOp === 'append') {
    const tail = state.nodes.length > 0 ? state.nodes[state.nodes.length - 1] : undefined
    const node: SurfaceNode = { seq: event.seq, prev: tail?.seq ?? null, next: null }
    if (tail) tail.next = event.seq
    state.nodes.push(node)
    state.nodeBySeq.set(event.seq, node)
    return
  }

  return {
    seq: event.seq,
    start: event.surfaceOp.start,
    end: event.surfaceOp.end,
    shadowedSeqs: replaceSurface(state, event.seq, event.surfaceOp),
  }
}

/** Apply one positional replacement and return the nodes it removed. */
function replaceSurface(
  state: SurfaceFoldState,
  newSeq: number,
  op: Extract<SurfaceOp, { op: 'replace' }>,
): number[] {
  const startNode = state.nodeBySeq.get(op.start)
  if (!startNode) {
    throw new Error(`surface replace: start seq ${op.start} not found in surface`)
  }
  const endNode = state.nodeBySeq.get(op.end)
  if (!endNode) {
    throw new Error(`surface replace: end seq ${op.end} not found in surface`)
  }
  const startIdx = state.nodes.indexOf(startNode)
  const endIdx = state.nodes.indexOf(endNode)
  if (startIdx > endIdx) {
    throw new Error(`surface replace: start seq ${op.start} (index ${startIdx}) is after end seq ${op.end} (index ${endIdx})`)
  }

  const removed = state.nodes.splice(startIdx, endIdx - startIdx + 1)
  for (const node of removed) state.nodeBySeq.delete(node.seq)

  const prevNode = startIdx > 0 ? state.nodes[startIdx - 1] : undefined
  const nextNode = startIdx < state.nodes.length ? state.nodes[startIdx] : undefined
  const newNode: SurfaceNode = {
    seq: newSeq,
    prev: prevNode?.seq ?? null,
    next: nextNode?.seq ?? null,
  }
  if (prevNode) prevNode.next = newSeq
  if (nextNode) nextNode.prev = newSeq
  state.nodes.splice(startIdx, 0, newNode)
  state.nodeBySeq.set(newSeq, newNode)
  state.replaceGeneration += 1
  return removed.map(node => node.seq)
}

/**
 * Replay a complete session log through the canonical surface fold.
 *
 * The returned arrays and nodes are detached snapshots. The incremental
 * {@link SurfaceManager} uses the same transition functions, so query read
 * models cannot disagree with `deriveMessages()` about replacement ranges.
 * @param events - session events in contiguous seq order.
 * @returns the current surface and every positional replacement.
 * @throws when a surface-eligible event lacks its mandatory `surfaceOp`, or a
 * replacement names nodes that are absent or reversed on the current surface.
 */
export function foldSurface(events: readonly SessionEvent[]): SurfaceFoldResult {
  const state = createFoldState()
  const replacements: SurfaceFoldReplacement[] = []
  for (const event of events) {
    const replacement = applySurfaceEvent(state, event)
    if (replacement !== undefined) replacements.push(replacement)
  }
  return {
    nodes: state.nodes.map(node => ({ ...node })),
    replacements,
  }
}

/**
 * Maintains a cached linked list of surface nodes, rebuilt lazily from
 * `surfaceOp` markers in the event log. Because the log is append-only, it
 * processes only the delta since the last rebuild — new events are folded
 * into the existing surface in O(new events) rather than rescanning the
 * whole log.
 */
export class SurfaceManager {
  /** Incremental state shared with the complete surface fold. */
  private _state = createFoldState()
  /** The last processed seq. -1 folds the seeded log on first access. */
  private _lastProcessedSeq = -1

  constructor(private log: readonly SessionEvent[]) {}

  /**
   * The surface's rewrite generation, bumped by every folded `replace` op.
   * A replace is the ONE operation that rewrites the
   * surface non-monotonically, so an incremental consumer of {@link nodes}
   * (the session's derived-message cache) compares this between visits — an
   * unchanged generation guarantees every node it has not seen is a pure tail
   * append; a changed one means its view must rebuild. Monotonic: it never
   * moves backwards, so comparisons cannot be fooled by a re-fold.
   */
  get replaceGeneration(): number {
    if (this._lastProcessedSeq < this.log.length - 1) this._processDelta()
    return this._state.replaceGeneration
  }

  /** The surface nodes in linked-list order (head to tail). */
  get nodes(): readonly SurfaceNode[] {
    if (this._lastProcessedSeq < this.log.length - 1) this._processDelta()
    return this._state.nodes
  }

  /**
   * Process events from `_lastProcessedSeq + 1` through the end of the log,
   * folding new surface markers into the existing linked list.
   */
  private _processDelta(): void {
    for (let i = this._lastProcessedSeq + 1; i < this.log.length; i++) {
      // Index is bounded by i < this.log.length — never undefined.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const event = this.log[i]!
      applySurfaceEvent(this._state, event)
    }
    this._lastProcessedSeq = this.log.length - 1
  }
}
