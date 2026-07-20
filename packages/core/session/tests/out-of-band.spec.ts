import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'test/log-only': { value: string }
  }

  interface OutOfBandSessionEventMap {
    'test/log-only': true
  }

}

const updateTrigger = { kind: 'injection', source: { kind: 'plugin', plugin: 'test' } } as const

describe('SessionStore.appendOutOfBand', () => {
  it('joins an open turn without adding a boundary or flushing it', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('open'))
    let flushes = 0
    ctx.on('session/flush', () => { flushes += 1 })
    session.append('turn/start', {
      turn: 1,
      trigger: { kind: 'message', source: { kind: 'user' } },
    })

    const event = await ctx.sessions.appendOutOfBand(
      session,
      'test/log-only',
      { value: 'inside' },
      updateTrigger,
    )

    expect(event).toMatchObject({ type: 'test/log-only', seq: 1, data: { value: 'inside' } })
    expect(session.events.map(item => item.type)).toEqual(['turn/start', 'test/log-only'])
    expect(flushes).toBe(0)
  })

  it('wraps a closed log in one zero-step turn and flushes the balanced update', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('closed'))
    const flushedTypes: string[][] = []
    ctx.on('session/flush', (flushed) => {
      flushedTypes.push(flushed.events.map(event => event.type))
    })

    const first = await ctx.sessions.appendOutOfBand(
      session,
      'test/log-only',
      { value: 'first' },
      updateTrigger,
    )
    const second = await ctx.sessions.appendOutOfBand(
      session,
      'test/log-only',
      { value: 'second' },
      updateTrigger,
    )

    expect(first.seq).toBe(1)
    expect(second.seq).toBe(4)
    expect(session.events).toMatchObject([
      { type: 'turn/start', seq: 0, data: { turn: 1, trigger: updateTrigger } },
      { type: 'test/log-only', seq: 1, data: { value: 'first' } },
      { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 3, data: { turn: 2, trigger: updateTrigger } },
      { type: 'test/log-only', seq: 4, data: { value: 'second' } },
      { type: 'turn/end', seq: 5, data: { turn: 2, reason: { kind: 'completed' } } },
    ])
    expect(flushedTypes).toEqual([
      ['turn/start', 'test/log-only', 'turn/end'],
      ['turn/start', 'test/log-only', 'turn/end', 'turn/start', 'test/log-only', 'turn/end'],
    ])
  })

  it('closes and flushes a zero-step turn when the target event is rejected', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('rejected'))
    let flushes = 0
    ctx.on('session/flush', () => { flushes += 1 })

    await expect(ctx.sessions.appendOutOfBand(
      session,
      'test/log-only',
      { value: 1n } as never,
      updateTrigger,
    )).rejects.toThrow(/non-JSON-serializable/)

    expect(session.events).toMatchObject([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    expect(flushes).toBe(1)
  })

  it('does not flush when the synthetic turn cannot open', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('start-failure'))
    let flushes = 0
    ctx.on('session/flush', () => { flushes += 1 })

    await expect(ctx.sessions.appendOutOfBand(
      session,
      'test/log-only',
      { value: 'unreachable' },
      { ...updateTrigger, invalid: 1n } as never,
    )).rejects.toThrow(/non-JSON-serializable/)

    expect(session.events).toEqual([])
    expect(flushes).toBe(0)
  })

  it('preserves a target rejection when the balancing flush also rejects', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('target-and-flush-failure'))
    ctx.on('session/flush', () => { throw new Error('disk failed') })

    await expect(ctx.sessions.appendOutOfBand(
      session,
      'test/log-only',
      { value: 1n } as never,
      updateTrigger,
    )).rejects.toThrow(/non-JSON-serializable/)

    expect(session.events.map(event => event.type)).toEqual([
      'turn/start',
      'turn/end',
    ])
  })

  it('keeps the session attached through publication and its flush', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.prepare(SessionId('dispose'))
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    let liveDuringFlush = false
    ctx.on('session/event', (_observed, event) => {
      if (event.type === 'turn/start') detach()
    })
    ctx.on('session/flush', () => {
      liveDuringFlush = ctx.sessions.get(session.id) === session
    })

    await ctx.sessions.appendOutOfBand(
      session,
      'test/log-only',
      { value: 'last' },
      updateTrigger,
    )

    expect(session.events.map(event => event.type)).toEqual([
      'turn/start',
      'test/log-only',
      'turn/end',
    ])
    expect(liveDuringFlush).toBe(true)
    expect(ctx.sessions.get(session.id)).toBeUndefined()
  })

  it('rejects detached sessions before opening a turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.prepare(SessionId('detached'))

    await expect(ctx.sessions.appendOutOfBand(
      session,
      'test/log-only',
      { value: 'nope' },
      updateTrigger,
    )).rejects.toThrow('session "detached" is not live in this store')
    expect(session.events).toEqual([])
  })

  it('leaves a balanced log when the durability checkpoint rejects', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('flush-failure'))
    ctx.on('session/flush', () => { throw new Error('disk failed') })

    await expect(ctx.sessions.appendOutOfBand(
      session,
      'test/log-only',
      { value: 'accepted' },
      updateTrigger,
    )).rejects.toThrow('disk failed')
    expect(session.events.map(event => event.type)).toEqual([
      'turn/start',
      'test/log-only',
      'turn/end',
    ])
  })

  it('rejects overlapping updates while the first append is still settling', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('overlap'))
    let release!: () => void
    const checkpoint = new Promise<void>((resolve) => {
      release = resolve
    })
    ctx.on('session/flush', () => checkpoint)

    const first = ctx.sessions.appendOutOfBand(
      session,
      'test/log-only',
      { value: 'first' },
      updateTrigger,
    )
    await expect(ctx.sessions.appendOutOfBand(
      session,
      'test/log-only',
      { value: 'overlap' },
      updateTrigger,
    )).rejects.toThrow(/out-of-band append in progress/)
    release()
    await expect(first).resolves.toMatchObject({ data: { value: 'first' } })
  })
})
