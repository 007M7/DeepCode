import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore from '@deepseek-ai/dsh-session'
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

describe('compaction invariants', () => {
  it('accepts successful and failed compaction lifecycles', async () => {
    const ctx = await setup()
    const success = ctx.sessions.create()
    success.append('compact/start', { turn: 1 })
    success.append('compact/summary', summary())
    success.append('compact/end', { turn: 1 })

    const failed = ctx.sessions.create()
    failed.append('compact/start', { turn: 2 })
    failed.append('compact/end', { turn: 2, error: 'provider failed' })
  })

  it('rebuilds an open trace when the companion loads after the session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('compact/start', { turn: 3 })
    await ctx.plugin(InvariantService)
    await ctx.plugin(CompactInvariant)
    expect(() => session.append('compact/end', { turn: 3, error: 'resume failed' })).not.toThrow()
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
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
    expect(() => { action(ctx.sessions.create()) }).toThrow(message)
  })
})
