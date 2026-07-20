import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as BashInvariant from '@deepseek-ai/dsh-bash/invariant'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantService)
  await ctx.plugin(BashInvariant)
  return ctx
}

function modeEvent(mode: string): SessionEvent {
  return { type: 'bash/sandbox-mode', seq: 0, time: 0, data: { mode } } as SessionEvent
}

describe('bash invariants', () => {
  it('accepts the closed sandbox vocabulary and ignores unrelated events', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, modeEvent('workspace-write')) }).not.toThrow()
    expect(() => { ctx.emit('session/event', {} as Session, {
      type: 'turn/start', seq: 0, time: 0, data: {},
    } as SessionEvent) }).not.toThrow()
    expect(() => { ctx.emit('tools/change') }).not.toThrow()
  })

  it('rejects an unknown durable sandbox mode', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, modeEvent('host-root')) })
      .toThrow(/unknown mode "host-root"/)
  })
})
