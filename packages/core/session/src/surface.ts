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

/** A validated replacement transition that has not mutated fold state yet. */
interface SurfaceReplacePlan extends SurfaceFoldReplacement {
  kind: 'replace'
  startIdx: number
  endIdx: number
}

/** One validated surface transition that has not mutated fold state yet. */
type SurfacePlan =
  | { kind: 'append'; seq: number }
  | SurfaceReplacePlan

/** Create an empty surface fold state. */
function createFoldState(): SurfaceFoldState {
  return { nodes: [], replaceGeneration: 0 }
}

/** Whether a runtime value is a non-negative safe event sequence. */
function isEventSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Whether a runtime value is the exact positional-replacement shape. */
function isReplaceOp(value: object): value is Extract<SurfaceOp, { op: 'replace' }> {
  const op = value as Record<string, unknown>
  return Object.keys(op).length === 3
    && Object.hasOwn(op, 'op')
    && Object.hasOwn(op, 'start')
    && Object.hasOwn(op, 'end')
    && op['op'] === 'replace'
    && isEventSeq(op['start'])
    && isEventSeq(op['end'])
}

/** Validate event-local surface eligibility and return its operation. */
function surfaceOpOf(event: SessionEvent): SurfaceOp | undefined {
  const raw = event as SessionEvent & { surfaceOp?: unknown; sourceEventSeqs?: unknown }
  if (!isSurfaceEligibleType(event.type)) {
    if (raw.surfaceOp !== undefined) {
      throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry surfaceOp`)
    }
    if (raw.sourceEventSeqs !== undefined) {
      throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry sourceEventSeqs`)
    }
    return
  }
  const op = raw.surfaceOp
  if (op === undefined) {
    throw new Error(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`)
  }
  if (op === 'append') return op
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    throw new Error(`session event "${event.type}" carries an invalid surfaceOp`)
  }
  if (!isReplaceOp(op)) {
    throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`)
  }
  return op
}

/** Validate provenance against prior log entries and the replacement range. */
function assertProvenance(
  event: SessionEvent,
  shadowedSeqs: readonly number[],
): void {
  const raw = (event as SessionEvent & { sourceEventSeqs?: unknown }).sourceEventSeqs
  const sources = new Set<number>()
  if (raw !== undefined) {
    if (!Array.isArray(raw)) {
      throw new Error(`sourceEventSeqs on event at seq ${event.seq} must be an array when present`)
    }
    if (raw.length === 0 && event.type !== 'assistant/message') {
      throw new Error('sourceEventSeqs must not be empty except on assistant/message')
    }
    let nonEarlierSource: number | undefined
    for (const source of raw) {
      if (!isEventSeq(source)) {
        throw new Error(`session event "${event.type}" sourceEventSeqs must densely contain non-negative safe integers`)
      }
      sources.add(source)
      if (nonEarlierSource === undefined && source >= event.seq) nonEarlierSource = source
    }
    if (sources.size !== raw.length) {
      throw new Error('sourceEventSeqs must not contain duplicates')
    }
    if (nonEarlierSource !== undefined) {
      throw new Error(`sourceEventSeqs must reference earlier events: ${nonEarlierSource} >= current seq ${event.seq}`)
    }
  }
  const missing = shadowedSeqs.filter(seq => !sources.has(seq))
  if (missing.length > 0) {
    throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`)
  }
}

/** Locate one replacement range without mutating the current fold state. */
function replacementRange(
  state: SurfaceFoldState,
  op: Extract<SurfaceOp, { op: 'replace' }>,
): Pick<SurfaceReplacePlan, 'startIdx' | 'endIdx' | 'shadowedSeqs'> {
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
  return {
    startIdx,
    endIdx,
    shadowedSeqs: state.nodes.slice(startIdx, endIdx + 1),
  }
}

/** Validate one event at its replay boundary and prepare its atomic fold transition. */
function planSurfaceEvent(
  state: SurfaceFoldState,
  event: SessionEvent,
  expectedSeq: number,
): SurfacePlan | undefined {
  if (event.seq !== expectedSeq) {
    throw new Error(`session event seq ${event.seq} is not contiguous; expected ${expectedSeq}`)
  }
  const surfaceOp = surfaceOpOf(event)
  if (surfaceOp === undefined) return
  if (surfaceOp === 'append') {
    assertProvenance(event, [])
    return { kind: 'append', seq: event.seq }
  }
  const range = replacementRange(state, surfaceOp)
  assertProvenance(event, range.shadowedSeqs)
  return {
    kind: 'replace',
    seq: event.seq,
    start: surfaceOp.start,
    end: surfaceOp.end,
    ...range,
  }
}

/** Apply one event and return replacement metadata only when one occurred. */
function applySurfaceEvent(
  state: SurfaceFoldState,
  event: SessionEvent,
  expectedSeq: number,
): SurfaceFoldReplacement | undefined {
  const plan = planSurfaceEvent(state, event, expectedSeq)
  if (plan?.kind === 'append') {
    state.nodes.push(plan.seq)
  } else if (plan?.kind === 'replace') {
    state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq)
    state.replaceGeneration += 1
  }
  if (plan?.kind !== 'replace') return
  return {
    seq: plan.seq,
    start: plan.start,
    end: plan.end,
    shadowedSeqs: plan.shadowedSeqs,
  }
}

/**
 * Replay a complete session log through the canonical surface fold.
 * @param events - session events in contiguous seq order.
 * @returns detached current sequences and replacement history.
 * @throws when an event violates surface metadata, provenance, or range rules.
 */
export function foldSurface(events: readonly SessionEvent[]): SurfaceFoldResult {
  const state = createFoldState()
  const replacements: SurfaceFoldReplacement[] = []
  for (const [index, event] of events.entries()) {
    const replacement = applySurfaceEvent(state, event, index)
    if (replacement !== undefined) replacements.push(replacement)
  }
  return { nodes: [...state.nodes], replacements }
}

/** Incremental ordered surface view and append-boundary validator. */
export class SurfaceManager {
  /** Shared transition state; replacement history is not retained. */
  private _state = createFoldState()
  /** Last processed seq; -1 folds a seeded log on first access. */
  private _lastProcessedSeq = -1

  constructor(private log: readonly SessionEvent[]) {}

  /**
   * Validate the next candidate without mutating the committed surface.
   * @param event - candidate event that has not entered the log yet.
   */
  validateNext(event: SessionEvent): void {
    if (this._lastProcessedSeq < this.log.length - 1) this._processDelta()
    planSurfaceEvent(this._state, event, this.log.length)
  }

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
      applySurfaceEvent(this._state, this.log[i]!, i)
      this._lastProcessedSeq = i
    }
  }
}
