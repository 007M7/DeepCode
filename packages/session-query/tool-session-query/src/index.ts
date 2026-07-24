/**
 * Model-facing, workspace-authorized session-history search and read tools.
 *
 * @module @deepseek-ai/dsh-tool-session-query
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  SessionId,
  type SessionEvent,
  type SessionEventType,
  type SessionHeader,
  type SessionId as SessionIdValue,
} from '@deepseek-ai/dsh-session'
import {
  SessionQueryError,
  extractSessionEventText,
  type SessionAvailability,
  type SessionEventMetadataFilter,
  type SessionEventSearchHit,
  type SessionEventSurface,
  type SessionEventTrace,
  type SessionEventWindow,
  type SessionLineageNode,
  type SessionLineageTrace,
  type SessionRecord,
  type SessionResultFilter,
  type SessionSearchCursor,
  type SessionSearchHit,
} from '@deepseek-ai/dsh-session-query'
import { defineTool, type GenericCallView, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-session-query'

/** Capability services required by the model-facing consumer. */
export const inject = ['tools', 'systemPrompt', 'sessionQuery']

/** Default maximum number of authorized search hits returned by one call. */
export const DEFAULT_MAX_SEARCH_RESULTS = 100

/** Default cooperative deadline for either full-text search tool. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000

/** Deployment-owned search count and timeout bounds. */
export interface Config {
  /** Maximum authorized hits returned by one search call. Defaults to 100. */
  maxSearchResults?: number
  /** Cooperative full-text search deadline in milliseconds. Defaults to 30000. */
  searchTimeoutMs?: number
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  maxSearchResults: z.number().step(1).min(1).default(DEFAULT_MAX_SEARCH_RESULTS),
  searchTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_SEARCH_TIMEOUT_MS),
})

interface ResolvedConfig {
  readonly maxSearchResults: number
  readonly searchTimeoutMs: number
}

interface SessionSearchArgs {
  query: string
  session_ids?: string[]
  created_at_from?: string
  created_at_to?: string
  parent_session_ids?: string[]
  include_root_sessions?: boolean
  availability?: SessionAvailability[]
  event_seq_from?: number
  event_seq_to?: number
  event_time_from?: string
  event_time_to?: string
  event_types?: string[]
  event_surfaces?: SessionEventSurface[]
}

interface EventSearchArgs {
  session_id?: string
  query: string
  seq_from?: number
  seq_to?: number
  time_from?: string
  time_to?: string
  event_types?: string[]
  surfaces?: SessionEventSurface[]
}

interface SessionTargetArgs {
  session_id?: string
}

interface EventTargetArgs extends SessionTargetArgs {
  seq: number
}

interface EventReadArgs extends EventTargetArgs {
  before?: number
  after?: number
}

interface Caller {
  readonly id: SessionIdValue
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

interface TitleView {
  readonly text: string
  readonly unavailableCode?: string
}

interface CompleteTitleMap extends ReadonlyMap<SessionIdValue, TitleView> {
  get(id: SessionIdValue): TitleView
}

interface SearchCollection<T> {
  readonly items: T[]
  readonly capped: boolean
}

interface AuthorizedDescendant {
  readonly record: SessionRecord
  readonly descendants: Array<AuthorizedDescendant | null>
}

const SESSION_SEARCH_PARAMETERS = {
  query: { type: 'string', required: true, description: 'Literal full-text query over prior session history.' },
  session_ids: { type: 'array', items: { type: 'string' }, description: 'Optional session ids to include.' },
  created_at_from: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 creation-time lower bound.' },
  created_at_to: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 creation-time upper bound.' },
  parent_session_ids: { type: 'array', items: { type: 'string' }, description: 'Optional direct parent session ids.' },
  include_root_sessions: { type: 'boolean', description: 'Include sessions with no parent in the parent filter.' },
  availability: {
    type: 'array',
    items: { type: 'string', enum: ['live', 'persisted'] },
    description: 'Require at least one selected source availability.',
  },
  event_seq_from: { type: 'integer', description: 'Inclusive event sequence lower bound.' },
  event_seq_to: { type: 'integer', description: 'Inclusive event sequence upper bound.' },
  event_time_from: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 event-time lower bound.' },
  event_time_to: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 event-time upper bound.' },
  event_types: { type: 'array', items: { type: 'string' }, description: 'Event types to include.' },
  event_surfaces: {
    type: 'array',
    items: { type: 'string', enum: ['current', 'shadowed', 'log-only'] },
    description: 'Event surfaces to include.',
  },
} as const

const EVENT_SEARCH_PARAMETERS = {
  session_id: { type: 'string', description: 'Target session id. Omit for the current session.' },
  query: { type: 'string', required: true, description: 'Literal full-text query over the target session.' },
  seq_from: { type: 'integer', description: 'Inclusive event sequence lower bound.' },
  seq_to: { type: 'integer', description: 'Inclusive event sequence upper bound.' },
  time_from: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 event-time lower bound.' },
  time_to: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 event-time upper bound.' },
  event_types: { type: 'array', items: { type: 'string' }, description: 'Event types to include.' },
  surfaces: {
    type: 'array',
    items: { type: 'string', enum: ['current', 'shadowed', 'log-only'] },
    description: 'Event surfaces to include.',
  },
} as const

const TARGET_SESSION_PARAMETER = {
  session_id: { type: 'string', description: 'Target session id. Omit for the current session.' },
} as const

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const PROMPT_TEXT =
  'Use session_search to find relevant work from prior sessions, or session_event_search to search earlier '
  + 'events in one session. Search results are cursor-free and workspace-scoped. Follow a useful hit with '
  + 'session_trace, session_event_trace, or session_event_read when you need lineage, relationships, or exact data.'

/** Register all five tools and their shared model guidance. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:session-query',
    order: 113,
    text: PROMPT_TEXT,
  })

  ctx.tools.register(defineTool({
    name: 'session_search',
    description: 'Search prior sessions in the caller workspace and return the strongest matching event from each session.',
    parameters: SESSION_SEARCH_PARAMETERS,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.searchTimeoutMs,
    isConcurrencySafe: () => true,
    execute: (args, exec) => executeSessionSearch(ctx, args, exec, resolved.maxSearchResults),
    presentCall: presentSessionSearchCall,
  }))

  ctx.tools.register(defineTool({
    name: 'session_event_search',
    description: 'Search prior events in one authorized session; the current session excludes the step performing this call.',
    parameters: EVENT_SEARCH_PARAMETERS,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.searchTimeoutMs,
    isConcurrencySafe: () => true,
    execute: (args, exec) => executeEventSearch(ctx, args, exec, resolved.maxSearchResults),
    presentCall: presentEventSearchCall,
  }))

  ctx.tools.register(defineTool({
    name: 'session_trace',
    description: 'Read the authorized session lineage around one session, including complete visible ancestor and descendant relationships.',
    parameters: TARGET_SESSION_PARAMETER,
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args, exec) => executeSessionTrace(ctx, args, exec),
    presentCall: presentSessionTraceCall,
  }))

  ctx.tools.register(defineTool({
    name: 'session_event_trace',
    description: 'Read every direct replacement and provenance relationship for one event in an authorized session.',
    parameters: {
      ...TARGET_SESSION_PARAMETER,
      seq: { type: 'integer', required: true, description: 'Target event sequence number.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args, exec) => executeEventTrace(ctx, args, exec),
    presentCall: args => presentEventTargetCall('Trace event', args),
  }))

  ctx.tools.register(defineTool({
    name: 'session_event_read',
    description: 'Read one full unabridged event and optional neighboring raw-event summaries from an authorized session.',
    parameters: {
      ...TARGET_SESSION_PARAMETER,
      seq: { type: 'integer', required: true, description: 'Target event sequence number.' },
      before: { type: 'integer', description: 'Number of preceding raw events to summarize. Omit for none.' },
      after: { type: 'integer', description: 'Number of following raw events to summarize. Omit for none.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args, exec) => executeEventRead(ctx, args, exec),
    presentCall: args => presentEventTargetCall('Read event', args),
  }))
}

function resolveConfig(config: Config): ResolvedConfig {
  const maxSearchResults = config.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS
  const searchTimeoutMs = config.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS
  if (!Number.isSafeInteger(maxSearchResults) || maxSearchResults < 1) {
    throw new TypeError('tool-session-query: maxSearchResults must be a positive safe integer')
  }
  if (!Number.isInteger(searchTimeoutMs) || searchTimeoutMs < 1 || searchTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(
      `tool-session-query: searchTimeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return { maxSearchResults, searchTimeoutMs }
}

function callerOf(exec: ToolRunContext): Caller {
  const agent = exec.agent
  if (agent === undefined) {
    throw new HarnessError(
      'session query tools require an agent-bound caller',
      'SESSION_QUERY_TOOL_MISSING_AGENT',
    )
  }
  return {
    id: agent.session.id,
    header: agent.session.header,
    events: agent.session.events,
  }
}

function targetId(args: SessionTargetArgs, caller: Caller): SessionIdValue {
  return args.session_id === undefined ? caller.id : SessionId(args.session_id)
}

async function authorizeTarget(
  ctx: Context,
  caller: Caller,
  target: SessionIdValue,
  signal: AbortSignal,
): Promise<void> {
  if (target === caller.id) return
  const cwd = caller.header.cwd
  if (cwd === undefined) throw unauthorizedTarget()
  signal.throwIfAborted()
  const records = await ctx.sessionQuery.filterSessions([
    { kind: 'id', values: [target] },
    { kind: 'cwd', values: [cwd] },
  ])
  signal.throwIfAborted()
  if (records.length !== 1) throw unauthorizedTarget()
}

function unauthorizedTarget(): HarnessError {
  return new HarnessError(
    'session target is outside the caller workspace',
    'SESSION_QUERY_TOOL_UNAUTHORIZED',
  )
}

async function executeSessionSearch(
  ctx: Context,
  args: SessionSearchArgs,
  exec: ToolRunContext,
  maxResults: number,
): Promise<string> {
  const caller = callerOf(exec)
  const cwd = caller.header.cwd
  if (cwd === undefined) {
    throw new HarnessError(
      'cross-session search is unavailable because the caller session has no workspace',
      'SESSION_QUERY_TOOL_UNAUTHORIZED',
    )
  }
  const query = normalizeQuery(args.query)
  const sessionFilters = buildSessionFilters(args)
  sessionFilters.push({ kind: 'cwd', values: [cwd] })
  const eventFilters = buildEventFilters({
    seqFrom: args.event_seq_from,
    seqTo: args.event_seq_to,
    timeFrom: args.event_time_from,
    timeTo: args.event_time_to,
    eventTypes: args.event_types,
    surfaces: args.event_surfaces,
  })
  const collected = await collectPages(
    maxResults,
    exec.signal,
    cursor => ctx.sessionQuery.searchSessions({
      query,
      sessionFilters,
      eventFilters,
      ...cursor === undefined ? {} : { cursor },
    }, { signal: exec.signal }),
    hit => hit.header.id !== caller.id && recordAuthorized(hit, caller),
  )

  const parentIds = collected.items
    .map(hit => hit.header.parentSession)
    .filter((id): id is SessionIdValue => id !== undefined)
  const authorizedParents = await authorizeSessionIds(ctx, caller, parentIds, exec.signal)
  const titles = await readTitles(ctx, collected.items.map(hit => hit.header.id), exec.signal)
  return formatSessionSearch(collected, titles, authorizedParents)
}

async function executeEventSearch(
  ctx: Context,
  args: EventSearchArgs,
  exec: ToolRunContext,
  maxResults: number,
): Promise<string> {
  const caller = callerOf(exec)
  const sessionId = targetId(args, caller)
  await authorizeTarget(ctx, caller, sessionId, exec.signal)
  const query = normalizeQuery(args.query)
  const range = sequenceRange(args.seq_from, args.seq_to)
  if (sessionId === caller.id) {
    const stepStart = caller.events.findLast(event => event.type === 'step/start')
    if (stepStart === undefined) {
      throw new HarnessError(
        'current-session search requires an active step boundary',
        'SESSION_QUERY_TOOL_NO_CURRENT_STEP',
      )
    }
    range.to = Math.min(range.to ?? Number.MAX_SAFE_INTEGER, stepStart.seq - 1)
  }
  const title = await readTitle(ctx, sessionId, exec.signal)
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) {
    return formatEventSearch(sessionId, title, { items: [], capped: false })
  }
  const filters = buildEventFilters({
    seqFrom: range.from,
    seqTo: range.to,
    timeFrom: args.time_from,
    timeTo: args.time_to,
    eventTypes: args.event_types,
    surfaces: args.surfaces,
  })
  const collected = await collectPages(
    maxResults,
    exec.signal,
    cursor => ctx.sessionQuery.searchEvents({
      sessionId,
      query,
      filters,
      ...cursor === undefined ? {} : { cursor },
    }, { signal: exec.signal }),
    () => true,
  )
  return formatEventSearch(sessionId, title, collected)
}

async function executeSessionTrace(
  ctx: Context,
  args: SessionTargetArgs,
  exec: ToolRunContext,
): Promise<string> {
  const caller = callerOf(exec)
  const sessionId = targetId(args, caller)
  await authorizeTarget(ctx, caller, sessionId, exec.signal)
  const trace = await ctx.sessionQuery.traceSession(sessionId)
  exec.signal.throwIfAborted()

  const ancestors: SessionRecord[] = []
  let ancestorBoundary = false
  for (const ancestor of trace.ancestors) {
    if (!recordAuthorized(ancestor, caller)) {
      ancestorBoundary = true
      break
    }
    ancestors.push(ancestor)
  }
  if (ancestors.length === trace.ancestors.length && !trace.complete) ancestorBoundary = true
  const descendants = authorizeDescendants(trace.descendants, caller)
  const visibleIds = [
    trace.target.header.id,
    ...ancestors.map(record => record.header.id),
    ...descendantIds(descendants),
  ]
  const titles = await readTitles(ctx, visibleIds, exec.signal)
  return formatSessionTrace(trace, ancestors, ancestorBoundary, descendants, titles)
}

async function executeEventTrace(
  ctx: Context,
  args: EventTargetArgs,
  exec: ToolRunContext,
): Promise<string> {
  assertNonNegativeSafeInteger('seq', args.seq)
  const caller = callerOf(exec)
  const sessionId = targetId(args, caller)
  await authorizeTarget(ctx, caller, sessionId, exec.signal)
  const trace = await ctx.sessionQuery.traceEvent({ sessionId, seq: args.seq })
  exec.signal.throwIfAborted()
  const title = await readTitle(ctx, sessionId, exec.signal)
  return formatEventTrace(sessionId, title, trace)
}

async function executeEventRead(
  ctx: Context,
  args: EventReadArgs,
  exec: ToolRunContext,
): Promise<string> {
  assertNonNegativeSafeInteger('seq', args.seq)
  if (args.before !== undefined) assertNonNegativeSafeInteger('before', args.before)
  if (args.after !== undefined) assertNonNegativeSafeInteger('after', args.after)
  const caller = callerOf(exec)
  const sessionId = targetId(args, caller)
  await authorizeTarget(ctx, caller, sessionId, exec.signal)
  const window = await ctx.sessionQuery.readEvent({
    sessionId,
    seq: args.seq,
    ...args.before === undefined ? {} : { before: args.before },
    ...args.after === undefined ? {} : { after: args.after },
  })
  exec.signal.throwIfAborted()
  const title = await readTitle(ctx, sessionId, exec.signal)
  return formatEventRead(sessionId, title, window)
}

function buildSessionFilters(args: SessionSearchArgs): SessionResultFilter[] {
  const filters: SessionResultFilter[] = []
  if (args.session_ids !== undefined) {
    assertNonEmptyArray('session_ids', args.session_ids)
    filters.push({ kind: 'id', values: args.session_ids.map(SessionId) })
  }
  const created = timestampRange('created_at', args.created_at_from, args.created_at_to)
  if (created !== undefined) filters.push({ kind: 'created-at', ...created })
  if (args.parent_session_ids !== undefined || args.include_root_sessions === true) {
    const values: Array<SessionIdValue | null> = []
    if (args.parent_session_ids !== undefined) {
      assertNonEmptyArray('parent_session_ids', args.parent_session_ids)
      values.push(...args.parent_session_ids.map(SessionId))
    }
    if (args.include_root_sessions === true) values.push(null)
    filters.push({ kind: 'parent', values })
  }
  if (args.availability !== undefined) {
    assertNonEmptyArray('availability', args.availability)
    filters.push({ kind: 'availability', values: args.availability })
  }
  return filters
}

interface EventFilterInput {
  readonly seqFrom?: number | undefined
  readonly seqTo?: number | undefined
  readonly timeFrom?: string | undefined
  readonly timeTo?: string | undefined
  readonly eventTypes?: string[] | undefined
  readonly surfaces?: SessionEventSurface[] | undefined
}

function buildEventFilters(input: EventFilterInput): SessionEventMetadataFilter[] {
  const filters: SessionEventMetadataFilter[] = []
  const seq = sequenceRange(input.seqFrom, input.seqTo)
  if (seq.from !== undefined || seq.to !== undefined) filters.push({ kind: 'seq', ...seq })
  const time = timestampRange('time', input.timeFrom, input.timeTo)
  if (time !== undefined) filters.push({ kind: 'time', ...time })
  if (input.eventTypes !== undefined) {
    assertNonEmptyArray('event_types', input.eventTypes)
    filters.push({ kind: 'type', values: input.eventTypes as SessionEventType[] })
  }
  if (input.surfaces !== undefined) {
    assertNonEmptyArray('surfaces', input.surfaces)
    filters.push({ kind: 'surface', values: input.surfaces })
  }
  return filters
}

function normalizeQuery(value: string): string {
  const query = value.trim().replace(/\s+/gu, ' ')
  if (query.length === 0) {
    throw new SessionQueryError(
      'session-search query must contain non-whitespace text',
      'SESSION_QUERY_INVALID_QUERY',
    )
  }
  if (query.includes('\0')) {
    throw new SessionQueryError(
      'session-search query must not contain NUL',
      'SESSION_QUERY_INVALID_QUERY',
    )
  }
  return query
}

function sequenceRange(
  from: number | undefined,
  to: number | undefined,
): { from?: number; to?: number } {
  if (from !== undefined) assertNonNegativeSafeInteger('sequence lower bound', from)
  if (to !== undefined) assertNonNegativeSafeInteger('sequence upper bound', to)
  if (from !== undefined && to !== undefined && from > to) {
    throw invalidRange('sequence', 'from must be less than or equal to to')
  }
  return {
    ...from === undefined ? {} : { from },
    ...to === undefined ? {} : { to },
  }
}

function timestampRange(
  name: string,
  from: string | undefined,
  to: string | undefined,
): { from?: number; to?: number } | undefined {
  if (from === undefined && to === undefined) return undefined
  const fromMs = from === undefined ? undefined : parseIsoTimestamp(`${name}_from`, from)
  const toMs = to === undefined ? undefined : parseIsoTimestamp(`${name}_to`, to)
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    throw invalidRange(name, 'from must be less than or equal to to')
  }
  return {
    ...fromMs === undefined ? {} : { from: fromMs },
    ...toMs === undefined ? {} : { to: toMs },
  }
}

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):(\d{2}))$/

function parseIsoTimestamp(name: string, value: string): number {
  const match = ISO_TIMESTAMP.exec(value)
  if (match === null) {
    throw invalidRange(name, 'must be an ISO 8601 timestamp with Z or a numeric offset')
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6] ?? 0)
  const offsetHour = Number(match[10] ?? 0)
  const offsetMinute = Number(match[11] ?? 0)
  if (
    month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59
  ) {
    throw invalidRange(name, 'must be a valid ISO 8601 timestamp')
  }
  const timestamp = Date.parse(value)
  return timestamp
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function invalidRange(name: string, detail: string): SessionQueryError {
  return new SessionQueryError(
    `session ${name} range ${detail}`,
    'SESSION_QUERY_INVALID_FILTER',
  )
}

function assertNonNegativeSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SessionQueryError(
      `${name} must be a non-negative safe integer`,
      'SESSION_QUERY_INVALID_FILTER',
    )
  }
}

function assertNonEmptyArray(name: string, values: readonly unknown[]): void {
  if (values.length === 0) {
    throw new SessionQueryError(
      `${name} must contain at least one value when supplied`,
      'SESSION_QUERY_INVALID_FILTER',
    )
  }
}

async function collectPages<T>(
  maxResults: number,
  signal: AbortSignal,
  request: (cursor?: SessionSearchCursor) => Promise<{
    readonly items: readonly T[]
    readonly nextCursor?: SessionSearchCursor
  }>,
  accept: (item: T) => boolean,
): Promise<SearchCollection<T>> {
  const items: T[] = []
  const seen = new Set<SessionSearchCursor>()
  let cursor: SessionSearchCursor | undefined
  while (true) {
    signal.throwIfAborted()
    let page: Awaited<ReturnType<typeof request>>
    try {
      page = await request(cursor)
    } catch (error: unknown) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_STALE_CURSOR') {
        throw new SessionQueryError(
          'session history changed while paging; retry the complete search call',
          'SESSION_QUERY_STALE_CURSOR',
          { cause: error },
        )
      }
      throw error
    }
    signal.throwIfAborted()
    for (const item of page.items) {
      if (!accept(item)) continue
      if (items.length === maxResults) {
        return { items, capped: true }
      }
      items.push(item)
    }
    if (page.nextCursor === undefined) return { items, capped: false }
    if (seen.has(page.nextCursor)) {
      throw new SessionQueryError(
        'session-search provider repeated a continuation cursor',
        'SESSION_QUERY_INVALID_CURSOR',
      )
    }
    seen.add(page.nextCursor)
    cursor = page.nextCursor
  }
}

function recordAuthorized(record: SessionRecord, caller: Caller): boolean {
  if (record.header.id === caller.id) return true
  return caller.header.cwd !== undefined && record.header.cwd === caller.header.cwd
}

async function authorizeSessionIds(
  ctx: Context,
  caller: Caller,
  ids: readonly SessionIdValue[],
  signal: AbortSignal,
): Promise<ReadonlySet<SessionIdValue>> {
  const unique = [...new Set(ids)]
  const authorized = new Set<SessionIdValue>()
  if (unique.includes(caller.id)) authorized.add(caller.id)
  const cwd = caller.header.cwd
  const other = unique.filter(id => id !== caller.id)
  if (cwd === undefined || other.length === 0) return authorized
  signal.throwIfAborted()
  const records = await ctx.sessionQuery.filterSessions([
    { kind: 'id', values: other },
    { kind: 'cwd', values: [cwd] },
  ])
  signal.throwIfAborted()
  for (const record of records) authorized.add(record.header.id)
  return authorized
}

async function readTitles(
  ctx: Context,
  ids: readonly SessionIdValue[],
  signal: AbortSignal,
): Promise<CompleteTitleMap> {
  const result = new Map<SessionIdValue, TitleView>()
  for (const id of new Set(ids)) {
    result.set(id, await readTitle(ctx, id, signal))
  }
  return result as CompleteTitleMap
}

async function readTitle(
  ctx: Context,
  id: SessionIdValue,
  signal: AbortSignal,
): Promise<TitleView> {
  signal.throwIfAborted()
  try {
    const title = await ctx.sessionQuery.readTitle(id)
    signal.throwIfAborted()
    return { text: title?.title ?? 'untitled' }
  } catch (error: unknown) {
    if (signal.aborted) signal.throwIfAborted()
    const code = error instanceof HarnessError ? error.code : 'UNKNOWN'
    ctx.logger.warn(`tool-session-query: title read failed for session "${id}": ${fullError(error)}`)
    return { text: 'untitled', unavailableCode: code }
  }
}

function fullError(error: unknown): string {
  return error instanceof Error ? error.stack ?? String(error) : String(error)
}

function authorizeDescendants(
  nodes: readonly SessionLineageNode[],
  caller: Caller,
): Array<AuthorizedDescendant | null> {
  return nodes.map((node) => {
    if (!recordAuthorized(node.session, caller)) return null
    return {
      record: node.session,
      descendants: authorizeDescendants(node.descendants, caller),
    }
  })
}

function descendantIds(nodes: readonly (AuthorizedDescendant | null)[]): SessionIdValue[] {
  const ids: SessionIdValue[] = []
  for (const node of nodes) {
    if (node === null) continue
    ids.push(node.record.header.id, ...descendantIds(node.descendants))
  }
  return ids
}

function titleText(view: TitleView): string {
  return view.unavailableCode === undefined
    ? view.text
    : `${view.text} (title unavailable: ${view.unavailableCode})`
}

function formatSessionSearch(
  collected: SearchCollection<SessionSearchHit>,
  titles: CompleteTitleMap,
  authorizedParents: ReadonlySet<SessionIdValue>,
): string {
  if (collected.items.length === 0) return 'No prior session matches found.'
  const lines = [`Session search results (${collected.items.length}):`]
  for (const [index, hit] of collected.items.entries()) {
    const parent = hit.header.parentSession === undefined
      ? 'root'
      : authorizedParents.has(hit.header.parentSession)
        ? hit.header.parentSession
        : '[outside workspace]'
    const availability = [
      hit.live ? 'live' : undefined,
      hit.persisted ? 'persisted' : undefined,
    ].filter((value): value is string => value !== undefined).join(', ') || 'unavailable'
    lines.push(
      '',
      `${index + 1}. Session ${hit.header.id} — ${titleText(titles.get(hit.header.id))}`,
      `   Created: ${formatTime(hit.header.createdAt)}`,
      `   Parent: ${parent}`,
      `   Availability: ${availability}`,
      `   Best match: seq ${hit.bestMatch.seq} | ${hit.bestMatch.type} | ${hit.bestMatch.surface} | ${formatTime(hit.bestMatch.time)}`,
      `   Snippet: ${hit.bestMatch.snippet}`,
    )
  }
  if (collected.capped) {
    lines.push('', 'Result cap reached. Narrow the query or add filters to find additional matches.')
  }
  return lines.join('\n')
}

function formatEventSearch(
  sessionId: SessionIdValue,
  title: TitleView,
  collected: SearchCollection<SessionEventSearchHit>,
): string {
  const lines = [`Session ${sessionId} — ${titleText(title)}`]
  if (collected.items.length === 0) {
    lines.push('', 'No prior event matches found.')
    return lines.join('\n')
  }
  lines.push('', `Event search results (${collected.items.length}):`)
  for (const [index, hit] of collected.items.entries()) {
    lines.push(
      `${index + 1}. seq ${hit.seq} | ${hit.type} | ${hit.surface} | ${formatTime(hit.time)}`,
      `   Snippet: ${hit.snippet}`,
    )
  }
  if (collected.capped) {
    lines.push('', 'Result cap reached. Narrow the query or add filters to find additional matches.')
  }
  return lines.join('\n')
}

function formatSessionTrace(
  trace: SessionLineageTrace,
  ancestors: readonly SessionRecord[],
  ancestorBoundary: boolean,
  descendants: readonly (AuthorizedDescendant | null)[],
  titles: CompleteTitleMap,
): string {
  const lines = [
    `Session ${trace.target.header.id} — ${titleText(titles.get(trace.target.header.id))}`,
    `Created: ${formatTime(trace.target.header.createdAt)}`,
    `Availability: ${availabilityText(trace.target)}`,
    '',
    'Ancestors (nearest first):',
  ]
  if (ancestors.length === 0 && !ancestorBoundary) lines.push('- none (target is a root session)')
  for (const record of ancestors) {
    lines.push(`- ${record.header.id} — ${titleText(titles.get(record.header.id))} | ${formatTime(record.header.createdAt)} | ${availabilityText(record)}`)
  }
  if (ancestorBoundary) lines.push('- [outside workspace boundary]')
  lines.push('', 'Descendants:')
  if (descendants.length === 0) lines.push('- none')
  else renderDescendants(lines, descendants, titles, 0)
  return lines.join('\n')
}

function renderDescendants(
  lines: string[],
  nodes: readonly (AuthorizedDescendant | null)[],
  titles: CompleteTitleMap,
  depth: number,
): void {
  for (const node of nodes) {
    const indent = '  '.repeat(depth)
    if (node === null) {
      lines.push(`${indent}- [outside workspace subtree]`)
      continue
    }
    const id = node.record.header.id
    lines.push(`${indent}- ${id} — ${titleText(titles.get(id))} | ${formatTime(node.record.header.createdAt)} | ${availabilityText(node.record)}`)
    renderDescendants(lines, node.descendants, titles, depth + 1)
  }
}

function formatEventTrace(
  sessionId: SessionIdValue,
  title: TitleView,
  trace: SessionEventTrace,
): string {
  return [
    `Session ${sessionId} — ${titleText(title)}`,
    `Target: seq ${trace.target.seq} | ${trace.target.type} | ${trace.target.surface} | ${formatTime(trace.target.time)}`,
    `Replaced by: ${trace.replacedBy ?? 'none'}`,
    `Replacement chain: ${seqList(trace.replacementChain)}`,
    `Events replaced by target: ${seqList(trace.replacedEventSeqs)}`,
    `Direct provenance sources: ${seqList(trace.sourceEventSeqs)}`,
    `Direct derived events: ${seqList(trace.derivedEventSeqs)}`,
  ].join('\n')
}

function formatEventRead(
  sessionId: SessionIdValue,
  title: TitleView,
  window: SessionEventWindow,
): string {
  const before = window.events.filter(event => event.seq < window.target.seq)
  const after = window.events.filter(event => event.seq > window.target.seq)
  const lines = [
    `Session ${sessionId} — ${titleText(title)}`,
    `Target event seq ${window.target.seq}:`,
    '```json',
    JSON.stringify(window.target, null, 2),
    '```',
  ]
  if (before.length > 0) {
    lines.push('', 'Before:')
    for (const event of before) lines.push(formatNeighbor(event))
  }
  if (after.length > 0) {
    lines.push('', 'After:')
    for (const event of after) lines.push(formatNeighbor(event))
  }
  return lines.join('\n')
}

function formatNeighbor(event: SessionEvent): string {
  const text = extractSessionEventText(event)
  return `- seq ${event.seq} | ${event.type} | ${formatTime(event.time)}`
    + (text.length === 0 ? ' | (no semantic text)' : `\n  ${text.replaceAll('\n', '\n  ')}`)
}

function availabilityText(record: SessionRecord): string {
  return [
    record.live ? 'live' : undefined,
    record.persisted ? 'persisted' : undefined,
  ].filter((value): value is string => value !== undefined).join(', ') || 'unavailable'
}

function seqList(values: readonly number[]): string {
  return values.length === 0 ? 'none' : values.join(', ')
}

function formatTime(value: number): string {
  return new Date(value).toISOString()
}

function presentSessionSearchCall(args: SessionSearchArgs): GenericCallView {
  return { card: 'generic', kind: 'search', title: 'Search prior sessions', rawInput: args.query }
}

function presentEventSearchCall(args: EventSearchArgs): GenericCallView {
  return { card: 'generic', kind: 'search', title: 'Search session events', rawInput: args.query }
}

function presentSessionTraceCall(args: SessionTargetArgs): GenericCallView {
  return {
    card: 'generic',
    kind: 'read',
    title: args.session_id === undefined ? 'Trace current session' : `Trace session ${args.session_id}`,
    ...args.session_id === undefined ? {} : { rawInput: args.session_id },
  }
}

function presentEventTargetCall(
  action: string,
  args: EventTargetArgs,
): GenericCallView {
  return {
    card: 'generic',
    kind: 'read',
    title: `${action} ${args.seq}`,
    rawInput: {
      ...args.session_id === undefined ? {} : { session_id: args.session_id },
      seq: args.seq,
    },
  }
}
