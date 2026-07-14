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
  knownSeqs: Set<number>
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
function createFoldState(replaceGeneration = 0): SurfaceFoldState {
  return {
    nodes: [],
    nodeBySeq: new Map(),
    knownSeqs: new Set(),
    replaceGeneration,
  }
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

/** Validate event-local metadata and narrow a surface-eligible event. */
function surfaceEventOf(event: SessionEvent): SurfaceEvent | undefined {
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
  if (raw.surfaceOp === undefined) {
    throw new Error(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`)
  }
  if (raw.surfaceOp !== 'append') {
    if (raw.surfaceOp === null || typeof raw.surfaceOp !== 'object' || Array.isArray(raw.surfaceOp)) {
      throw new Error(`session event "${event.type}" carries an invalid surfaceOp`)
    }
    if (!isReplaceOp(raw.surfaceOp)) {
      throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`)
    }
  }
  if (raw.sourceEventSeqs !== undefined && !Array.isArray(raw.sourceEventSeqs)) {
    throw new Error(`sourceEventSeqs on event at seq ${event.seq} must be an array when present`)
  }
  if (Array.isArray(raw.sourceEventSeqs) && !raw.sourceEventSeqs.every(isEventSeq)) {
    throw new Error(`session event "${event.type}" sourceEventSeqs must contain non-negative safe integers`)
  }
  return event as SurfaceEvent
}

/** Validate provenance against prior log entries and the replacement range. */
function assertProvenance(
  event: SurfaceEvent,
  knownSeqs: ReadonlySet<number>,
  shadowedSeqs: readonly number[],
): void {
  const sources = event.sourceEventSeqs
  if (sources !== undefined && sources.length === 0) {
    throw new Error('sourceEventSeqs must not be empty when present')
  }
  const sourceSet = new Set(sources ?? [])
  if (sources !== undefined && sourceSet.size !== sources.length) {
    throw new Error('sourceEventSeqs must not contain duplicates')
  }
  for (const source of sources ?? []) {
    if (source >= event.seq) {
      throw new Error(`sourceEventSeqs must reference earlier events: ${source} >= current seq ${event.seq}`)
    }
    if (!knownSeqs.has(source)) {
      throw new Error(`sourceEventSeqs references unknown seq ${source}`)
    }
  }
  const missing = shadowedSeqs.filter(seq => !sourceSet.has(seq))
  if (missing.length > 0) {
    throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`)
  }
}

/** Locate one replacement range without mutating the current fold state. */
function replacementRange(
  state: SurfaceFoldState,
  op: Extract<SurfaceOp, { op: 'replace' }>,
): Pick<SurfaceReplacePlan, 'startIdx' | 'endIdx' | 'shadowedSeqs'> {
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
  return {
    startIdx,
    endIdx,
    shadowedSeqs: state.nodes.slice(startIdx, endIdx + 1).map(node => node.seq),
  }
}

/** Validate one event and prepare its atomic fold transition. */
function planSurfaceEvent(state: SurfaceFoldState, event: SessionEvent): SurfacePlan | undefined {
  const surfaceEvent = surfaceEventOf(event)
  if (surfaceEvent === undefined) return
  if (surfaceEvent.surfaceOp === 'append') {
    assertProvenance(surfaceEvent, state.knownSeqs, [])
    return { kind: 'append', seq: event.seq }
  }
  const range = replacementRange(state, surfaceEvent.surfaceOp)
  assertProvenance(surfaceEvent, state.knownSeqs, range.shadowedSeqs)
  return {
    kind: 'replace',
    seq: event.seq,
    start: surfaceEvent.surfaceOp.start,
    end: surfaceEvent.surfaceOp.end,
    ...range,
  }
}

/** Apply one already-validated positional replacement. */
function replaceSurface(state: SurfaceFoldState, plan: SurfaceReplacePlan): void {
  const { startIdx, endIdx } = plan

  const removed = state.nodes.splice(startIdx, endIdx - startIdx + 1)
  for (const node of removed) state.nodeBySeq.delete(node.seq)

  const prevNode = startIdx > 0 ? state.nodes[startIdx - 1] : undefined
  const nextNode = startIdx < state.nodes.length ? state.nodes[startIdx] : undefined
  const newNode: SurfaceNode = {
    seq: plan.seq,
    prev: prevNode?.seq ?? null,
    next: nextNode?.seq ?? null,
  }
  if (prevNode) prevNode.next = plan.seq
  if (nextNode) nextNode.prev = plan.seq
  state.nodes.splice(startIdx, 0, newNode)
  state.nodeBySeq.set(plan.seq, newNode)
  state.replaceGeneration += 1
}

/** Apply one event and return replacement metadata only when one occurred. */
function applySurfaceEvent(
  state: SurfaceFoldState,
  event: SessionEvent,
): SurfaceFoldReplacement | undefined {
  const plan = planSurfaceEvent(state, event)
  if (plan?.kind === 'append') {
    const tail = state.nodes.at(-1)
    const node: SurfaceNode = { seq: plan.seq, prev: tail?.seq ?? null, next: null }
    if (tail) tail.next = plan.seq
    state.nodes.push(node)
    state.nodeBySeq.set(plan.seq, node)
  } else if (plan?.kind === 'replace') {
    replaceSurface(state, plan)
  }
  state.knownSeqs.add(event.seq)
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
 *
 * The returned arrays and nodes are detached snapshots. The incremental
 * {@link SurfaceManager} uses the same transition functions, so query read
 * models cannot disagree with `deriveMessages()` about replacement ranges.
 * @param events - session events in contiguous seq order.
 * @returns the current surface and every positional replacement.
 * @throws when any event violates the unified surface contract: metadata must
 * be well shaped and type-eligible, provenance must name unique known earlier
 * events, and a positional replacement must name and cite its complete range.
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
 * Maintains a cached linked list of surface nodes and validates each candidate
 * before it enters the event log. Because the log is append-only, it processes
 * only committed deltas and plans the candidate without mutation rather than
 * rescanning the whole log.
 */
export class SurfaceManager {
  /** Incremental state shared with the complete surface fold. */
  private _state = createFoldState()
  /** The last processed seq. -1 forces a full rebuild on first access. */
  private _lastProcessedSeq = -1

  constructor(private log: readonly SessionEvent[]) {}

  /**
   * Validate one candidate as the next log event without applying it. The
   * committed log is folded first, then the candidate's complete surface and
   * provenance transition is planned atomically; a failure leaves the current
   * surface unchanged.
   * @param event - candidate event that has not entered `log` yet.
   */
  validateNext(event: SessionEvent): void {
    if (this._lastProcessedSeq < this.log.length - 1) this._processDelta()
    planSurfaceEvent(this._state, event)
  }

  /**
   * Reset to unprocessed state. Call after the log has been replaced
   * wholesale (e.g. after Session seed). Not needed for normal appends —
   * those are picked up incrementally.
   */
  invalidate(): void {
    this._lastProcessedSeq = -1
    // A wholesale rebuild is a rewrite: bump the generation so incremental
    // consumers (the session's derived-message cache) discard their view.
    this._state = createFoldState(this._state.replaceGeneration + 1)
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
      this._lastProcessedSeq = i
    }
  }
}
