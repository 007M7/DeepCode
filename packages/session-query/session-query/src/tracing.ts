/** Session lineage and event surface/provenance tracing. */

import { foldSurface, isSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionEventRecord,
  SessionEventTrace,
  SessionLineageNode,
  SessionLineageTrace,
  SessionRecord,
} from './types.ts'
import { SessionQueryError } from './config.ts'

/**
 * Classify raw events against the canonical surface fold.
 * @param sessionId - owner of the event log.
 * @param events - detached raw log.
 * @returns lightweight records in seq order.
 */
export function eventRecords(sessionId: SessionId, events: readonly SessionEvent[]): SessionEventRecord[] {
  const fold = safeFold(events)
  const current = new Set(fold.nodes.map(node => node.seq))
  const shadowed = new Set(fold.replacements.flatMap(replacement => replacement.shadowedSeqs))
  return events.map(event => ({
    sessionId,
    seq: event.seq,
    type: event.type,
    time: event.time,
    surface: current.has(event.seq) ? 'current' : shadowed.has(event.seq) ? 'shadowed' : 'log-only',
  }))
}

/**
 * Build one event trace from a validated logical event log.
 * @param sessionId - owner of the event log.
 * @param events - detached raw log.
 * @param seq - target event seq.
 * @returns direct provenance and replacement relationships.
 */
export function traceEventLog(sessionId: SessionId, events: readonly SessionEvent[], seq: number): SessionEventTrace {
  const target = events[seq]
  if (target === undefined || target.seq !== seq) {
    throw new SessionQueryError(`session "${sessionId}" has no event at seq ${seq}`, 'SESSION_QUERY_EVENT_NOT_FOUND')
  }
  const records = eventRecords(sessionId, events)
  const fold = safeFold(events)
  const shadowedBy = new Map<number, number>()
  const shadows = new Map<number, number[]>()
  for (const replacement of fold.replacements) {
    shadows.set(replacement.seq, [...replacement.shadowedSeqs])
    for (const shadowed of replacement.shadowedSeqs) shadowedBy.set(shadowed, replacement.seq)
  }
  const references: number[] = []
  const referencedBy: number[] = []
  for (const event of events) {
    if (!isSurfaceEvent(event)) continue
    for (const source of event.sourceEventSeqs ?? []) {
      if (event.seq === seq) references.push(source)
      if (source === seq) referencedBy.push(event.seq)
    }
  }
  const replacementChain: number[] = []
  let replacement = shadowedBy.get(seq)
  while (replacement !== undefined) {
    replacementChain.push(replacement)
    replacement = shadowedBy.get(replacement)
  }
  const immediate = shadowedBy.get(seq)
  // seq was checked against the contiguous event log, so its parallel record exists.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const targetRecord = records[seq]!
  return {
    target: { ...targetRecord },
    ...immediate !== undefined ? { shadowedBy: immediate } : {},
    replacementChain,
    shadows: shadows.get(seq) ?? [],
    references,
    referencedBy,
  }
}

/**
 * Trace ancestry and descendants within one materialized logical corpus.
 * @param records - complete visible logical corpus.
 * @param sessionId - target session id.
 * @returns complete known lineage or explicit unresolved parent.
 */
export function traceLineage(records: readonly SessionRecord[], sessionId: SessionId): SessionLineageTrace {
  const byId = new Map(records.map(record => [record.header.id, record]))
  const target = byId.get(sessionId)
  if (target === undefined) {
    throw new SessionQueryError(`session "${sessionId}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND')
  }

  const parents: SessionRecord[] = []
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
    parents.push(parent)
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
  const buildChildren = (id: SessionId): SessionLineageNode[] => (childrenByParent.get(id) ?? []).map(child => ({
    session: cloneRecord(child),
    children: buildChildren(child.header.id),
  }))

  return {
    target: cloneRecord(target),
    parents: parents.map(cloneRecord),
    ...unresolvedParentId !== undefined
      ? { unresolvedParentId }
      : { root: cloneRecord(parents.at(-1) ?? target) },
    children: buildChildren(sessionId),
  }
}

function safeFold(events: readonly SessionEvent[]): ReturnType<typeof foldSurface> {
  try {
    return foldSurface(events)
  } catch (error: unknown) {
    throw new SessionQueryError(`invalid session surface: ${errorMessage(error)}`, 'SESSION_QUERY_INVALID_SURFACE', { cause: error })
  }
}

function cloneRecord(record: SessionRecord): SessionRecord {
  return { ...record, header: structuredClone(record.header) }
}

function compareSessionsAscending(a: SessionRecord, b: SessionRecord): number {
  return a.header.createdAt - b.header.createdAt || a.header.id.localeCompare(b.header.id)
}

function lineageCycle(id: SessionId): never {
  throw new SessionQueryError(`session lineage contains a cycle at "${id}"`, 'SESSION_QUERY_INVALID_LINEAGE')
}

function errorMessage(error: unknown): string {
  /* v8 ignore next -- foldSurface throws Error instances */
  return error instanceof Error ? error.message : 'unknown error'
}
