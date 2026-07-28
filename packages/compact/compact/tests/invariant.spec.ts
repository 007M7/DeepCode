import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as CompactInvariant from '@deepseek-ai/dsh-compact/invariant'
import InvariantService from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService)
  await ctx.plugin(CompactInvariant)
  return ctx
}

const summary = (overrides: Record<string, unknown> = {}) => ({
  summary: [{ type: 'text' as const, text: 'short' }],
  shadowedRange: { start: 2, end: 4 },
  shadowedSeqs: [2, 3, 4],
  shadowedTokenCount: 12,
  provider: 'mock',
  model: 'mock',
  ...overrides,
})

function startTurn(session: ReturnType<Context['sessions']['create']>, turn = 1): void {
  session.append('turn/start', { turn, trigger: { kind: 'message', source: { kind: 'user' } } })
}

describe('compaction invariants', () => {
  it('accepts successful and failed compaction lifecycles', async () => {
    const ctx = await setup()
    const success = ctx.sessions.create()
    startTurn(success)
    success.append('compact/start', { turn: 1 })
    success.append('compact/summary', summary())
    success.append('compact/end', { turn: 1 })

    const failed = ctx.sessions.create()
    startTurn(failed, 2)
    failed.append('compact/start', { turn: 2 })
    failed.append('compact/end', { turn: 2, error: 'provider failed' })
  })

  it('rebuilds an open trace when the companion loads after the session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('compact/start', { turn: 1 })
    await ctx.plugin(InvariantService)
    await ctx.plugin(CompactInvariant)
    expect(() => session.append('compact/end', { turn: 1, error: 'resume failed' })).not.toThrow()
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })

  it('adopts a bare session and ignores unrelated committed events', async () => {
    const ctx = await setup()
    const session = new Session(SessionId('bare-compaction-session'))
    expect(() => {
      ctx.emit('session/event', session, {
        type: 'turn/start', seq: 0, time: 0,
        data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } },
      })
      ctx.emit('session/event', session, {
        type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 },
      })
      ctx.emit('session/event', session, {
        type: 'compact/start', seq: 2, time: 2, data: { turn: 1 },
      })
    }).not.toThrow()
  })

  it('rejects compaction outside or for a different open turn', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => session.append('compact/start', { turn: 1 })).toThrow(/outside any open turn/)
    startTurn(session)
    expect(() => session.append('compact/start', { turn: 2 })).toThrow(/but open turn is 1/)
  })

  it('rejects an unenclosed compaction event when replaying an existing session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    startTurn(session)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('compact/start', { turn: 1 })
    await ctx.plugin(InvariantService)
    await expect(ctx.plugin(CompactInvariant).then(() => undefined)).rejects.toThrow(/outside any open turn/)
  })

  it('rejects an open compaction that crosses into another turn', async () => {
    const ctx = await setup()
    const summarySession = ctx.sessions.create()
    startTurn(summarySession)
    summarySession.append('compact/start', { turn: 1 })
    summarySession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    startTurn(summarySession, 2)
    expect(() => summarySession.append('compact/summary', summary()))
      .toThrow(/belongs to turn 1 but open turn is 2/)

    const endSession = ctx.sessions.create()
    startTurn(endSession)
    endSession.append('compact/start', { turn: 1 })
    endSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    startTurn(endSession, 2)
    expect(() => endSession.append('compact/end', { turn: 1, error: 'late' }))
      .toThrow(/names turn 1 but open turn is 2/)
  })

  it.each([
    ['summary without start', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compact/summary', summary())
    }, /no matching compact\/start/],
    ['nested start', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compact/start', { turn: 1 })
      session.append('compact/start', { turn: 2 })
    }, /still compacting/],
    ['repeated summary', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compact/start', { turn: 1 })
      session.append('compact/summary', summary())
      session.append('compact/summary', summary())
    }, /repeated within one compaction/],
    ['empty shadow set', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compact/start', { turn: 1 })
      session.append('compact/summary', summary({ shadowedSeqs: [] }))
    }, /shadowedSeqs must be non-empty/],
    ['wrong endpoints', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compact/start', { turn: 1 })
      session.append('compact/summary', summary({ shadowedRange: { start: 1, end: 4 } }))
    }, /shadowedRange must match/],
    ['invalid token count', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compact/start', { turn: 1 })
      session.append('compact/summary', summary({ shadowedTokenCount: -1 }))
    }, /non-negative safe integer/],
    ['end without start', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compact/end', { turn: 1, error: 'failed' })
    }, /no matching compact\/start/],
    ['wrong end turn', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compact/start', { turn: 1 })
      session.append('compact/end', { turn: 2, error: 'failed' })
    }, /does not match/],
    ['success without summary', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compact/start', { turn: 1 })
      session.append('compact/end', { turn: 1 })
    }, /requires one compact\/summary/],
  ])('rejects %s', async (_name, action, message) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    expect(() => { action(session) }).toThrow(message)
  })
})
