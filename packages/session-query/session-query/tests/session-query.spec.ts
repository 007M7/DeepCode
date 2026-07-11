import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import SessionQueryService, {
  SessionQueryError,
  filterEventResults,
  filterSessionResults,
} from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchHit,
  SessionEventSearchSpec,
  SessionIndexSnapshot,
  SessionQueryErrorCode,
  SessionRecord,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchProvider,
  SessionSearchProviderStatus,
  SessionSearchSpec,
} from '@deepseek-ai/dsh-session-query'

declare module '@deepseek-ai/dsh-llm' {
  interface ContentBlockMap {
    'test/text': { type: 'test/text'; value: string }
  }
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'test/note': { note: string }
  }
}

function header(id: string, createdAt = 1, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt, ...extra }
}

function eventLog(text = 'hello'): SessionEvent[] {
  return [{
    type: 'user/message',
    seq: 0,
    time: 10,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
    surfaceOp: 'append',
  }]
}

class TestPersistence extends SessionPersistence {
  static entries = new Map<SessionIdType, { meta: SessionHeader; events: SessionEvent[] }>()
  static listFailure: unknown
  static loadFailure: unknown
  static listBarrier: Promise<void> | undefined
  static onList: (() => void) | undefined

  static reset(entries: readonly { meta: SessionHeader; events: SessionEvent[] }[] = []): void {
    this.entries = new Map(entries.map(entry => [entry.meta.id, structuredClone(entry)]))
    this.listFailure = undefined
    this.loadFailure = undefined
    this.listBarrier = undefined
    this.onList = undefined
  }

  create(meta: SessionHeader): Promise<void> {
    TestPersistence.entries.set(meta.id, { meta: structuredClone(meta), events: [] })
    return Promise.resolve()
  }

  append(id: SessionIdType, events: readonly SessionEvent[]): Promise<void> {
    const entry = TestPersistence.entries.get(id)
    if (entry === undefined) throw new Error('missing test session')
    entry.events.push(...structuredClone(events))
    return Promise.resolve()
  }

  load(id: SessionIdType): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    if (TestPersistence.loadFailure !== undefined) return Promise.reject(asError(TestPersistence.loadFailure))
    const entry = TestPersistence.entries.get(id)
    if (entry === undefined) return Promise.reject(new Error('missing test session'))
    return Promise.resolve(structuredClone(entry))
  }

  list(): Promise<SessionHeader[]> {
    if (TestPersistence.listFailure !== undefined) return Promise.reject(asError(TestPersistence.listFailure))
    const snapshot = [...TestPersistence.entries.values()].map(entry => structuredClone(entry.meta))
    TestPersistence.onList?.()
    return (TestPersistence.listBarrier ?? Promise.resolve()).then(() => snapshot)
  }
}

class FakeProvider implements SessionSearchProvider {
  readonly id: string
  statusValue: SessionSearchProviderStatus = { available: true }
  persisted = new Map<SessionIdType, SessionIndexSnapshot>()
  live = new Map<SessionIdType, SessionIndexSnapshot>()
  activeHistory: boolean[] = []
  removedPersisted: SessionIdType[] = []
  removedLive: SessionIdType[] = []
  sessionRequests: SessionSearchSpec[] = []
  eventRequests: SessionEventSearchSpec[] = []
  failNextLive = false
  failNextPersisted = false
  failNextActive = false
  sessionPage: SessionSearchPage<SessionSearchHit>
  eventPage: SessionSearchPage<SessionEventSearchHit>

  constructor(id = 'fake') {
    this.id = id
    this.sessionPage = { providerId: id, items: [] }
    this.eventPage = { providerId: id, items: [] }
  }

  status(): SessionSearchProviderStatus {
    return this.statusValue
  }

  persistedInventory(): Promise<readonly { sessionId: SessionIdType; fingerprint: string }[]> {
    return Promise.resolve([...this.persisted.values()].map(snapshot => ({
      sessionId: snapshot.session.header.id,
      fingerprint: snapshot.fingerprint,
    })))
  }

  setPersistedActive(active: boolean): Promise<void> {
    if (this.failNextActive) {
      this.failNextActive = false
      return Promise.reject(new Error('activation failed'))
    }
    this.activeHistory.push(active)
    return Promise.resolve()
  }

  replacePersisted(snapshot: SessionIndexSnapshot): Promise<void> {
    if (this.failNextPersisted) {
      this.failNextPersisted = false
      return Promise.reject(new Error('persisted index failed'))
    }
    this.persisted.set(snapshot.session.header.id, structuredClone(snapshot))
    return Promise.resolve()
  }

  removePersisted(sessionId: SessionIdType): Promise<void> {
    this.removedPersisted.push(sessionId)
    this.persisted.delete(sessionId)
    return Promise.resolve()
  }

  replaceLive(snapshot: SessionIndexSnapshot): Promise<void> {
    if (this.failNextLive) {
      this.failNextLive = false
      return Promise.reject(new Error('live index failed'))
    }
    this.live.set(snapshot.session.header.id, structuredClone(snapshot))
    return Promise.resolve()
  }

  removeLive(sessionId: SessionIdType): Promise<void> {
    this.removedLive.push(sessionId)
    this.live.delete(sessionId)
    return Promise.resolve()
  }

  searchSessions(request: SessionSearchSpec): Promise<SessionSearchPage<SessionSearchHit>> {
    this.sessionRequests.push(structuredClone(request))
    return Promise.resolve(structuredClone(this.sessionPage))
  }

  searchEvents(request: SessionEventSearchSpec): Promise<SessionSearchPage<SessionEventSearchHit>> {
    this.eventRequests.push(structuredClone(request))
    return Promise.resolve(structuredClone(this.eventPage))
  }
}

async function liveContext(config: ConstructorParameters<typeof SessionQueryService>[1] = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionQueryService, config)
  return ctx
}

function expectCode(code: SessionQueryErrorCode): Error {
  return expect.objectContaining({ code }) as Error
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('pure result filters', () => {
  it('chains session filters as AND while values within one filter are OR', () => {
    const root: SessionRecord = { header: header('root', 1, { cwd: '/a' }), live: true, persisted: false }
    const child: SessionRecord = { header: header('child', 2, { cwd: '/b', parentSession: root.header.id }), live: false, persisted: true }
    const both: SessionRecord = { header: header('both', 3, { cwd: '/a', parentSession: root.header.id }), live: true, persisted: true }
    const input = [child, root, both]

    const output = filterSessionResults(input, [
      { kind: 'cwd', values: ['/a', '/b'] },
      { kind: 'created-at', range: { from: 2, to: 3 } },
      { kind: 'parent', values: [root.header.id] },
      { kind: 'availability', values: ['live', 'persisted'] },
      { kind: 'id', values: [child.header.id, both.header.id] },
    ])

    expect(output).toEqual([child, both])
    expect(output[0]).toBe(child)
    expect(input).toEqual([child, root, both])
    expect(filterSessionResults(input, [{ kind: 'cwd', values: [null] }])).toEqual([])
  })

  it('filters event ranges/types/status without reordering richer records', () => {
    const events = [
      { sessionId: SessionId('s'), seq: 2, type: 'user/message' as const, time: 20, surface: 'current' as const, extra: true },
      { sessionId: SessionId('s'), seq: 1, type: 'tool/call' as const, time: 10, surface: 'shadowed' as const, extra: true },
      { sessionId: SessionId('s'), seq: 3, type: 'assistant/chunk' as const, time: 30, surface: 'log-only' as const, extra: true },
    ]
    const output = filterEventResults(events, [
      { kind: 'seq', range: { from: 1, to: 2 } },
      { kind: 'time', range: { from: 10, to: 20 } },
      { kind: 'type', values: ['user/message', 'tool/call'] },
      { kind: 'surface', values: ['current', 'shadowed'] },
    ])
    expect(output).toEqual(events.slice(0, 2))
    expect(output[0]).toBe(events[0])
  })

  it('rejects invalid serializable filter values', () => {
    expect(() => filterSessionResults([], [{ kind: 'created-at', range: { from: 2, to: 1 } }]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => filterEventResults([], [{ kind: 'seq', range: { from: Number.NaN } }]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => filterEventResults([], [{ kind: 'time', range: { to: Number.POSITIVE_INFINITY } }]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => filterEventResults([], [{ kind: 'surface', values: ['other' as never] }]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => filterSessionResults([], [{ kind: 'availability', values: ['other' as never] }]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
  })

  it('handles absent range bounds and root/availability alternatives', () => {
    const record: SessionRecord = { header: header('root'), live: false, persisted: true }
    expect(filterSessionResults([record], [
      { kind: 'parent', values: [null] },
      { kind: 'cwd', values: [null] },
      { kind: 'availability', values: ['persisted'] },
    ])).toEqual([record])
    const event = { sessionId: record.header.id, seq: 2, type: 'user/message' as const, time: 4, surface: 'current' as const }
    expect(filterEventResults([event], [{ kind: 'seq', range: { to: 2 } }, { kind: 'time', range: { from: 4 } }])).toEqual([event])
  })
})

describe('logical corpus reads and traces', () => {
  it('lists, classifies, reads, and traces a live session using detached records', async () => {
    const ctx = await liveContext({ readWindowMax: 2 })
    const session = ctx.sessions.create(SessionId('live'), { meta: { createdAt: 20, cwd: '/work' } })
    const original = session.append('user/message', { content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const chunk = session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'answer' } })
    const answer = session.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'answer' }] }, { surfaceOp: 'append', sourceEventSeqs: [chunk.seq] })
    const summary = session.append('assistant/message', { turn: 1, step: 2, content: [{ type: 'text', text: 'summary' }] }, { surfaceOp: { op: 'replace', start: original.seq, end: original.seq }, sourceEventSeqs: [original.seq] })
    const resummary = session.append('assistant/message', { turn: 1, step: 3, content: [{ type: 'text', text: 'resummary' }] }, { surfaceOp: { op: 'replace', start: summary.seq, end: answer.seq }, sourceEventSeqs: [summary.seq, answer.seq] })

    const listed = await ctx.sessionQuery.listSessions()
    expect(listed).toEqual([{ header: session.header, live: true, persisted: false }])
    listed[0]!.header.createdAt = -1
    expect(session.header.createdAt).toBe(20)
    expect((await ctx.sessionQuery.listEvents(session.id)).map(event => event.surface))
      .toEqual(['shadowed', 'log-only', 'shadowed', 'shadowed', 'current'])

    const window = await ctx.sessionQuery.readEvent({ sessionId: session.id, seq: answer.seq, before: 2, after: 2 })
    expect([window.startSeq, window.endSeq]).toEqual([0, 4])
    expect(window.target.seq).toBe(answer.seq)
    if (window.events[0]?.type !== 'user/message') throw new Error('expected user message')
    window.events[0].data.content = []
    expect(session.events[0]?.type === 'user/message' && session.events[0].data.content).toHaveLength(1)

    await expect(ctx.sessionQuery.traceEvent(session.id, original.seq)).resolves.toMatchObject({
      shadowedBy: summary.seq,
      replacementChain: [summary.seq, resummary.seq],
      referencedBy: [summary.seq],
    })
    await expect(ctx.sessionQuery.traceEvent(session.id, summary.seq)).resolves.toMatchObject({
      shadows: [original.seq],
      references: [original.seq],
      referencedBy: [resummary.seq],
    })
    await expect(ctx.sessionQuery.traceEvent(session.id, chunk.seq)).resolves.toMatchObject({ referencedBy: [answer.seq] })
    await expect(ctx.sessionQuery.readEvent({ sessionId: session.id, seq: 99 })).rejects.toThrow(expectCode('SESSION_QUERY_EVENT_NOT_FOUND'))
    await expect(ctx.sessionQuery.readEvent({ sessionId: session.id, seq: 0, before: 3 })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_WINDOW'))
    await expect(ctx.sessionQuery.traceEvent(session.id, 99)).rejects.toThrow(expectCode('SESSION_QUERY_EVENT_NOT_FOUND'))
  })

  it('turns malformed replacement logs into typed surface failures', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('bad-surface'))
    session.append('assistant/message', { turn: 1, step: 1, content: [] }, {
      surfaceOp: { op: 'replace', start: 9, end: 9 },
      sourceEventSeqs: [],
    })
    await expect(ctx.sessionQuery.listEvents(session.id)).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_SURFACE'))
  })

  it('returns complete, partial, deterministic, and cycle-checked lineage', async () => {
    const ctx = await liveContext()
    const root = ctx.sessions.create(SessionId('root'), { meta: { createdAt: 1 } })
    const second = ctx.sessions.create(SessionId('second'), { meta: { createdAt: 2, parentSession: root.id } })
    const first = ctx.sessions.create(SessionId('first'), { meta: { createdAt: 2, parentSession: root.id } })
    const grandchild = ctx.sessions.create(SessionId('grandchild'), { meta: { createdAt: 3, parentSession: first.id } })
    const partial = ctx.sessions.create(SessionId('partial'), { meta: { createdAt: 4, parentSession: SessionId('missing') } })

    const trace = await ctx.sessionQuery.traceSession(grandchild.id)
    expect(trace.parents.map(record => record.header.id)).toEqual([first.id, root.id])
    expect(trace.root?.header.id).toBe(root.id)
    const rootTrace = await ctx.sessionQuery.traceSession(root.id)
    expect(rootTrace.children.map(node => node.session.header.id)).toEqual([first.id, second.id])
    expect(rootTrace.children[0]?.children[0]?.session.header.id).toBe(grandchild.id)
    await expect(ctx.sessionQuery.traceSession(partial.id)).resolves.toMatchObject({ unresolvedParentId: SessionId('missing') })
    await expect(ctx.sessionQuery.traceSession(SessionId('absent'))).rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))

    const cyclic = await liveContext()
    const a = new Session(SessionId('a'), [], header('a', 1, { parentSession: SessionId('b') }))
    const b = new Session(SessionId('b'), [], header('b', 2, { parentSession: SessionId('a') }))
    cyclic.sessions.enter(a)
    cyclic.sessions.enter(b)
    await expect(cyclic.sessionQuery.traceSession(a.id)).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_LINEAGE'))
  })

  it('uses live content over a matching persisted base and scopes persistence failures', async () => {
    const common = header('same', 5, { cwd: '/w' })
    const persistedOnly = header('persisted', 1)
    TestPersistence.reset([
      { meta: common, events: eventLog('persisted version') },
      { meta: persistedOnly, events: eventLog('persisted only') },
    ])
    const ctx = await liveContext()
    const live = ctx.sessions.create(common.id, { meta: { createdAt: common.createdAt, cwd: '/w' } })
    live.append('user/message', { content: [{ type: 'text', text: 'live version' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const persistenceFiber = await ctx.plugin(TestPersistence)
    await expect(ctx.sessionQuery.listEvents(SessionId('not-listed')))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))

    const records = await ctx.sessionQuery.listSessions()
    expect(records.map(record => [record.header.id, record.live, record.persisted])).toEqual([
      [common.id, true, true],
      [persistedOnly.id, false, true],
    ])
    const liveWindow = await ctx.sessionQuery.readEvent({ sessionId: common.id, seq: 0 })
    expect(liveWindow.target.type === 'user/message' && liveWindow.target.data.content[0]).toMatchObject({ text: 'live version' })
    await expect(ctx.sessionQuery.readEvent({ sessionId: persistedOnly.id, seq: 0 }))
      .resolves.toMatchObject({ session: { persisted: true } })

    TestPersistence.listFailure = new Error('list unavailable')
    await expect(ctx.sessionQuery.listEvents(common.id)).resolves.toHaveLength(1)
    await expect(ctx.sessionQuery.listSessions()).rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.listFailure = undefined
    TestPersistence.loadFailure = new Error('load unavailable')
    await expect(ctx.sessionQuery.listEvents(persistedOnly.id)).rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.loadFailure = new SessionQueryError('typed load failure', 'SESSION_QUERY_EVENT_NOT_FOUND')
    await expect(ctx.sessionQuery.listEvents(persistedOnly.id)).rejects.toThrow(expectCode('SESSION_QUERY_EVENT_NOT_FOUND'))

    await persistenceFiber.dispose()
    TestPersistence.loadFailure = undefined
    await expect(ctx.sessionQuery.listSessions()).resolves.toEqual([{ header: common, live: true, persisted: false }])
  })

  it('rejects immutable source header conflicts', async () => {
    TestPersistence.reset([{ meta: header('conflict', 1, { cwd: '/persisted' }), events: eventLog() }])
    const ctx = await liveContext()
    ctx.sessions.create(SessionId('conflict'), { meta: { createdAt: 1, cwd: '/live' } })
    await ctx.plugin(TestPersistence)
    await expect(ctx.sessionQuery.listSessions()).rejects.toThrow(expectCode('SESSION_QUERY_SOURCE_CONFLICT'))
  })
})

describe('provider selection and synchronization', () => {
  it('selects one usable provider, validates requests/pages, and disposes registration', async () => {
    const ctx = await liveContext({ defaultLimit: 2, maxLimit: 3 })
    const session = ctx.sessions.create(SessionId('s'))
    session.append('user/message', { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const provider = new FakeProvider()
    const dispose = ctx.sessionQuery.registerSearchProvider(provider)
    const record: SessionRecord = { header: structuredClone(session.header), live: true, persisted: false }
    const bestMatch = { sessionId: session.id, seq: 0, type: 'user/message' as const, time: session.events[0]!.time, surface: 'current' as const, snippet: 'hello' }
    provider.sessionPage = { providerId: provider.id, items: [
      { ...record, bestMatch }, { ...record, bestMatch }, { ...record, bestMatch },
    ], nextCursor: 'next' }

    await expect(ctx.sessionQuery.searchSessions({ query: ' hello ', sessionFilters: [{ kind: 'availability', values: ['live'] }] }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PROVIDER_ERROR'))
    expect(provider.sessionRequests[0]).toMatchObject({ query: 'hello', limit: 2 })
    expect(provider.live.get(session.id)?.documents[0]?.text).toBe('hello')
    await expect(ctx.sessionQuery.searchSessions({ query: ' ' })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_QUERY'))
    await expect(ctx.sessionQuery.searchSessions({ query: 'x', limit: 4 })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_LIMIT'))
    provider.eventPage = { providerId: 'wrong', items: [] }
    await expect(ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'x' })).rejects.toThrow(expectCode('SESSION_QUERY_PROVIDER_ERROR'))

    provider.eventPage = { providerId: provider.id, items: [] }
    await expect(ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'x', limit: 1 }, { signal: new AbortController().signal }))
      .resolves.toMatchObject({ providerId: provider.id })

    dispose()
    await expect(ctx.sessionQuery.searchSessions({ query: 'x' })).rejects.toThrow(expectCode('SESSION_QUERY_PROVIDER_UNAVAILABLE'))
  })

  it('coalesces concurrent synchronization and supports cancellation while provider search is pending', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('coalesce'))
    session.append('user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const provider = new FakeProvider()
    ctx.sessionQuery.registerSearchProvider(provider)

    let releaseLive!: () => void
    const liveBarrier = new Promise<void>((resolve) => { releaseLive = resolve })
    let replacements = 0
    provider.replaceLive = async (snapshot) => {
      replacements += 1
      await liveBarrier
      provider.live.set(snapshot.session.header.id, structuredClone(snapshot))
    }
    const first = ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'x' })
    const second = ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'x' })
    await Promise.resolve()
    releaseLive()
    await Promise.all([first, second])
    expect(replacements).toBe(1)

    session.append('user/message', { content: [{ type: 'text', text: 'y' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    let releaseCorpus!: () => void
    const corpusBarrier = new Promise<void>((resolve) => { releaseCorpus = resolve })
    let corpusReplacements = 0
    provider.replaceLive = async (snapshot) => {
      corpusReplacements += 1
      await corpusBarrier
      provider.live.set(snapshot.session.header.id, structuredClone(snapshot))
    }
    const crossFirst = ctx.sessionQuery.searchSessions({ query: 'x' })
    const crossSecond = ctx.sessionQuery.searchSessions({ query: 'x' })
    await Promise.resolve()
    releaseCorpus()
    await Promise.all([crossFirst, crossSecond])
    expect(corpusReplacements).toBe(1)

    let releaseSearch!: () => void
    const searchBarrier = new Promise<void>((resolve) => { releaseSearch = resolve })
    provider.searchSessions = async () => {
      await searchBarrier
      return { providerId: provider.id, items: [] }
    }
    const controller = new AbortController()
    const pending = ctx.sessionQuery.searchSessions({ query: 'x' }, { signal: controller.signal })
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))
    releaseSearch()
    await Promise.resolve()

    provider.searchSessions = () => Promise.reject(new Error('search failed'))
    await expect(ctx.sessionQuery.searchSessions({ query: 'x' }, { signal: new AbortController().signal }))
      .rejects.toThrow('search failed')
  })

  it('reconciles a live removal observed while an older full sync is in flight', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.prepare(SessionId('removed-during-sync'))
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    session.append('user/message', { content: [{ type: 'text', text: 'stale live hit' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const provider = new FakeProvider()
    const replaceStarted = deferred()
    const releaseReplace = deferred()
    provider.replaceLive = async (snapshot) => {
      replaceStarted.resolve()
      await releaseReplace.promise
      provider.live.set(snapshot.session.header.id, structuredClone(snapshot))
    }
    const searchLiveIds: SessionIdType[][] = []
    provider.searchSessions = () => {
      searchLiveIds.push([...provider.live.keys()])
      const items: SessionSearchHit[] = []
      for (const snapshot of provider.live.values()) {
        const document = snapshot.documents[0]
        if (document === undefined) continue
        items.push({
          ...structuredClone(snapshot.session),
          bestMatch: { ...structuredClone(document), snippet: document.text },
        })
      }
      return Promise.resolve({ providerId: provider.id, items })
    }
    ctx.sessionQuery.registerSearchProvider(provider)

    const first = ctx.sessionQuery.searchSessions({ query: 'stale' })
    await replaceStarted.promise
    detach()
    const second = ctx.sessionQuery.searchSessions({ query: 'stale' })
    releaseReplace.resolve()

    await first
    await expect(second).resolves.toMatchObject({ items: [] })
    expect(provider.removedLive).toContain(session.id)
    expect(searchLiveIds.at(-1)).toEqual([])
  })

  it('searches a persisted target after corpus reconciliation', async () => {
    const persisted = header('event-persisted', 1)
    TestPersistence.reset([{ meta: persisted, events: eventLog('persisted target') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const provider = new FakeProvider()
    ctx.sessionQuery.registerSearchProvider(provider)

    await expect(ctx.sessionQuery.searchEvents({ sessionId: persisted.id, query: 'target' }))
      .resolves.toMatchObject({ providerId: provider.id })
    expect(provider.persisted.get(persisted.id)?.documents[0]?.text).toBe('persisted target')
  })

  it('fails loudly for duplicate, configured, unavailable, and ambiguous providers', async () => {
    const ctx = await liveContext()
    const first = new FakeProvider('first')
    ctx.sessionQuery.registerSearchProvider(first)
    expect(() => ctx.sessionQuery.registerSearchProvider(new FakeProvider('first'))).toThrow(expectCode('SESSION_QUERY_DUPLICATE_PROVIDER'))
    const second = new FakeProvider('second')
    ctx.sessionQuery.registerSearchProvider(second)
    await expect(ctx.sessionQuery.searchSessions({ query: 'x' })).rejects.toThrow(expectCode('SESSION_QUERY_PROVIDER_AMBIGUOUS'))

    const configured = await liveContext({ searchProvider: 'chosen' })
    await expect(configured.sessionQuery.searchSessions({ query: 'x' })).rejects.toThrow(expectCode('SESSION_QUERY_PROVIDER_CONFIGURED_MISSING'))
    const chosen = new FakeProvider('chosen')
    chosen.statusValue = { available: false, reason: 'unavailable' }
    configured.sessionQuery.registerSearchProvider(chosen)
    await expect(configured.sessionQuery.searchSessions({ query: 'x' })).rejects.toThrow(expectCode('SESSION_QUERY_PROVIDER_CONFIGURED_UNAVAILABLE'))
    chosen.statusValue = { available: true }
    await expect(configured.sessionQuery.searchSessions({ query: 'x' })).resolves.toMatchObject({ providerId: 'chosen' })
  })

  it('removes provider registrations with their contributing fiber', async () => {
    const ctx = await liveContext()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.sessionQuery.registerSearchProvider(new FakeProvider('scoped'))
    }, { inject: ['sessionQuery'] }))
    await expect(ctx.sessionQuery.searchSessions({ query: 'x' })).resolves.toMatchObject({ providerId: 'scoped' })
    await fiber.dispose()
    await expect(ctx.sessionQuery.searchSessions({ query: 'x' })).rejects.toThrow(expectCode('SESSION_QUERY_PROVIDER_UNAVAILABLE'))
  })

  it('reconciles persisted bases and live overrides, reuses fingerprints, and hides rows on unmount', async () => {
    const persisted = header('persisted', 1)
    const overlaid = header('overlaid', 1)
    TestPersistence.reset([
      { meta: persisted, events: eventLog('persisted') },
      { meta: overlaid, events: eventLog('base') },
    ])
    const ctx = await liveContext()
    const live = ctx.sessions.create(overlaid.id, { meta: { createdAt: overlaid.createdAt } })
    live.append('user/message', { content: [{ type: 'text', text: 'override' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const persistenceFiber = await ctx.plugin(TestPersistence)
    const provider = new FakeProvider()
    provider.failNextActive = true
    provider.persisted.set(SessionId('stale'), { session: { header: header('stale'), live: false, persisted: true }, fingerprint: 'stale', documents: [] })
    ctx.sessionQuery.registerSearchProvider(provider)

    await ctx.sessionQuery.searchSessions({ query: 'x' })
    expect(provider.persisted.get(persisted.id)?.documents[0]?.text).toBe('persisted')
    expect(provider.live.get(overlaid.id)?.documents[0]?.text).toBe('override')
    expect(provider.live.get(overlaid.id)?.session).toMatchObject({ live: true, persisted: true })
    expect(provider.removedPersisted).toEqual([SessionId('stale')])
    expect(provider.activeHistory.at(-1)).toBe(true)
    const fingerprint = provider.persisted.get(persisted.id)?.fingerprint
    await ctx.sessionQuery.searchSessions({ query: 'x' })
    expect(provider.persisted.get(persisted.id)?.fingerprint).toBe(fingerprint)

    const announced = header('announced', 3)
    TestPersistence.entries.set(announced.id, { meta: announced, events: eventLog('announced') })
    await ctx.parallel('session/persisted', announced, { kind: 'append', fromSeq: 0, toSeq: 0 })
    await ctx.sessionQuery.searchSessions({ query: 'x' })
    expect(provider.persisted.get(announced.id)?.documents[0]?.text).toBe('announced')

    provider.failNextActive = true
    await persistenceFiber.dispose()
    await ctx.sessionQuery.searchSessions({ query: 'x' })
    expect(provider.activeHistory.at(-1)).toBe(false)
    expect(provider.persisted.has(persisted.id)).toBe(true)
  })

  it('preserves persisted observations that race an older inventory listing', async () => {
    TestPersistence.reset()
    const listStarted = deferred()
    const releaseList = deferred()
    TestPersistence.onList = listStarted.resolve
    TestPersistence.listBarrier = releaseList.promise
    const ctx = await liveContext()
    const provider = new FakeProvider()
    ctx.sessionQuery.registerSearchProvider(provider)
    await ctx.plugin(TestPersistence)
    await listStarted.promise

    const announced = header('racing-announcement', 3)
    TestPersistence.entries.set(announced.id, { meta: announced, events: eventLog('after durable notification') })
    await ctx.parallel('session/persisted', announced, { kind: 'append', fromSeq: 0, toSeq: 0 })
    const search = ctx.sessionQuery.searchSessions({ query: 'notification' })
    releaseList.resolve()

    await expect(search).resolves.toMatchObject({ providerId: provider.id })
    expect(provider.persisted.get(announced.id)?.documents[0]?.text).toBe('after durable notification')
    TestPersistence.listBarrier = undefined
    TestPersistence.onList = undefined
  })

  it('synchronizes only a live target for event search and retries dirty failures', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('target'))
    session.append('user/message', { content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const provider = new FakeProvider()
    ctx.sessionQuery.registerSearchProvider(provider)

    await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'one' })
    expect(provider.live.get(session.id)?.documents[0]?.text).toBe('one')
    session.append('user/message', { content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    provider.failNextLive = true
    await expect(ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'two' })).rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    await expect(ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'two' })).resolves.toMatchObject({ providerId: provider.id })
    expect(provider.live.get(session.id)?.documents.map(document => document.text)).toEqual(['one', 'two'])

    const controller = new AbortController()
    controller.abort()
    await expect(ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'x' }, { signal: controller.signal }))
      .rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))
    await expect(ctx.sessionQuery.searchEvents({ sessionId: SessionId('missing'), query: 'x' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))
  })

  it('removes a disposed live override and reveals the provider base', async () => {
    const persisted = header('fallback', 1)
    TestPersistence.reset([{ meta: persisted, events: eventLog('base') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    let session!: Session
    const liveFiber = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create(persisted.id, { meta: { createdAt: persisted.createdAt } })
      session.append('user/message', { content: [{ type: 'text', text: 'live' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    }, { inject: ['sessions'] }))
    const provider = new FakeProvider()
    ctx.sessionQuery.registerSearchProvider(provider)
    await ctx.sessionQuery.searchSessions({ query: 'x' })
    expect(provider.live.has(session.id)).toBe(true)

    await liveFiber.dispose()
    await Promise.resolve()
    await ctx.sessionQuery.searchSessions({ query: 'x' })
    expect(provider.removedLive).toContain(session.id)
    expect(provider.live.has(session.id)).toBe(false)
    expect(provider.persisted.get(session.id)?.documents[0]?.text).toBe('base')
  })

  it('retries failed persisted reconciliation without affecting canonical writes', async () => {
    const persisted = header('retry', 1)
    TestPersistence.reset([{ meta: persisted, events: eventLog('retry') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const provider = new FakeProvider()
    provider.failNextPersisted = true
    ctx.sessionQuery.registerSearchProvider(provider)

    await expect(ctx.sessionQuery.searchSessions({ query: 'x' })).rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    await expect(ctx.sessionQuery.searchSessions({ query: 'x' })).resolves.toMatchObject({ providerId: provider.id })
    expect(provider.persisted.get(persisted.id)?.documents[0]?.text).toBe('retry')
  })

  it('types synchronous extractor failures during full-search key construction', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('throwing-extractor'))
    session.append('test/note', { note: 'unreachable' })
    const provider = new FakeProvider()
    ctx.sessionQuery.registerSearchProvider(provider)
    const cause = new Error('custom extractor failed')
    ctx.sessionQuery.registerEventTextExtractor('test/note', {
      version: 'throwing-v1',
      extract: () => { throw cause },
    })

    let thrown: unknown
    try {
      await ctx.sessionQuery.searchSessions({ query: 'x' })
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SessionQueryError)
    expect(thrown).toMatchObject({ code: 'SESSION_QUERY_INDEX_FAILED', cause })
    expect(asError(thrown).message).toContain(`provider "${provider.id}"`)
    expect(provider.sessionRequests).toEqual([])
  })
})

describe('semantic text extractors', () => {
  it('indexes core semantic text and excludes chunks and structural events', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('semantic'))
    const nested: ContentBlock[] = [
      { type: 'text', text: 'visible' },
      { type: 'reasoning', text: 'thinking' },
      { type: 'tool-call', id: CallId('block-call'), name: 'block-tool', arguments: '{"x":1}' },
      { type: 'tool-result', toolCallId: CallId('block-call'), content: [{ type: 'text', text: 'block-result' }] },
    ]
    session.append('user/message', { content: nested, source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('prompt/blocked', { content: [{ type: 'text', text: 'blocked prompt' }], source: { kind: 'user' }, reason: 'policy reason' })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'shell', arguments: '{"cmd":"pwd"}' })
    session.append('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'tool output' }], isError: true, error: { name: 'ToolError', code: 'DENIED' } }, { surfaceOp: 'append' })
    session.append('todo/write', { todos: [{ content: 'finish tests', status: 'in_progress' }] })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', step: 1, message: 'model failed', code: 'MODEL' } })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', step: 1, message: 'uncoded failure' } })
    session.append('turn/end', { turn: 2, reason: { kind: 'aborted' } })
    session.append('turn/end', { turn: 3, reason: { kind: 'aborted', reason: 'cancelled' } })
    session.append('turn/end', { turn: 4, reason: { kind: 'rejected', reason: 'rejected detail' } })
    session.append('turn/end', { turn: 5, reason: { kind: 'disposed' } })
    session.append('turn/end', { turn: 6, reason: { kind: 'max-tokens' } })
    session.append('turn/end', { turn: 7, reason: { kind: 'interrupted' } })
    session.append('turn/end', { turn: 8, reason: { kind: 'completed' } })
    session.append('tool/result', { turn: 1, step: 2, callId: CallId('c2'), content: [], isError: false }, { surfaceOp: 'append' })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'raw chunk' } })
    session.append('step/start', { turn: 1, step: 2 })
    const provider = new FakeProvider()
    ctx.sessionQuery.registerSearchProvider(provider)

    await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'x' })
    const documents = provider.live.get(session.id)?.documents ?? []
    expect(documents.map(document => document.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(documents.map(document => document.text).join('\n')).toContain('visible\nthinking\nblock-tool\n{"x":1}\nblock-result')
    expect(documents.map(document => document.text).join('\n')).toContain('blocked prompt\npolicy reason')
    expect(documents.map(document => document.text).join('\n')).toContain('ToolError\nDENIED')
    expect(documents.map(document => document.text).join('\n')).toContain('in_progress finish tests')
    expect(documents.map(document => document.text).join('\n')).toContain('error\nmodel failed\nMODEL')
    expect(documents.map(document => document.text).join('\n')).toContain('aborted\ncancelled')
    expect(documents.map(document => document.text).join('\n')).toContain('rejected\nrejected detail')
    expect(documents.map(document => document.text).join('\n')).toContain('disposed\nmax-tokens\ninterrupted')
    expect(documents.map(document => document.text).join('\n')).not.toContain('raw chunk')
  })

  it('supports versioned effect-scoped custom event and content extractors', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('custom'))
    session.append('test/note', { note: 'event note' })
    session.append('user/message', { content: [{ type: 'test/text', value: 'block note' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const provider = new FakeProvider()
    ctx.sessionQuery.registerSearchProvider(provider)
    let disposeEvent!: () => void
    let disposeContent!: () => void
    const extractorFiber = await ctx.plugin(Object.assign((inner: Context) => {
      disposeEvent = inner.sessionQuery.registerEventTextExtractor('test/note', { version: 'event-v1', extract: event => [event.data.note] })
      disposeContent = inner.sessionQuery.registerContentTextExtractor('test/text', { version: 'block-v1', extract: block => [block.value] })
    }, { inject: ['sessionQuery'] }))

    await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'x' })
    const first = provider.live.get(session.id)
    expect(first?.documents.map(document => document.text)).toEqual(['event note', 'block note'])
    expect(() => ctx.sessionQuery.registerEventTextExtractor('test/note', { version: 'v2', extract: () => [] }))
      .toThrow(expectCode('SESSION_QUERY_DUPLICATE_EXTRACTOR'))
    expect(() => ctx.sessionQuery.registerContentTextExtractor('test/text', { version: 'block-v2', extract: () => [] }))
      .toThrow(expectCode('SESSION_QUERY_DUPLICATE_EXTRACTOR'))
    expect(() => ctx.sessionQuery.registerContentTextExtractor('test/text', { version: ' ', extract: () => [] }))
      .toThrow(expectCode('SESSION_QUERY_INVALID_EXTRACTOR'))

    disposeEvent()
    disposeContent()
    await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'x' })
    const second = provider.live.get(session.id)
    expect(second?.documents).toEqual([])
    expect(second?.fingerprint).not.toBe(first?.fingerprint)
    await extractorFiber.dispose()

    const replacementFiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.sessionQuery.registerEventTextExtractor('test/note', { version: 'event-v2', extract: event => [`replacement ${event.data.note}`] })
      inner.sessionQuery.registerContentTextExtractor('test/text', { version: 'block-v2', extract: block => [`replacement ${block.value}`] })
    }, { inject: ['sessionQuery'] }))
    await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'x' })
    const third = provider.live.get(session.id)
    expect(third?.documents.map(document => document.text)).toEqual(['replacement event note', 'replacement block note'])
    expect(third?.fingerprint).not.toBe(second?.fingerprint)
    await replacementFiber.dispose()
    await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'x' })
    expect(provider.live.get(session.id)?.documents).toEqual([])
  })
})

describe('configuration', () => {
  it('rejects an impossible default page size and exposes typed errors', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await expect(ctx.plugin(SessionQueryService, { defaultLimit: 3, maxLimit: 2 }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CONFIG'))
    const error = new SessionQueryError('test', 'SESSION_QUERY_INVALID_CONFIG')
    expect(error).toMatchObject({ name: 'SessionQueryError', code: 'SESSION_QUERY_INVALID_CONFIG' })
  })

  it('uses constructor defaults and removes the service on plugin disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionQueryService)
    const session = ctx.sessions.create(SessionId('defaults'))
    await expect(ctx.sessionQuery.readEvent({ sessionId: session.id, seq: 0, after: 51 }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_WINDOW'))
    await fiber.dispose()
    expect(ctx.sessionQuery).toBeUndefined()

    const direct = new Context()
    await direct.plugin(SessionStore)
    const service = new SessionQueryService(direct, {})
    const directSession = direct.sessions.create(SessionId('direct-defaults'))
    await expect(service.readEvent({ sessionId: directSession.id, seq: 0, before: 51 }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_WINDOW'))
    await direct.fiber.dispose()
  })
})
