import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from 'cordis'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import SessionPersistence, { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import SessionSearchSqlite, {
  SESSION_QUERY_SQLITE_APPLICATION_ID,
  SESSION_QUERY_SQLITE_SCHEMA_VERSION,
} from '@deepseek-ai/dsh-session-query-sqlite'
import {
  SessionQueryError,
  SessionSearchCursor,
  type SessionAvailability,
  type SessionQueryErrorCode,
  type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryPath(name = 'search.db'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-session-search-'))
  temporaryDirectories.push(directory)
  return join(directory, name)
}

function header(id: string, createdAt = 1, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt, ...extra }
}

function messageEvents(text: string, time = 1): SessionEvent[] {
  return [{
    type: 'user/message',
    seq: 0,
    time,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
    surfaceOp: 'append',
  }]
}

function expectCode(code: SessionQueryErrorCode): Error {
  return expect.objectContaining({ code }) as Error
}

function replaceCursorOffset(
  cursor: ReturnType<typeof SessionSearchCursor>,
  offset: number,
): ReturnType<typeof SessionSearchCursor> {
  const payload = JSON.parse(
    Buffer.from(cursor, 'base64url').toString('utf8'),
  ) as Record<string, unknown>
  return SessionSearchCursor(Buffer.from(JSON.stringify({ ...payload, offset }), 'utf8').toString('base64url'))
}

class TestPersistence extends SessionPersistence {
  static entries = new Map<SessionIdType, { meta: SessionHeader; events: SessionEvent[] }>()
  static revisions = new Map<SessionIdType, number>()
  static nextRevision = 0
  static loads = new Map<SessionIdType, number>()
  static loadEffect: ((entry: { meta: SessionHeader; events: SessionEvent[] }) => void) | undefined
  static listGate: Promise<void> | undefined
  static listStarted: (() => void) | undefined
  static snapshotEffect: (() => void | Promise<void>) | undefined
  static snapshotOverride: (() => SessionPersistenceSnapshot[]) | undefined
  static failure: unknown

  static reset(entries: readonly { meta: SessionHeader; events: SessionEvent[] }[] = []): void {
    this.entries = new Map()
    this.revisions = new Map()
    this.loads = new Map()
    this.loadEffect = undefined
    for (const entry of entries) this.set(entry)
    this.listGate = undefined
    this.listStarted = undefined
    this.snapshotEffect = undefined
    this.snapshotOverride = undefined
    this.failure = undefined
  }

  static set(entry: { meta: SessionHeader; events: SessionEvent[] }): void {
    this.entries.set(entry.meta.id, structuredClone(entry))
    this.revisions.set(entry.meta.id, ++this.nextRevision)
  }

  create(meta: SessionHeader): Promise<void> {
    TestPersistence.set({ meta, events: [] })
    return Promise.resolve()
  }

  append(id: SessionIdType, events: readonly SessionEvent[]): Promise<void> {
    const entry = TestPersistence.entries.get(id)
    if (entry === undefined) return Promise.reject(new Error('missing test session'))
    entry.events.push(...structuredClone(events))
    TestPersistence.revisions.set(id, ++TestPersistence.nextRevision)
    return Promise.resolve()
  }

  async load(id: SessionIdType): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    TestPersistence.loads.set(id, (TestPersistence.loads.get(id) ?? 0) + 1)
    if (TestPersistence.failure !== undefined) throw TestPersistence.failure
    const entry = TestPersistence.entries.get(id)
    if (entry === undefined) throw new Error('missing test session')
    if (TestPersistence.loadEffect !== undefined) {
      const effect = TestPersistence.loadEffect
      TestPersistence.loadEffect = undefined
      effect(entry)
      TestPersistence.revisions.set(id, ++TestPersistence.nextRevision)
    }
    return structuredClone(entry)
  }

  async list(): Promise<SessionHeader[]> {
    TestPersistence.listStarted?.()
    await TestPersistence.listGate
    if (TestPersistence.failure !== undefined) throw TestPersistence.failure
    return [...TestPersistence.entries.values()].map(entry => structuredClone(entry.meta))
  }


  async listSnapshots(): Promise<SessionPersistenceSnapshot[]> {
    TestPersistence.listStarted?.()
    await TestPersistence.listGate
    if (TestPersistence.failure !== undefined) throw TestPersistence.failure
    const snapshots = TestPersistence.snapshotOverride?.()
      ?? [...TestPersistence.entries.values()].map(entry => ({
        header: structuredClone(entry.meta),
        revision: SessionPersistenceRevision(`test:${TestPersistence.revisions.get(entry.meta.id)}`),
      }))
    await TestPersistence.snapshotEffect?.()
    return snapshots
  }
}

async function liveContext(config: ConstructorParameters<typeof SessionSearchSqlite>[1] = { path: ':memory:' }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionSearchSqlite, config)
  return ctx
}

describe('SQLite session search', () => {
  it('searches two-character Unicode61 tokens in live-only sessions', async () => {
    const ctx = await liveContext({ path: ':memory:', snippetChars: 20 })
    const session = ctx.sessions.create(SessionId('live'), { meta: { cwd: '/work', createdAt: 10, seedLength: 1 } })
    session.append(
      'user/message',
      { content: [{ type: 'text', text: 'An AI helper' }], source: { kind: 'user' } },
      { surfaceOp: 'append' },
    )

    await expect(ctx.sessionSearch.searchEvents({ sessionId: session.id, query: 'AI' }))
      .resolves.toMatchObject({ items: [{ sessionId: session.id, seq: 0, snippet: 'An AI helper' }] })
    await expect(ctx.sessionSearch.searchSessions({ query: 'AI' }))
      .resolves.toMatchObject({ items: [{ header: { ...session.header, seedLength: 1 }, live: true, persisted: false }] })
  })

  it('searches all surfaces by default and applies metadata before ranking', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 10, maxLimit: 20 })
    const parent = SessionId('parent')
    const events: SessionEvent[] = [
      { type: 'user/message', seq: 0, time: 10, data: { content: [{ type: 'text', text: 'needle original' }], source: { kind: 'user' } }, surfaceOp: 'append' },
      { type: 'assistant/chunk', seq: 1, time: 11, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'needle raw' } } },
      { type: 'user/message', seq: 2, time: 12, data: { content: [{ type: 'text', text: 'needle summary' }], source: { kind: 'plugin', plugin: 'test' } }, surfaceOp: { op: 'replace', start: 0, end: 0 } },
      { type: 'turn/end', seq: 3, time: 13, data: { turn: 1, reason: { kind: 'error', step: 1, message: 'needle failure' } } },
    ]
    ctx.sessions.create(SessionId('a'), { seed: events, meta: { cwd: '/a', parentSession: parent, createdAt: 20 } })
    ctx.sessions.create(SessionId('b'), { seed: messageEvents('needle peer', 12), meta: { createdAt: 20 } })

    const all = await ctx.sessionSearch.searchEvents({ sessionId: SessionId('a'), query: 'needle' })
    expect(new Set(all.items.map(item => item.surface))).toEqual(new Set(['current', 'shadowed', 'log-only']))
    await expect(ctx.sessionSearch.searchEvents({
      sessionId: SessionId('a'),
      query: 'needle',
      filters: [
        { kind: 'seq', from: 2, to: 2 },
        { kind: 'time', from: 12, to: 12 },
        { kind: 'type', values: ['user/message'] },
        { kind: 'surface', values: ['current'] },
      ],
    })).resolves.toMatchObject({ items: [{ seq: 2, surface: 'current' }] })

    const grouped = await ctx.sessionSearch.searchSessions({
      query: 'needle',
      sessionFilters: [
        { kind: 'id', values: [SessionId('a')] },
        { kind: 'cwd', values: ['/a'] },
        { kind: 'created-at', from: 20, to: 20 },
        { kind: 'parent', values: [parent] },
        { kind: 'availability', values: ['live'] },
      ],
      eventFilters: [{ kind: 'surface', values: ['shadowed'] }],
    })
    expect(grouped.items).toHaveLength(1)
    expect(grouped.items[0]).toMatchObject({
      header: { id: SessionId('a'), cwd: '/a', parentSession: parent },
      live: true,
      persisted: false,
      bestMatch: { seq: 0, surface: 'shadowed' },
    })
  })

  it('uses literal phrase tokens, stable ties, and bounded Unicode snippets', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 10, maxLimit: 10, snippetChars: 5 })
    ctx.sessions.create(SessionId('a'), { seed: messageEvents('😀😀 alpha beta BRAID 😀😀', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('b'), { seed: messageEvents('alpha beta', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('c'), { seed: messageEvents('alpha middle beta', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('d'), { seed: messageEvents('alpha beta', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('operator'), { seed: messageEvents('needle OR absent', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('only'), { seed: messageEvents('needle only', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('quote'), { seed: messageEvents('say "needle" exactly', 10), meta: { createdAt: 1 } })

    const phrase = await ctx.sessionSearch.searchSessions({ query: 'alpha beta' })
    expect(phrase.items.map(item => item.header.id)).toEqual([SessionId('b'), SessionId('d'), SessionId('a')])
    expect(phrase.items.every(item => Array.from(item.bestMatch.snippet).length <= 5)).toBe(true)
    await expect(ctx.sessionSearch.searchSessions({ query: 'AI' })).resolves.toEqual({ items: [] })
    await expect(ctx.sessionSearch.searchSessions({ query: 'needle OR absent' }))
      .resolves.toMatchObject({ items: [{ header: { id: SessionId('operator') } }] })
    await expect(ctx.sessionSearch.searchSessions({ query: 'say "needle"' }))
      .resolves.toMatchObject({ items: [{ header: { id: SessionId('quote') } }] })
    await expect(ctx.sessionSearch.searchSessions({ query: '*' })).resolves.toEqual({ items: [] })
  })

  it('ranks live and persisted matches on one source-comparable contract', async () => {
    const persisted = header('z-persisted')
    TestPersistence.reset([
      { meta: persisted, events: messageEvents('needle needle', 10) },
      ...Array.from({ length: 12 }, (_, index) => ({
        meta: header(`filler-${index}`),
        events: messageEvents('needle', 10),
      })),
    ])
    const ctx = await liveContext()
    const persistence = await ctx.plugin(TestPersistence)
    ctx.sessions.create(SessionId('a-live'), {
      seed: messageEvents('needle needle', 10),
      meta: { createdAt: persisted.createdAt },
    })

    const result = await ctx.sessionSearch.searchSessions({
      query: 'needle',
      sessionFilters: [{ kind: 'id', values: [SessionId('a-live'), persisted.id] }],
    })
    expect(result.items.map(item => item.header.id)).toEqual([SessionId('a-live'), persisted.id])
    await persistence.dispose()
  })

  it('positions snippets from FTS5 matches across diacritics and punctuation', async () => {
    const ctx = await liveContext({ path: ':memory:', snippetChars: 14 })
    const session = ctx.sessions.create(SessionId('snippet'), {
      seed: messageEvents('long long long—café,\nnext value', 10),
    })

    const page = await ctx.sessionSearch.searchEvents({ sessionId: session.id, query: 'CAFE' })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.snippet).toContain('café')
    expect(page.items[0]!.snippet).toContain('—')
    expect(page.items[0]!.snippet).not.toContain('\n')
    expect(Array.from(page.items[0]!.snippet).length).toBeLessThanOrEqual(14)
  })

  it('binds cursors to requests and only invalidates within-session pages for target changes', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 5 })
    const target = ctx.sessions.create(SessionId('target'), {
      seed: [
        ...messageEvents('needle one', 10),
        { ...messageEvents('needle two', 11)[0]!, seq: 1 },
        { ...messageEvents('needle three', 12)[0]!, seq: 2 },
      ],
    })
    ctx.sessions.create(SessionId('other'), { seed: messageEvents('needle other', 10) })

    const eventPage = await ctx.sessionSearch.searchEvents({ sessionId: target.id, query: 'needle', limit: 1 })
    const sessionPage = await ctx.sessionSearch.searchSessions({ query: 'needle', limit: 1 })
    expect(eventPage.nextCursor).toEqual(expect.any(String))
    expect(sessionPage.nextCursor).toEqual(expect.any(String))
    if (eventPage.nextCursor === undefined || sessionPage.nextCursor === undefined) throw new Error('expected cursors')

    const unsafeOffsetCursor = replaceCursorOffset(eventPage.nextCursor, 1e100)
    await expect(ctx.sessionSearch.searchEvents({
      sessionId: target.id,
      query: 'needle',
      limit: 1,
      cursor: unsafeOffsetCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))

    const eventKeys = eventPage.items.map(item => `${item.sessionId}:${item.seq}`)
    let eventCursor: ReturnType<typeof SessionSearchCursor> | undefined = eventPage.nextCursor
    while (eventCursor !== undefined) {
      const next = await ctx.sessionSearch.searchEvents({
        sessionId: target.id,
        query: 'needle',
        limit: 1,
        cursor: eventCursor,
      })
      eventKeys.push(...next.items.map(item => `${item.sessionId}:${item.seq}`))
      eventCursor = next.nextCursor
    }
    expect(eventKeys).toHaveLength(3)
    expect(new Set(eventKeys).size).toBe(eventKeys.length)

    const sessionIds = sessionPage.items.map(item => item.header.id)
    let sessionCursor: ReturnType<typeof SessionSearchCursor> | undefined = sessionPage.nextCursor
    while (sessionCursor !== undefined) {
      const next = await ctx.sessionSearch.searchSessions({ query: 'needle', limit: 1, cursor: sessionCursor })
      sessionIds.push(...next.items.map(item => item.header.id))
      sessionCursor = next.nextCursor
    }
    expect(sessionIds).toHaveLength(2)
    expect(new Set(sessionIds).size).toBe(sessionIds.length)

    ctx.sessions.create(SessionId('unrelated'), { seed: messageEvents('needle unrelated', 20) })
    await expect(ctx.sessionSearch.searchEvents({
      sessionId: target.id,
      query: 'needle',
      limit: 1,
      cursor: eventPage.nextCursor,
    })).resolves.toMatchObject({ items: [{ sessionId: target.id }] })
    await expect(ctx.sessionSearch.searchSessions({ query: 'needle', limit: 1, cursor: sessionPage.nextCursor }))
      .rejects.toThrow(expectCode('SESSION_QUERY_STALE_CURSOR'))
    await expect(ctx.sessionSearch.searchEvents({
      sessionId: target.id,
      query: 'different',
      limit: 1,
      cursor: eventPage.nextCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))

    target.append('user/message', { content: [{ type: 'text', text: 'needle four' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    await expect(ctx.sessionSearch.searchEvents({
      sessionId: target.id,
      query: 'needle',
      limit: 1,
      cursor: eventPage.nextCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_STALE_CURSOR'))
  })

  it('invalidates session cursors after transient persistence topology changes', async () => {
    TestPersistence.reset()
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 5 })
    ctx.sessions.create(SessionId('first'), { seed: messageEvents('needle first') })
    ctx.sessions.create(SessionId('second'), { seed: messageEvents('needle second') })
    const page = await ctx.sessionSearch.searchSessions({ query: 'needle', limit: 1 })
    if (page.nextCursor === undefined) throw new Error('expected cursor')

    const persistence = await ctx.plugin(TestPersistence)
    await persistence.dispose()

    await expect(ctx.sessionSearch.searchSessions({
      query: 'needle',
      limit: 1,
      cursor: page.nextCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_STALE_CURSOR'))
  })

  it('rejects invalid requests, filters, cursors, and direct config', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 2, maxLimit: 3 })
    const session = ctx.sessions.create(SessionId('valid'), { seed: messageEvents('needle') })
    for (const request of [
      { sessionId: session.id, query: '' },
      { sessionId: session.id, query: 'needle', limit: 0 },
      { sessionId: session.id, query: 'needle', limit: 4 },
      { sessionId: session.id, query: 'needle', filters: [{ kind: 'seq', from: 2, to: 1 }] },
      { sessionId: session.id, query: 'needle', filters: [{ kind: 'surface', values: ['future'] }] },
      { sessionId: session.id, query: 'bad\0query' },
    ] as const) {
      await expect(ctx.sessionSearch.searchEvents(request as never)).rejects.toBeInstanceOf(Error)
    }
    await expect(ctx.sessionSearch.searchSessions({
      query: 'needle',
      sessionFilters: [{ kind: 'availability', values: ['remote' as never] }],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionSearch.searchSessions({
      query: 'needle',
      sessionFilters: [{ kind: 'future' } as never],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionSearch.searchSessions({
      query: 'needle',
      eventFilters: [{ kind: 'future' } as never],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionSearch.searchEvents({
      sessionId: session.id,
      query: 'needle',
      filters: [{ kind: 'future' } as never],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionSearch.searchEvents({
      sessionId: session.id,
      query: 'needle',
      cursor: SessionSearchCursor('not-json'),
    }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))
    await expect(ctx.sessionSearch.searchEvents({ sessionId: SessionId('absent'), query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))

    for (const config of [
      { path: '' },
      { path: ':memory:', defaultLimit: 0 },
      { path: ':memory:', maxLimit: 0 },
      { path: ':memory:', defaultLimit: 1e100 },
      { path: ':memory:', maxLimit: 1e100 },
      { path: ':memory:', snippetChars: 0 },
      { path: ':memory:', defaultLimit: 3, maxLimit: 2 },
      { path: ':memory:', journalMode: 'memory' },
    ]) {
      const direct = new Context()
      await direct.plugin(SessionStore)
      expect(() => new SessionSearchSqlite(direct, config as never))
        .toThrow(expectCode('SESSION_QUERY_INVALID_CONFIG'))
    }
  })

  it('rejects aggregate filter bindings above SQLite\'s portable variable limit', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('binding-limit'), { seed: messageEvents('needle') })
    // Each clause is below the ceiling; combined with its sibling and fixed
    // query bindings, the complete statement is not portable.
    const halfPortableLimit = 16_383
    const ids = Array.from(
      { length: halfPortableLimit },
      (_, index) => SessionId(`binding-${index}`),
    )
    const types = Array.from({ length: halfPortableLimit }, () => 'user/message' as const)
    const surfaces = Array.from({ length: halfPortableLimit }, () => 'current' as const)

    await expect(ctx.sessionSearch.searchSessions({
      query: 'needle',
      sessionFilters: [{ kind: 'id', values: ids }],
      eventFilters: [{ kind: 'type', values: types }],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionSearch.searchEvents({
      sessionId: session.id,
      query: 'needle',
      filters: [
        { kind: 'type', values: types },
        { kind: 'surface', values: surfaces },
      ],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
  })
})

describe('SQLite reconciliation and source lifecycle', () => {
  it('owns queued request and filter values before waiting for the serializer', async () => {
    const durable = header('owned')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    const persistence = await ctx.plugin(TestPersistence)
    let release!: () => void
    TestPersistence.listGate = new Promise<void>((resolve) => { release = resolve })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markStarted()
    }
    const blocking = ctx.sessionSearch.searchSessions({ query: 'needle' })
    await started

    const availability: SessionAvailability[] = ['persisted']
    const request: SessionSearchRequest = {
      query: 'needle',
      sessionFilters: [{ kind: 'availability', values: availability }],
    }
    const queued = ctx.sessionSearch.searchSessions(request)
    request.query = 'absent'
    availability[0] = 'live'
    release()

    await expect(blocking).resolves.toMatchObject({ items: [{ header: durable }] })
    await expect(queued).resolves.toMatchObject({ items: [{ header: durable }] })
    await persistence.dispose()
  })

  it('mounts persistence dynamically, shadows with TEMP live rows, reveals, and hides on unmount', async () => {
    const shared = header('shared', 10, { cwd: '/work' })
    const durable = header('durable', 5)
    TestPersistence.reset([
      { meta: shared, events: messageEvents('persisted needle') },
      { meta: durable, events: messageEvents('durable needle') },
    ])
    const ctx = await liveContext()
    await expect(ctx.sessionSearch.searchSessions({ query: 'durable' })).resolves.toEqual({ items: [] })
    const persistenceFiber = await ctx.plugin(TestPersistence)

    await expect(ctx.sessionSearch.searchSessions({ query: 'durable' }))
      .resolves.toMatchObject({ items: [{ header: durable, live: false, persisted: true }] })
    const live = ctx.sessions.prepare(shared.id, { meta: { createdAt: 10, cwd: '/work' } })
    live.append('user/message', { content: [{ type: 'text', text: 'live needle' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const detach = ctx.sessions.enter(live)
    ctx.sessions.announce(live)

    await expect(ctx.sessionSearch.searchSessions({ query: 'persisted' })).resolves.toEqual({ items: [] })
    await expect(ctx.sessionSearch.searchSessions({ query: 'live' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: true, persisted: true }] })
    detach()
    await expect(ctx.sessionSearch.searchSessions({ query: 'persisted' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: false, persisted: true }] })

    await persistenceFiber.dispose()
    await expect(ctx.sessionSearch.searchSessions({ query: 'durable' })).resolves.toEqual({ items: [] })
    await expect(ctx.sessionSearch.searchEvents({ sessionId: durable.id, query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))
  })

  it('uses the reconciled persistence binding through the query boundary', async () => {
    const durable = header('post-reconcile-unmount')
    TestPersistence.reset([{ meta: durable, events: [
      ...messageEvents('durable needle', 1),
      { ...messageEvents('durable needle again', 2)[0]!, seq: 1 },
    ] }])
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 2 })
    const persistence = await ctx.plugin(TestPersistence)
    const internals = ctx.sessionSearch as unknown as {
      _reconcile(signal: AbortSignal | undefined): Promise<{
        identity: symbol
        service?: SessionPersistence
      }>
    }
    const reconcile = internals._reconcile.bind(internals)
    const boundary = vi.spyOn(internals, '_reconcile').mockImplementation(async (signal) => {
      const binding = await reconcile(signal)
      await persistence.dispose()
      return binding
    })

    const page = await ctx.sessionSearch.searchEvents({
      sessionId: durable.id,
      query: 'needle',
      limit: 1,
    })
    expect(page.items).toMatchObject([{ sessionId: durable.id }])
    expect(page.nextCursor).toEqual(expect.any(String))
    boundary.mockRestore()
    await expect(ctx.sessionSearch.searchEvents({ sessionId: durable.id, query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))
  })

  it('discards a stale list rejection when persistence unmounts during observation', async () => {
    const durable = header('racing')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    const persistenceFiber = await ctx.plugin(TestPersistence)
    let release!: () => void
    TestPersistence.listGate = new Promise<void>((resolve) => { release = resolve })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markStarted()
    }

    const search = ctx.sessionSearch.searchSessions({ query: 'needle' })
    await started
    await persistenceFiber.dispose()
    TestPersistence.failure = new Error('stale backend rejection')
    release()
    await expect(search).resolves.toEqual({ items: [] })
  })

  it('retries against a replacement after the prior binding rejects', async () => {
    const durable = header('replacement')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    const prior = await ctx.plugin(TestPersistence)
    let rejectPrior!: (reason: unknown) => void
    TestPersistence.listGate = new Promise<void>((_resolve, reject) => { rejectPrior = reject })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markStarted()
    }

    const search = ctx.sessionSearch.searchSessions({ query: 'needle' })
    await started
    await prior.dispose()
    TestPersistence.listGate = undefined
    const replacement = await ctx.plugin(TestPersistence)
    rejectPrior(new Error('stale prior binding'))
    await expect(search).resolves.toMatchObject({ items: [{ header: durable }] })
    await replacement.dispose()
  })

  it('reloads a replacement source even when its opaque revisions collide', async () => {
    const durable = header('colliding-replacement')
    TestPersistence.reset([{ meta: durable, events: messageEvents('old content') }])
    const revision = TestPersistence.revisions.get(durable.id)!
    const ctx = await liveContext()
    const prior = await ctx.plugin(TestPersistence)
    await expect(ctx.sessionSearch.searchSessions({ query: 'old' }))
      .resolves.toMatchObject({ items: [{ header: durable }] })
    await prior.dispose()

    TestPersistence.set({ meta: durable, events: messageEvents('new needle') })
    TestPersistence.revisions.set(durable.id, revision)
    const replacement = await ctx.plugin(TestPersistence)
    const page = await ctx.sessionSearch.searchSessions({ query: 'new needle' })
    expect(TestPersistence.loads.get(durable.id)).toBe(2)
    expect(page).toMatchObject({ items: [{ header: durable }] })
    await expect(ctx.sessionSearch.searchSessions({ query: 'old' })).resolves.toEqual({ items: [] })
    expect(TestPersistence.loads.get(durable.id)).toBe(2)
    await replacement.dispose()
  })

  it('retries when a successful observation belongs to a source unmounted during listing', async () => {
    const durable = header('successful-unmount')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    const persistence = await ctx.plugin(TestPersistence)
    let lists = 0
    TestPersistence.snapshotEffect = async () => {
      lists += 1
      if (lists === 2) await persistence.dispose()
    }

    await expect(ctx.sessionSearch.searchSessions({ query: 'needle' })).resolves.toEqual({ items: [] })
    expect(lists).toBe(2)
  })

  it('retries when the snapshot population changes during observation', async () => {
    const first = header('first')
    const added = header('added-during-list')
    TestPersistence.reset([{ meta: first, events: messageEvents('first needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    TestPersistence.snapshotEffect = () => {
      TestPersistence.snapshotEffect = undefined
      TestPersistence.set({ meta: added, events: messageEvents('added needle') })
    }

    const page = await ctx.sessionSearch.searchSessions({ query: 'needle' })
    expect(page.items.map(item => item.header.id).sort()).toEqual([added.id, first.id].sort())
    expect(TestPersistence.loads.get(first.id)).toBe(2)
    expect(TestPersistence.loads.get(added.id)).toBe(1)
  })

  it('fails after one retry when persistence snapshots keep changing', async () => {
    const durable = header('continuous-mutation')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    let lists = 0
    TestPersistence.snapshotEffect = () => {
      lists += 1
      TestPersistence.set({ meta: durable, events: messageEvents(`durable needle ${lists}`) })
    }

    await expect(ctx.sessionSearch.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    expect(lists).toBe(4)
  })

  it('retries if the persistence binding changes while live sessions are observed', async () => {
    const durable = header('live-boundary-retry')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const internals = ctx.sessionSearch as unknown as {
      _persistenceBinding: { identity: symbol; service?: SessionPersistence }
    }
    const originalList = ctx.sessions.list.bind(ctx.sessions)
    let bumped = false
    const list = vi.spyOn(ctx.sessions, 'list').mockImplementation(() => {
      if (!bumped) {
        bumped = true
        internals._persistenceBinding = {
          ...internals._persistenceBinding,
          identity: Symbol(),
        }
      }
      return originalList()
    })

    await expect(ctx.sessionSearch.searchSessions({ query: 'needle' }))
      .resolves.toMatchObject({ items: [{ header: durable }] })
    expect(TestPersistence.loads.get(durable.id)).toBe(2)
    list.mockRestore()
  })

  it('rejects malformed snapshots and preserves typed persistence failures', async () => {
    const durable = header('invalid-snapshot')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)

    TestPersistence.snapshotOverride = () => 'not-an-array' as never
    await expect(ctx.sessionSearch.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.snapshotOverride = () => [{ header: durable, revision: 1 as never }]
    await expect(ctx.sessionSearch.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.snapshotOverride = () => [
      { header: durable, revision: SessionPersistenceRevision('duplicate:1') },
      { header: durable, revision: SessionPersistenceRevision('duplicate:2') },
    ]
    await expect(ctx.sessionSearch.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))

    TestPersistence.snapshotOverride = undefined
    const typed = new SessionQueryError('typed persistence failure', 'SESSION_QUERY_PERSISTENCE_FAILED')
    TestPersistence.failure = typed
    await expect(ctx.sessionSearch.searchSessions({ query: 'needle' })).rejects.toBe(typed)
  })

  it('rejects immutable header conflicts between live and persisted sources', async () => {
    const shared = header('conflict', 10)
    TestPersistence.reset([{ meta: shared, events: messageEvents('persisted needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    ctx.sessions.create(shared.id, { seed: messageEvents('live needle'), meta: { createdAt: 11 } })

    await expect(ctx.sessionSearch.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SOURCE_CONFLICT'))
  })

  it('preserves unchanged persisted generations while reconciling new, changed, and deleted rows', async () => {
    const path = await temporaryPath()
    const unchanged = header('unchanged')
    const changed = header('changed')
    const deleted = header('deleted')
    TestPersistence.reset([
      { meta: unchanged, events: messageEvents('unchanged needle') },
      { meta: changed, events: messageEvents('old needle') },
      { meta: deleted, events: messageEvents('deleted needle') },
    ])
    const first = new Context()
    await first.plugin(SessionStore)
    const firstPersistence = await first.plugin(TestPersistence)
    const firstSearch = await first.plugin(SessionSearchSqlite, { path })
    await first.sessionSearch.searchSessions({ query: 'needle' })
    expect(Object.fromEntries(TestPersistence.loads)).toEqual({ unchanged: 1, changed: 1, deleted: 1 })
    await first.sessionSearch.searchSessions({ query: 'needle' })
    expect(Object.fromEntries(TestPersistence.loads)).toEqual({ unchanged: 1, changed: 1, deleted: 1 })
    await firstSearch.dispose()
    await firstPersistence.dispose()

    const beforeDb = new DatabaseSync(path)
    const beforeRows = beforeDb.prepare('SELECT id, generation FROM persisted_sessions ORDER BY id').all() as Array<{ id: string; generation: number }>
    beforeDb.close()
    const before = new Map(beforeRows.map(row => [row.id, row.generation]))

    const added = header('added')
    TestPersistence.entries.delete(deleted.id)
    TestPersistence.set({ meta: changed, events: messageEvents('changed needle') })
    TestPersistence.set({ meta: added, events: messageEvents('added needle') })
    const second = new Context()
    await second.plugin(SessionStore)
    const secondPersistence = await second.plugin(TestPersistence)
    const secondSearch = await second.plugin(SessionSearchSqlite, { path })
    const result = await second.sessionSearch.searchSessions({ query: 'needle' })
    expect(result.items.map(item => item.header.id).sort()).toEqual([added.id, changed.id, unchanged.id].sort())
    expect(Object.fromEntries(TestPersistence.loads)).toEqual({
      unchanged: 1,
      changed: 2,
      deleted: 1,
      added: 1,
    })
    await secondSearch.dispose()
    await secondPersistence.dispose()

    const afterDb = new DatabaseSync(path)
    const afterRows = afterDb.prepare('SELECT id, generation FROM persisted_sessions ORDER BY id').all() as Array<{ id: string; generation: number }>
    afterDb.close()
    const after = new Map(afterRows.map(row => [row.id, row.generation]))
    expect(after.get(unchanged.id)).toBe(before.get(unchanged.id))
    expect(after.get(changed.id)).toBeGreaterThan(before.get(changed.id)!)
    expect(after.has(deleted.id)).toBe(false)
    expect(after.has(added.id)).toBe(true)
  })

  it('drops connection-local live overlays on reopen and retains persistent bases', async () => {
    const path = await temporaryPath()
    const shared = header('shared', 10)
    TestPersistence.reset([{ meta: shared, events: messageEvents('persisted needle') }])
    const first = new Context()
    await first.plugin(SessionStore)
    const persistence = await first.plugin(TestPersistence)
    const live = first.sessions.create(shared.id, { seed: messageEvents('live needle'), meta: { createdAt: 10 } })
    const search = await first.plugin(SessionSearchSqlite, { path })
    await expect(first.sessionSearch.searchEvents({ sessionId: live.id, query: 'live' })).resolves.toMatchObject({ items: [{}] })
    await search.dispose()
    await persistence.dispose()

    const second = new Context()
    await second.plugin(SessionStore)
    const persistenceAgain = await second.plugin(TestPersistence)
    const searchAgain = await second.plugin(SessionSearchSqlite, { path })
    await expect(second.sessionSearch.searchSessions({ query: 'live' })).resolves.toEqual({ items: [] })
    await expect(second.sessionSearch.searchSessions({ query: 'persisted' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: false, persisted: true }] })
    expect(TestPersistence.loads.get(shared.id)).toBe(1)
    await searchAgain.dispose()
    await persistenceAgain.dispose()
  })

  it('refreshes the stored revision after a mutating load repair', async () => {
    const durable = header('repair')
    TestPersistence.reset([{ meta: durable, events: messageEvents('before repair') }])
    TestPersistence.loadEffect = (entry) => {
      entry.events = messageEvents('repaired needle')
    }
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)

    await expect(ctx.sessionSearch.searchSessions({ query: 'repaired' }))
      .resolves.toMatchObject({ items: [{ header: durable }] })
    expect(TestPersistence.loads.get(durable.id)).toBe(2)
    await ctx.sessionSearch.searchSessions({ query: 'repaired' })
    expect(TestPersistence.loads.get(durable.id)).toBe(2)
  })

  it('recovers on the next search after source and SQLite transaction failures', async () => {
    TestPersistence.reset([{ meta: header('durable'), events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    TestPersistence.failure = 'offline'
    await expect(ctx.sessionSearch.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    const signal = new AbortController().signal
    await expect(ctx.sessionSearch.searchSessions({ query: 'needle' }, { signal }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.failure = new Error('still offline')
    await expect(ctx.sessionSearch.searchSessions({ query: 'needle' }, { signal }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.failure = undefined
    await expect(ctx.sessionSearch.searchSessions({ query: 'needle' })).resolves.toMatchObject({ items: [{}] })

    const live = ctx.sessions.create(SessionId('live'), { seed: messageEvents('base') })
    await ctx.sessionSearch.searchEvents({ sessionId: live.id, query: 'base' })
    const db = (ctx.sessionSearch as unknown as { _db: DatabaseSync })._db
    db.exec('PRAGMA query_only = ON')
    live.append('user/message', { content: [{ type: 'text', text: 'retry needle' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    await expect(ctx.sessionSearch.searchEvents({ sessionId: live.id, query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    db.exec('PRAGMA query_only = OFF')
    await expect(ctx.sessionSearch.searchEvents({ sessionId: live.id, query: 'needle' }))
      .resolves.toMatchObject({ items: [{ seq: 1 }] })
  })
})

describe('SQLite schema, cancellation, and real persistence integration', () => {
  it('resets a recognized incompatible derived schema but refuses a foreign database', async () => {
    const stalePath = await temporaryPath('stale.db')
    const stale = new DatabaseSync(stalePath)
    stale.exec(`PRAGMA application_id = ${SESSION_QUERY_SQLITE_APPLICATION_ID}`)
    stale.exec('PRAGMA user_version = 999')
    stale.exec('CREATE TABLE stale(value TEXT)')
    stale.close()
    const staleCtx = await liveContext({ path: stalePath })
    staleCtx.sessions.create(SessionId('live'), { seed: messageEvents('needle') })
    await staleCtx.sessionSearch.searchSessions({ query: 'needle' })
    await (staleCtx.sessionSearch as SessionSearchSqlite).close()
    const rebuilt = new DatabaseSync(stalePath)
    expect((rebuilt.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(SESSION_QUERY_SQLITE_SCHEMA_VERSION)
    expect(rebuilt.prepare("SELECT name FROM sqlite_master WHERE name = 'stale'").get()).toBeUndefined()
    rebuilt.close()

    const foreignPath = await temporaryPath('foreign.db')
    const foreign = new DatabaseSync(foreignPath)
    foreign.exec('PRAGMA journal_mode = WAL')
    foreign.exec('CREATE TABLE canonical(value TEXT)')
    foreign.exec("INSERT INTO canonical VALUES ('safe')")
    foreign.close()
    const foreignCtx = await liveContext({ path: foreignPath, journalMode: 'delete' })
    await expect(foreignCtx.sessionSearch.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    const stillForeign = new DatabaseSync(foreignPath)
    expect(stillForeign.prepare('SELECT value FROM canonical').get()).toEqual({ value: 'safe' })
    expect(stillForeign.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    stillForeign.close()
    await (foreignCtx.sessionSearch as SessionSearchSqlite).close()

    const otherAppPath = await temporaryPath('other-app.db')
    const otherApp = new DatabaseSync(otherAppPath)
    otherApp.exec('PRAGMA application_id = 123')
    otherApp.close()
    const otherAppCtx = await liveContext({ path: otherAppPath })
    await expect(otherAppCtx.sessionSearch.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    await (otherAppCtx.sessionSearch as SessionSearchSqlite).close()
  })

  it('observes asynchronous open rejection even when no query is made', async () => {
    const path = await temporaryPath('never-queried.db')
    const foreign = new DatabaseSync(path)
    foreign.exec('CREATE TABLE canonical(value TEXT)')
    foreign.close()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const ctx = await liveContext({ path })
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(unhandled).toEqual([])
      await (ctx.sessionSearch as SessionSearchSqlite).close()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('cancels both queued and in-flight source waits without committing them', async () => {
    TestPersistence.reset()
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)

    const boundaryController = new AbortController()
    const boundary = ctx.sessionSearch.searchSessions({ query: 'needle' }, { signal: boundaryController.signal })
    queueMicrotask(() => { boundaryController.abort() })
    await expect(boundary).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))

    const readyController = new AbortController()
    readyController.abort()
    const internals = ctx.sessionSearch as unknown as {
      _ensureReady(signal: AbortSignal): Promise<void>
    }
    await expect(internals._ensureReady(readyController.signal))
      .rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))

    let releaseBlocking!: () => void
    TestPersistence.listGate = new Promise<void>((resolve) => { releaseBlocking = resolve })
    let markBlockingStarted!: () => void
    const blockingStarted = new Promise<void>((resolve) => { markBlockingStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markBlockingStarted()
    }
    const blocking = ctx.sessionSearch.searchSessions({ query: 'needle' })
    await blockingStarted

    const queuedController = new AbortController()
    const queued = ctx.sessionSearch.searchSessions({ query: 'needle' }, { signal: queuedController.signal })
    queuedController.abort()
    await expect(queued).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))

    releaseBlocking()
    await expect(blocking).resolves.toEqual({ items: [] })

    TestPersistence.set({
      meta: header('uncommitted'),
      events: messageEvents('durable needle'),
    })
    let releaseActive!: () => void
    TestPersistence.listGate = new Promise<void>((resolve) => { releaseActive = resolve })
    let markActiveStarted!: () => void
    const activeStarted = new Promise<void>((resolve) => { markActiveStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markActiveStarted()
    }
    const activeController = new AbortController()
    const active = ctx.sessionSearch.searchSessions({ query: 'needle' }, { signal: activeController.signal })
    await activeStarted
    activeController.abort()
    await expect(active).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))
    releaseActive()

    const db = (ctx.sessionSearch as unknown as { _db: DatabaseSync })._db
    expect(db.prepare('SELECT COUNT(*) AS count FROM persisted_sessions').get()).toEqual({ count: 0 })
    await expect(ctx.sessionSearch.searchSessions({ query: 'needle' }))
      .resolves.toMatchObject({ items: [{ header: { id: SessionId('uncommitted') } }] })
  })

  it('rejects queued and future work when close waits for an accepted operation', async () => {
    TestPersistence.reset()
    let release!: () => void
    TestPersistence.listGate = new Promise<void>((resolve) => { release = resolve })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markStarted()
    }
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const search = ctx.sessionSearch as SessionSearchSqlite
    const accepted = search.searchSessions({ query: 'needle' })
    await started
    const queued = search.searchSessions({ query: 'needle' })
    const closing = search.close()
    const repeatedClose = search.close()
    expect(repeatedClose).toBe(closing)
    release()

    await expect(accepted).resolves.toEqual({ items: [] })
    await expect(queued).rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    await Promise.all([closing, repeatedClose])
    await expect(search.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(search.close()).toBe(closing)
  })

  it('awaits optional-persistence child-fiber quiescence on disposal', async () => {
    TestPersistence.reset()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const search = await ctx.plugin(SessionSearchSqlite, { path: ':memory:' })
    const persistence = await ctx.plugin(TestPersistence)
    const optional = (ctx.sessionSearch as unknown as {
      _optionalPersistenceFiber: Fiber
    })._optionalPersistenceFiber
    let release!: () => void
    const cleanup = new Promise<void>((resolve) => { release = resolve })
    optional.ctx.effect(() => () => cleanup)

    let settled = false
    const disposing = search.dispose().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await disposing
    await persistence.dispose()
  })

  it('combines the real SQLite persistence backend with the real search service keylessly', async () => {
    const persistencePath = await temporaryPath('canonical.db')
    const searchPath = await temporaryPath('derived.db')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const persistence = await ctx.plugin(SessionPersistenceSqlite, { path: persistencePath })
    const search = await ctx.plugin(SessionSearchSqlite, { path: searchPath })
    const meta = header('real', 10, { cwd: '/work' })
    await ctx.sessionPersistence.create(meta)
    await ctx.sessionPersistence.append(meta.id, messageEvents('real SQLite needle'))

    await expect(ctx.sessionSearch.searchSessions({ query: 'SQLite needle' }))
      .resolves.toMatchObject({ items: [{ header: meta, persisted: true, live: false }] })
    await expect(ctx.sessionSearch.searchEvents({ sessionId: meta.id, query: 'SQLite needle' }))
      .resolves.toMatchObject({ items: [{ sessionId: meta.id, seq: 0 }] })
    await expect(ctx.sessionSearch.searchEvents({ sessionId: SessionId('absent'), query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))
    await search.dispose()
    await expect(ctx.sessionPersistence.load(meta.id)).resolves.toMatchObject({ meta, events: [{ seq: 0 }] })
    await persistence.dispose()
  })

  it('reconciles colliding local revisions when a derived index reopens against another SQLite store', async () => {
    const persistencePathA = await temporaryPath('canonical-a.db')
    const persistencePathB = await temporaryPath('canonical-b.db')
    const searchPath = await temporaryPath('derived-collision.db')
    const shared = header('same-id', 10)

    const first = new Context()
    await first.plugin(SessionStore)
    const persistenceA = await first.plugin(SessionPersistenceSqlite, { path: persistencePathA })
    await first.sessionPersistence.create(shared)
    await first.sessionPersistence.append(shared.id, messageEvents('alpha source'))
    const loadA = vi.spyOn(first.sessionPersistence, 'load')
    const searchA = await first.plugin(SessionSearchSqlite, { path: searchPath })
    await expect(first.sessionSearch.searchSessions({ query: 'alpha' }))
      .resolves.toMatchObject({ items: [{ header: shared }] })
    expect(loadA).toHaveBeenCalledTimes(1)
    await searchA.dispose()
    await persistenceA.dispose()

    const reopened = new Context()
    await reopened.plugin(SessionStore)
    const persistenceAAgain = await reopened.plugin(SessionPersistenceSqlite, { path: persistencePathA })
    const reopenedLoad = vi.spyOn(reopened.sessionPersistence, 'load')
    const searchAAgain = await reopened.plugin(SessionSearchSqlite, { path: searchPath })
    await expect(reopened.sessionSearch.searchSessions({ query: 'alpha' }))
      .resolves.toMatchObject({ items: [{ header: shared }] })
    expect(reopenedLoad).not.toHaveBeenCalled()
    await searchAAgain.dispose()
    await persistenceAAgain.dispose()

    const second = new Context()
    await second.plugin(SessionStore)
    const persistenceB = await second.plugin(SessionPersistenceSqlite, { path: persistencePathB })
    await second.sessionPersistence.create(shared)
    await second.sessionPersistence.append(shared.id, messageEvents('bravo source'))
    const loadB = vi.spyOn(second.sessionPersistence, 'load')
    const searchB = await second.plugin(SessionSearchSqlite, { path: searchPath })
    await expect(second.sessionSearch.searchSessions({ query: 'bravo' }))
      .resolves.toMatchObject({ items: [{ header: shared }] })
    await expect(second.sessionSearch.searchSessions({ query: 'alpha' })).resolves.toEqual({ items: [] })
    expect(loadB).toHaveBeenCalledTimes(1)
    await searchB.dispose()
    await persistenceB.dispose()
  })
})
