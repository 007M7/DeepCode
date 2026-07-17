import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import SessionQueryService, {
  type SessionQueryErrorCode,
} from '@deepseek-ai/dsh-session-query'

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
  static afterList: (() => void) | undefined

  static reset(entries: readonly { meta: SessionHeader; events: SessionEvent[] }[] = []): void {
    this.entries = new Map(entries.map(entry => [entry.meta.id, structuredClone(entry)]))
    this.listFailure = undefined
    this.loadFailure = undefined
    this.afterList = undefined
  }

  create(meta: SessionHeader): Promise<void> {
    TestPersistence.entries.set(meta.id, { meta: structuredClone(meta), events: [] })
    return Promise.resolve()
  }

  append(id: SessionIdType, events: readonly SessionEvent[]): Promise<void> {
    const entry = TestPersistence.entries.get(id)
    if (entry === undefined) return Promise.reject(new Error('missing test session'))
    entry.events.push(...structuredClone(events))
    return Promise.resolve()
  }

  load(id: SessionIdType): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    if (TestPersistence.loadFailure !== undefined) return rejectUnknown(TestPersistence.loadFailure)
    const entry = TestPersistence.entries.get(id)
    if (entry === undefined) return Promise.reject(new Error('missing test session'))
    return Promise.resolve(structuredClone(entry))
  }

  list(): Promise<SessionHeader[]> {
    if (TestPersistence.listFailure !== undefined) return rejectUnknown(TestPersistence.listFailure)
    const headers = [...TestPersistence.entries.values()].map(entry => structuredClone(entry.meta))
    TestPersistence.afterList?.()
    return Promise.resolve(headers)
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

function rejectUnknown<T>(reason: unknown): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    // Exercise containment for an implementation that violates the Error rejection convention.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    reject(reason)
  })
}

describe('session-query exact reads', () => {
  it('lists live sessions deterministically and returns detached headers', async () => {
    const ctx = await liveContext()
    const older = ctx.sessions.create(SessionId('older'), { meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('z'), { meta: { createdAt: 2 } })
    ctx.sessions.create(SessionId('a'), { meta: { createdAt: 2 } })

    const records = await ctx.sessionQuery.listSessions()
    expect(records.map(record => record.header.id)).toEqual([SessionId('a'), SessionId('z'), older.id])
    expect(records.every(record => record.live && !record.persisted)).toBe(true)
    Object.assign(records[2]!.header, { createdAt: 99 })
    expect(older.header.createdAt).toBe(1)
  })

  it('classifies current, shadowed, and raw-log-only events through foldSurface', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('surface'))
    const first = session.append(
      'user/message',
      { content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } },
      { surfaceOp: 'append' },
    )
    session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'draft' },
    })
    session.append(
      'assistant/message',
      { turn: 1, step: 1, content: [{ type: 'text', text: 'replacement' }] },
      { surfaceOp: { op: 'replace', start: first.seq, end: first.seq }, sourceEventSeqs: [first.seq] },
    )

    expect((await ctx.sessionQuery.listEvents(session.id)).map(record => record.surface))
      .toEqual(['shadowed', 'log-only', 'current'])
  })

  it('returns a bounded detached raw-event window and validates the request', async () => {
    const ctx = await liveContext({ readWindowMax: 1 })
    const session = ctx.sessions.create(SessionId('window'), { meta: { cwd: '/work' } })
    for (const text of ['one', 'two', 'three']) {
      session.append(
        'user/message',
        { content: [{ type: 'text', text }], source: { kind: 'user' } },
        { surfaceOp: 'append' },
      )
    }

    const result = await ctx.sessionQuery.readEvent({ sessionId: session.id, seq: 1, before: 1, after: 1 })
    expect([result.startSeq, result.endSeq, result.target.seq]).toEqual([0, 2, 1])
    expect(result.session).toEqual(session.header)
    Object.assign(result.session, { createdAt: -1 })
    if (result.events[0]?.type !== 'user/message') throw new Error('expected user message')
    result.events[0].data.content = []
    expect(session.header.createdAt).not.toBe(-1)
    expect(session.events[0]?.type === 'user/message' && session.events[0].data.content).toHaveLength(1)

    await expect(ctx.sessionQuery.readEvent({ sessionId: session.id, seq: 9 }))
      .rejects.toThrow(expectCode('SESSION_QUERY_EVENT_NOT_FOUND'))
    for (const request of [
      { sessionId: session.id, seq: 0, before: -1 },
      { sessionId: session.id, seq: 0, before: 2 },
      { sessionId: session.id, seq: 0, after: 0.5 },
    ]) {
      await expect(ctx.sessionQuery.readEvent(request)).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_WINDOW'))
    }
  })

  it('merges authoritative persistence with live precedence and detects conflicts', async () => {
    const shared = header('shared', 3, { cwd: '/same' })
    const durable = header('durable', 2)
    TestPersistence.reset([
      { meta: shared, events: eventLog('persisted') },
      { meta: durable, events: eventLog('durable') },
    ])
    const ctx = await liveContext()
    const live = ctx.sessions.create(shared.id, { meta: { createdAt: 3, cwd: '/same' } })
    live.append(
      'user/message',
      { content: [{ type: 'text', text: 'live' }], source: { kind: 'user' } },
      { surfaceOp: 'append' },
    )
    const persistence = await ctx.plugin(TestPersistence)

    expect((await ctx.sessionQuery.listSessions()).map(record => [record.header.id, record.live, record.persisted]))
      .toEqual([[shared.id, true, true], [durable.id, false, true]])
    const liveRead = await ctx.sessionQuery.readEvent({ sessionId: shared.id, seq: 0 })
    expect(liveRead.target.type === 'user/message' && liveRead.target.data.content[0])
      .toMatchObject({ text: 'live' })
    await expect(ctx.sessionQuery.readEvent({ sessionId: durable.id, seq: 0 }))
      .resolves.toMatchObject({ session: durable })

    const sharedEntry = TestPersistence.entries.get(shared.id)!
    sharedEntry.meta = { ...sharedEntry.meta, cwd: '/conflict' }
    await expect(ctx.sessionQuery.listSessions()).rejects.toThrow(expectCode('SESSION_QUERY_SOURCE_CONFLICT'))
    await persistence.dispose()
    await expect(ctx.sessionQuery.listSessions()).resolves.toEqual([
      { header: shared, live: true, persisted: false },
    ])
  })

  it('keeps known live reads independent from persistence health', async () => {
    TestPersistence.reset()
    const ctx = await liveContext()
    const live = ctx.sessions.create(SessionId('live'))
    live.append(
      'user/message',
      { content: [{ type: 'text', text: 'available' }], source: { kind: 'user' } },
      { surfaceOp: 'append' },
    )
    await ctx.plugin(TestPersistence)
    TestPersistence.listFailure = new Error('list unavailable')
    TestPersistence.loadFailure = new Error('load unavailable')

    await expect(ctx.sessionQuery.listEvents(live.id)).resolves.toHaveLength(1)
    await expect(ctx.sessionQuery.readEvent({ sessionId: live.id, seq: 0 })).resolves.toMatchObject({ target: { seq: 0 } })
    await expect(ctx.sessionQuery.listSessions()).rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    await expect(ctx.sessionQuery.listEvents(SessionId('durable'))).rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
  })

  it('reports absent sessions, persisted load failures, and persisted header conflicts', async () => {
    const durable = header('durable')
    TestPersistence.reset([{ meta: durable, events: eventLog() }])
    const ctx = await liveContext()
    await expect(ctx.sessionQuery.listEvents(SessionId('absent')))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))
    await ctx.plugin(TestPersistence)
    await expect(ctx.sessionQuery.listEvents(SessionId('absent')))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))

    TestPersistence.loadFailure = 'raw failure'
    await expect(ctx.sessionQuery.listEvents(durable.id))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.loadFailure = undefined
    const durableEntry = TestPersistence.entries.get(durable.id)!
    durableEntry.meta = { ...durableEntry.meta, cwd: '/changed-after-list' }
    TestPersistence.afterList = () => {
      const listedEntry = TestPersistence.entries.get(durable.id)!
      listedEntry.meta = { ...listedEntry.meta, cwd: '/changed-during-read' }
    }
    await expect(ctx.sessionQuery.listEvents(durable.id))
      .rejects.toThrow(expectCode('SESSION_QUERY_SOURCE_CONFLICT'))
  })

  it('turns malformed surfaces and direct invalid config into typed errors', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('bad-surface'))
    ;(session as unknown as { log: SessionEvent[] }).log.push({
      type: 'assistant/message',
      seq: 0,
      time: 1,
      data: { turn: 1, step: 1, content: [] },
      surfaceOp: { op: 'replace', start: 9, end: 9 },
    })
    await expect(ctx.sessionQuery.listEvents(session.id))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_SURFACE'))

    const persisted = header('bad-persisted-surface')
    TestPersistence.reset([{
      meta: persisted,
      events: [{
        type: 'user/message',
        seq: 0,
        time: 1,
        data: { content: [{ type: 'text', text: 'hidden' }], source: { kind: 'user' } },
      }],
    }])
    const persistence = await ctx.plugin(TestPersistence)
    await expect(ctx.sessionQuery.listEvents(persisted.id))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_SURFACE'))
    await persistence.dispose()

    const direct = new Context()
    await direct.plugin(SessionStore)
    expect(new SessionQueryService(direct)).toBeInstanceOf(SessionQueryService)
    const invalid = new Context()
    await invalid.plugin(SessionStore)
    expect(() => new SessionQueryService(invalid, { readWindowMax: -1 }))
      .toThrow(expectCode('SESSION_QUERY_INVALID_CONFIG'))
  })

  it('leaves the optional persistence dependency optional', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionQueryService)
    expect(ctx.sessionQuery).toBeInstanceOf(SessionQueryService)
    await fiber.dispose()
    expect(ctx.sessionQuery).toBeUndefined()
  })
})
