/**
 * Surface layer on top of the session event log: a derived, cached sequence
 * list of events that produce LLM messages. Folded deterministically from
 * `surfaceOp` markers in the log — the log is the source of truth; the surface
 * is a view.
 *
 * @module @deepseek-ai/dsh-session/surface
 */

import type { SessionEvent, SurfaceEvent, SurfaceEventType, SurfaceOp } from './types.ts'

/**
 * The set of event type strings that are eligible for the surface sequence.
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

/**
 * Maintains a cached ordered list of surface event sequences, folded lazily from
 * `surfaceOp` markers in the event log. Because the log is append-only, it
 * processes only the delta since the last rebuild — new events are folded
 * into the existing surface in O(new events) rather than rescanning the
 * whole log.
 */
export class SurfaceManager {
  /** Surface event sequences in head-to-tail order. Empty until first access. */
  private _nodes: number[] = []
  /** The last processed seq. -1 folds the seeded log on first access. */
  private _lastProcessedSeq = -1

  /** Rewrite generation — see {@link replaceGeneration}. */
  private _replaceGeneration = 0

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
    return this._replaceGeneration
  }

  /** Surface event sequences in head-to-tail order. */
  get nodes(): readonly number[] {
    if (this._lastProcessedSeq < this.log.length - 1) this._processDelta()
    return this._nodes
  }

  /**
   * Process events from `_lastProcessedSeq + 1` through the end of the log,
   * folding new surface markers into the existing sequence list.
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
        this._nodes.push(event.seq)
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
    const startIdx = this._nodes.indexOf(op.start)
    if (startIdx === -1) {
      throw new Error(`surface replace: start seq ${op.start} not found in surface`)
    }
    const endIdx = this._nodes.indexOf(op.end)
    if (endIdx === -1) {
      throw new Error(`surface replace: end seq ${op.end} not found in surface`)
    }
    if (startIdx > endIdx) {
      throw new Error(`surface replace: start seq ${op.start} (index ${startIdx}) is after end seq ${op.end} (index ${endIdx})`)
    }

    // Remove shadowed nodes from `[startIdx, endIdx]` inclusive.
    const count = endIdx - startIdx + 1
    this._nodes.splice(startIdx, count, newSeq)
    this._replaceGeneration += 1
  }
}
