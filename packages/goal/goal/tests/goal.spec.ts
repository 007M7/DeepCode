import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createUserMessage, HarnessError, type ContentBlock, type MessageSource } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import GoalService, {
  GoalError,
  GoalId,
  decodeGoalChange,
  foldGoal,
  renderGoalChange,
} from '@deepseek-ai/dsh-goal'
import type { GoalChangeMeta, GoalRef, GoalSnapshotChangeMeta } from '@deepseek-ai/dsh-goal'

type DeferredInjection = UserMessage

interface StubAgent {
  agent: Agent
  session: Session
  deferred: DeferredInjection[]
  setDeferred(value: boolean): void
  setStatus(value: AgentStatus): void
  drain(): void
}

/** Number the next balanced one-shot injection turn. */
function nextTurn(session: Session): number {
  return session.events.reduce((max, event) => event.type === 'turn/start' ? Math.max(max, event.data.turn) : max, 0) + 1
}

/** Mirror the public Agent.inject contract for domain tests. */
function appendInjection(session: Session, input: UserMessage): void {
  session.append('user/message', input, { surfaceOp: 'append' })
}

/** Build a registry-compatible agent around one concrete session. */
function stubAgentForSession(session: Session): StubAgent {
  const id = session.id
  const deferred: DeferredInjection[] = []
  let shouldDefer = false
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id,
    options: {},
    session,
    ctx: new Context(),
    get status() { return status },
    get acceptsNextStep() { return status === 'running' },
    send: () => {},
    updateInbox: () => 'not-found',
    followup: () => {},
    steer: () => {},
    inject(input) {
      if (shouldDefer) deferred.push(input)
      else appendInjection(session, input)
    },
    cancel() {},
    whenIdle() { return Promise.resolve() },
  }
  return {
    agent,
    session,
    deferred,
    setDeferred(value) { shouldDefer = value },
    setStatus(value) { status = value },
    drain() {
      shouldDefer = false
      for (const injection of deferred.splice(0)) appendInjection(session, injection)
    },
  }
}

/** Build a registry-compatible agent with controllable context deferral. */
function stubAgent(rawId: string, seed?: readonly import('@deepseek-ai/dsh-session').SessionEvent[]): StubAgent {
  return stubAgentForSession(new Session(SessionId(rawId), seed))
}

async function harness(config: { defaultMaxGoalRounds?: number } = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService, config)
  const stub = stubAgent(`goal-test-${Math.random()}`)
  ctx.agents.register(stub.agent)
  return { ctx, ...stub }
}

/** Append one admitted goal round as a balanced user-message turn. */
function appendRound(session: Session, ref: GoalRef, round: number): void {
  const source = { kind: 'goal', goalId: ref.id, revision: ref.revision, round } as const
  const turn = nextTurn(session)
  session.append('turn/start', { turn, trigger: { kind: 'message', source } })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `round ${round}` }], source,
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('GoalService creation and replay', () => {
  it('applies the configured default and writes one verbatim context snapshot', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const { ctx, agent, session } = await harness({ defaultMaxGoalRounds: 17 })
    const seen: string[] = []
    ctx.on('goal/changed', (_subject, change) => { seen.push(change.operation) })

    const goal = ctx.goals.create(agent, { objective: '  finish the feature  ' })

    expect(goal).toMatchObject({
      objective: 'finish the feature',
      phase: 'active',
      revision: 1,
      maxGoalRounds: 17,
      roundsStarted: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      activation: 'armed',
    })
    expect(goal.id).toMatch(/^goal-/)
    expect(seen).toEqual(['create'])
    expect(session.events.map(event => event.type)).toEqual(['user/message'])
    const context = session.events[0]
    expect(context?.type).toBe('user/message')
    if (context?.type !== 'user/message') throw new Error('expected goal context')
    expect(context.data.source).toMatchObject({ kind: 'goal', goalId: goal.id, revision: 1, round: 0 })
    const change = context.data.source.kind === 'goal' ? decodeGoalChange(context.data.source.change) : undefined
    if (change === undefined) throw new Error('expected decoded goal change')
    expect(change).toMatchObject({ operation: 'create', goal: { id: goal.id } })
    expect(context.data.content).toEqual(renderGoalChange(change))
    expect(session.deriveMessages()).toEqual([context.data])
    expect(foldGoal(session.events)).toMatchObject({ goal: { id: goal.id }, roundsStarted: 0 })
    vi.useRealTimers()
  })

  it('uses 256 rounds by default and validates create input inside create', async () => {
    const { ctx, agent } = await harness()
    expect(() => ctx.goals.create(agent, { objective: '   ' })).toThrow(expect.objectContaining({
      code: 'GOAL_INVALID_OBJECTIVE',
    }))
    expect(() => ctx.goals.create(agent, { objective: 'x', maxGoalRounds: 0 })).toThrow(expect.objectContaining({
      code: 'GOAL_INVALID_MAX_ROUNDS',
    }))
    expect(() => ctx.goals.create(agent, { objective: 'x', maxGoalRounds: 1.5 })).toThrow(GoalError)
    expect(() => ctx.goals.create(agent, { objective: 'x', maxGoalRounds: 1.5 })).toThrow(HarnessError)
    expect(() => ctx.goals.create(agent, {
      objective: 'x', maxGoalRounds: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow(GoalError)
    expect(ctx.goals.create(agent, { objective: 'x' }).maxGoalRounds).toBe(256)
  })

  it('also resolves the default when constructed directly without Cordis config normalization', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const goals = new GoalService(ctx)
    const stub = stubAgent('goal-direct-construction')
    ctx.agents.register(stub.agent)
    expect(goals.create(stub.agent, { objective: 'direct' })).toMatchObject({
      objective: 'direct', maxGoalRounds: 256,
    })
  })

  it('rejects invalid direct configuration', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await expect(ctx.plugin(GoalService, { defaultMaxGoalRounds: -1 })).rejects.toThrow(expect.objectContaining({
      code: 'GOAL_INVALID_MAX_ROUNDS',
    }))
  })

  it('restores a seeded goal and rounds with activation disarmed', async () => {
    const first = await harness()
    const created = first.ctx.goals.create(first.agent, { objective: 'seed me', maxGoalRounds: 9 })
    appendRound(first.session, created, 1)
    appendRound(first.session, created, 2)

    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(GoalService)
    const resumed = stubAgent('seeded-goal', first.session.events)
    ctx.agents.register(resumed.agent)
    expect(ctx.goals.get(resumed.agent)).toMatchObject({
      id: created.id,
      roundsStarted: 2,
      activation: 'disarmed',
    })
  })

  it('inherits the completed-turn goal prefix through SessionStore.fork with child activation disarmed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(GoalService)
    const parent = stubAgentForSession(ctx.sessions.create(SessionId('goal-fork-parent')))
    ctx.agents.register(parent.agent)
    const goal = ctx.goals.create(parent.agent, { objective: 'inherit through fork', maxGoalRounds: 5 })
    appendRound(parent.session, goal, 1)

    const child = stubAgentForSession(ctx.sessions.fork(parent.session))
    ctx.agents.register(child.agent)
    expect(ctx.goals.get(child.agent)).toMatchObject({
      id: goal.id,
      objective: goal.objective,
      roundsStarted: 1,
      activation: 'disarmed',
    })
    expect(child.session.header.parentSession).toBe(parent.session.id)
    expect(child.session.header.seedLength).toBe(parent.session.seq)
  })

  it('disarms live activation on every session-start edge', async () => {
    const { ctx, agent, session } = await harness()
    let goal = ctx.goals.create(agent, { objective: 'stay stopped after resume' })
    expect(goal.activation).toBe('armed')
    agentEvents(ctx, agent).emit('agent/session-start', 'resume')
    expect(ctx.goals.get(agent)?.activation).toBe('disarmed')
    goal = ctx.goals.resume(agent, goal)
    expect(goal).toMatchObject({ phase: 'active', activation: 'armed', revision: 2 })
    expect(() => foldGoal(session.events)).not.toThrow()
  })

  it('lets a lifecycle owner disarm without writing a durable revision', async () => {
    const { ctx, agent, session } = await harness()
    const goal = ctx.goals.create(agent, { objective: 'survive driver reload' })
    const before = session.events.length
    expect(ctx.goals.disarm(agent)).toMatchObject({
      id: goal.id,
      revision: goal.revision,
      phase: 'active',
      activation: 'disarmed',
    })
    expect(session.events).toHaveLength(before)
    expect(ctx.goals.resume(agent, goal)).toMatchObject({ revision: 2, activation: 'armed' })
  })

  it('removes the service and its session-start listener with the providing fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(GoalService)
    const first = ctx.goals
    const stub = stubAgent('goal-hmr')
    ctx.agents.register(stub.agent)
    const goal = first.create(stub.agent, { objective: 'survive service reload' })

    await fiber.dispose()
    expect(ctx.get('goals')).toBeUndefined()
    agentEvents(ctx, stub.agent).emit('agent/session-start', 'resume')
    expect(first.get(stub.agent)).toMatchObject({ id: goal.id, activation: 'armed' })

    await ctx.plugin(GoalService)
    expect(ctx.goals).not.toBe(first)
    expect(ctx.goals.get(stub.agent)).toMatchObject({ id: goal.id, activation: 'disarmed' })
  })

  it('requires the exact live registry instance for reads and mutations', async () => {
    const { ctx, agent } = await harness()
    // A same-id agent backed by a different session object — the live-instance
    // check must reject it even though the ids match.
    const impostor = stubAgentForSession(new Session(agent.id)).agent
    expect(() => ctx.goals.get(impostor)).toThrow(expect.objectContaining({ code: 'GOAL_AGENT_NOT_LIVE' }))
    expect(() => ctx.goals.create(impostor, { objective: 'no' })).toThrow(expect.objectContaining({
      code: 'GOAL_AGENT_NOT_LIVE',
    }))
  })

})

describe('GoalService mutations', () => {
  it('edits with compare-and-set revisions and rejects empty edits', async () => {
    const { ctx, agent } = await harness()
    const created = ctx.goals.create(agent, { objective: 'old', maxGoalRounds: 4 })
    expect(() => ctx.goals.edit(agent, created, {})).toThrow(expect.objectContaining({ code: 'GOAL_INVALID_EDIT' }))
    const objective = ctx.goals.edit(agent, created, { objective: ' new ' })
    expect(objective).toMatchObject({ objective: 'new', maxGoalRounds: 4, revision: 2, activation: 'armed' })
    expect(() => ctx.goals.edit(agent, created, { maxGoalRounds: 8 })).toThrow(expect.objectContaining({
      code: 'GOAL_STALE_REVISION',
    }))
    const cap = ctx.goals.edit(agent, objective, { maxGoalRounds: 8 })
    expect(cap).toMatchObject({ objective: 'new', maxGoalRounds: 8, revision: 3 })
    expect(() => ctx.goals.edit(agent, cap, { objective: ' ' })).toThrow(expect.objectContaining({
      code: 'GOAL_INVALID_OBJECTIVE',
    }))
  })

  it('supports pause, resume, block, and completion transitions', async () => {
    const { ctx, agent } = await harness()
    let goal = ctx.goals.create(agent, { objective: 'lifecycle' })
    goal = ctx.goals.pause(agent, goal)
    expect(goal).toMatchObject({ phase: 'paused', activation: 'disarmed', revision: 2 })
    goal = ctx.goals.resume(agent, goal)
    expect(goal).toMatchObject({ phase: 'active', activation: 'armed', revision: 3 })
    goal = ctx.goals.block(agent, goal, { code: 'needs-input', message: 'A choice is required.' })
    expect(goal).toMatchObject({
      phase: 'blocked',
      blockedReason: { code: 'needs-input', message: 'A choice is required.' },
      activation: 'disarmed',
    })
    goal = ctx.goals.resume(agent, goal)
    goal = ctx.goals.pause(agent, goal)
    goal = ctx.goals.complete(agent, goal)
    expect(goal).toMatchObject({ phase: 'complete', activation: 'disarmed' })
    expect(() => ctx.goals.resume(agent, goal)).toThrow(expect.objectContaining({ code: 'GOAL_INVALID_TRANSITION' }))
  })

  it('allows completion from every stopped phase and replacement only after completion', async () => {
    const phases = ['paused', 'blocked'] as const
    for (const phase of phases) {
      const { ctx, agent } = await harness()
      let goal = ctx.goals.create(agent, { objective: phase })
      goal = phase === 'paused'
        ? ctx.goals.pause(agent, goal)
        : ctx.goals.block(agent, goal, { code: 'test-blocker', message: 'Blocked for the test.' })
      const complete = ctx.goals.complete(agent, goal)
      const replacement = ctx.goals.create(agent, { objective: `after ${phase}` })
      expect(complete.phase).toBe('complete')
      expect(replacement.id).not.toBe(complete.id)
      expect(replacement.revision).toBe(1)
    }
  })

  it('rejects replacement and invalid phase transitions while a resumable goal exists', async () => {
    const { ctx, agent } = await harness()
    const goal = ctx.goals.create(agent, { objective: 'still active' })
    expect(() => ctx.goals.create(agent, { objective: 'replacement' })).toThrow(expect.objectContaining({
      code: 'GOAL_ALREADY_EXISTS',
    }))
    expect(() => ctx.goals.resume(agent, goal)).toThrow(expect.objectContaining({ code: 'GOAL_INVALID_TRANSITION' }))
    const paused = ctx.goals.pause(agent, goal)
    expect(() => ctx.goals.pause(agent, paused)).toThrow(expect.objectContaining({ code: 'GOAL_INVALID_TRANSITION' }))
    expect(() => ctx.goals.block(agent, paused, {
      code: 'test-blocker', message: 'Blocked for the test.',
    })).toThrow(expect.objectContaining({
      code: 'GOAL_INVALID_TRANSITION',
    }))
  })

  it('records canonical blocker reasons and enforces the round cap on resume', async () => {
    const { ctx, agent, session } = await harness()
    let goal = ctx.goals.create(agent, { objective: 'bounded', maxGoalRounds: 2 })
    for (const reason of [null, [], { code: 1, message: 'invalid code' }, { code: 'round-limit', message: 1 }]) {
      expect(() => ctx.goals.block(agent, goal, reason as never)).toThrow(expect.objectContaining({
        code: 'GOAL_INVALID_BLOCK_REASON',
      }))
    }
    expect(() => ctx.goals.block(agent, goal, {
      code: 'Not Canonical', message: 'invalid code',
    })).toThrow(expect.objectContaining({ code: 'GOAL_INVALID_BLOCK_REASON' }))
    expect(() => ctx.goals.block(agent, goal, {
      code: 'round-limit', message: '   ',
    })).toThrow(expect.objectContaining({ code: 'GOAL_INVALID_BLOCK_REASON' }))
    appendRound(session, goal, 1)
    expect(ctx.goals.get(agent)?.roundsStarted).toBe(1)
    appendRound(session, goal, 2)
    goal = ctx.goals.block(agent, goal, { code: 'round-limit', message: '  Goal round limit reached.  ' })
    expect(goal).toMatchObject({
      phase: 'blocked',
      blockedReason: { code: 'round-limit', message: 'Goal round limit reached.' },
      roundsStarted: 2,
      activation: 'disarmed',
    })
    expect(() => ctx.goals.resume(agent, goal)).toThrow(expect.objectContaining({ code: 'GOAL_INVALID_TRANSITION' }))
    goal = ctx.goals.edit(agent, goal, { maxGoalRounds: 3 })
    expect(goal.blockedReason).toEqual({ code: 'round-limit', message: 'Goal round limit reached.' })
    goal = ctx.goals.resume(agent, goal)
    expect(goal).toMatchObject({ phase: 'active', maxGoalRounds: 3, activation: 'armed' })
    expect(goal.blockedReason).toBeUndefined()
    appendRound(session, goal, 3)
    goal = ctx.goals.block(agent, goal, { code: 'round-limit', message: 'Goal round limit reached.' })
    expect(ctx.goals.complete(agent, goal).phase).toBe('complete')
  })

  it('clears through a revisioned tombstone and permits a fresh goal', async () => {
    const { ctx, agent, session } = await harness()
    const goal = ctx.goals.create(agent, { objective: 'temporary' })
    const tombstone = ctx.goals.clear(agent, goal)
    expect(tombstone).toEqual({ id: goal.id, revision: 2 })
    expect(ctx.goals.get(agent)).toBeUndefined()
    expect(foldGoal(session.events)).toEqual({ roundsStarted: 0, lastRef: tombstone })
    expect(() => ctx.goals.clear(agent, goal)).toThrow(expect.objectContaining({ code: 'GOAL_NOT_FOUND' }))
    const next = ctx.goals.create(agent, { objective: 'fresh' })
    expect(next.id).not.toBe(goal.id)
  })

  it('keeps per-goal mutation timestamps monotonic when the wall clock moves backward', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100)
    const { ctx, agent, session } = await harness()
    let goal = ctx.goals.create(agent, { objective: 'monotonic time' })
    vi.setSystemTime(90)
    goal = ctx.goals.pause(agent, goal)
    expect(goal.updatedAt).toBe(100)
    vi.setSystemTime(80)
    ctx.goals.clear(agent, goal)
    const clear = session.events
      .filter(event => event.type === 'user/message' && event.data.source.kind === 'goal')
      .map(event => event.type === 'user/message' && event.data.source.kind === 'goal'
        ? decodeGoalChange(event.data.source.change)
        : undefined)
      .at(-1)
    expect(clear).toMatchObject({ operation: 'clear', clearedAt: 100 })
    expect(() => foldGoal(session.events)).not.toThrow()
    vi.useRealTimers()
  })

  it('contains goal notification failures and preserves later listeners', async () => {
    const { ctx, agent } = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    ctx.on('goal/changed', () => { throw new Error('broken observer') })
    ctx.on('goal/changed', (_subject, change) => { seen.push(change.operation) })
    expect(ctx.goals.create(agent, { objective: 'notify' }).phase).toBe('active')
    expect(seen).toEqual(['create'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken observer'))
  })

  it('preserves multiple pending revisions until deferred injections enter the log', async () => {
    const test = await harness()
    const { ctx, agent, session, deferred } = test
    test.setDeferred(true)
    let goal = ctx.goals.create(agent, { objective: 'deferred', maxGoalRounds: 5 })
    goal = ctx.goals.edit(agent, goal, { objective: 'deferred edit' })
    goal = ctx.goals.pause(agent, goal)
    expect(goal).toMatchObject({ revision: 3, phase: 'paused', activation: 'disarmed' })
    expect(deferred).toHaveLength(3)
    expect(session.events).toHaveLength(0)

    appendInjection(session, createUserMessage({
      content: [{ type: 'text', text: 'unrelated' }], source: { kind: 'plugin', plugin: 'test' },
    }))
    expect(ctx.goals.get(agent)).toMatchObject({ revision: 3, phase: 'paused' })
    test.drain()
    expect(deferred).toHaveLength(0)
    expect(ctx.goals.get(agent)).toMatchObject({ revision: 3, phase: 'paused' })
    expect(foldGoal(session.events)).toMatchObject({ goal: { revision: 3, phase: 'paused' } })
  })

  it('publishes a mutation consistently to a reentrant session observer', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(GoalService)
    const stub = stubAgentForSession(ctx.sessions.create(SessionId('goal-reentrant-observer')))
    ctx.agents.register(stub.agent)
    let observed: ReturnType<GoalService['get']>
    ctx.on('session/event', (session, event) => {
      if (session === stub.session && event.type === 'user/message' && event.data.source.kind === 'goal') observed = ctx.goals.get(stub.agent)
    })

    const created = ctx.goals.create(stub.agent, { objective: 'publish once' })

    expect(observed).toEqual(created)
    expect(ctx.goals.get(stub.agent)).toEqual(created)
    expect(foldGoal(stub.session.events)).toMatchObject({ goal: { id: created.id, revision: 1 } })
  })

  it('rolls back a pending mutation when injection rejects before append', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(GoalService)
    const stub = stubAgent('goal-rejected-injection')
    const append = stub.agent.inject.bind(stub.agent)
    let reject = true
    stub.agent.inject = (input) => {
      if (reject) throw new Error('injection rejected')
      append(input)
    }
    ctx.agents.register(stub.agent)

    expect(() => ctx.goals.create(stub.agent, { objective: 'first attempt' })).toThrow('injection rejected')
    reject = false
    expect(ctx.goals.create(stub.agent, { objective: 'second attempt' })).toMatchObject({
      objective: 'second attempt',
      revision: 1,
    })
  })

  it('rejects deferred goal mutations that enter the log out of FIFO order', async () => {
    const test = await harness()
    test.setDeferred(true)
    const created = test.ctx.goals.create(test.agent, { objective: 'ordered' })
    test.ctx.goals.edit(test.agent, created, { objective: 'ordered edit' })
    const second = test.deferred[1]
    if (second === undefined) throw new Error('expected a second deferred goal mutation')
    appendInjection(test.session, second)
    expect(() => test.ctx.goals.get(test.agent)).toThrow('advance the current goal')
  })

  it('observes a valid goal snapshot appended after an empty cache was established', async () => {
    const { ctx, agent, session } = await harness()
    expect(ctx.goals.get(agent)).toBeUndefined()
    const change: GoalSnapshotChangeMeta = {
      kind: 'goal/change',
      version: 1,
      operation: 'create',
      goal: {
        id: GoalId('goal-external'),
        revision: 1,
        objective: 'observe external append',
        phase: 'active',
        maxGoalRounds: 4,
      },
      roundsStarted: 0,
      createdAt: 12,
      updatedAt: 12,
    }
    const source = { kind: 'goal', goalId: change.goal.id, revision: 1, round: 0, change } as const
    const turn = nextTurn(session)
    session.append('turn/start', { turn, trigger: { kind: 'injection', source } })
    session.append('user/message', createUserMessage({
      content: renderGoalChange(change), source,
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })

    expect(ctx.goals.get(agent)).toMatchObject({
      id: change.goal.id,
      objective: change.goal.objective,
      activation: 'disarmed',
    })
  })

  it('reports the same corrupt unseen event after committing its valid prefix', async () => {
    const { ctx, agent, session } = await harness()
    expect(ctx.goals.get(agent)).toBeUndefined()
    const change: GoalSnapshotChangeMeta = {
      kind: 'goal/change',
      version: 1,
      operation: 'create',
      goal: {
        id: GoalId('goal-valid-prefix'),
        revision: 1,
        objective: 'valid prefix',
        phase: 'active',
        maxGoalRounds: 4,
      },
      roundsStarted: 0,
      createdAt: 12,
      updatedAt: 12,
    }
    appendInjection(session, createUserMessage({
      content: renderGoalChange(change),
      source: { kind: 'goal', goalId: change.goal.id, revision: 1, round: 0, change },
    }))
    appendInjection(session, createUserMessage({
      content: [{ type: 'text', text: 'corrupt' }],
      source: {
        kind: 'goal', goalId: change.goal.id, revision: 2, round: 0,
        change: { ...change, operation: 'edit', extra: true } as never,
      },
    }))

    expect(() => ctx.goals.get(agent)).toThrow('invalid shape')
    expect(() => ctx.goals.get(agent)).toThrow('invalid shape')
  })
})

describe('goal replay validation', () => {
  function snapshotChange(overrides: Partial<GoalSnapshotChangeMeta> = {}): GoalSnapshotChangeMeta {
    return {
      kind: 'goal/change',
      version: 1,
      operation: 'create',
      goal: {
        id: GoalId('goal-validation'),
        revision: 1,
        objective: 'validate',
        phase: 'active',
        maxGoalRounds: 2,
      },
      roundsStarted: 0,
      createdAt: 10,
      updatedAt: 10,
      ...overrides,
    }
  }

  function appendChange(
    session: Session,
    change: GoalChangeMeta,
    overrides: { content?: ContentBlock[]; source?: MessageSource } = {},
  ): void {
    const source = overrides.source ?? {
      kind: 'goal',
      goalId: change.operation === 'clear' ? change.cleared.id : change.goal.id,
      revision: change.operation === 'clear' ? change.cleared.revision : change.goal.revision,
      round: 0,
      change,
    }
    const turn = nextTurn(session)
    session.append('turn/start', { turn, trigger: { kind: 'injection', source } })
    session.append('user/message', createUserMessage({
      content: overrides.content ?? renderGoalChange(change),
      source,
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }

  function oneChange(change: GoalChangeMeta, overrides: { content?: ContentBlock[]; source?: MessageSource } = {}) {
    const session = new Session(SessionId(`validation-${Math.random()}`))
    appendChange(session, change, overrides)
    return session.events
  }

  function mutation(
    current: GoalSnapshotChangeMeta,
    operation: Exclude<GoalSnapshotChangeMeta['operation'], 'create'>,
    phase: GoalSnapshotChangeMeta['goal']['phase'],
    overrides: Partial<GoalSnapshotChangeMeta> = {},
  ): GoalSnapshotChangeMeta {
    return {
      ...current,
      operation,
      goal: {
        id: current.goal.id,
        revision: current.goal.revision + 1,
        objective: current.goal.objective,
        phase,
        ...phase === 'blocked'
          ? { blockedReason: { code: 'test-blocker', message: 'Blocked for replay validation.' } }
          : {},
        maxGoalRounds: current.goal.maxGoalRounds,
      },
      updatedAt: current.updatedAt + 1,
      ...overrides,
    }
  }

  function foldPair(first: GoalSnapshotChangeMeta, second: GoalChangeMeta): ReturnType<typeof foldGoal> {
    const session = new Session(SessionId(`validation-pair-${Math.random()}`))
    appendChange(session, first)
    appendChange(session, second)
    return foldGoal(session.events)
  }

  it('ignores unrelated metadata and non-goal round sources', () => {
    expect(decodeGoalChange(undefined)).toBeUndefined()
    expect(decodeGoalChange({ kind: 'other' })).toBeUndefined()
    const session = new Session(SessionId('unrelated'))
    appendInjection(session, createUserMessage({
      content: [{ type: 'text', text: 'other' }],
      source: { kind: 'plugin', plugin: 'test' },
    }))
    expect(foldGoal(session.events)).toEqual({ roundsStarted: 0 })
    const source = { kind: 'plugin', plugin: 'ordinary-user-message' } as const
    const turn = nextTurn(session)
    session.append('turn/start', { turn, trigger: { kind: 'message', source } })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'ordinary' }], source,
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    expect(foldGoal(session.events)).toEqual({ roundsStarted: 0 })
  })

  it('rejects rounds attributed to another goal', () => {
    const change = snapshotChange()
    const session = new Session(SessionId('other-goal-round'), oneChange(change))
    appendRound(session, { id: GoalId('goal-other'), revision: 1 }, 1)
    expect(() => foldGoal(session.events)).toThrow('not the next admitted round')
  })

  it('rejects unsupported versions, operations, and top-level shapes', () => {
    expect(() => decodeGoalChange({ ...snapshotChange(), version: 2 })).toThrow('unsupported goal change version')
    expect(() => decodeGoalChange({ ...snapshotChange(), operation: 'explode' })).toThrow('operation is invalid')
    expect(() => decodeGoalChange({ ...snapshotChange(), extra: true })).toThrow('snapshot change has an invalid shape')
    expect(() => decodeGoalChange({
      kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'x', revision: 2 }, clearedAt: 1, extra: true,
    })).toThrow('clear change has an invalid shape')
  })

  it('rejects invalid create and missing-current mutation sequences', () => {
    const base = snapshotChange()
    const invalidCreates: GoalSnapshotChangeMeta[] = [
      { ...base, goal: { ...base.goal, revision: 2 } },
      { ...base, goal: { ...base.goal, phase: 'paused' } },
      { ...base, roundsStarted: 1 },
    ]
    for (const change of invalidCreates) expect(() => foldGoal(oneChange(change))).toThrow('goal create requires')

    const edit = mutation(base, 'edit', 'active')
    expect(() => foldGoal(oneChange(edit))).toThrow('requires a current goal')
    const clear: GoalChangeMeta = {
      kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: base.goal.id, revision: 2 }, clearedAt: 12,
    }
    expect(() => foldGoal(oneChange(clear))).toThrow('clear requires a current goal')

    const secondCreate = snapshotChange({
      goal: { ...base.goal, id: GoalId('goal-second') },
      createdAt: 20,
      updatedAt: 20,
    })
    expect(() => foldPair(base, secondCreate)).toThrow('goal create requires')
  })

  it('rejects stale identity, counters, timestamps, and definition changes', () => {
    const base = snapshotChange()
    const invalid: GoalSnapshotChangeMeta[] = [
      mutation(base, 'edit', 'active', { goal: { ...base.goal, id: GoalId('goal-wrong'), revision: 2 } }),
      mutation(base, 'edit', 'active', { goal: { ...base.goal, revision: 3 } }),
      mutation(base, 'edit', 'active', { createdAt: 11 }),
      mutation(base, 'edit', 'active', { updatedAt: 9 }),
      mutation(base, 'edit', 'active', { roundsStarted: 1 }),
      mutation(base, 'pause', 'paused', {
        goal: { ...base.goal, revision: 2, phase: 'paused', objective: 'changed illegally' },
      }),
      mutation(base, 'pause', 'paused', {
        goal: { ...base.goal, revision: 2, phase: 'paused', maxGoalRounds: 3 },
      }),
    ]
    for (const change of invalid) expect(() => foldPair(base, change)).toThrow()
  })

  it('rejects invalid replayed lifecycle phase transitions', () => {
    const base = snapshotChange()
    const invalid: GoalSnapshotChangeMeta[] = [
      mutation(base, 'edit', 'paused'),
      mutation(base, 'pause', 'active'),
      mutation(base, 'resume', 'paused'),
      mutation(base, 'complete', 'active'),
      mutation(base, 'block', 'active'),
    ]
    for (const change of invalid) expect(() => foldPair(base, change)).toThrow()

    const paused = mutation(base, 'pause', 'paused')
    const exhausted = mutation(paused, 'resume', 'active', {
      roundsStarted: 2,
      goal: { ...paused.goal, revision: 3, phase: 'active', maxGoalRounds: 2 },
    })
    const session = new Session(SessionId('exhausted-resume'))
    appendChange(session, base)
    appendRound(session, base.goal, 1)
    appendRound(session, base.goal, 2)
    appendChange(session, { ...paused, roundsStarted: 2 })
    appendChange(session, exhausted)
    expect(() => foldGoal(session.events)).toThrow('exhausted round budget')
  })

  it('rejects invalid clear continuity and goal id reuse', () => {
    const base = snapshotChange()
    const staleClear: GoalChangeMeta = {
      kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: base.goal.id, revision: 3 }, clearedAt: 11,
    }
    expect(() => foldPair(base, staleClear)).toThrow('advance the current goal')
    const earlyClear: GoalChangeMeta = {
      kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: base.goal.id, revision: 2 }, clearedAt: 9,
    }
    expect(() => foldPair(base, earlyClear)).toThrow('timestamp cannot precede')

    const complete = mutation(base, 'complete', 'complete')
    const sameCurrentId = snapshotChange({
      goal: { ...base.goal, revision: 1 },
      createdAt: 20,
      updatedAt: 20,
    })
    const completedSession = new Session(SessionId('reuse-complete'))
    appendChange(completedSession, base)
    appendChange(completedSession, complete)
    appendChange(completedSession, sameCurrentId)
    expect(() => foldGoal(completedSession.events)).toThrow('fresh active revision-one')

    const second = snapshotChange({
      goal: { ...base.goal, id: GoalId('goal-second') },
      createdAt: 20,
      updatedAt: 20,
    })
    const secondComplete = mutation(second, 'complete', 'complete')
    const nonAdjacentReuse = new Session(SessionId('reuse-non-adjacent'))
    appendChange(nonAdjacentReuse, base)
    appendChange(nonAdjacentReuse, complete)
    appendChange(nonAdjacentReuse, second)
    appendChange(nonAdjacentReuse, secondComplete)
    appendChange(nonAdjacentReuse, { ...sameCurrentId, createdAt: 30, updatedAt: 30 })
    expect(() => foldGoal(nonAdjacentReuse.events)).toThrow('fresh active revision-one')

    const clear: GoalChangeMeta = {
      kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: base.goal.id, revision: 2 }, clearedAt: 11,
    }
    const clearedSession = new Session(SessionId('reuse-clear'))
    appendChange(clearedSession, base)
    appendChange(clearedSession, clear)
    appendChange(clearedSession, sameCurrentId)
    expect(() => foldGoal(clearedSession.events)).toThrow('fresh active revision-one')
  })

  it('rejects goal-source context without matching durable metadata', () => {
    const session = new Session(SessionId('goal-source-without-meta'))
    const source = { kind: 'goal', goalId: GoalId('goal-missing-meta'), revision: 1, round: 0 } as const
    const turn = nextTurn(session)
    session.append('turn/start', { turn, trigger: { kind: 'injection', source } })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'missing' }], source,
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    expect(() => foldGoal(session.events)).toThrow('lacks source change data')
  })

  it('rejects malformed snapshots, refs, counters, and timestamps', () => {
    const base = snapshotChange()
    const badSnapshots: unknown[] = [
      null,
      { ...base.goal, extra: true },
      { ...base.goal, id: '' },
      { ...base.goal, objective: ' ' },
      { ...base.goal, objective: ' padded ' },
      { ...base.goal, phase: 'unknown' },
      { ...base.goal, blockedReason: { code: 'unexpected', message: 'Only blocked goals have reasons.' } },
      { ...base.goal, phase: 'blocked' },
      { ...base.goal, phase: 'blocked', blockedReason: null },
      { ...base.goal, phase: 'blocked', blockedReason: { code: 'test-blocker', message: 'Valid.', extra: true } },
      { ...base.goal, phase: 'blocked', blockedReason: { code: 'NOT_CANONICAL', message: 'Bad code.' } },
      { ...base.goal, phase: 'blocked', blockedReason: { code: 'test-blocker', message: ' padded ' } },
      { ...base.goal, revision: 0 },
      { ...base.goal, maxGoalRounds: -1 },
    ]
    for (const goal of badSnapshots) expect(() => decodeGoalChange({ ...base, goal })).toThrow()
    expect(() => decodeGoalChange({ ...base, roundsStarted: -1 })).toThrow('roundsStarted')
    expect(() => decodeGoalChange({ ...base, createdAt: -1 })).toThrow('createdAt')
    expect(() => decodeGoalChange({ ...base, updatedAt: 9 })).toThrow('cannot precede')
    expect(() => decodeGoalChange({
      kind: 'goal/change', version: 1, operation: 'clear', cleared: null, clearedAt: 1,
    })).toThrow('tombstone')
    expect(() => decodeGoalChange({
      kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: '', revision: 1 }, clearedAt: 1,
    })).toThrow('non-empty')
    expect(() => decodeGoalChange({
      kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'x', revision: 0 }, clearedAt: 1,
    })).toThrow('positive safe integer')
  })

  it('rejects source and content drift from the durable metadata', () => {
    const change = snapshotChange()
    expect(() => foldGoal(oneChange(change, { source: { kind: 'plugin', plugin: 'wrong' } }))).toThrow('mismatched source')
    expect(() => foldGoal(oneChange(change, {
      source: { kind: 'goal', goalId: change.goal.id, revision: 1, round: -1 },
    }))).toThrow('source is invalid')
    expect(() => foldGoal(oneChange(change, {
      source: { kind: 'goal', goalId: GoalId('goal-imposter'), revision: 1, round: 0, change },
    }))).toThrow('mismatched source attribution')
    expect(() => foldGoal(oneChange(change, {
      source: { kind: 'goal', goalId: change.goal.id, revision: 2, round: 0, change },
    }))).toThrow('mismatched source attribution')
    expect(() => foldGoal(oneChange(change, { content: [{ type: 'text', text: 'wrong' }] }))).toThrow('model-visible content')
  })

  it('folds a clear tombstone after a snapshot', () => {
    const change = snapshotChange()
    const session = new Session(SessionId('fold-clear'), oneChange(change))
    const clear: GoalChangeMeta = {
      kind: 'goal/change',
      version: 1,
      operation: 'clear',
      cleared: { id: change.goal.id, revision: 2 },
      clearedAt: 20,
    }
    const source = { kind: 'goal', goalId: change.goal.id, revision: 2, round: 0, change: clear } as const
    const turn = nextTurn(session)
    session.append('turn/start', { turn, trigger: { kind: 'injection', source } })
    session.append('user/message', createUserMessage({
      content: renderGoalChange(clear), source,
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    expect(foldGoal(session.events)).toEqual({
      roundsStarted: 0,
      lastRef: { id: change.goal.id, revision: 2 },
    })
  })
})
