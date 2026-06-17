/**
 * Surface layer on top of the session event log: a derived, cached linked list
 * of events that produce LLM messages. Rebuilt deterministically from
 * `surfaceOp` markers in the log — the log is the source of truth; the surface
 * is a view.
 *
 * @module @deepseek-ai/dsh-session/surface
 */

import type { SessionEvent, SurfaceOp } from './types.ts'

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
  /** Map from event seq → node for O(1) lookup during replacements. */
  private _nodeBySeq = new Map<number, SurfaceNode>()
  /** The last processed seq. -1 forces a full rebuild on first access. */
  private _lastProcessedSeq = -1

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
  }

  /** The surface nodes in linked-list order (head to tail). */
  get nodes(): readonly SurfaceNode[] {
    if (this._lastProcessedSeq < this.log.length - 1) this._processDelta()
    return this._nodes
  }

  /** Whether any event in the log carries `surfaceOp` markers. */
  get hasSurface(): boolean {
    if (this._nodes.length > 0) return true
    // Never processed anything — scan the whole log.
    if (this._lastProcessedSeq === -1) return this.log.some(e => e.surfaceOp !== undefined)
    // Processed up to _lastProcessedSeq without finding surface nodes; check
    // only new events.
    for (let i = this._lastProcessedSeq + 1; i < this.log.length; i++) {
      if (this.log[i]?.surfaceOp !== undefined) return true
    }
    return false
  }

  /**
   * Process events from `_lastProcessedSeq + 1` through the end of the log,
   * folding new surface markers into the existing linked list.
   */
  private _processDelta(): void {
    for (let i = this._lastProcessedSeq + 1; i < this.log.length; i++) {
      const event = this.log[i]
      if (event === undefined || event.surfaceOp === undefined) continue

      if (event.surfaceOp === 'append') {
        const tail = this._nodes.length > 0 ? this._nodes[this._nodes.length - 1] : undefined
        const node: SurfaceNode = { seq: event.seq, prev: tail?.seq ?? null, next: null }
        if (tail) tail.next = event.seq
        this._nodes.push(node)
        this._nodeBySeq.set(event.seq, node)
      } else {
        this._replace(this._nodes, this._nodeBySeq, event.seq, event.surfaceOp)
      }
    }
    this._lastProcessedSeq = this.log.length - 1
  }

  /** Apply a replace operation to the in-progress surface. */
  private _replace(
    nodes: SurfaceNode[],
    nodeBySeq: Map<number, SurfaceNode>,
    newSeq: number,
    op: Extract<SurfaceOp, { op: 'replace' }>,
  ): void {
    const startIdx = nodes.findIndex(n => n.seq === op.start)
    if (startIdx === -1) {
      throw new Error(`surface replace: start seq ${op.start} not found in surface`)
    }
    const endIdx = nodes.findIndex(n => n.seq === op.end)
    if (endIdx === -1) {
      throw new Error(`surface replace: end seq ${op.end} not found in surface`)
    }
    if (startIdx > endIdx) {
      throw new Error(`surface replace: start seq ${op.start} (index ${startIdx}) is after end seq ${op.end} (index ${endIdx})`)
    }

    // Remove shadowed nodes from `[startIdx, endIdx]` inclusive.
    const count = endIdx - startIdx + 1
    const removed = nodes.splice(startIdx, count)
    for (const r of removed) nodeBySeq.delete(r.seq)

    // Insert the new node where the removed range was.
    const prevNode = startIdx > 0 ? nodes[startIdx - 1] : undefined
    const nextNode = startIdx < nodes.length ? nodes[startIdx] : undefined

    const newNode: SurfaceNode = {
      seq: newSeq,
      prev: prevNode?.seq ?? null,
      next: nextNode?.seq ?? null,
    }
    if (prevNode) prevNode.next = newSeq
    if (nextNode) nextNode.prev = newSeq
    nodes.splice(startIdx, 0, newNode)
    nodeBySeq.set(newSeq, newNode)
  }
}
