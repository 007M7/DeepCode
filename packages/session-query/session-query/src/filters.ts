/** Pure provider-independent predicates for logical sessions and event text. */

import type { SessionRecord, SessionEventSearchDocument, SessionEventResultFilter, SessionResultFilter, SessionResultRange } from './types.ts'
import { SessionQueryError } from './config.ts'

/**
 * Apply ANDed logical-session filters while preserving input order.
 * @param records - detached logical-session records to inspect.
 * @param filters - clauses whose list values are ORed within each clause.
 * @returns records accepted by every clause.
 */
export function filterSessionResults<T extends SessionRecord>(
  records: readonly T[],
  filters: readonly SessionResultFilter[] = [],
): T[] {
  const predicates = filters.map(sessionPredicate)
  return records.filter(record => predicates.every(predicate => predicate(record)))
}

/**
 * Apply ANDed event filters to extracted semantic documents.
 * @param documents - semantic documents produced by {@link buildSessionEventSearchDocuments}.
 * @param filters - metadata and literal-text predicates.
 * @returns documents accepted by every clause, in input order.
 */
export function filterSessionEventDocuments<T extends SessionEventSearchDocument>(
  documents: readonly T[],
  filters: readonly SessionEventResultFilter[] = [],
): T[] {
  const predicates = filters.map(eventPredicate)
  return documents.filter(document => predicates.every(predicate => predicate(document)))
}

/**
 * Compile a literal case-insensitive, whitespace-flexible semantic-text match.
 * @param text - caller-provided literal text.
 * @returns Unicode-aware regular expression safe from regex injection.
 */
export function compileSessionTextFilter(text: string): RegExp {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    throw new SessionQueryError(
      'session text filter must contain non-whitespace text',
      'SESSION_QUERY_INVALID_FILTER',
    )
  }
  const pattern = trimmed
    .split(/\s+/u)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('\\s+')
  return new RegExp(pattern, 'iu')
}

function sessionPredicate(filter: SessionResultFilter): (record: SessionRecord) => boolean {
  switch (filter.kind) {
    case 'id':
      return record => filter.values.includes(record.header.id)
    case 'cwd':
      return record => filter.values.includes(record.header.cwd ?? null)
    case 'created-at': {
      const range = validateRange(filter.kind, filter)
      return record => matchesRange(record.header.createdAt, range)
    }
    case 'parent':
      return record => filter.values.includes(record.header.parentSession ?? null)
    case 'availability':
      assertAllowedValues(filter.kind, filter.values, ['live', 'persisted'])
      return record => filter.values.some(value => value === 'live' ? record.live : record.persisted)
  }
}

function eventPredicate(filter: SessionEventResultFilter): (document: SessionEventSearchDocument) => boolean {
  switch (filter.kind) {
    case 'seq': {
      const range = validateRange(filter.kind, filter)
      return document => matchesRange(document.seq, range)
    }
    case 'time': {
      const range = validateRange(filter.kind, filter)
      return document => matchesRange(document.time, range)
    }
    case 'type':
      return document => filter.values.includes(document.type)
    case 'surface':
      assertAllowedValues(filter.kind, filter.values, ['current', 'shadowed', 'log-only'])
      return document => filter.values.includes(document.surface)
    case 'text': {
      const pattern = compileSessionTextFilter(filter.text)
      return document => pattern.test(document.text)
    }
  }
}

function assertAllowedValues(
  name: string,
  values: readonly string[],
  allowed: readonly string[],
): void {
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw new SessionQueryError(
        `session ${name} filter contains unknown value "${value}"`,
        'SESSION_QUERY_INVALID_FILTER',
      )
    }
  }
}

function validateRange(name: string, range: SessionResultRange): SessionResultRange {
  if (range.from !== undefined && !Number.isFinite(range.from)) {
    throw invalidRange(name, 'from must be finite')
  }
  if (range.to !== undefined && !Number.isFinite(range.to)) {
    throw invalidRange(name, 'to must be finite')
  }
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) {
    throw invalidRange(name, 'from must be less than or equal to to')
  }
  return range
}

function matchesRange(value: number, range: SessionResultRange): boolean {
  return (range.from === undefined || value >= range.from)
    && (range.to === undefined || value <= range.to)
}

function invalidRange(name: string, detail: string): SessionQueryError {
  return new SessionQueryError(
    `session ${name} filter ${detail}`,
    'SESSION_QUERY_INVALID_FILTER',
  )
}
