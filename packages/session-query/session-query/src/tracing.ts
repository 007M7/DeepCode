/** One-shot session-lineage and event-relationship tracing helpers. */

import { foldSurface, isSurfaceEligibleType } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from './config.ts'
import type {
  SessionEventRecord,
  SessionEventTrace,
  SessionLineageNode,
  SessionLineageTrace,
  SessionRecord,
} from './types.ts'

interface EventLogAnalysis {
  records: SessionEventRecord[]
  replacedBy: Map<number, number>
  replacedEventSeqs: Map<number, number[]>
}

/**
 * Classify a raw event log with one canonical surface fold.
 * @param sessionId - owner of the event log.
 * @param events - detached raw event log.
 * @returns lightweight records in ascending log order.
 */
export function eventRecords(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SessionEventRecord[] {
  return analyzeEventLog(sessionId, events).records
}

/**
 * Trace one target after one canonical surface fold and whole-log validation.
 * @param sessionId - owner of the event log.
 * @param events - detached raw event log.
 * @param seq - target event seq.
 * @returns direct surface and provenance relationships.
 */
export function traceEventLog(
  sessionId: SessionId,
  events: readonly SessionEvent[],
  seq: number,
): SessionEventTrace {
  const target = events[seq]
  if (target === undefined || target.seq !== seq) {
    throw new SessionQueryError(
      `session "${sessionId}" has no event at seq ${seq}`,
      'SESSION_QUERY_EVENT_NOT_FOUND',
    )
  }

  const analysis = analyzeEventLog(sessionId, events)
  validateProvenance(events, analysis.replacedEventSeqs)

  const replacementChain: number[] = []
  let replacement = analysis.replacedBy.get(seq)
  while (replacement !== undefined) {
    replacementChain.push(replacement)
    replacement = analysis.replacedBy.get(replacement)
  }

  const sourceEventSeqs = eventSources(target)
  const derivedEventSeqs: number[] = []
  for (const event of events) {
    if (event.seq <= seq) continue
    if (eventSources(event).includes(seq)) derivedEventSeqs.push(event.seq)
  }

  // The target check above proves the parallel record exists at this index.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const targetRecord = analysis.records[seq]!
  const replacedBy = analysis.replacedBy.get(seq)
  return {
    target: { ...targetRecord },
    ...replacedBy === undefined ? {} : { replacedBy },
    replacementChain,
    replacedEventSeqs: [...(analysis.replacedEventSeqs.get(seq) ?? [])],
    sourceEventSeqs: [...sourceEventSeqs],
    derivedEventSeqs,
  }
}

/**
 * Trace one target's known ancestry and recursively known descendants.
 * @param records - complete logical corpus from one observation.
 * @param sessionId - target session id.
 * @returns complete or explicitly partial lineage.
 */
export function traceLineage(
  records: readonly SessionRecord[],
  sessionId: SessionId,
): SessionLineageTrace {
  const byId = new Map(records.map(record => [record.header.id, record]))
  const target = byId.get(sessionId)
  if (target === undefined) {
    throw new SessionQueryError(
      `session "${sessionId}" not found`,
      'SESSION_QUERY_SESSION_NOT_FOUND',
    )
  }

  const ancestors: SessionRecord[] = []
  const ancestrySeen = new Set<SessionId>([sessionId])
  let unresolvedParentId: SessionId | undefined
  let parentId = target.header.parentSession
  while (parentId !== undefined) {
    if (ancestrySeen.has(parentId)) lineageCycle(parentId)
    ancestrySeen.add(parentId)
    const parent = byId.get(parentId)
    if (parent === undefined) {
      unresolvedParentId = parentId
      break
    }
    ancestors.push(parent)
    parentId = parent.header.parentSession
  }

  const childrenByParent = new Map<SessionId, SessionRecord[]>()
  for (const record of records) {
    const parent = record.header.parentSession
    if (parent === undefined) continue
    const children = childrenByParent.get(parent) ?? []
    children.push(record)
    childrenByParent.set(parent, children)
  }
  for (const children of childrenByParent.values()) children.sort(compareSessionsAscending)

  const descendants = buildDescendants(childrenByParent, sessionId)
  const common = {
    target: cloneRecord(target),
    ancestors: ancestors.map(cloneRecord),
    descendants,
  }
  if (unresolvedParentId !== undefined) {
    return { ...common, complete: false, unresolvedParentId }
  }
  return {
    ...common,
    complete: true,
    root: cloneRecord(ancestors.at(-1) ?? target),
  }
}

function analyzeEventLog(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): EventLogAnalysis {
  const folded = safeFold(events)
  const current = new Set(folded.nodes.map(node => node.seq))
  const shadowed = new Set<number>()
  const replacedBy = new Map<number, number>()
  const replacedEventSeqs = new Map<number, number[]>()
  for (const replacement of folded.replacements) {
    const removed = [...replacement.shadowedSeqs]
    replacedEventSeqs.set(replacement.seq, removed)
    for (const removedSeq of removed) {
      shadowed.add(removedSeq)
      replacedBy.set(removedSeq, replacement.seq)
    }
  }
  return {
    records: events.map(event => ({
      sessionId,
      seq: event.seq,
      type: event.type,
      time: event.time,
      surface: current.has(event.seq)
        ? 'current'
        : shadowed.has(event.seq) ? 'shadowed' : 'log-only',
    })),
    replacedBy,
    replacedEventSeqs,
  }
}

function validateProvenance(
  events: readonly SessionEvent[],
  replacedEventSeqs: ReadonlyMap<number, readonly number[]>,
): void {
  for (const event of events) {
    const sources = rawEventSources(event)
    if (sources === undefined) continue
    if (!isSurfaceEligibleType(event.type)) {
      invalidProvenance(`non-surface event at seq ${event.seq} carries sourceEventSeqs`)
    }
    if (!Array.isArray(sources) || sources.length === 0) {
      invalidProvenance(`event at seq ${event.seq} has an empty or invalid sourceEventSeqs`)
    }
    const unique = new Set<unknown>()
    for (const source of sources as unknown[]) {
      if (unique.has(source)) {
        invalidProvenance(`event at seq ${event.seq} repeats source seq ${String(source)}`)
      }
      unique.add(source)
      if (
        typeof source !== 'number'
        || !Number.isInteger(source)
        || source < 0
        || source >= event.seq
        || events[source]?.seq !== source
      ) {
        invalidProvenance(`event at seq ${event.seq} references unknown or non-earlier source seq ${String(source)}`)
      }
    }
  }

  for (const [replacementSeq, removedSeqs] of replacedEventSeqs) {
    // The fold reports only replacement events from the input log.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const replacement = events.find(event => event.seq === replacementSeq)!
    const sources = rawEventSources(replacement)
    if (!Array.isArray(sources)) {
      invalidProvenance(`replacement at seq ${replacementSeq} omits its shadowed surface sources`)
    }
    const sourceSet = new Set(sources as unknown[])
    for (const removedSeq of removedSeqs) {
      if (!sourceSet.has(removedSeq)) {
        invalidProvenance(`replacement at seq ${replacementSeq} omits shadowed surface seq ${removedSeq}`)
      }
    }
  }
}

function rawEventSources(event: SessionEvent): unknown {
  return (event as SessionEvent & { sourceEventSeqs?: unknown }).sourceEventSeqs
}

function eventSources(event: SessionEvent): number[] {
  const sources = rawEventSources(event)
  return Array.isArray(sources) ? sources as number[] : []
}

function safeFold(events: readonly SessionEvent[]): ReturnType<typeof foldSurface> {
  try {
    return foldSurface(events)
  } catch (error: unknown) {
    throw new SessionQueryError(
      /* v8 ignore next -- foldSurface throws Error instances */
      `invalid session surface: ${error instanceof Error ? error.message : 'unknown error'}`,
      'SESSION_QUERY_INVALID_SURFACE',
      { cause: error },
    )
  }
}

function buildDescendants(
  childrenByParent: ReadonlyMap<SessionId, readonly SessionRecord[]>,
  sessionId: SessionId,
): SessionLineageNode[] {
  return (childrenByParent.get(sessionId) ?? []).map(child => ({
    session: cloneRecord(child),
    descendants: buildDescendants(childrenByParent, child.header.id),
  }))
}

function compareSessionsAscending(a: SessionRecord, b: SessionRecord): number {
  return a.header.createdAt - b.header.createdAt || a.header.id.localeCompare(b.header.id)
}

function cloneRecord(record: SessionRecord): SessionRecord {
  return { ...record, header: structuredClone(record.header) }
}

function lineageCycle(id: SessionId): never {
  throw new SessionQueryError(
    `session lineage contains a cycle at "${id}"`,
    'SESSION_QUERY_INVALID_LINEAGE',
  )
}

function invalidProvenance(message: string): never {
  throw new SessionQueryError(
    `invalid session provenance: ${message}`,
    'SESSION_QUERY_INVALID_PROVENANCE',
  )
}
