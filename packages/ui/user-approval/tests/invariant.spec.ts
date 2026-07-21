import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import * as ApprovalInvariant from '@deepseek-ai/dsh-user-approval/invariant'
import InvariantService from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService)
  await ctx.plugin(ApprovalInvariant)
  return ctx
}

describe('approval invariants', () => {
  it('accepts paired audit events and closed policy values', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const id = ApprovalRequestId('ask-1')
    session.append('approval/asked', { id, toolName: 'bash' })
    session.append('approval/decided', { id, outcome: 'allowed-once' })
    session.append('approval/policy', { policy: 'never' })
  })

  it('rebuilds an unmatched question from an existing session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    const id = ApprovalRequestId('ask-resume')
    session.append('approval/asked', { id, toolName: 'bash' })
    await ctx.plugin(InvariantService)
    await ctx.plugin(ApprovalInvariant)
    expect(() => session.append('approval/decided', { id, outcome: 'cancelled' })).not.toThrow()
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })

  it('adopts a bare session first observed through publication', async () => {
    const ctx = await setup()
    const session = new Session(SessionId('bare-approval-session'))
    const id = ApprovalRequestId('bare-ask')
    const asked = {
      type: 'approval/asked', seq: 0, time: 0, data: { id, toolName: 'bash' },
    } as const
    const decided = {
      type: 'approval/decided', seq: 1, time: 1, data: { id, outcome: 'rejected' as const },
    } as const
    expect(() => {
      ctx.emit('session/event', session, asked)
      ctx.emit('session/event', session, decided)
    }).not.toThrow()
  })

  it('rejects malformed and unpaired audit events', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const id = ApprovalRequestId('ask-1')
    expect(() => session.append('approval/asked', { id, toolName: '' }))
      .toThrow(/toolName must be non-empty/)
    session.append('approval/asked', { id, toolName: 'bash' })
    expect(() => session.append('approval/asked', { id, toolName: 'bash' }))
      .toThrow(/repeated open id/)
    expect(() => session.append('approval/decided', {
      id: ApprovalRequestId('missing'), outcome: 'rejected',
    })).toThrow(/no matching approval\/asked/)
    expect(() => session.append('approval/decided', { id, outcome: 'maybe' as never }))
      .toThrow(/unknown outcome/)
    expect(() => session.append('approval/policy', { policy: 'always' as never }))
      .toThrow(/unknown policy/)
  })
})
