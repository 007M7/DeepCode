import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionForkService, { SessionForkError } from '../src/index.ts'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-session-fork-'))
  tempDirs.push(dir)
  return dir
}

async function setup(): Promise<{ ctx: Context; fork: SessionForkService }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionForkService)
  return { ctx, fork: ctx.sessionFork }
}

function appendClosedTurn(session: Session, reason: TurnEndReason = { kind: 'completed' }): void {
  session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
  session.append('user/message', {
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason })
}

function firstUserMessage(events: readonly SessionEvent[]): SessionEvent<'user/message'> {
  const event = events.find((e): e is SessionEvent<'user/message'> => e.type === 'user/message')
  if (event === undefined) throw new Error('missing user/message')
  return event
}

describe('SessionForkService', () => {
  it('registers as ctx.sessionFork and unregisters on fiber disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionForkService)
    expect(ctx.sessionFork).toBeInstanceOf(SessionForkService)

    await fiber.dispose()

    expect(ctx.sessionFork).toBeUndefined()
  })

  it('snapshots an empty live session as an empty seed with lineage metadata', async () => {
    const { ctx, fork } = await setup()
    const source = ctx.sessions.create(SessionId('empty-parent'), { meta: { cwd: '/workspace' } })

    const snapshot = fork.snapshot(source)

    expect(snapshot.source).toBe(source)
    expect(snapshot.seed).toEqual([])
    expect(snapshot.meta).toEqual({
      cwd: '/workspace',
      parentSession: SessionId('empty-parent'),
      seedLength: 0,
    })
  })

  it('snapshots a completed boundary by live session id and deep-clones seed events', async () => {
    const { ctx, fork } = await setup()
    const source = ctx.sessions.create(SessionId('parent'), { meta: { cwd: '/workspace' } })
    appendClosedTurn(source)

    const snapshot = fork.snapshot(SessionId('parent'))

    expect(snapshot.source).toBe(source)
    expect(snapshot.seed).toEqual(source.events)
    expect(snapshot.seed).not.toBe(source.events)
    expect(snapshot.seed[1]).not.toBe(source.events[1])
    firstUserMessage(snapshot.seed).data.content[0] = { type: 'text', text: 'mutated' }
    expect(firstUserMessage(source.events).data.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(snapshot.meta).toEqual({
      cwd: '/workspace',
      parentSession: SessionId('parent'),
      seedLength: source.events.length,
    })
  })

  it('accepts every turn/end reason as a fork boundary', async () => {
    const { ctx, fork } = await setup()
    const reasons: TurnEndReason[] = [
      { kind: 'completed' },
      { kind: 'aborted', reason: 'cancelled by user' },
      { kind: 'error', step: 1, message: 'model failed', code: 'MODEL' },
      { kind: 'disposed' },
      { kind: 'max-tokens' },
      { kind: 'interrupted' },
    ]

    for (const reason of reasons) {
      const source = ctx.sessions.create(SessionId(`parent-${reason.kind}`))
      appendClosedTurn(source, reason)

      const snapshot = fork.snapshot(source)

      expect(snapshot.seed.at(-1)?.type).toBe('turn/end')
      expect(snapshot.meta.seedLength).toBe(source.events.length)
    }
  })

  it('rejects an unknown live session id', async () => {
    const { fork } = await setup()

    expect(() => fork.snapshot(SessionId('missing')))
      .toThrow(new SessionForkError('session "missing" not found', 'SESSION_NOT_FOUND'))
  })

  it('rejects a detached Session object that is not live in ctx.sessions', async () => {
    const { fork } = await setup()
    const detached = new Session(SessionId('detached'))

    expect(() => fork.snapshot(detached))
      .toThrow(new SessionForkError('session "detached" not found', 'SESSION_NOT_FOUND'))
  })

  it('rejects a stale Session object whose id is live on a different instance', async () => {
    const { ctx, fork } = await setup()
    ctx.sessions.create(SessionId('same-id'))
    const stale = new Session(SessionId('same-id'))

    expect(() => fork.snapshot(stale))
      .toThrow(new SessionForkError('session "same-id" is not the live store instance', 'SESSION_NOT_LIVE'))
  })

  it('rejects non-empty logs whose last event is not turn/end', async () => {
    const { ctx, fork } = await setup()
    const cases: [string, (session: Session) => void][] = [
      ['turn/start', (session) => {
        session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
      }],
      ['step/start', (session) => {
        session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
        session.append('step/start', { turn: 1, step: 1 })
      }],
      ['user/message', (session) => {
        session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
        session.append('user/message', { content: [{ type: 'text', text: 'open' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
      }],
      ['assistant/message', (session) => {
        session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'partial' }] }, { surfaceOp: 'append' })
      }],
      ['tool/call', (session) => {
        const callId = CallId('call-open')
        session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('assistant/message', {
          turn: 1,
          step: 1,
          content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
        }, { surfaceOp: 'append' })
        session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
      }],
    ]

    for (const [lastType, build] of cases) {
      const source = ctx.sessions.create(SessionId(`open-${lastType}`))
      build(source)

      expect(() => fork.snapshot(source))
        .toThrow(new SessionForkError(`cannot fork session "open-${lastType}" inside an open turn (last event: ${lastType})`, 'OPEN_TURN'))
    }
  })

  it('creates a forked child session with the seed and lineage metadata', async () => {
    const { ctx, fork } = await setup()
    const source = ctx.sessions.create(SessionId('parent'), { meta: { cwd: '/workspace' } })
    appendClosedTurn(source)

    const child = fork.fork({ source, sessionId: SessionId('child') })

    expect(child.id).toBe(SessionId('child'))
    expect(child.events).toEqual(source.events)
    expect(child.header.parentSession).toBe(source.id)
    expect(child.header.seedLength).toBe(source.events.length)
    expect(child.header.cwd).toBe('/workspace')
    firstUserMessage(child.events).data.content[0] = { type: 'text', text: 'child mutation' }
    expect(firstUserMessage(source.events).data.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('rejects a child session id that is already live with a typed fork error', async () => {
    const { ctx, fork } = await setup()
    const source = ctx.sessions.create(SessionId('parent'))
    appendClosedTurn(source)
    ctx.sessions.create(SessionId('child'))

    expect(() => fork.fork({ source, sessionId: SessionId('child') }))
      .toThrow(new SessionForkError('session "child" already exists', 'SESSION_ALREADY_EXISTS'))
  })

  it('rejects a duplicate child session id before validating the source boundary', async () => {
    const { ctx, fork } = await setup()
    const source = ctx.sessions.create(SessionId('open-parent'))
    source.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    ctx.sessions.create(SessionId('child'))

    expect(() => fork.fork({ source, sessionId: SessionId('child') }))
      .toThrow(new SessionForkError('session "child" already exists', 'SESSION_ALREADY_EXISTS'))
  })

  it('persists a forked child seed through the existing session write path', async () => {
    const root = await tempRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionForkService)
    await ctx.plugin(SessionPersistenceJsonl, { root })
    const source = ctx.sessions.create(SessionId('persist-parent'), { meta: { cwd: '/workspace' } })
    appendClosedTurn(source)

    const child = ctx.sessionFork.fork({ source, sessionId: SessionId('persist-child') })
    await ctx.parallel('session/flush', child)
    const loaded = await ctx.sessionPersistence.load(child.id)

    expect(loaded.events).toEqual(source.events)
    expect(loaded.meta).toMatchObject({
      id: SessionId('persist-child'),
      cwd: '/workspace',
      parentSession: SessionId('persist-parent'),
      seedLength: source.events.length,
    })
    await ctx.fiber.dispose()
  })
})
