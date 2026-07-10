/** Pure serializable session-query result filters. */

import { assertNever } from '@deepseek-ai/dsh-llm'
import type {
  SessionEventRecord,
  SessionEventResultFilter,
  SessionQueryRange,
  SessionRecord,
  SessionResultFilter,
} from './types.ts'
import { SessionQueryError } from './config.ts'

const AVAILABILITIES = ['live', 'persisted'] as const
const SURFACE_STATES = ['current', 'shadowed', 'log-only'] as const

/**
 * Apply an ordered AND-chain of session filters while preserving item order
 * and the concrete generic item type.
 * @param results - session records or richer session search hits.
 * @param filters - serializable filters applied in order.
 * @returns a fresh filtered array.
 */
export function filterSessionResults<T extends SessionRecord>(
  results: readonly T[],
  filters: readonly SessionResultFilter[],
): T[] {
  for (const filter of filters) validateSessionFilter(filter)
  return results.filter(result => filters.every(filter => matchesSessionFilter(result, filter)))
}

/**
 * Apply an ordered AND-chain of event filters while preserving item order and
 * the concrete generic item type.
 * @param results - event records or richer event search hits.
 * @param filters - serializable filters applied in order.
 * @returns a fresh filtered array.
 */
export function filterEventResults<T extends SessionEventRecord>(
  results: readonly T[],
  filters: readonly SessionEventResultFilter[],
): T[] {
  for (const filter of filters) validateEventFilter(filter)
  return results.filter(result => filters.every(filter => matchesEventFilter(result, filter)))
}

function matchesSessionFilter(record: SessionRecord, filter: SessionResultFilter): boolean {
  switch (filter.kind) {
    case 'id': return filter.values.includes(record.header.id)
    case 'cwd': return filter.values.includes(record.header.cwd ?? null)
    case 'created-at': return inRange(record.header.createdAt, filter.range)
    case 'parent': return filter.values.includes(record.header.parentSession ?? null)
    case 'availability': return filter.values.some(value => value === 'live' ? record.live : record.persisted)
    /* v8 ignore next -- closed discriminated union exhaustiveness guard */
    default: return assertNever(filter)
  }
}

function matchesEventFilter(record: SessionEventRecord, filter: SessionEventResultFilter): boolean {
  switch (filter.kind) {
    case 'seq': return inRange(record.seq, filter.range)
    case 'time': return inRange(record.time, filter.range)
    case 'type': return filter.values.includes(record.type)
    case 'surface': return filter.values.includes(record.surface)
    /* v8 ignore next -- closed discriminated union exhaustiveness guard */
    default: return assertNever(filter)
  }
}

function validateSessionFilter(filter: SessionResultFilter): void {
  switch (filter.kind) {
    case 'id':
    case 'cwd':
    case 'parent':
      return
    case 'created-at':
      validateRange('created-at', filter.range)
      return
    case 'availability':
      for (const value of filter.values) {
        if (!(AVAILABILITIES as readonly string[]).includes(value)) invalidFilter(`unknown availability "${value}"`)
      }
      return
    /* v8 ignore next -- closed discriminated union exhaustiveness guard */
    default:
      assertNever(filter)
  }
}

function validateEventFilter(filter: SessionEventResultFilter): void {
  switch (filter.kind) {
    case 'seq':
    case 'time':
      validateRange(filter.kind, filter.range)
      return
    case 'type':
      return
    case 'surface':
      for (const value of filter.values) {
        if (!(SURFACE_STATES as readonly string[]).includes(value)) invalidFilter(`unknown surface status "${value}"`)
      }
      return
    /* v8 ignore next -- closed discriminated union exhaustiveness guard */
    default:
      assertNever(filter)
  }
}

function validateRange(name: string, range: SessionQueryRange): void {
  if (range.from !== undefined && !Number.isFinite(range.from)) invalidFilter(`${name}.from must be finite`)
  if (range.to !== undefined && !Number.isFinite(range.to)) invalidFilter(`${name}.to must be finite`)
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) {
    invalidFilter(`${name}.from must be <= ${name}.to`)
  }
}

function invalidFilter(message: string): never {
  throw new SessionQueryError(`session-query filter: ${message}`, 'SESSION_QUERY_INVALID_FILTER')
}

function inRange(value: number, range: SessionQueryRange): boolean {
  return (range.from === undefined || value >= range.from)
    && (range.to === undefined || value <= range.to)
}
