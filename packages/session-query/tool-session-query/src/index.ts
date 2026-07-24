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
  type SessionEventSearchPage,
  type SessionEventSearchHit,
  type SessionEventSurface,
  type SessionEventTraceObservation,
  type SessionEventWindow,
  type SessionLineageNode,
  type SessionLineageTrace,
  type SessionRecord,
  type SessionResultFilter,
  type SessionQueryErrorCode,
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

interface DescendantProjectionFrame {
  readonly node: SessionLineageNode
  readonly target: Array<AuthorizedDescendant | null>
  readonly next: DescendantProjectionFrame | undefined
}

interface DescendantVisit {
  readonly node: AuthorizedDescendant | null
  readonly depth: number
  readonly next: DescendantVisit | undefined
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

interface ModelSafeServiceFailure {
  readonly code: SessionQueryErrorCode | 'SESSION_QUERY_TOOL_FAILED'
  readonly message: string
}

const UNPRINTABLE_SERVICE_ERROR = '[unprintable session query failure]'

const SAFE_SESSION_QUERY_FAILURES = {
  SESSION_QUERY_ABORTED: {
    code: 'SESSION_QUERY_ABORTED',
    message: 'session query was cancelled',
  },
  SESSION_QUERY_EVENT_NOT_FOUND: {
    code: 'SESSION_QUERY_EVENT_NOT_FOUND',
    message: 'session event was not found',
  },
  SESSION_QUERY_INDEX_FAILED: {
    code: 'SESSION_QUERY_INDEX_FAILED',
    message: 'session search index is unavailable',
  },
  SESSION_QUERY_INVALID_CONFIG: {
    code: 'SESSION_QUERY_TOOL_FAILED',
    message: 'session query operation failed',
  },
  SESSION_QUERY_INVALID_CURSOR: {
    code: 'SESSION_QUERY_INVALID_CURSOR',
    message: 'session search continuation is invalid',
  },
  SESSION_QUERY_INVALID_FILTER: {
    code: 'SESSION_QUERY_INVALID_FILTER',
    message: 'session query filters were rejected',
  },
  SESSION_QUERY_INVALID_LIMIT: {
    code: 'SESSION_QUERY_INVALID_LIMIT',
    message: 'session query result limit was rejected',
  },
  SESSION_QUERY_INVALID_QUERY: {
    code: 'SESSION_QUERY_INVALID_QUERY',
    message: 'session query was rejected',
  },
  SESSION_QUERY_INVALID_LINEAGE: {
    code: 'SESSION_QUERY_INVALID_LINEAGE',
    message: 'session lineage is invalid',
  },
  SESSION_QUERY_INVALID_SURFACE: {
    code: 'SESSION_QUERY_INVALID_SURFACE',
    message: 'session event history is invalid',
  },
  SESSION_QUERY_INVALID_WINDOW: {
    code: 'SESSION_QUERY_INVALID_WINDOW',
    message: 'session event window is invalid',
  },
  SESSION_QUERY_PERSISTENCE_FAILED: {
    code: 'SESSION_QUERY_PERSISTENCE_FAILED',
    message: 'session history storage is unavailable',
  },
  SESSION_QUERY_SESSION_NOT_FOUND: {
    code: 'SESSION_QUERY_SESSION_NOT_FOUND',
    message: 'session was not found',
  },
  SESSION_QUERY_STALE_CURSOR: {
    code: 'SESSION_QUERY_STALE_CURSOR',
    message: 'session history changed while paging; retry the complete search call',
  },
  SESSION_QUERY_SOURCE_CONFLICT: {
    code: 'SESSION_QUERY_TOOL_FAILED',
    message: 'session query operation failed',
  },
} satisfies Record<SessionQueryErrorCode, ModelSafeServiceFailure>

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
    execute: (args, exec) => executeSessionSearch(ctx, args, exec, resolved.maxSearchResults),
    presentCall: presentSessionSearchCall,
  }))

  ctx.tools.register(defineTool({
    name: 'session_event_search',
    description: 'Search prior events in one authorized session; the current session excludes the step performing this call.',
    parameters: EVENT_SEARCH_PARAMETERS,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.searchTimeoutMs,
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
  const records = await sessionQueryCall(ctx, signal, 'target authorization', () =>
    ctx.sessionQuery.filterSessions([
      { kind: 'id', values: [target] },
      { kind: 'cwd', values: [cwd] },
    ], signal))
  if (records.length !== 1) throw unauthorizedTarget()
}

function unauthorizedTarget(): HarnessError {
  return new HarnessError(
    'session target is outside the caller workspace',
    'SESSION_QUERY_TOOL_UNAUTHORIZED',
  )
}

async function sessionQueryCall<Value>(
  ctx: Context,
  signal: AbortSignal,
  operation: string,
  call: () => Promise<Value>,
): Promise<Value> {
  signal.throwIfAborted()
  try {
    const value = await call()
    signal.throwIfAborted()
    return value
  } catch (error: unknown) {
    signal.throwIfAborted()
    throw sanitizeSessionQueryError(ctx, operation, error)
  }
}

function sanitizeSessionQueryError(
  ctx: Context,
  operation: string,
  error: unknown,
): HarnessError {
  const generic = genericSessionQueryFailure()
  const diagnostic = fullError(error)
  try {
    ctx.logger.warn(`tool-session-query: ${operation} failed: ${diagnostic}`)
    if (error instanceof SessionQueryError) {
      const code: unknown = error.code
      const failure = typeof code === 'string' && Object.hasOwn(SAFE_SESSION_QUERY_FAILURES, code)
        ? SAFE_SESSION_QUERY_FAILURES[code as SessionQueryErrorCode]
        : undefined
      if (failure !== undefined && failure.code !== 'SESSION_QUERY_TOOL_FAILED') {
        return new SessionQueryError(failure.message, failure.code)
      }
    }
    if (error instanceof HarnessError && error.code === 'SESSION_QUERY_TOOL_UNAUTHORIZED') {
      return unauthorizedTarget()
    }
  } catch {
    return generic
  }
  return generic
}

function genericSessionQueryFailure(): HarnessError {
  return new HarnessError(
    'session query operation failed',
    'SESSION_QUERY_TOOL_FAILED',
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
  const eventFilters = buildEventFilters({
    seqFrom: args.event_seq_from,
    seqTo: args.event_seq_to,
    timeFrom: args.event_time_from,
    timeTo: args.event_time_to,
    eventTypes: args.event_types,
    surfaces: args.event_surfaces,
  })
  const requestedParentIds = materializeParentSessionIds(args.parent_session_ids)
  if (requestedParentIds !== undefined || args.include_root_sessions === true) {
    const authorizedParentIds = requestedParentIds === undefined
      ? new Set<SessionIdValue>()
      : await authorizeSessionIds(ctx, caller, requestedParentIds, exec.signal)
    const parentValues: Array<SessionIdValue | null> = requestedParentIds
      ?.filter(id => authorizedParentIds.has(id)) ?? []
    if (args.include_root_sessions === true) parentValues.push(null)
    if (parentValues.length === 0) return formatEmptySessionSearch()
    sessionFilters.push({ kind: 'parent', values: parentValues })
  }
  sessionFilters.push({ kind: 'cwd', values: [cwd] })
  const collected = await collectPages(
    maxResults,
    exec.signal,
    cursor => sessionQueryCall(ctx, exec.signal, 'session search', () =>
      ctx.sessionQuery.searchSessions({
        query,
        sessionFilters,
        eventFilters,
        ...cursor === undefined ? {} : { cursor },
      }, { signal: exec.signal })),
    hit => hit.header.id !== caller.id && recordAuthorized(hit, caller),
  )

  const parentIds = collected.items
    .map(hit => hit.header.parentSession)
    .filter((id): id is SessionIdValue => id !== undefined)
  const authorizedParents = await authorizeSessionIds(ctx, caller, parentIds, exec.signal)
  const titles = await readTitles(ctx, caller, collected.items.map(hit => hit.header.id), exec.signal)
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
  const title = await readTitle(ctx, caller, sessionId, exec.signal)
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
    async (cursor): Promise<SessionEventSearchPage> => {
      const page = await sessionQueryCall(ctx, exec.signal, 'event search', () =>
        ctx.sessionQuery.searchEvents({
          sessionId,
          query,
          filters,
          ...cursor === undefined ? {} : { cursor },
        }, { signal: exec.signal }))
      assertObservedTargetAuthorized(caller, sessionId, page.session)
      return page
    },
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
  const trace = await sessionQueryCall(ctx, exec.signal, 'session lineage trace', () =>
    ctx.sessionQuery.traceSession(sessionId, exec.signal))
  assertObservedTargetAuthorized(caller, sessionId, trace.target.header)

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
  const titles = await readTitles(ctx, caller, visibleIds, exec.signal)
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
  const trace = await sessionQueryCall(ctx, exec.signal, 'event trace', () =>
    ctx.sessionQuery.traceEvent({ sessionId, seq: args.seq }, exec.signal))
  assertObservedTargetAuthorized(caller, sessionId, trace.session)
  const title = await readTitle(ctx, caller, sessionId, exec.signal)
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
  const window = await sessionQueryCall(ctx, exec.signal, 'event read', () =>
    ctx.sessionQuery.readEvent({
      sessionId,
      seq: args.seq,
      ...args.before === undefined ? {} : { before: args.before },
      ...args.after === undefined ? {} : { after: args.after },
    }, exec.signal))
  assertObservedTargetAuthorized(caller, sessionId, window.session)
  const title = await readTitle(ctx, caller, sessionId, exec.signal)
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
  if (args.availability !== undefined) {
    assertNonEmptyArray('availability', args.availability)
    filters.push({ kind: 'availability', values: args.availability })
  }
  return filters
}

function materializeParentSessionIds(values: readonly string[] | undefined): SessionIdValue[] | undefined {
  if (values === undefined) return undefined
  assertNonEmptyArray('parent_session_ids', values)
  return [...new Set(values.map(SessionId))]
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
  const fromTimestamp = from === undefined ? undefined : parseIsoTimestamp(`${name}_from`, from)
  const toTimestamp = to === undefined ? undefined : parseIsoTimestamp(`${name}_to`, to)
  if (
    fromTimestamp !== undefined
    && toTimestamp !== undefined
    && compareTimestamps(fromTimestamp, toTimestamp) > 0
  ) {
    throw invalidRange(name, 'from must be less than or equal to to')
  }
  return {
    ...fromTimestamp === undefined ? {} : { from: timestampLowerBound(fromTimestamp) },
    ...toTimestamp === undefined ? {} : { to: timestampUpperBound(toTimestamp) },
  }
}

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):(\d{2}))$/

interface ExactTimestamp {
  readonly millisecond: number
  /** Canonical decimal digits strictly below one millisecond; no trailing zeroes. */
  readonly remainder: string
}

function parseIsoTimestamp(name: string, value: string): ExactTimestamp {
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
  const fraction = match[7] ?? ''
  const millisecondDigits = fraction.slice(0, 3).padEnd(3, '0')
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}`
    + `:${match[6] ?? '00'}.${millisecondDigits}${match[8]}`
  const timestamp = Date.parse(normalized)
  if (!Number.isSafeInteger(timestamp)) {
    throw invalidRange(name, 'must be a valid ISO 8601 timestamp')
  }
  return {
    millisecond: timestamp,
    remainder: fraction.slice(3).replace(/0+$/u, ''),
  }
}

function compareTimestamps(left: ExactTimestamp, right: ExactTimestamp): number {
  if (left.millisecond !== right.millisecond) {
    return left.millisecond < right.millisecond ? -1 : 1
  }
  const length = Math.max(left.remainder.length, right.remainder.length)
  for (let index = 0; index < length; index += 1) {
    const leftDigit = left.remainder[index] ?? '0'
    const rightDigit = right.remainder[index] ?? '0'
    if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1
  }
  return 0
}

function timestampLowerBound(timestamp: ExactTimestamp): number {
  return timestamp.remainder.length === 0
    ? timestamp.millisecond
    : nextUpFinite(timestamp.millisecond)
}

function timestampUpperBound(timestamp: ExactTimestamp): number {
  return timestamp.remainder.length === 0
    ? timestamp.millisecond
    : nextDownFinite(timestamp.millisecond + 1)
}

/** Return the adjacent IEEE-754 value toward positive infinity for a finite input. */
function nextUpFinite(value: number): number {
  if (value === 0) return Number.MIN_VALUE
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  const bits = view.getBigUint64(0)
  view.setBigUint64(0, value > 0 ? bits + 1n : bits - 1n)
  return view.getFloat64(0)
}

/** Return the adjacent IEEE-754 value toward negative infinity for a finite input. */
function nextDownFinite(value: number): number {
  if (value === 0) return -Number.MIN_VALUE
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  const bits = view.getBigUint64(0)
  view.setBigUint64(0, value > 0 ? bits - 1n : bits + 1n)
  return view.getFloat64(0)
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
    const page = await request(cursor)
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
  return headerAuthorized(record.header, caller)
}

function headerAuthorized(header: SessionHeader, caller: Caller): boolean {
  if (header.id === caller.id) return header.cwd === caller.header.cwd
  return caller.header.cwd !== undefined && header.cwd === caller.header.cwd
}

function assertObservedTargetAuthorized(
  caller: Caller,
  target: SessionIdValue,
  observed: SessionHeader,
): void {
  if (observed.id !== target || !headerAuthorized(observed, caller)) throw unauthorizedTarget()
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
  const records = await sessionQueryCall(ctx, signal, 'session-id authorization', () =>
    ctx.sessionQuery.filterSessions([
      { kind: 'id', values: other },
      { kind: 'cwd', values: [cwd] },
    ], signal))
  const requested = new Set(other)
  for (const record of records) {
    if (requested.has(record.header.id) && recordAuthorized(record, caller)) {
      authorized.add(record.header.id)
    }
  }
  return authorized
}

async function readTitles(
  ctx: Context,
  caller: Caller,
  ids: readonly SessionIdValue[],
  signal: AbortSignal,
): Promise<CompleteTitleMap> {
  const result = new Map<SessionIdValue, TitleView>()
  const observations = await sessionQueryCall(ctx, signal, 'title observation', () =>
    ctx.sessionQuery.readTitleSnapshots(ids, signal))
  for (const observation of observations) {
    if (observation.status === 'rejected') {
      result.set(observation.sessionId, unavailableTitle(ctx, observation.reason))
      continue
    }
    assertObservedTargetAuthorized(caller, observation.sessionId, observation.value.session)
    result.set(observation.sessionId, { text: observation.value.title?.title ?? 'untitled' })
  }
  return result as CompleteTitleMap
}

async function readTitle(
  ctx: Context,
  caller: Caller,
  id: SessionIdValue,
  signal: AbortSignal,
): Promise<TitleView> {
  return (await readTitles(ctx, caller, [id], signal)).get(id)
}

function unavailableTitle(
  ctx: Context,
  error: unknown,
): TitleView {
  const sanitized = sanitizeSessionQueryError(ctx, 'title observation item', error)
  if (sanitized.code === 'SESSION_QUERY_TOOL_UNAUTHORIZED') throw sanitized
  return { text: 'untitled', unavailableCode: sanitized.code }
}

function fullError(error: unknown): string {
  try {
    return renderFullError(error)
  } catch {
    return UNPRINTABLE_SERVICE_ERROR
  }
}

function renderFullError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const diagnostics: string[] = []
  const seen = new Set<Error>()
  let current: unknown = error
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    diagnostics.push(current.stack ?? String(current))
    current = current.cause
  }
  /* v8 ignore next -- defensive containment for a cyclic Error.cause graph */
  if (current instanceof Error) diagnostics.push('[circular error cause]')
  else if (current !== undefined) diagnostics.push(renderFullError(current))
  return diagnostics.join('\nCaused by: ')
}

function authorizeDescendants(
  nodes: readonly SessionLineageNode[],
  caller: Caller,
): Array<AuthorizedDescendant | null> {
  const result: Array<AuthorizedDescendant | null> = []
  let pending: DescendantProjectionFrame | undefined
  for (const node of [...nodes].reverse()) {
    pending = { node, target: result, next: pending }
  }
  while (pending !== undefined) {
    const current = pending
    pending = current.next
    if (!recordAuthorized(current.node.session, caller)) {
      current.target.push(null)
      continue
    }
    const projected: AuthorizedDescendant = {
      record: current.node.session,
      descendants: [],
    }
    current.target.push(projected)
    for (const child of [...current.node.descendants].reverse()) {
      pending = {
        node: child,
        target: projected.descendants,
        next: pending,
      }
    }
  }
  return result
}

function * visitDescendants(
  nodes: readonly (AuthorizedDescendant | null)[],
): Generator<DescendantVisit> {
  let pending: DescendantVisit | undefined
  for (const node of [...nodes].reverse()) {
    pending = { node, depth: 0, next: pending }
  }
  while (pending !== undefined) {
    const current = pending
    pending = current.next
    yield current
    if (current.node === null) continue
    for (const child of [...current.node.descendants].reverse()) {
      pending = {
        node: child,
        depth: current.depth + 1,
        next: pending,
      }
    }
  }
}

function descendantIds(nodes: readonly (AuthorizedDescendant | null)[]): SessionIdValue[] {
  const ids: SessionIdValue[] = []
  for (const { node } of visitDescendants(nodes)) {
    if (node !== null) ids.push(node.record.header.id)
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
  if (collected.items.length === 0) return formatEmptySessionSearch()
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

function formatEmptySessionSearch(): string {
  return 'No prior session matches found.'
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
  else renderDescendants(lines, descendants, titles)
  return lines.join('\n')
}

function renderDescendants(
  lines: string[],
  nodes: readonly (AuthorizedDescendant | null)[],
  titles: CompleteTitleMap,
): void {
  for (const { node, depth } of visitDescendants(nodes)) {
    const indent = '  '.repeat(depth)
    if (node === null) {
      lines.push(`${indent}- [outside workspace subtree]`)
      continue
    }
    const id = node.record.header.id
    lines.push(`${indent}- ${id} — ${titleText(titles.get(id))} | ${formatTime(node.record.header.createdAt)} | ${availabilityText(node.record)}`)
  }
}

function formatEventTrace(
  sessionId: SessionIdValue,
  title: TitleView,
  trace: SessionEventTraceObservation,
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
