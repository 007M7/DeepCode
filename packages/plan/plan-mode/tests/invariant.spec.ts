import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore, { type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as PlanModeInvariant from '@deepseek-ai/dsh-plan-mode/invariant'
import InvariantService from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(PlanModeInvariant)
  return ctx
}

function event(active: unknown): SessionEvent {
  return { type: 'plan/mode', seq: 0, time: 0, data: { active } } as SessionEvent
}

describe('plan-mode stream invariants', () => {
  it('accepts either boolean state', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, event(true)) }).not.toThrow()
    expect(() => { ctx.emit('session/event', {} as Session, event(false)) }).not.toThrow()
  })

  it.each([42, 'plan', undefined])('rejects invalid durable plan state %j', async (active) => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, event(active)) })
      .toThrow(/expected a boolean/)
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

  it('rejects invalid existing state on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append('plan/mode', { active: 'plan' as unknown as boolean })
    await ctx.plugin(InvariantService, { enabled: true })

    await expect(ctx.plugin(PlanModeInvariant).then(() => undefined)).rejects.toThrow(/expected a boolean/)
  })
})
