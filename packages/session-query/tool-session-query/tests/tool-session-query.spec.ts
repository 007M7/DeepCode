import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, HarnessError } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  SessionId,
  type Session,
  type SessionHeader,
  type SessionId as SessionIdValue,
} from '@deepseek-ai/dsh-session'
import SessionQueryService, {
  SessionQueryError,
  SessionSearchCursor,
  type SessionEventSearchHit,
  type SessionEventSearchPage,
  type SessionEventSearchRequest,
  type SessionLineageNode,
  type SessionSearchExecContext,
  type SessionSearchHit,
  type SessionSearchPage,
  type SessionSearchRequest,
  type SessionTitleObservationResult,
} from '@deepseek-ai/dsh-session-query'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ToolSessionQuery from '@deepseek-ai/dsh-tool-session-query'

const activeContexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of activeContexts.splice(0)) await ctx.fiber.dispose()
  FakeQuery.reset()
})

function header(id: string, cwd: string | undefined, createdAt = 1, parentSession?: SessionIdValue): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt,
    ...cwd === undefined ? {} : { cwd },
    ...parentSession === undefined ? {} : { parentSession },
  }
}

function createSession(
  ctx: Context,
  id: string,
  cwd: string | undefined,
  createdAt = 1,
  parentSession?: SessionIdValue,
): Session {
  return ctx.sessions.create(SessionId(id), {
    meta: {
      createdAt,
      ...cwd === undefined ? {} : { cwd },
      ...parentSession === undefined ? {} : { parentSession },
    },
  })
}

function openStep(session: Session, text = 'prior needle'): void {
  session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
  session.append(
    'user/message',
    { content: [{ type: 'text', text }], source: { kind: 'user' } },
    { surfaceOp: 'append' },
  )
  session.append('step/start', { turn: 1, step: 1 })
}

function fakeAgent(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

function sessionHit(
  id: string,
  cwd: string | undefined,
  text = 'needle excerpt',
  parentSession?: SessionIdValue,
): SessionSearchHit {
  return {
    header: header(id, cwd, 100, parentSession),
    live: true,
    persisted: false,
    bestMatch: {
      sessionId: SessionId(id),
      seq: 4,
      type: 'assistant/message',
      time: 200,
      surface: 'current',
      snippet: text,
    },
  }
}

function eventHit(sessionId: SessionIdValue, seq: number, text = 'needle excerpt'): SessionEventSearchHit {
  return {
    sessionId,
    seq,
    type: 'user/message',
    time: 200 + seq,
    surface: 'current',
    snippet: text,
  }
}

class FakeQuery extends SessionQueryService {
  static sessionSearch: (
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ) => Promise<SessionSearchPage<SessionSearchHit>> = () => Promise.resolve({ items: [] })

  static eventSearch: (
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ) => Promise<SessionEventSearchPage> = request => Promise.resolve({
    session: header(request.sessionId, '/work'),
    items: [],
  })

  static sessionRequests: SessionSearchRequest[] = []
  static eventRequests: SessionEventSearchRequest[] = []
  static searchSignals: Array<AbortSignal | undefined> = []
  static titles = new Map<SessionIdValue, string | Error>()

  static reset(): void {
    this.sessionSearch = () => Promise.resolve({ items: [] })
    this.eventSearch = request => Promise.resolve({
      session: header(request.sessionId, '/work'),
      items: [],
    })
    this.sessionRequests = []
    this.eventRequests = []
    this.searchSignals = []
    this.titles = new Map()
  }

  override searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    FakeQuery.sessionRequests.push(request)
    FakeQuery.searchSignals.push(exec?.signal)
    return FakeQuery.sessionSearch(request, exec)
  }

  override searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    FakeQuery.eventRequests.push(request)
    FakeQuery.searchSignals.push(exec?.signal)
    return FakeQuery.eventSearch(request, exec)
  }

  override async readTitleSnapshots(
    sessionIds: readonly SessionIdValue[],
    signal?: AbortSignal,
  ): Promise<SessionTitleObservationResult[]> {
    const observations = await super.readTitleSnapshots(sessionIds, signal)
    return observations.map((observation): SessionTitleObservationResult => {
      const value = FakeQuery.titles.get(observation.sessionId)
      if (value instanceof Error) {
        return { sessionId: observation.sessionId, status: 'rejected', reason: value }
      }
      if (value === undefined || observation.status === 'rejected') return observation
      return {
        ...observation,
        value: {
          ...observation.value,
          title: {
            title: value,
            messageSeqs: [],
            source: { kind: 'fallback' },
            eventSeq: 0,
            updatedAt: 1,
          },
        },
      }
    })
  }
}

interface Mounted {
  readonly ctx: Context
  readonly fiber: Fiber
  readonly caller: Session
  call(name: string, args: unknown, options?: { agent?: Agent; signal?: AbortSignal }): Promise<ToolExecutionResult>
}

async function mount(
  config: ToolSessionQuery.Config = {},
  callerCwd: string | null = '/work',
): Promise<Mounted> {
  const ctx = new Context()
  activeContexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(FakeQuery)
  const fiber = await ctx.plugin(ToolSessionQuery, config)
  const caller = createSession(ctx, 'caller', callerCwd ?? undefined, 10)
  openStep(caller)
  let calls = 0
  return {
    ctx,
    fiber,
    caller,
    call: (toolName, args, options = {}) => ctx.tools.execute({
      name: toolName,
      arguments: args,
      callId: CallId(`call-${++calls}`),
      signal: options.signal ?? new AbortController().signal,
      ...options.agent === undefined ? { agent: fakeAgent(caller) } : { agent: options.agent },
    }),
  }
}

function text(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

function errorCode(result: ToolExecutionResult): string | undefined {
  return result.isError ? result.error.info?.code : undefined
}

describe('registration and schemas', () => {
  it('registers the five cursor-free tools, prompt, timeouts, and pure generic presenters, then disposes them', async () => {
    const mounted = await mount({ maxSearchResults: 7, searchTimeoutMs: 1234 })
    const names = mounted.ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual([
      'session_search',
      'session_event_search',
      'session_trace',
      'session_event_trace',
      'session_event_read',
    ])
    const sessionSchema = mounted.ctx.tools.schemas().find(schema => schema.name === 'session_search')
    expect(sessionSchema?.parameters).not.toHaveProperty('properties.cursor')
    expect(sessionSchema?.parameters).not.toHaveProperty('properties.limit')
    expect(sessionSchema?.parameters).not.toHaveProperty('properties.cwd')
    expect(mounted.ctx.tools.get('session_search')?.timeoutMs).toBe(1234)
    expect(mounted.ctx.tools.get('session_trace')?.timeoutMs).toBeUndefined()
    const safeArgs: Record<string, unknown> = {
      session_search: { query: 'q' },
      session_event_search: { query: 'q' },
      session_trace: {},
      session_event_trace: { seq: 0 },
      session_event_read: { seq: 0 },
    }
    for (const name of names) {
      expect(mounted.ctx.tools.get(name)?.isConcurrencySafe?.(safeArgs[name])).toBe(true)
    }
    expect(mounted.ctx.tools.get('session_search')?.output.render({}, 'rendered'))
      .toEqual([{ type: 'text', text: 'rendered' }])
    expect(mounted.ctx.tools.get('session_search')?.presentCall?.({ query: 'needle' }))
      .toEqual({ card: 'generic', kind: 'search', title: 'Search prior sessions', rawInput: 'needle' })
    expect(mounted.ctx.tools.get('session_event_search')?.presentCall?.({ query: 'needle' }))
      .toEqual({ card: 'generic', kind: 'search', title: 'Search session events', rawInput: 'needle' })
    expect(mounted.ctx.tools.get('session_trace')?.presentCall?.({}))
      .toEqual({ card: 'generic', kind: 'read', title: 'Trace current session' })
    expect(mounted.ctx.tools.get('session_trace')?.presentCall?.({ session_id: 'other' }))
      .toEqual({ card: 'generic', kind: 'read', title: 'Trace session other', rawInput: 'other' })
    expect(mounted.ctx.tools.get('session_event_trace')?.presentCall?.({ session_id: 'other', seq: 3 }))
      .toEqual({
        card: 'generic',
        kind: 'read',
        title: 'Trace event 3',
        rawInput: { session_id: 'other', seq: 3 },
      })
    expect(mounted.ctx.tools.get('session_event_read')?.presentCall?.({ seq: 4 }))
      .toEqual({ card: 'generic', kind: 'read', title: 'Read event 4', rawInput: { seq: 4 } })
    const assembly = await mounted.ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'tool:session-query')?.text)
      .toContain('prior sessions')

    await mounted.fiber.dispose()
    expect(mounted.ctx.tools.schemas().map(schema => schema.name)).toEqual([])
    expect((await mounted.ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .not.toContain('tool:session-query')
  })

  it('fails invalid direct config before registering anything', async () => {
    const mounted = await mount()
    for (const maxSearchResults of [0, 1.5, Number.NaN]) {
      expect(() => { ToolSessionQuery.apply(mounted.ctx, { maxSearchResults }) })
        .toThrow('maxSearchResults')
    }
    for (const searchTimeoutMs of [0, 1.5, Number.POSITIVE_INFINITY, MAX_TIMER_DELAY_MS + 1]) {
      expect(() => { ToolSessionQuery.apply(mounted.ctx, { searchTimeoutMs }) })
        .toThrow(`no greater than ${MAX_TIMER_DELAY_MS}`)
    }
    expect(() => { ToolSessionQuery.apply(new Context(), {}) }).toThrow()
  })

  it('expresses the complete Node timer range in the Loader config schema', () => {
    expect(new ToolSessionQuery.Config({ searchTimeoutMs: MAX_TIMER_DELAY_MS }))
      .toEqual({ maxSearchResults: 100, searchTimeoutMs: MAX_TIMER_DELAY_MS })
    expect(() => new ToolSessionQuery.Config({ searchTimeoutMs: 1.5 })).toThrow()
    expect(() => new ToolSessionQuery.Config({ searchTimeoutMs: MAX_TIMER_DELAY_MS + 1 })).toThrow()
  })
})

describe('input validation and translation', () => {
  it.each([
    [{ query: '   ' }, 'SESSION_QUERY_INVALID_QUERY'],
    [{ query: 'bad\0query' }, 'SESSION_QUERY_INVALID_QUERY'],
    [{ query: 'q', session_ids: [] }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', parent_session_ids: [] }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', availability: [] }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', availability: ['archived'] }, 'INVALID_ARGS'],
    [{ query: 'q', event_types: [] }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', event_surfaces: [] }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', event_surfaces: ['hidden'] }, 'INVALID_ARGS'],
    [{ query: 'q', event_seq_from: -1 }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', event_seq_to: Number.MAX_SAFE_INTEGER + 1 }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', event_seq_from: 2, event_seq_to: 1 }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2026-07-24T10:00:00' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2026-02-30T10:00:00Z' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2100-02-29T10:00:00Z' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2026-04-31T10:00:00Z' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2026-01-01T24:00:00Z' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2026-01-01T00:60:00Z' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2026-01-01T00:00:60Z' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2026-01-01T00:00:00+24:00' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2026-01-01T00:00:00+00:60' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{
      query: 'q',
      created_at_from: '2026-07-25T00:00:00Z',
      created_at_to: '2026-07-24T00:00:00Z',
    }, 'SESSION_QUERY_INVALID_FILTER'],
  ])('rejects invalid search arguments %#', async (args, code) => {
    const mounted = await mount()
    const result = await mounted.call('session_search', args)
    expect(errorCode(result)).toBe(code)
  })

  it('normalizes the query and compiles inclusive session/event filters with one parent OR clause', async () => {
    const mounted = await mount()
    await mounted.call('session_search', {
      query: '  alpha   beta ',
      session_ids: ['a', 'b'],
      created_at_from: '2026-07-24T00:00:00+08:00',
      created_at_to: '2026-07-24T01:00:00+08:00',
      parent_session_ids: ['parent'],
      include_root_sessions: true,
      availability: ['live'],
      event_seq_from: 2,
      event_seq_to: 9,
      event_time_from: '2026-07-24T00:00:00Z',
      event_time_to: '2026-07-24T01:00:00Z',
      event_types: ['plugin/open-event'],
      event_surfaces: ['shadowed'],
    })
    expect(FakeQuery.sessionRequests).toHaveLength(1)
    expect(FakeQuery.sessionRequests[0]).toEqual({
      query: 'alpha beta',
      sessionFilters: [
        { kind: 'id', values: ['a', 'b'] },
        {
          kind: 'created-at',
          from: Date.parse('2026-07-24T00:00:00+08:00'),
          to: Date.parse('2026-07-24T01:00:00+08:00'),
        },
        { kind: 'parent', values: ['parent', null] },
        { kind: 'availability', values: ['live'] },
        { kind: 'cwd', values: ['/work'] },
      ],
      eventFilters: [
        { kind: 'seq', from: 2, to: 9 },
        {
          kind: 'time',
          from: Date.parse('2026-07-24T00:00:00Z'),
          to: Date.parse('2026-07-24T01:00:00Z'),
        },
        { kind: 'type', values: ['plugin/open-event'] },
        { kind: 'surface', values: ['shadowed'] },
      ],
    })
  })

  it('compiles one-sided timestamps and independent root/parent clauses', async () => {
    const mounted = await mount()
    await mounted.call('session_search', {
      query: 'q',
      created_at_from: '2024-02-29T00:00Z',
      include_root_sessions: true,
      event_time_to: '2000-02-29T00:00Z',
    })
    expect(FakeQuery.sessionRequests[0]?.sessionFilters).toContainEqual({
      kind: 'created-at',
      from: Date.parse('2024-02-29T00:00Z'),
    })
    expect(FakeQuery.sessionRequests[0]?.sessionFilters).toContainEqual({
      kind: 'parent',
      values: [null],
    })
    expect(FakeQuery.sessionRequests[0]?.eventFilters).toContainEqual({
      kind: 'time',
      to: Date.parse('2000-02-29T00:00Z'),
    })

    await mounted.call('session_search', {
      query: 'q',
      parent_session_ids: ['parent'],
    })
    expect(FakeQuery.sessionRequests[1]?.sessionFilters).toContainEqual({
      kind: 'parent',
      values: ['parent'],
    })
  })
})

describe('workspace authority and lineage redaction', () => {
  it('fails closed without an agent and for direct cross-workspace targets', async () => {
    const mounted = await mount()
    createSession(mounted.ctx, 'outside', '/outside')
    const missing = await mounted.ctx.tools.execute({
      name: 'session_trace',
      arguments: {},
      callId: CallId('missing-agent'),
      signal: new AbortController().signal,
    })
    expect(errorCode(missing)).toBe('SESSION_QUERY_TOOL_MISSING_AGENT')
    const denied = await mounted.call('session_event_read', { session_id: 'outside', seq: 0 })
    expect(errorCode(denied)).toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')
    expect(text(denied)).not.toContain('session "outside"')
  })

  it('allows only self for a null-cwd caller and denies cross-session search', async () => {
    const mounted = await mount({}, null)
    const own = await mounted.call('session_trace', {})
    expect(own.isError).toBe(false)
    expect(text(own)).toContain('Session caller')
    expect(errorCode(await mounted.call('session_search', { query: 'q' })))
      .toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')
    createSession(mounted.ctx, 'other', undefined)
    expect(errorCode(await mounted.call('session_trace', { session_id: 'other' })))
      .toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')
  })

  it('redacts an unauthorized ancestor and prunes unauthorized descendant subtrees without hidden ids', async () => {
    const mounted = await mount()
    const hiddenParent = createSession(mounted.ctx, 'hidden-parent-secret', '/outside')
    const target = createSession(mounted.ctx, 'target', '/work', 20, hiddenParent.id)
    const visible = createSession(mounted.ctx, 'visible-child', '/work', 30, target.id)
    const hidden = createSession(mounted.ctx, 'hidden-child-secret', '/outside', 40, target.id)
    createSession(mounted.ctx, 'hidden-grandchild-secret', '/work', 50, hidden.id)
    FakeQuery.titles.set(target.id, 'Target title')
    FakeQuery.titles.set(visible.id, 'Visible title')

    const result = await mounted.call('session_trace', { session_id: target.id })
    const output = text(result)
    expect(output).toContain('Target title')
    expect(output).toContain('visible-child')
    expect(output).toContain('[outside workspace boundary]')
    expect(output).toContain('[outside workspace subtree]')
    expect(output).not.toContain('hidden-parent-secret')
    expect(output).not.toContain('hidden-child-secret')
    expect(output).not.toContain('hidden-grandchild-secret')
  })

  it('renders branching descendants in source preorder with one indented marker per pruned subtree', async () => {
    const mounted = await mount()
    const target = createSession(mounted.ctx, 'branch-target', '/work', 20)
    const [targetRecord] = await mounted.ctx.sessionQuery.filterSessions([{
      kind: 'id',
      values: [target.id],
    }])
    if (targetRecord === undefined) throw new Error('expected target record')
    const firstId = SessionId('branch-first')
    const nestedId = SessionId('branch-nested')
    const hiddenId = SessionId('branch-hidden-secret')
    const hiddenDescendantId = SessionId('branch-hidden-descendant-secret')
    const lastId = SessionId('branch-last')
    const descendants: SessionLineageNode[] = [
      {
        session: { ...targetRecord, header: header(firstId, '/work', 30) },
        descendants: [
          {
            session: { ...targetRecord, header: header(nestedId, '/work', 40) },
            descendants: [],
          },
          {
            session: { ...targetRecord, header: header(hiddenId, '/outside', 50) },
            descendants: [{
              session: { ...targetRecord, header: header(hiddenDescendantId, '/work', 60) },
              descendants: [],
            }],
          },
        ],
      },
      {
        session: { ...targetRecord, header: header(lastId, '/work', 70) },
        descendants: [],
      },
    ]
    vi.spyOn(mounted.ctx.sessionQuery, 'traceSession').mockResolvedValue({
      target: targetRecord,
      ancestors: [],
      descendants,
      complete: true,
      root: targetRecord,
    })
    const titleReads: SessionIdValue[] = []
    vi.spyOn(mounted.ctx.sessionQuery, 'readTitleSnapshots').mockImplementation((sessionIds) => {
      titleReads.push(...sessionIds)
      return Promise.resolve([...new Set(sessionIds)].map(sessionId => ({
        sessionId,
        status: 'fulfilled' as const,
        value: { session: header(sessionId, '/work') },
      })))
    })

    const output = text(await mounted.call('session_trace', { session_id: target.id }))
    expect(output.slice(output.indexOf('Descendants:'))).toBe([
      'Descendants:',
      '- branch-first — untitled | 1970-01-01T00:00:00.030Z | live',
      '  - branch-nested — untitled | 1970-01-01T00:00:00.040Z | live',
      '  - [outside workspace subtree]',
      '- branch-last — untitled | 1970-01-01T00:00:00.070Z | live',
    ].join('\n'))
    expect(titleReads).toEqual([target.id, firstId, nestedId, lastId])
  })

  it('renders authorized ancestors and an unresolved lineage boundary without leaking it', async () => {
    const mounted = await mount()
    const root = createSession(mounted.ctx, 'visible-root', '/work', 5)
    const target = createSession(mounted.ctx, 'visible-target', '/work', 6, root.id)
    const complete = text(await mounted.call('session_trace', { session_id: target.id }))
    expect(complete).toContain('visible-root')

    const missingParent = SessionId('missing-parent-secret')
    const incomplete = createSession(mounted.ctx, 'incomplete-target', '/work', 7, missingParent)
    const redacted = text(await mounted.call('session_trace', { session_id: incomplete.id }))
    expect(redacted).toContain('[outside workspace boundary]')
    expect(redacted).not.toContain(missingParent)
  })

  it('renders unavailable trace records and keeps a self-id descendant authorized', async () => {
    const mounted = await mount()
    const target = createSession(mounted.ctx, 'trace-unavailable', '/work')
    const [record] = await mounted.ctx.sessionQuery.filterSessions([{ kind: 'id', values: [target.id] }])
    const [callerRecord] = await mounted.ctx.sessionQuery.filterSessions([{
      kind: 'id',
      values: [mounted.caller.id],
    }])
    if (record === undefined || callerRecord === undefined) throw new Error('expected live records')
    const unavailable = { ...record, live: false, persisted: false }
    const persisted = { ...callerRecord, live: false, persisted: true }
    vi.spyOn(mounted.ctx.sessionQuery, 'traceSession').mockResolvedValue({
      target: unavailable,
      ancestors: [],
      descendants: [{ session: persisted, descendants: [] }],
      complete: true,
      root: unavailable,
    })
    const output = text(await mounted.call('session_trace', { session_id: target.id }))
    expect(output).toContain('Availability: unavailable')
    expect(output).toContain(mounted.caller.id)
    expect(output).toContain('persisted')
  })

  it('rejects every payload observation whose target moved after pre-authorization', async () => {
    const mounted = await mount()
    const target = createSession(mounted.ctx, 'moving-target', '/work')
    target.append(
      'user/message',
      { content: [{ type: 'text', text: 'authorized payload' }], source: { kind: 'user' } },
      { surfaceOp: 'append' },
    )
    const movedHeader = header(target.id, '/outside')

    FakeQuery.eventSearch = () => Promise.resolve({
      session: movedHeader,
      items: [eventHit(target.id, 0, 'secret event hit')],
    })
    const search = await mounted.call('session_event_search', {
      session_id: target.id,
      query: 'secret',
    })
    expect(errorCode(search)).toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')
    expect(text(search)).not.toContain('secret event hit')

    const lineage = await mounted.ctx.sessionQuery.traceSession(target.id)
    vi.spyOn(mounted.ctx.sessionQuery, 'traceSession').mockResolvedValueOnce({
      ...lineage,
      target: { ...lineage.target, header: movedHeader },
    })
    expect(errorCode(await mounted.call('session_trace', { session_id: target.id })))
      .toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')

    const eventTrace = await mounted.ctx.sessionQuery.traceEvent({ sessionId: target.id, seq: 0 })
    vi.spyOn(mounted.ctx.sessionQuery, 'traceEvent').mockResolvedValueOnce({
      ...eventTrace,
      session: movedHeader,
    })
    expect(errorCode(await mounted.call('session_event_trace', { session_id: target.id, seq: 0 })))
      .toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')

    const eventWindow = await mounted.ctx.sessionQuery.readEvent({ sessionId: target.id, seq: 0 })
    vi.spyOn(mounted.ctx.sessionQuery, 'readEvent').mockResolvedValueOnce({
      ...eventWindow,
      session: movedHeader,
    })
    expect(errorCode(await mounted.call('session_event_read', { session_id: target.id, seq: 0 })))
      .toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')

    FakeQuery.sessionSearch = () => Promise.resolve({
      items: [sessionHit(target.id, '/work', 'safe hit')],
    })
    vi.spyOn(mounted.ctx.sessionQuery, 'readTitleSnapshots').mockResolvedValueOnce([{
      sessionId: target.id,
      status: 'fulfilled',
      value: {
        session: movedHeader,
        title: {
          title: 'secret moved title',
          messageSeqs: [],
          source: { kind: 'fallback' },
          eventSeq: 0,
          updatedAt: 1,
        },
      },
    }])
    const titled = await mounted.call('session_search', { query: 'safe' })
    expect(errorCode(titled)).toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')
    expect(text(titled)).not.toContain('secret moved title')
  })

  it('rejects a default self read when its same-id observation moved after caller capture', async () => {
    const mounted = await mount()
    const secret = mounted.caller.append(
      'context/message',
      {
        content: [{ type: 'text', text: 'same-id moved secret' }],
        source: { kind: 'plugin', plugin: 'test' },
      },
      { surfaceOp: 'append' },
    )
    const window = await mounted.ctx.sessionQuery.readEvent({
      sessionId: mounted.caller.id,
      seq: secret.seq,
    })
    vi.spyOn(mounted.ctx.sessionQuery, 'readEvent').mockResolvedValueOnce({
      ...window,
      session: header(mounted.caller.id, '/outside'),
    })

    const denied = await mounted.call('session_event_read', { seq: secret.seq })
    expect(errorCode(denied)).toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')
    expect(text(denied)).not.toContain('same-id moved secret')
  })
})

describe('search paging, prior-history bounds, titles, and cancellation', () => {
  it('drains hidden internal pages to the authorized non-self cap and masks an unauthorized parent id', async () => {
    const mounted = await mount({ maxSearchResults: 2 })
    const outside = createSession(mounted.ctx, 'outside-parent-secret', '/outside')
    const a = createSession(mounted.ctx, 'a', '/work')
    const b = createSession(mounted.ctx, 'b', '/work')
    FakeQuery.titles.set(a.id, 'Alpha')
    FakeQuery.titles.set(b.id, 'Beta')
    const c1 = SessionSearchCursor('c1')
    const c2 = SessionSearchCursor('c2')
    FakeQuery.sessionSearch = (request) => {
      if (request.cursor === undefined) {
        return Promise.resolve({
          items: [
            sessionHit('caller', '/work'),
            sessionHit('unauthorized', '/outside'),
          ],
          nextCursor: c1,
        })
      }
      if (request.cursor === c1) {
        return Promise.resolve({
          items: [sessionHit('a', '/work', 'first', outside.id)],
          nextCursor: c2,
        })
      }
      return Promise.resolve({
        items: [
          sessionHit('b', '/work', 'second'),
          sessionHit('additional-authorized', '/work', 'third'),
        ],
      })
    }

    const result = await mounted.call('session_search', { query: 'needle' })
    const output = text(result)
    expect(FakeQuery.sessionRequests).toHaveLength(3)
    expect(FakeQuery.sessionRequests.every(request => request.limit === undefined)).toBe(true)
    expect(FakeQuery.sessionRequests.map(request => request.cursor)).toEqual([undefined, c1, c2])
    expect(output).toContain('Session a — Alpha')
    expect(output).toContain('Session b — Beta')
    expect(output).toContain('Parent: [outside workspace]')
    expect(output).not.toContain('outside-parent-secret')
    expect(output).toContain('Result cap reached')
  })

  it('does not report a cap when only rejected hits remain after the authorized limit', async () => {
    const mounted = await mount({ maxSearchResults: 1 })
    const cursor = SessionSearchCursor('rejected-tail')
    FakeQuery.sessionSearch = request => request.cursor === undefined
      ? Promise.resolve({
        items: [sessionHit('authorized', '/work')],
        nextCursor: cursor,
      })
      : Promise.resolve({
        items: [
          sessionHit(mounted.caller.id, '/work'),
          sessionHit('outside', '/outside'),
        ],
      })

    const output = text(await mounted.call('session_search', { query: 'needle' }))
    expect(FakeQuery.sessionRequests.map(request => request.cursor)).toEqual([undefined, cursor])
    expect(output).toContain('Session authorized')
    expect(output).not.toContain('Result cap reached')
  })

  it('preserves stale-cursor diagnostics without transparently restarting', async () => {
    const mounted = await mount({ maxSearchResults: 2 })
    const cursor = SessionSearchCursor('stale-next')
    FakeQuery.sessionSearch = request => request.cursor === undefined
      ? Promise.resolve({ items: [], nextCursor: cursor })
      : Promise.reject(new SessionQueryError('stale provider generation', 'SESSION_QUERY_STALE_CURSOR'))
    const result = await mounted.call('session_search', { query: 'needle' })
    expect(errorCode(result)).toBe('SESSION_QUERY_STALE_CURSOR')
    expect(text(result)).toContain('retry the complete search call')
    expect(FakeQuery.sessionRequests).toHaveLength(2)
  })

  it('rejects a repeated internal cursor instead of looping', async () => {
    const mounted = await mount()
    const cursor = SessionSearchCursor('repeat')
    FakeQuery.sessionSearch = () => Promise.resolve({ items: [], nextCursor: cursor })
    const result = await mounted.call('session_search', { query: 'needle' })
    expect(errorCode(result)).toBe('SESSION_QUERY_INVALID_CURSOR')
    expect(FakeQuery.sessionRequests).toHaveLength(2)
  })

  it('renders authorized parent ids and all availability states', async () => {
    const mounted = await mount({ maxSearchResults: 3 })
    const parent = createSession(mounted.ctx, 'parent', '/work')
    const child = createSession(mounted.ctx, 'child', '/work', 2, parent.id)
    const callerChild = createSession(mounted.ctx, 'caller-child', '/work', 3, mounted.caller.id)
    FakeQuery.sessionSearch = () => Promise.resolve({
      items: [
        { ...sessionHit(child.id, '/work', 'both', parent.id), live: true, persisted: true },
        { ...sessionHit(callerChild.id, '/work', 'persisted', mounted.caller.id), live: false, persisted: true },
        { ...sessionHit('unavailable', '/work', 'neither'), live: false, persisted: false },
      ],
    })
    const output = text(await mounted.call('session_search', { query: 'needle' }))
    expect(output).toContain('Parent: parent')
    expect(output).toContain(`Parent: ${mounted.caller.id}`)
    expect(output).toContain('Availability: live, persisted')
    expect(output).toContain('Availability: persisted')
    expect(output).toContain('Availability: unavailable')
  })

  it('intersects current-session search with the event before the latest step and leaves other targets unchanged', async () => {
    const mounted = await mount()
    FakeQuery.eventSearch = request => Promise.resolve({
      session: header(request.sessionId, '/work'),
      items: [eventHit(request.sessionId, 1)],
    })
    await mounted.call('session_event_search', {
      query: 'prior',
      seq_from: 0,
      seq_to: 99,
    })
    expect(FakeQuery.eventRequests[0]?.filters).toContainEqual({ kind: 'seq', from: 0, to: 1 })

    const other = createSession(mounted.ctx, 'other', '/work')
    await mounted.call('session_event_search', {
      session_id: other.id,
      query: 'prior',
      seq_from: 0,
      seq_to: 99,
    })
    expect(FakeQuery.eventRequests[1]?.filters).toContainEqual({ kind: 'seq', from: 0, to: 99 })
  })

  it('returns no current-session hits without calling FTS when the user range starts in the active step', async () => {
    const mounted = await mount()
    const result = await mounted.call('session_event_search', {
      query: 'prior',
      seq_from: 2,
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('No prior event matches found.')
    expect(FakeQuery.eventRequests).toEqual([])
  })

  it('requires a current step boundary and drains event pages to a capped result', async () => {
    const mounted = await mount({ maxSearchResults: 2 })
    const noStep = createSession(mounted.ctx, 'no-step', '/work')
    const missing = await mounted.call(
      'session_event_search',
      { query: 'q' },
      { agent: fakeAgent(noStep) },
    )
    expect(errorCode(missing)).toBe('SESSION_QUERY_TOOL_NO_CURRENT_STEP')

    const other = createSession(mounted.ctx, 'paged-events', '/work')
    const cursor = SessionSearchCursor('events-next')
    FakeQuery.eventSearch = request => request.cursor === undefined
      ? Promise.resolve({
        session: header(other.id, '/work'),
        items: [eventHit(other.id, 1)],
        nextCursor: cursor,
      })
      : Promise.resolve({
        session: header(other.id, '/work'),
        items: [eventHit(other.id, 2), eventHit(other.id, 3)],
      })
    const result = await mounted.call('session_event_search', {
      session_id: other.id,
      query: 'q',
    })
    expect(FakeQuery.eventRequests.map(request => request.cursor)).toEqual([undefined, cursor])
    expect(text(result)).toContain('Result cap reached')
  })

  it('preserves base results when a title read fails, annotates the code, and logs the full error', async () => {
    const mounted = await mount()
    const hit = createSession(mounted.ctx, 'hit', '/work')
    const failure = new HarnessError('title backend failed', 'TITLE_BACKEND')
    FakeQuery.titles.set(hit.id, failure)
    FakeQuery.sessionSearch = () => Promise.resolve({ items: [sessionHit(hit.id, '/work')] })
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)
    const result = await mounted.call('session_search', { query: 'needle' })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('untitled (title unavailable: TITLE_BACKEND)')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('title backend failed'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HarnessError'))
  })

  it('reports unknown title failures and preserves an Error without a stack', async () => {
    const mounted = await mount()
    const first = createSession(mounted.ctx, 'unknown-title', '/work')
    const second = createSession(mounted.ctx, 'stackless-title', '/work')
    const stackless = new Error('stackless')
    Object.defineProperty(stackless, 'stack', { value: undefined })
    const readTitles = vi.spyOn(mounted.ctx.sessionQuery, 'readTitleSnapshots')
      .mockResolvedValueOnce([
        { sessionId: first.id, status: 'rejected', reason: 'string failure' },
        { sessionId: second.id, status: 'rejected', reason: stackless },
      ])
    FakeQuery.sessionSearch = () => Promise.resolve({
      items: [
        sessionHit(first.id, '/work'),
        sessionHit(second.id, '/work'),
      ],
    })
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)
    const result = await mounted.call('session_search', { query: 'needle' })
    expect(text(result)).toContain('title unavailable: UNKNOWN')
    expect(readTitles).toHaveBeenCalledTimes(1)
    expect(readTitles.mock.calls[0]?.[0]).toEqual([first.id, second.id])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('string failure'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Error: stackless'))
  })

  it('does not downgrade cancellation during title enrichment', async () => {
    const mounted = await mount()
    const hit = createSession(mounted.ctx, 'abort-title', '/work')
    const controller = new AbortController()
    const cancellation = new Error('cancelled title batch')
    FakeQuery.sessionSearch = () => Promise.resolve({ items: [sessionHit(hit.id, '/work')] })
    let started!: () => void
    const batchStarted = new Promise<void>((resolve) => { started = resolve })
    const readTitles = vi.spyOn(mounted.ctx.sessionQuery, 'readTitleSnapshots').mockImplementation((_ids, signal) => {
      started()
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(cancellation) }, { once: true })
      })
    })
    const pending = mounted.call('session_search', { query: 'needle' }, { signal: controller.signal })
    await batchStarted
    controller.abort(cancellation)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(text(result)).not.toContain('title unavailable')
    expect(readTitles.mock.calls[0]?.[1]).toBe(controller.signal)
  })

  it('does not downgrade an authorization failure returned by title observation', async () => {
    const mounted = await mount()
    const hit = createSession(mounted.ctx, 'unauthorized-title-error', '/work')
    const failure = new HarnessError(
      'title observation became unauthorized',
      'SESSION_QUERY_TOOL_UNAUTHORIZED',
    )
    FakeQuery.sessionSearch = () => Promise.resolve({ items: [sessionHit(hit.id, '/work')] })
    vi.spyOn(mounted.ctx.sessionQuery, 'readTitleSnapshots').mockResolvedValueOnce([{
      sessionId: hit.id,
      status: 'rejected',
      reason: failure,
    }])

    const result = await mounted.call('session_search', { query: 'needle' })

    expect(errorCode(result)).toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')
    expect(text(result)).not.toContain('title unavailable')
  })

  it('passes the exact execution signal to every FTS page and stops on cancellation', async () => {
    const mounted = await mount()
    const controller = new AbortController()
    let started!: () => void
    const bodyStarted = new Promise<void>((resolve) => { started = resolve })
    FakeQuery.sessionSearch = (_request, exec) => new Promise((_resolve, reject) => {
      started()
      exec?.signal?.addEventListener('abort', () => {
        reject(new SessionQueryError('aborted', 'SESSION_QUERY_ABORTED'))
      }, { once: true })
    })
    const pending = mounted.call('session_search', { query: 'needle' }, { signal: controller.signal })
    await bodyStarted
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(errorCode(result)).toBe('SESSION_QUERY_ABORTED')
    expect(FakeQuery.searchSignals).toEqual([controller.signal])
  })
})

describe('trace and exact read rendering', () => {
  it('renders a deeply nested lineage without recursive consumer traversal', async () => {
    const mounted = await mount()
    const target = createSession(mounted.ctx, 'deep-target', '/work')
    const [targetRecord] = await mounted.ctx.sessionQuery.filterSessions([{
      kind: 'id',
      values: [target.id],
    }])
    if (targetRecord === undefined) throw new Error('expected target record')
    const depth = 3_000
    let descendants: SessionLineageNode[] = []
    for (let index = depth; index >= 1; index -= 1) {
      descendants = [{
        session: {
          ...targetRecord,
          header: header(`deep-${index}`, '/work', index),
        },
        descendants,
      }]
    }
    vi.spyOn(mounted.ctx.sessionQuery, 'traceSession').mockResolvedValue({
      target: targetRecord,
      ancestors: [],
      descendants,
      complete: true,
      root: targetRecord,
    })
    vi.spyOn(mounted.ctx.sessionQuery, 'readTitleSnapshots').mockImplementation(sessionIds => Promise.resolve(
      [...new Set(sessionIds)].map(sessionId => ({
        sessionId,
        status: 'fulfilled' as const,
        value: { session: header(sessionId, '/work') },
      })),
    ))

    const output = text(await mounted.call('session_trace', { session_id: target.id }))
    expect(output).toContain('Descendants:\n- deep-1 —')
    expect(output).toContain(`${'  '.repeat(depth - 1)}- deep-${depth} —`)
  })

  it('renders every event relationship sequence and a UTC target timestamp', async () => {
    const mounted = await mount()
    const session = createSession(mounted.ctx, 'relationships', '/work')
    session.append(
      'user/message',
      { content: [{ type: 'text', text: 'source' }], source: { kind: 'user' } },
      { surfaceOp: 'append' },
    )
    session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        content: [{ type: 'text', text: 'replacement' }],
        provenance: { provider: 'test', model: 'test' },
      },
      { surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0] },
    )
    const result = await mounted.call('session_event_trace', { session_id: session.id, seq: 0 })
    expect(text(result)).toContain('Replacement chain: 1')
    expect(text(result)).toContain('Direct derived events: 1')
    expect(text(result)).toContain(new Date(session.events[0]?.time ?? 0).toISOString())
  })

  it('renders unabridged fenced target JSON and readable semantic neighbor summaries', async () => {
    const mounted = await mount()
    const session = createSession(mounted.ctx, 'read', '/work')
    session.append(
      'user/message',
      { content: [{ type: 'text', text: 'before semantic text' }], source: { kind: 'user' } },
      { surfaceOp: 'append' },
    )
    session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        content: [{ type: 'text', text: 'target full text' }],
        provenance: { provider: 'test', model: 'test' },
      },
      { surfaceOp: 'append' },
    )
    session.append(
      'context/message',
      { content: [{ type: 'text', text: 'after semantic text' }], source: { kind: 'plugin', plugin: 'test' } },
      { surfaceOp: 'append' },
    )
    const result = await mounted.call('session_event_read', {
      session_id: session.id,
      seq: 1,
      before: 1,
      after: 1,
    })
    const output = text(result)
    expect(output).toContain('```json')
    expect(output).toContain('"text": "target full text"')
    expect(output).toContain('before semantic text')
    expect(output).toContain('after semantic text')
    expect(output).not.toContain('truncated')
  })

  it('renders empty event relationships and neighbors without semantic text', async () => {
    const mounted = await mount()
    const session = createSession(mounted.ctx, 'empty-relations', '/work')
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })

    const trace = text(await mounted.call('session_event_trace', {
      session_id: session.id,
      seq: 0,
    }))
    expect(trace).toContain('Replaced by: none')
    expect(trace).toContain('Replacement chain: none')

    const onlyAfter = text(await mounted.call('session_event_read', {
      session_id: session.id,
      seq: 0,
      after: 1,
    }))
    expect(onlyAfter).not.toContain('Before:')
    expect(onlyAfter).toContain('(no semantic text)')

    const onlyBefore = text(await mounted.call('session_event_read', {
      session_id: session.id,
      seq: 1,
      before: 1,
    }))
    expect(onlyBefore).toContain('Before:')
    expect(onlyBefore).not.toContain('After:')
  })

  it.each([
    ['session_event_trace', { seq: -1 }],
    ['session_event_read', { seq: Number.MAX_SAFE_INTEGER + 1 }],
    ['session_event_read', { seq: 0, before: -1 }],
    ['session_event_read', { seq: 0, after: 1.5 }, 'INVALID_ARGS'],
  ])('rejects invalid exact-read integers for %s', async (name, args, expected = 'SESSION_QUERY_INVALID_FILTER') => {
    const mounted = await mount()
    expect(errorCode(await mounted.call(name, args))).toBe(expected)
  })
})
