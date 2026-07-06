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
 * Whether an event's `type` is surface-eligible (one of the five
 * message-producing {@link SurfaceEventType} values). This is the TYPE check
 * only — it does NOT require `surfaceOp` to be present. Use it to detect a
 * surface-eligible event that is MISSING its mandatory marker (e.g. validating
 * a seed/load log); use {@link isSurfaceEvent} to narrow to a fully-formed
 * {@link SurfaceEvent} with `surfaceOp` present.
 */
export function isSurfaceEligibleType(type: string): boolean {
  return SURFACE_EVENT_TYPES.has(type)
}

/**
 * Narrow a {@link SessionEvent} to {@link SurfaceEvent}: checks that the
 * event's `type` is surface-eligible AND that `surfaceOp` is present.
 * The narrowed type has mandatory {@link SurfaceOp}.
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

/**
 * Maintains a cached linked list of surface nodes, rebuilt lazily from
 * `surfaceOp` markers in the event log. Because the log is append-only, it
 * processes only the delta since the last rebuild — new events are folded
 * into the existing surface in O(new events) rather than rescanning the
 * whole log.
 */
export class SurfaceManager {
  /** Surface nodes in linked-list order (head to tail). Empty until first access. */
  private _nodes: SurfaceNode[] = []
  /** Map from event seq → node. */
  private _nodeBySeq = new Map<number, SurfaceNode>()
  /** The last processed seq. -1 forces a full rebuild on first access. */
  private _lastProcessedSeq = -1

  /** Rewrite generation — see {@link replaceGeneration}. */
  private _replaceGeneration = 0

  constructor(private log: readonly SessionEvent[]) {}

  /**
   * Reset to unprocessed state. Call after the log has been replaced
   * wholesale (e.g. after Session seed). Not needed for normal appends —
   * those are picked up incrementally.
   */
  invalidate(): void {
    this._lastProcessedSeq = -1
    this._nodes = []
    this._nodeBySeq.clear()
    // A wholesale rebuild is a rewrite: bump the generation so incremental
    // consumers (the session's derived-message cache) discard their view.
    this._replaceGeneration += 1
  }

  /**
   * The surface's rewrite generation: bumped by every folded `replace` op and
   * by {@link invalidate}. A replace is the ONE operation that rewrites the
   * surface non-monotonically, so an incremental consumer of {@link nodes}
   * (the session's derived-message cache) compares this between visits — an
   * unchanged generation guarantees every node it has not seen is a pure tail
   * append; a changed one means its view must rebuild. Monotonic: it never
   * moves backwards, so comparisons cannot be fooled by a re-fold.
   */
  get replaceGeneration(): number {
    if (this._lastProcessedSeq < this.log.length - 1) this._processDelta()
    return this._replaceGeneration
  }

  /** The surface nodes in linked-list order (head to tail). */
  get nodes(): readonly SurfaceNode[] {
    if (this._lastProcessedSeq < this.log.length - 1) this._processDelta()
    return this._nodes
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
      // isSurfaceEvent checks event.type first (is it a surface-eligible type?)
      // then checks that surfaceOp is present. Only after both pass do we treat
      // it as a SurfaceEvent with mandatory surfaceOp.
      if (!isSurfaceEvent(event)) continue

      if (event.surfaceOp === 'append') {
        const tail = this._nodes.length > 0 ? this._nodes[this._nodes.length - 1] : undefined
        const node: SurfaceNode = { seq: event.seq, prev: tail?.seq ?? null, next: null }
        if (tail) tail.next = event.seq
        this._nodes.push(node)
        this._nodeBySeq.set(event.seq, node)
      } else {
        this._replace(event.seq, event.surfaceOp)
      }
    }
    this._lastProcessedSeq = this.log.length - 1
  }

  /** Apply a replace operation to the in-progress surface. */
  private _replace(
    newSeq: number,
    op: Extract<SurfaceOp, { op: 'replace' }>,
  ): void {
    const startNode = this._nodeBySeq.get(op.start)
    if (!startNode) {
      throw new Error(`surface replace: start seq ${op.start} not found in surface`)
    }
    const endNode = this._nodeBySeq.get(op.end)
    if (!endNode) {
      throw new Error(`surface replace: end seq ${op.end} not found in surface`)
    }
    const startIdx = this._nodes.indexOf(startNode)
    const endIdx = this._nodes.indexOf(endNode)
    if (startIdx > endIdx) {
      throw new Error(`surface replace: start seq ${op.start} (index ${startIdx}) is after end seq ${op.end} (index ${endIdx})`)
    }

    // Remove shadowed nodes from `[startIdx, endIdx]` inclusive.
    const count = endIdx - startIdx + 1
    const removed = this._nodes.splice(startIdx, count)
    for (const r of removed) this._nodeBySeq.delete(r.seq)

    // Insert the new node where the removed range was.
    const prevNode = startIdx > 0 ? this._nodes[startIdx - 1] : undefined
    const nextNode = startIdx < this._nodes.length ? this._nodes[startIdx] : undefined

    const newNode: SurfaceNode = {
      seq: newSeq,
      prev: prevNode?.seq ?? null,
      next: nextNode?.seq ?? null,
    }
    if (prevNode) prevNode.next = newSeq
    if (nextNode) nextNode.prev = newSeq
    this._nodes.splice(startIdx, 0, newNode)
    this._nodeBySeq.set(newSeq, newNode)
    this._replaceGeneration += 1
  }
}
