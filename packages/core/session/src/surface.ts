/**
 * Surface layer on top of the session event log: an ordered view of events
 * that produce LLM messages. The append-only log remains the source of truth.
 *
 * @module @deepseek-ai/dsh-session/surface
 */

import type { SessionEvent, SurfaceEvent, SurfaceEventType, SurfaceOp } from './types.ts'

/** Runtime counterpart of the message-producing event union. */
const SURFACE_EVENT_TYPES = new Set<string>([
  'user/message',
  'assistant/message',
  'tool/result',
  'context/message',
  'steering/message',
])

/**
 * Whether an event type can join the model-visible surface.
 * @param type - event type to test.
 * @returns true for one of the five message-producing event types.
 */
export function isSurfaceEligibleType(type: string): boolean {
  return SURFACE_EVENT_TYPES.has(type)
}

/**
 * Narrow an event to a surface-eligible event carrying its required marker.
 * @param event - event to test.
 * @returns true when both the type and marker identify a surface event.
 */
export function isSurfaceEvent(event: SessionEvent): event is SurfaceEvent {
  if (!SURFACE_EVENT_TYPES.has(event.type)) return false
  return (event as SessionEvent<SurfaceEventType>).surfaceOp !== undefined
}

/** One replacement operation observed while folding a session surface. */
export interface SurfaceFoldReplacement {
  /** Seq of the event that replaced the prior surface range. */
  seq: number
  /** Declared inclusive start seq of the replaced surface range. */
  start: number
  /** Declared inclusive end seq of the replaced surface range. */
  end: number
  /** Actual surface entries removed by the operation, in surface order. */
  shadowedSeqs: number[]
}

/** Complete result of replaying the surface operations in a session log. */
export interface SurfaceFoldResult {
  /** Current surface event sequences in model-visible order. */
  nodes: number[]
  /** Replacement operations in event order. */
  replacements: SurfaceFoldReplacement[]
}

/** Mutable state shared by complete and incremental folds. */
interface SurfaceFoldState {
  nodes: number[]
  replaceGeneration: number
}

/** Create one empty fold state. */
function createFoldState(): SurfaceFoldState {
  return { nodes: [], replaceGeneration: 0 }
}

/** Apply one event and return replacement metadata when one occurred. */
function applySurfaceEvent(
  state: SurfaceFoldState,
  event: SessionEvent,
): SurfaceFoldReplacement | undefined {
  if (!isSurfaceEligibleType(event.type)) return
  if (!isSurfaceEvent(event)) {
    throw new Error(`surface event "${event.type}" (seq ${event.seq}) carries no surfaceOp marker`)
  }
  if (event.surfaceOp === 'append') {
    state.nodes.push(event.seq)
    return
  }

  const shadowedSeqs = replaceSurface(state, event.seq, event.surfaceOp)
  return {
    seq: event.seq,
    start: event.surfaceOp.start,
    end: event.surfaceOp.end,
    shadowedSeqs,
  }
}

/** Replace one inclusive surface range and return the removed sequences. */
function replaceSurface(
  state: SurfaceFoldState,
  newSeq: number,
  op: Extract<SurfaceOp, { op: 'replace' }>,
): number[] {
  const startIdx = state.nodes.indexOf(op.start)
  if (startIdx === -1) {
    throw new Error(`surface replace: start seq ${op.start} not found in surface`)
  }
  const endIdx = state.nodes.indexOf(op.end)
  if (endIdx === -1) {
    throw new Error(`surface replace: end seq ${op.end} not found in surface`)
  }
  if (startIdx > endIdx) {
    throw new Error(`surface replace: start seq ${op.start} (index ${startIdx}) is after end seq ${op.end} (index ${endIdx})`)
  }

  const shadowedSeqs = state.nodes.splice(startIdx, endIdx - startIdx + 1, newSeq)
  state.replaceGeneration += 1
  return shadowedSeqs
}

/**
 * Replay a complete event log through the canonical surface fold.
 * @param events - events in contiguous seq order.
 * @returns detached current sequences and replacement history.
 * @throws when a surface marker is missing or names an invalid range.
 */
export function foldSurface(events: readonly SessionEvent[]): SurfaceFoldResult {
  const state = createFoldState()
  const replacements: SurfaceFoldReplacement[] = []
  for (const event of events) {
    const replacement = applySurfaceEvent(state, event)
    if (replacement !== undefined) replacements.push(replacement)
  }
  return { nodes: [...state.nodes], replacements }
}

/** Incremental ordered surface view over an append-only session log. */
export class SurfaceManager {
  /** Shared transition state; replacement history is not retained. */
  private _state = createFoldState()
  /** Last processed seq; -1 folds a seeded log on first access. */
  private _lastProcessedSeq = -1

  constructor(private log: readonly SessionEvent[]) {}

  /** Monotonic count of folded positional replacements. */
  get replaceGeneration(): number {
    if (this._lastProcessedSeq < this.log.length - 1) this._processDelta()
    return this._state.replaceGeneration
  }

  /** Surface event sequences in model-visible order. */
  get nodes(): readonly number[] {
    if (this._lastProcessedSeq < this.log.length - 1) this._processDelta()
    return this._state.nodes
  }

  /** Fold events appended since the previous access. */
  private _processDelta(): void {
    for (let i = this._lastProcessedSeq + 1; i < this.log.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bounded by the loop condition
      applySurfaceEvent(this._state, this.log[i]!)
    }
    this._lastProcessedSeq = this.log.length - 1
  }
}
