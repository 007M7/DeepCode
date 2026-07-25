import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import {
  GoalId,
  renderGoalChange,
  type GoalSnapshotChangeMeta,
} from '@deepseek-ai/dsh-goal'
import * as GoalInvariantCompanion from '@deepseek-ai/dsh-goal/invariant'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'

const change: GoalSnapshotChangeMeta = {
  kind: 'goal/change',
  version: 1,
  operation: 'create',
  goal: {
    id: GoalId('goal-invariant'),
    revision: 1,
    objective: 'check the stream',
    phase: 'active',
    maxGoalRounds: 2,
  },
  roundsStarted: 0,
  createdAt: 1,
  updatedAt: 1,
}

const changeSource = {
  kind: 'goal',
  goalId: change.goal.id,
  revision: change.goal.revision,
  round: 0,
} as const

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(GoalInvariantCompanion)
  return ctx
}

describe('goal stream invariants', () => {
  it('accepts canonical goal snapshots and sequential admitted rounds', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('goal-invariant-valid'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'injection', source: changeSource } })
    session.append('user/message', {
      content: renderGoalChange(change),
      source: changeSource,
      meta: change as never,
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', {
      turn: 2,
      trigger: {
        kind: 'message',
        source: { kind: 'goal', goalId: change.goal.id, revision: 1, round: 1 },
      },
    })
    expect(() => {
      session.append('user/message', {
        content: [{ type: 'text', text: 'continue' }],
        source: { kind: 'goal', goalId: change.goal.id, revision: 1, round: 1 },
      }, { surfaceOp: 'append' })
    }).not.toThrow()
  })

  it('rejects model-visible drift before committing it and keeps the fold reusable', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('goal-invariant-invalid'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'injection', source: changeSource } })
    expect(() => {
      session.append('user/message', {
        content: [{ type: 'text', text: 'counterfeit' }],
        source: changeSource,
        meta: change as never,
      }, { surfaceOp: 'append' })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-goal',
    }))
    expect(session.seq).toBe(1)
    expect(() => {
      session.append('user/message', {
        content: renderGoalChange(change),
        source: changeSource,
        meta: change as never,
      }, { surfaceOp: 'append' })
    }).not.toThrow()
  })

  it('reconstructs an existing durable goal before checking later rounds', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('goal-invariant-late-load'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'injection', source: changeSource } })
    session.append('user/message', {
      content: renderGoalChange(change),
      source: changeSource,
      meta: change as never,
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await ctx.plugin(InvariantService, { enabled: true })
    await ctx.plugin(GoalInvariantCompanion)
    session.append('turn/start', {
      turn: 2,
      trigger: {
        kind: 'message',
        source: { kind: 'goal', goalId: change.goal.id, revision: 1, round: 1 },
      },
    })
    expect(() => {
      session.append('user/message', {
        content: [{ type: 'text', text: 'continue after load' }],
        source: { kind: 'goal', goalId: change.goal.id, revision: 1, round: 1 },
      }, { surfaceOp: 'append' })
    }).not.toThrow()
  })
})
