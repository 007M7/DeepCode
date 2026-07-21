import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore, { type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as ModeInvariant from '@deepseek-ai/dsh-mode/invariant'
import InvariantService from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(ModeInvariant)
  return ctx
}

function event(mode: unknown): SessionEvent {
  return { type: 'mode/set', seq: 0, time: 0, data: { mode } } as SessionEvent
}

describe('mode stream invariants', () => {
  it('accepts a plain non-empty trimmed mode name', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, event('plan')) }).not.toThrow()
    expect(() => { ctx.emit('session/event', {} as Session, event('default')) }).not.toThrow()
  })

  it.each([
    [42, /invalid mode 42/],
    ['', /invalid mode ""/],
    [' plan ', /invalid mode " plan "/],
  ])('rejects an invalid durable mode selection', async (mode, message) => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, event(mode)) }).toThrow(message)
  })

  it('ignores unrelated dispatches and session events', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('tools/change')
      ctx.emit('session/event', {} as Session, {
        type: 'turn/start', seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } },
      })
    }).not.toThrow()
  })

  it('rejects an invalid existing selection on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append('mode/set', { mode: '' })
    await ctx.plugin(InvariantService, { enabled: true })

    await expect(ctx.plugin(ModeInvariant).then(() => undefined)).rejects.toThrow(/invalid mode ""/)
  })
})
