/**
 * The `goal` projection unit: mounting GoalService beside the registry
 * serves the current whole goal on the history tail page with a consistent
 * asOfSeq; before the first create the value is null; a clear tombstone
 * returns it to null; a composition without the goal service has no `goal`
 * key; unmounting drops it (HMR safety). Malformed goal-shaped events are
 * ignored fail-soft (same-reference return) — strict replay validation
 * belongs to the write side and foldGoal, never the projection drive.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import GoalService, { applyGoalProjection, foldGoal } from '@deepseek-ai/dsh-goal'
import type { GoalRef } from '@deepseek-ai/dsh-goal'

interface Bench {
  ctx: Context
  session: Session
  agent: Agent
  tailValues(): Record<string, unknown>
  tailAsOfSeq(): number
}

/** Register a minimal registry-compatible live agent over a store session. */
function liveAgent(ctx: Context, session: Session): Agent {
  const status: AgentStatus = 'idle'
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {} })
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx,
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input: UserMessage) {
      inbox.append('next-step', input)
    },
    reserveTurnAdmission: () => undefined,
    cancel() {},
    whenIdle() { return Promise.resolve() },
  }
  ctx.agents.register(agent)
  return agent
}

async function harness(withGoal: boolean): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  if (withGoal) await ctx.plugin(GoalService)
  const session = ctx.sessions.create()
  const agent = liveAgent(ctx, session)
  return {
    ctx,
    session,
    agent,
    tailValues: () => ctx.sessionProjections.snapshot(session).values,
    tailAsOfSeq: () => ctx.sessionProjections.snapshot(session).asOfSeq,
  }
}

/** One paginable message so the tail is non-degenerate. */
function seedMessage(session: Session): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

describe('goal projection unit', () => {
  it('serves null before the first create', async () => {
    const bench = await harness(true)
    seedMessage(bench.session)
    expect(bench.tailValues()).toEqual({ goal: null })
    expect(bench.tailAsOfSeq()).toBe(bench.session.seq - 1)
  })

  it('serves the whole current goal after create and tracks mutations last-wins', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    try {
      const bench = await harness(true)
      seedMessage(bench.session)
      const created = bench.ctx.goals.create(bench.agent, { objective: 'ship the goal bar' })
      const afterCreate = bench.tailValues().goal
      expect(afterCreate).toMatchObject({
        goal: { id: created.id, revision: 1, objective: 'ship the goal bar', phase: 'active' },
        roundsStarted: 0,
      })

      const ref: GoalRef = { id: created.id, revision: created.revision }
      const paused = bench.ctx.goals.pause(bench.agent, ref)
      expect(bench.tailValues().goal).toMatchObject({
        goal: { revision: paused.revision, phase: 'paused' },
      })
      expect(bench.tailAsOfSeq()).toBe(bench.session.seq - 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns to null after a clear tombstone', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    try {
      const bench = await harness(true)
      seedMessage(bench.session)
      const created = bench.ctx.goals.create(bench.agent, { objective: 'temporary' })
      expect(bench.tailValues().goal).not.toBeNull()
      bench.ctx.goals.clear(bench.agent, { id: created.id, revision: created.revision })
      expect(bench.tailValues().goal).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not revive a cleared goal when its create message is reinserted', async () => {
    const bench = await harness(true)
    const created = bench.ctx.goals.create(bench.agent, { objective: 'stay cleared' })
    const createMessage = bench.agent.inbox.nextStep.find(message => message.source.kind === 'goal'
      && message.source.change?.operation === 'create')
    if (createMessage === undefined) throw new Error('missing create message')
    bench.ctx.goals.clear(bench.agent, created)

    bench.agent.inbox.claim('next-step')
    bench.agent.inbox.prepend('next-step', createMessage)

    expect(bench.tailValues().goal).toBeNull()
    expect(foldGoal(bench.session.events).goal).toBeUndefined()
  })

  it('does not regress a goal revision when its create message is reinserted', async () => {
    const bench = await harness(true)
    const created = bench.ctx.goals.create(bench.agent, { objective: 'first revision' })
    const createMessage = bench.agent.inbox.nextStep.find(message => message.source.kind === 'goal'
      && message.source.change?.operation === 'create')
    if (createMessage === undefined) throw new Error('missing create message')
    const edited = bench.ctx.goals.edit(bench.agent, created, { objective: 'second revision' })

    bench.agent.inbox.claim('next-step')
    bench.agent.inbox.prepend('next-step', createMessage)

    expect(bench.tailValues().goal).toMatchObject({
      goal: { revision: edited.revision, objective: 'second revision' },
    })
    expect(foldGoal(bench.session.events).goal).toMatchObject({
      revision: edited.revision,
      objective: 'second revision',
    })
  })

  it('ignores non-goal and malformed goal-shaped events fail-soft (same reference)', () => {
    // The package invariant rejects a violating stream loudly wherever it is
    // installed — the unit itself must never throw on the projection drive
    // (a throwing apply would tear down every registered unit's drive), so
    // its transition is exercised directly as the pure function it is.
    const plainUser = createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    })
    const user = { type: 'user/message', seq: 0, time: 1, data: plainUser } as never
    const state = { goal: { id: 'g1', revision: 1, objective: 'x', phase: 'active', maxGoalRounds: 4 }, roundsStarted: 0, createdAt: 1, updatedAt: 1 } as never
    const empty = [null, []] as const
    expect(applyGoalProjection(empty, user)).toBe(empty)
    const queuedUser = {
      type: 'agent/inbox/spliced', seq: 1, time: 2,
      data: { target: 'next-step', start: 0, inserted: [plainUser] },
    } as never
    const current = [state, []] as const
    expect(applyGoalProjection(current, queuedUser)).toBe(current)

    const malformedMessage = createUserMessage({
      content: [{ type: 'text', text: 'broken' }],
      source: { kind: 'goal', goalId: 'g-broken', revision: 1, round: 0 } as never,
    })
    const malformed = { type: 'user/message', seq: 1, time: 2, data: malformedMessage } as never
    // Same-reference return: the registry's Object.is gate sees no change.
    expect(applyGoalProjection(current, malformed)).toBe(current)
    expect(applyGoalProjection(empty, malformed)).toBe(empty)
    const queuedMalformed = {
      type: 'agent/inbox/spliced', seq: 2, time: 3,
      data: { target: 'next-step', start: 0, inserted: [malformedMessage] },
    } as never
    expect(applyGoalProjection(current, queuedMalformed)).toBe(current)

    const queuedRound = {
      type: 'agent/inbox/spliced', seq: 3, time: 4,
      data: { target: 'next-step', start: 0, inserted: [createUserMessage({
        content: [{ type: 'text', text: 'later round' }],
        source: { kind: 'goal', goalId: 'g1', revision: 1, round: 1 } as never,
      })] },
    } as never
    expect(applyGoalProjection(current, queuedRound)).toBe(current)

    const validGoalUser = { type: 'user/message', seq: 2, time: 3, data: createUserMessage({
      content: [{ type: 'text', text: 'legacy direct change' }],
      source: { kind: 'goal', goalId: 'g1', revision: 1, round: 0, change: { kind: 'goal/change' } } as never,
    }) } as never
    expect(applyGoalProjection(empty, validGoalUser)).toBe(empty)

    // A non-message event (the registry drives EVERY committed event through
    // apply): early same-reference return.
    const turnStart = { type: 'turn/start', seq: 3, time: 4, data: { turn: 1 } } as never
    expect(applyGoalProjection(current, turnStart)).toBe(current)

    // A round-zero goal source whose change carries a foreign kind: same posture.
    const foreignMessage = createUserMessage({
      content: [{ type: 'text', text: 'foreign' }],
      source: { kind: 'goal', goalId: 'g1', revision: 1, round: 0, change: { kind: 'not-a-goal-change' } } as never,
    })
    const foreignKind = { type: 'user/message', seq: 2, time: 3, data: foreignMessage } as never
    expect(applyGoalProjection(current, foreignKind)).toBe(current)
    const queuedForeignKind = {
      type: 'agent/inbox/spliced', seq: 4, time: 5,
      data: { target: 'next-step', start: 0, inserted: [foreignMessage] },
    } as never
    expect(applyGoalProjection(current, queuedForeignKind)).toBe(current)
  })

  it('has no goal key when the goal service is not composed', async () => {
    const bench = await harness(false)
    seedMessage(bench.session)
    expect('goal' in (bench.tailValues() ?? {})).toBe(false)
  })

  it('drops the key when the goal fiber unloads (HMR safety)', async () => {
    const bench = await harness(false)
    seedMessage(bench.session)
    const fiber = await bench.ctx.plugin(GoalService)
    expect(bench.tailValues()).toEqual({ goal: null })
    await fiber.dispose()
    expect('goal' in (bench.tailValues() ?? {})).toBe(false)
  })
})
