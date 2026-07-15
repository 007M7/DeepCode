/** Request normalization, parameterized predicates, and result presentation. */

import {
  SessionQueryError,
  filterSessionEventDocuments,
  filterSessionResults,
} from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventMetadataFilter,
  SessionEventSearchRequest,
  SessionResultFilter,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'

/** Limit defaults needed to normalize a search request. */
export interface QueryLimits {
  /** Page size used when the request omits one. */
  defaultLimit: number
  /** Largest accepted page size. */
  maxLimit: number
}

/** Normalized cross-session request. */
export interface NormalizedSessionRequest {
  query: string
  sessionFilters: readonly SessionResultFilter[]
  eventFilters: readonly SessionEventMetadataFilter[]
  limit: number
  cursor?: string
}

/** Normalized within-session request. */
export interface NormalizedEventRequest {
  sessionId: SessionEventSearchRequest['sessionId']
  query: string
  filters: readonly SessionEventMetadataFilter[]
  limit: number
  cursor?: string
}

/** Parameterized SQL predicate fragment. */
export interface SqlWhere {
  /** SQL without the leading `WHERE`. */
  sql: string
  /** Bindings in placeholder order. */
  params: Array<string | number>
}

/**
 * Validate and canonicalize a cross-session request.
 * @param request - caller-provided query, filters, limit, and cursor.
 * @param limits - configured default and maximum page sizes.
 * @returns normalized request with explicit arrays and limit.
 */
export function normalizeSessionRequest(
  request: SessionSearchRequest,
  limits: QueryLimits,
): NormalizedSessionRequest {
  const sessionFilters = request.sessionFilters ?? []
  const eventFilters = request.eventFilters ?? []
  filterSessionResults([], sessionFilters)
  filterSessionEventDocuments([], eventFilters)
  return {
    query: normalizeQuery(request.query),
    sessionFilters,
    eventFilters,
    limit: normalizeLimit(request.limit, limits),
    ...request.cursor === undefined ? {} : { cursor: request.cursor },
  }
}

/**
 * Validate and canonicalize a within-session request.
 * @param request - caller-provided target, query, filters, limit, and cursor.
 * @param limits - configured default and maximum page sizes.
 * @returns normalized request with an explicit filter array and limit.
 */
export function normalizeEventRequest(
  request: SessionEventSearchRequest,
  limits: QueryLimits,
): NormalizedEventRequest {
  const filters = request.filters ?? []
  filterSessionEventDocuments([], filters)
  return {
    sessionId: request.sessionId,
    query: normalizeQuery(request.query),
    filters,
    limit: normalizeLimit(request.limit, limits),
    ...request.cursor === undefined ? {} : { cursor: request.cursor },
  }
}

/**
 * Compile logical-session predicates against selected-document columns.
 * @param filters - validated ANDed logical-session clauses.
 * @returns parameterized SQL fragment and ordered bindings.
 */
export function buildSessionWhere(filters: readonly SessionResultFilter[]): SqlWhere {
  const clauses: string[] = []
  const params: Array<string | number> = []
  for (const filter of filters) {
    switch (filter.kind) {
      case 'id':
        addList(clauses, params, 'session_id', filter.values)
        break
      case 'cwd':
        addNullableList(clauses, params, 'cwd', filter.values)
        break
      case 'created-at':
        addRange(clauses, params, 'created_at', filter)
        break
      case 'parent':
        addNullableList(clauses, params, 'parent_session', filter.values)
        break
      case 'availability': {
        const availability = [...new Set(filter.values)]
        if (availability.length === 0) clauses.push('0')
        else if (availability.length === 1) clauses.push(`${availability[0]} = 1`)
        break
      }
    }
  }
  return { sql: clauses.join(' AND '), params }
}

/**
 * Compile event metadata predicates against selected-document columns.
 * @param filters - validated ANDed event metadata clauses.
 * @returns parameterized SQL fragment and ordered bindings.
 */
export function buildEventWhere(filters: readonly SessionEventMetadataFilter[]): SqlWhere {
  const clauses: string[] = []
  const params: Array<string | number> = []
  for (const filter of filters) {
    switch (filter.kind) {
      case 'seq':
        addRange(clauses, params, 'seq', filter)
        break
      case 'time':
        addRange(clauses, params, 'time', filter)
        break
      case 'type':
        addList(clauses, params, 'type', filter.values)
        break
      case 'surface':
        addList(clauses, params, 'surface', filter.values)
        break
    }
  }
  return { sql: clauses.join(' AND '), params }
}

/**
 * Quote caller text as one FTS5 phrase so query syntax remains inert data.
 * @param query - normalized caller query.
 * @returns FTS5 expression containing one escaped literal phrase.
 */
export function quoteFtsData(query: string): string {
  return `"${query.replaceAll('"', '""')}"`
}

/**
 * Build the stable normalized request identity stored in opaque cursors.
 * @param request - normalized request whose filter ordering is canonicalized.
 * @returns deterministic JSON identity for cursor binding.
 */
export function requestFingerprint(request: NormalizedSessionRequest | NormalizedEventRequest): string {
  if ('sessionId' in request) {
    return JSON.stringify({
      scope: 'events',
      sessionId: request.sessionId,
      query: request.query,
      filters: canonicalFilters(request.filters),
      limit: request.limit,
    })
  }
  return JSON.stringify({
    scope: 'sessions',
    query: request.query,
    sessionFilters: canonicalFilters(request.sessionFilters),
    eventFilters: canonicalFilters(request.eventFilters),
    limit: request.limit,
  })
}

/**
 * Build a whitespace-normalized excerpt no longer than `maxChars`.
 * @param text - complete extracted semantic document.
 * @param query - normalized literal query used to position the excerpt.
 * @param maxChars - maximum result length in Unicode code points.
 * @returns bounded plain-text snippet.
 */
export function makeSnippet(text: string, query: string, maxChars: number): string {
  const clean = text.replace(/\s+/gu, ' ').trim()
  const characters = Array.from(clean)
  if (characters.length <= maxChars) return clean
  if (maxChars === 1) return '…'
  const foundUnits = clean.toLowerCase().indexOf(query.toLowerCase())
  const found = foundUnits < 0 ? -1 : Array.from(clean.slice(0, foundUnits)).length
  let start = found < 0 ? 0 : Math.max(0, found - Math.floor(maxChars / 3))
  let prefix = start > 0 ? '…' : ''
  let suffix = '…'
  let contentLength = maxChars - prefix.length - suffix.length
  if (contentLength < 1) {
    start = 0
    prefix = ''
    contentLength = maxChars - 1
  }
  let end = Math.min(characters.length, start + contentLength)
  if (end === characters.length) {
    suffix = ''
    contentLength = maxChars - prefix.length
    start = Math.max(0, end - contentLength)
  }
  end = Math.min(characters.length, start + contentLength)
  return `${prefix}${characters.slice(start, end).join('')}${suffix}`
}

function normalizeQuery(value: string): string {
  if (typeof value !== 'string') {
    throw new SessionQueryError('session-search query must be text', 'SESSION_QUERY_INVALID_QUERY')
  }
  const query = value.trim().replace(/\s+/gu, ' ')
  if (query.length === 0) {
    throw new SessionQueryError(
      'session-search query must contain non-whitespace text',
      'SESSION_QUERY_INVALID_QUERY',
    )
  }
  return query
}

function normalizeLimit(value: number | undefined, limits: QueryLimits): number {
  const limit = value ?? limits.defaultLimit
  if (!Number.isInteger(limit) || limit < 1 || limit > limits.maxLimit) {
    throw new SessionQueryError(
      `session-search limit must be an integer between 1 and ${limits.maxLimit}`,
      'SESSION_QUERY_INVALID_LIMIT',
    )
  }
  return limit
}

function addList(
  clauses: string[],
  params: Array<string | number>,
  column: string,
  values: readonly (string | number)[],
): void {
  if (values.length === 0) {
    clauses.push('0')
    return
  }
  clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`)
  params.push(...values)
}

function addNullableList(
  clauses: string[],
  params: Array<string | number>,
  column: string,
  values: readonly (string | null)[],
): void {
  if (values.length === 0) {
    clauses.push('0')
    return
  }
  const concrete = values.filter((value): value is string => value !== null)
  const parts: string[] = []
  if (concrete.length > 0) {
    parts.push(`${column} IN (${concrete.map(() => '?').join(', ')})`)
    params.push(...concrete)
  }
  if (values.includes(null)) parts.push(`${column} IS NULL`)
  clauses.push(`(${parts.join(' OR ')})`)
}

function addRange(
  clauses: string[],
  params: Array<string | number>,
  column: string,
  range: { from?: number; to?: number },
): void {
  if (range.from !== undefined) {
    clauses.push(`CAST(${column} AS INTEGER) >= ?`)
    params.push(range.from)
  }
  if (range.to !== undefined) {
    clauses.push(`CAST(${column} AS INTEGER) <= ?`)
    params.push(range.to)
  }
}

function canonicalFilters(filters: readonly (SessionResultFilter | SessionEventMetadataFilter)[]): unknown[] {
  return filters.map((filter) => {
    if ('values' in filter) {
      return { ...filter, values: [...filter.values].sort(compareNullable) }
    }
    return {
      kind: filter.kind,
      from: filter.from ?? null,
      to: filter.to ?? null,
    }
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  return a.localeCompare(b)
}
