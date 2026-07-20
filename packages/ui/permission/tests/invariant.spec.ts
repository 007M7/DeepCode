import { describe, expect, it } from 'vitest'
import { Context, Service } from 'cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import * as PermissionInvariant from '@deepseek-ai/dsh-permission/invariant'
import InvariantService from '@deepseek-ai/dsh-invariants'

class PermissionProbe extends Service {
  readonly names = ['safe', 'trusted']

  constructor(ctx: Context) {
    super(ctx, 'permission')
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(PermissionProbe)
  await ctx.plugin(InvariantService)
  await ctx.plugin(PermissionInvariant)
  return ctx
}

function presetEvent(preset: string): SessionEvent {
  return { type: 'permission/preset', seq: 0, time: 0, data: { preset } }
}

describe('permission invariants', () => {
  it('accepts configured preset events and ignores other session data', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, presetEvent('safe')) }).not.toThrow()
    expect(() => { ctx.emit('session/event', {} as Session, {
      type: 'turn/end', seq: 0, time: 0, data: {},
    } as SessionEvent) }).not.toThrow()
    expect(() => { ctx.emit('tools/change') }).not.toThrow()
  })

  it('rejects a durable preset that the active table cannot resolve', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, presetEvent('missing')) })
      .toThrow(/unknown preset "missing"/)
  })
})
