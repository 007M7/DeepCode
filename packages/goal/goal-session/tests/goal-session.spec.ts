import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { Agent, PromptDecision } from '@deepseek-ai/dsh-agent'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService, { foldGoal, GoalId } from '@deepseek-ai/dsh-goal'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import * as goalSession from '../src/index.ts'

declare module '@deepseek-ai/dsh-session' {
  interface TurnTriggerMap {
    /** Test-only plugin turn with no message source. */
    'test-metadata': { kind: 'test-metadata' }
  }
}

type ScriptEntry = StreamChunk[] | Error | 'hang' | ((options: GenerateOptions) => StreamChunk[])

/** Small request-recording adapter with controllable failure and cancellation. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if (entry instanceof Error) throw entry
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    const chunks = typeof entry === 'function' ? entry(options) : entry
    for (const chunk of chunks) yield chunk
  }
}

/** One successful text response. */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One successful response cut off at the model output limit. */
function maxTokensResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

/** Complete request history as a single string for ordering assertions. */
function requestText(request: GenerateOptions): string {
  return request.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

interface Harness {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly agent: Agent
  readonly driver: Awaited<ReturnType<Context['plugin']>>
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
})

/** Mount a real loop with only its model scripted. */
async function harness(script: ScriptEntry[]): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(GoalService)
  const driver = await ctx.plugin(goalSession)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId(`goal-session-${Math.random()}`), {
    provider: 'mock',
    model: 'mock',
  })
  return { ctx, adapter, agent, driver }
}

/** Await a stable goal projection selected by the caller. */
async function waitForGoal(
  ctx: Context,
  agent: Agent,
  predicate: (goal: GoalView | undefined) => boolean,
): Promise<GoalView | undefined> {
  await vi.waitFor(() => {
    expect(predicate(ctx.goals.get(agent))).toBe(true)
  })
  return ctx.goals.get(agent)
}

/** Await a specific number of dispatched model requests. */
async function waitForRequests(adapter: ScriptedAdapter, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(adapter.requests).toHaveLength(count)
  })
}

describe('goal-round outcome policy', () => {
  it.each([
    [{ kind: 'completed' }, true, { kind: 'continue' }],
    [{ kind: 'aborted' }, true, { kind: 'pause', reason: 'cancelled' }],
    [{ kind: 'error', step: 1, message: 'slow down', code: 'RATE_LIMIT' }, true,
      { kind: 'blocked', code: 'usage-limited', message: 'slow down' }],
    [{ kind: 'error', step: 1, failure: { message: 'credits exhausted', code: 'QUOTA' } }, true,
      { kind: 'blocked', code: 'usage-limited', message: 'credits exhausted' }],
    [{ kind: 'error', step: 1, failure: { message: 'provider failed', code: 'SERVER' } }, true,
      { kind: 'blocked', code: 'turn-error', message: 'provider failed' }],
    [{ kind: 'error', step: 1, message: 'broken' }, true,
      { kind: 'blocked', code: 'turn-error', message: 'broken' }],
    [{ kind: 'max-tokens' }, true,
      { kind: 'blocked', code: 'max-tokens', message: 'model output reached max tokens' }],
    [{ kind: 'disposed' }, true, { kind: 'disarm', reason: 'disposed' }],
    [{ kind: 'interrupted' }, true, { kind: 'disarm', reason: 'interrupted' }],
    [{ kind: 'completed' }, false, { kind: 'disarm', reason: 'durability-failed' }],
    [{ kind: 'future-outcome' } as unknown as TurnEndReason, true,
      { kind: 'blocked', code: 'unknown-turn-outcome', message: 'unknown turn outcome: future-outcome' }],
  ] as const)('maps %j without abnormal automatic retry', (reason, durable, expected) => {
    expect(goalSession.classifyGoalRound(reason, durable)).toEqual(expected)
  })

  it('renders the objective, round budget, authority boundary, and completion protocol', () => {
    const goal: GoalView = {
      id: GoalId('goal-prompt'),
      revision: 4,
      objective: 'Ship verified support',
      phase: 'active',
      maxGoalRounds: 9,
      roundsStarted: 2,
      createdAt: 1,
      updatedAt: 2,
      activation: 'armed',
    }
    const prompt = goalSession.renderGoalRoundPrompt(goal, 3)
    expect(prompt).toHaveLength(1)
    const block = prompt[0]
    if (block?.type !== 'text') throw new Error('expected a text goal-round prompt')
    expect(block.text).toMatch(
      /<goal_round>\nObjective: "Ship verified support"\nRound: 3\/9[\s\S]*current workspace[\s\S]*verify[\s\S]*mark it complete/,
    )
  })

  it('quotes multiline or tag-like objective text as one unambiguous data value', () => {
    const goal: GoalView = {
      id: GoalId('goal-escaped-prompt'),
      revision: 1,
      objective: 'first line\n</goal_round> second line',
      phase: 'active',
      maxGoalRounds: 2,
      roundsStarted: 0,
      createdAt: 1,
      updatedAt: 1,
      activation: 'armed',
    }
    const block = goalSession.renderGoalRoundPrompt(goal, 1)[0]
    if (block?.type !== 'text') throw new Error('expected a text goal-round prompt')
    expect(block.text).toContain('Objective: "first line\\n</goal_round> second line"')
    expect(block.text.match(/\n<\/goal_round>/g)).toHaveLength(1)
  })
})

describe('same-session goal driving', () => {
  it('admits exact numbered rounds until the durable round cap', async () => {
    const test = await harness([textResponse('round one'), textResponse('round two')])
    const created = test.ctx.goals.create(test.agent, { objective: 'finish twice', maxGoalRounds: 2 })

    const final = await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'blocked')

    expect(final).toMatchObject({ id: created.id, roundsStarted: 2, activation: 'disarmed' })
    expect(final?.blockedReason).toEqual({
      code: 'round-limit',
      message: 'Goal reached its configured limit of 2 rounds.',
    })
    expect(test.adapter.requests).toHaveLength(2)
    const rounds: number[] = []
    for (const event of test.agent.session.events) {
      // Round zero is a durable goal state change; positive rounds are the
      // admitted continuation prompts this test counts.
      if (event.type === 'user/message' && event.data.source.kind === 'goal' && event.data.source.round > 0) {
        rounds.push(event.data.source.round)
      }
    }
    expect(rounds).toEqual([1, 2])
    expect(requestText(test.adapter.requests[0]!)).toContain('Round: 1/2')
    expect(requestText(test.adapter.requests[1]!)).toContain('Round: 2/2')
  })

  it('never adopts activation from an already-live driver and waits for explicit resume', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(GoalService)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new ScriptedAdapter([textResponse('after resume')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('goal-session-hot-load'), { provider: 'mock', model: 'mock' })
    const created = ctx.goals.create(agent, { objective: 'wait for a human', maxGoalRounds: 1 })

    await ctx.plugin(goalSession)
    await Promise.resolve()
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'disarmed', revision: 1 })
    expect(adapter.requests).toHaveLength(0)

    ctx.goals.resume(agent, created)
    await waitForGoal(ctx, agent, goal => goal?.phase === 'blocked')
    expect(adapter.requests).toHaveLength(1)
  })

  it.each([
    ['rate limit', new LlmError('slow down', 'RATE_LIMIT'), 'usage-limited'],
    ['request error', new Error('provider broke'), 'turn-error'],
    ['max tokens', maxTokensResponse('unfinished'), 'max-tokens'],
  ] as const)('stops after a %s without an automatic retry', async (_label, response, code) => {
    const test = await harness([response])
    test.ctx.goals.create(test.agent, { objective: 'stop safely', maxGoalRounds: 8 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    expect(goal).toMatchObject({ roundsStarted: 1, activation: 'disarmed' })
    expect(goal?.blockedReason?.code).toBe(code)
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('maps a downstream prompt veto to blocked without admitting the round', async () => {
    const test = await harness([])
    test.ctx.on('agent/prompt-submit', (_agent, _content, source, _signal, next) => source.kind === 'goal'
      ? Promise.resolve({ kind: 'block', reason: 'deployment policy' })
      : next())
    test.ctx.goals.create(test.agent, { objective: 'respect policy' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    expect(goal?.roundsStarted).toBe(0)
    expect(goal?.blockedReason).toEqual({ code: 'prompt-rejected', message: 'deployment policy' })
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.agent.session.events.some(event => event.type === 'turn/start')).toBe(false)
  })

  it('does not reserve again when a stopped-goal observer queues ordinary work', async () => {
    const test = await harness([textResponse('human follow-up')])
    test.ctx.on('agent/prompt-submit', (_agent, _content, source, _signal, next) => source.kind === 'goal'
      ? Promise.resolve({ kind: 'block', reason: 'stop this round' })
      : next())
    test.ctx.on('goal/changed', (agent, change) => {
      if (change.operation === 'block') agent.followup({ content: [{ type: 'text', text: 'inspect the blocker' }], source: { kind: 'user' } })
    })
    test.ctx.goals.create(test.agent, { objective: 'stop and inspect' })

    await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'blocked')
    await waitForRequests(test.adapter, 1)
    await test.agent.whenIdle()

    expect(requestText(test.adapter.requests[0]!)).toContain('inspect the blocker')
  })

  it('pauses and drops a reserved round when cancellation lands before admission', async () => {
    const test = await harness([])
    const cancel = test.ctx.on('agent/inbox/enqueue', (agent, info) => {
      if (agent === test.agent && info.source.kind === 'goal') {
        cancel()
        agent.cancel({ kind: 'user' })
      }
    })
    test.ctx.goals.create(test.agent, { objective: 'do not start yet' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')

    expect(goal).toMatchObject({ roundsStarted: 0, activation: 'disarmed' })
    expect(test.adapter.requests).toHaveLength(0)
    // No admitted continuation round (positive round); goal state changes
    // (round zero) are expected in the log.
    expect(test.agent.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'goal' && event.data.source.round > 0)).toBe(false)
  })

  it('pauses an admitted round when cancellation aborts an active step', async () => {
    const test = await harness(['hang'])
    test.ctx.goals.create(test.agent, { objective: 'stop in flight' })
    await waitForRequests(test.adapter, 1)

    test.agent.cancel({ kind: 'user' })
    await test.agent.whenIdle()
    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')

    expect(goal).toMatchObject({ roundsStarted: 1, activation: 'disarmed' })
    expect(foldGoal(test.agent.session.events)).toMatchObject({
      goal: { phase: 'paused', revision: 2 },
      roundsStarted: 1,
    })
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('lets already-queued human work finish before reserving the next round', async () => {
    const test = await harness([textResponse('human answer'), textResponse('goal answer')])
    test.ctx.goals.create(test.agent, { objective: 'continue after the human', maxGoalRounds: 1 })
    test.agent.followup({ content: [{ type: 'text', text: 'human goes first' }], source: { kind: 'user' } })

    await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'blocked')

    expect(test.adapter.requests).toHaveLength(2)
    expect(requestText(test.adapter.requests[0]!)).toContain('human goes first')
    expect(requestText(test.adapter.requests[0]!)).not.toContain('<goal_round>')
    expect(requestText(test.adapter.requests[1]!)).toContain('<goal_round>')
  })

  it('ignores plugin-owned turn triggers while a goal round is queued', async () => {
    const test = await harness([textResponse('goal answer')])
    const warnings: string[] = []
    test.ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof test.ctx.logger.warn
    let inserted = false
    test.ctx.on('agent/inbox/enqueue', (agent, info) => {
      if (agent !== test.agent || info.source.kind !== 'goal' || inserted) return
      inserted = true
      const lastStart = agent.session.events.findLast(event => event.type === 'turn/start')
      const turn = (lastStart?.data.turn ?? 0) + 1
      agent.session.append('turn/start', {
        turn,
        trigger: { kind: 'test-metadata' },
      })
      agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    })
    test.ctx.goals.create(test.agent, { objective: 'ignore metadata', maxGoalRounds: 1 })

    await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'blocked')

    expect(inserted).toBe(true)
    expect(test.adapter.requests).toHaveLength(1)
    expect(warnings.some(warning => warning.includes('session/event listener threw'))).toBe(false)
  })

  it('makes a reserved round stale when a listener queues human work behind it', async () => {
    const test = await harness([textResponse('human batch'), textResponse('later goal')])
    let inserted = false
    test.ctx.on('agent/inbox/enqueue', (agent, info) => {
      if (agent !== test.agent || info.source.kind !== 'goal' || inserted) return
      inserted = true
      agent.followup({ content: [{ type: 'text', text: 'human joined the pending batch' }], source: { kind: 'user' } })
    })
    test.ctx.goals.create(test.agent, { objective: 'yield to nested human input', maxGoalRounds: 1 })

    await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'blocked')

    expect(test.adapter.requests).toHaveLength(2)
    expect(requestText(test.adapter.requests[0]!)).toContain('human joined the pending batch')
    expect(requestText(test.adapter.requests[0]!)).not.toContain('<goal_round>')
    expect(requestText(test.adapter.requests[1]!)).toContain('<goal_round>')
  })

  it('blocks a queued reservation made stale by a goal edit and continues the new revision', async () => {
    const test = await harness([textResponse('new revision')])
    let edited = false
    test.ctx.on('agent/inbox/enqueue', (agent, info) => {
      if (agent !== test.agent || info.source.kind !== 'goal' || edited) return
      edited = true
      const current = test.ctx.goals.get(agent)
      if (current === undefined) throw new Error('missing goal during queued edit')
      test.ctx.goals.edit(agent, current, { objective: 'new objective' })
    })
    test.ctx.goals.create(test.agent, { objective: 'old objective', maxGoalRounds: 1 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    expect(goal).toMatchObject({ revision: 3, objective: 'new objective', roundsStarted: 1 })
    const admitted = test.agent.session.events.find(event => event.type === 'user/message'
      && event.data.source.kind === 'goal' && event.data.source.round > 0)
    expect(admitted?.type === 'user/message' && admitted.data.source.kind === 'goal'
      ? admitted.data.source.revision
      : undefined).toBe(2)
  })

  it('rechecks revision after downstream prompt hooks before admitting', async () => {
    const test = await harness([textResponse('new revision')])
    let edited = false
    test.ctx.on('agent/prompt-submit', (agent, _content, source, _signal, next) => {
      if (source.kind === 'goal' && !edited) {
        edited = true
        const current = test.ctx.goals.get(agent)
        if (current === undefined) throw new Error('missing goal during prompt edit')
        test.ctx.goals.edit(agent, current, { objective: 'edited downstream' })
      }
      return next()
    })
    test.ctx.goals.create(test.agent, { objective: 'edit during admission', maxGoalRounds: 1 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    expect(goal).toMatchObject({ objective: 'edited downstream', roundsStarted: 1 })
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('disarms without dispatch when a durability checkpoint fails', async () => {
    const test = await harness([])
    test.ctx.on('session/flush', () => Promise.reject(new Error('disk unavailable')))
    test.ctx.goals.create(test.agent, { objective: 'do not outrun storage' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')

    expect(goal).toMatchObject({ phase: 'active', roundsStarted: 0 })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('disarms instead of reserving another round when the round checkpoint fails', async () => {
    const test = await harness([textResponse('round one ran')])
    // The loop persists eagerly with no turn-end flush, so the driver owns
    // the round durability barrier. Let goal creation's checkpoint pass, then
    // fail the flush that settles round one: no second round may be reserved
    // on state that was never persisted.
    let flushes = 0
    test.ctx.on('session/flush', () => {
      flushes += 1
      // Flush 1 is goal creation's checkpoint; flush 2 settles round one.
      return flushes >= 2 ? Promise.reject(new Error('round checkpoint failed')) : undefined
    })
    test.ctx.goals.create(test.agent, { objective: 'no autonomous rounds without durability', maxGoalRounds: 5 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')

    expect(goal).toMatchObject({ phase: 'active', roundsStarted: 1 })
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('reserves the next round only after the settled round checkpoint succeeds', async () => {
    const test = await harness([textResponse('round one'), textResponse('round two')])
    const flushes: number[] = []
    test.ctx.on('session/flush', () => { flushes.push(test.adapter.requests.length) })
    test.ctx.goals.create(test.agent, { objective: 'checkpoint between rounds', maxGoalRounds: 2 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    expect(goal?.blockedReason?.code).toBe('round-limit')
    expect(goal?.roundsStarted).toBe(2)
    expect(test.adapter.requests).toHaveLength(2)
    // A flush was observed after round one settled and before round two
    // dispatched (recorded request count 1 at flush time).
    expect(flushes).toContain(1)
  })

  it('contains a checkpoint failure after a clear notification leaves no current goal', async () => {
    const test = await harness([])
    test.ctx.on('session/flush', () => Promise.reject(new Error('clear checkpoint failed')))
    agentEvents(test.ctx, test.agent).emit('goal/changed', {
      operation: 'clear',
      ref: { id: GoalId('cleared-goal'), revision: 2 },
    })
    await new Promise<void>((resolve) => { setImmediate(resolve) })

    expect(test.ctx.goals.get(test.agent)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('settles a goal round from its successful retry turn, not the failed original', async () => {
    const test = await harness([
      new LlmError('transient', 'SERVER'),
      textResponse('retry succeeded'),
    ])
    // The llm-retry shape: schedule one retry for the failed goal-round request.
    let retried = false
    test.ctx.on('agent/request-error', async (_subject) => {
      if (!retried) {
        retried = true
        return { kind: 'retry' }
      }
    })
    test.ctx.goals.create(test.agent, { objective: 'survive a transient failure', maxGoalRounds: 1 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    // The retry turn's completed outcome settles the round: round-limit, not
    // the failed original turn's turn-error.
    expect(goal?.blockedReason?.code).toBe('round-limit')
    expect(goal?.roundsStarted).toBe(1)
    expect(test.adapter.requests).toHaveLength(2)
  })

  it('does not double-clear when a throwing hook already cancelled the round', async () => {
    const test = await harness([])
    // The downstream hook cancels (pausing the goal and clearing the queued
    // attempt through cancel-requested) and THEN throws: the catch finds no
    // matching reservation and must not reschedule a paused goal.
    let fired = false
    test.ctx.on('agent/prompt-submit', async (agent, _content, source, _signal, next) => {
      if (source.kind === 'goal' && !fired) {
        fired = true
        agent.cancel({ kind: 'user' })
        throw new Error('hook cancelled then exploded')
      }
      return next()
    })
    test.ctx.goals.create(test.agent, { objective: 'cancel then throw' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    await test.agent.whenIdle()
    await new Promise((resolve) => { setImmediate(resolve) })

    expect(goal?.roundsStarted).toBe(0)
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'paused' })
  })

  it('reschedules the round when a downstream admission hook throws', async () => {
    const test = await harness([textResponse('second admission succeeded')])
    // Registered after goal-session's own listener: the throw propagates back
    // through goal-session's next() await, dropping the whole admission.
    let threw = false
    test.ctx.on('agent/prompt-submit', async (_agent, _content, source, _signal, next) => {
      if (source.kind === 'goal' && !threw) {
        threw = true
        throw new Error('downstream admission hook exploded')
      }
      return next()
    })
    test.ctx.goals.create(test.agent, { objective: 'survive a throwing hook', maxGoalRounds: 1 })

    // The cleared reservation lets the driver reschedule; the second
    // admission passes and the round completes to its limit.
    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')
    expect(goal?.blockedReason?.code).toBe('round-limit')
    expect(goal?.roundsStarted).toBe(1)
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('a retry turn on a non-goal failure leaves the goal reservation untouched', async () => {
    const test = await harness([
      new LlmError('transient on human turn', 'SERVER'),
      textResponse('human retry succeeded'),
      textResponse('goal round ran'),
    ])
    let retried = false
    test.ctx.on('agent/request-error', async (_subject) => {
      if (!retried) {
        retried = true
        return { kind: 'retry' }
      }
    })
    // A human prompt fails and retries while a goal is armed but its round
    // is not yet reserved: the retry trigger must not adopt or clear
    // anything (the attempt is absent), and the goal proceeds normally.
    test.ctx.goals.create(test.agent, { objective: 'ignore foreign retries', maxGoalRounds: 1 })
    test.agent.followup({ content: [{ type: 'text', text: 'human work' }], source: { kind: 'user' } })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')
    expect(goal?.blockedReason?.code).toBe('round-limit')
    expect(goal?.roundsStarted).toBe(1)
  })

  it('blocks the goal when a custom agent rejects the otherwise valid follow-up', async () => {
    const test = await harness([])
    // Reject only the goal-sourced round follow-up, not the state-change injection
    // that precedes it.
    const realFollowup = test.agent.followup.bind(test.agent)
    vi.spyOn(test.agent, 'followup').mockImplementation((input) => {
      if (input.source.kind === 'goal') {
        throw new Error('queue rejected')
      }
      return realFollowup(input)
    })
    test.ctx.goals.create(test.agent, { objective: 'handle queue failure' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    expect(goal).toMatchObject({ roundsStarted: 0, activation: 'disarmed' })
    expect(goal?.blockedReason).toEqual({
      code: 'queue-failed',
      message: 'Could not queue goal round 1: queue rejected',
    })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('preserves a custom agent side effect when followup disarms before throwing', async () => {
    const test = await harness([])
    const realFollowup = test.agent.followup.bind(test.agent)
    vi.spyOn(test.agent, 'followup').mockImplementation((input) => {
      if (input.source.kind === 'goal') {
        test.ctx.goals.disarm(test.agent)
        throw new Error('queue rejected after disarm')
      }
      return realFollowup(input)
    })
    test.ctx.goals.create(test.agent, { objective: 'preserve the newer activation state' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')

    expect(goal).toMatchObject({ phase: 'active', roundsStarted: 0 })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('contains a mutation failure inside the scheduler loop and fails closed', async () => {
    const test = await harness([textResponse('the only round')])
    // The only ctx.goals.block call in a completing one-round run is the
    // driver's round-limit stop, so the mock fails exactly that drive pass.
    vi.spyOn(test.ctx.goals, 'block').mockImplementationOnce(() => {
      throw new Error('round-limit block failed')
    })
    test.ctx.goals.create(test.agent, { objective: 'contain a driver failure', maxGoalRounds: 1 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')

    expect(goal).toMatchObject({ phase: 'active', roundsStarted: 1 })
    expect(goal?.blockedReason).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('contains synchronous scheduler startup failure', async () => {
    const test = await harness([])
    vi.spyOn(test.ctx.agents, 'withoutInitiator').mockImplementationOnce(() => {
      throw 'scheduler closed'
    })
    test.ctx.goals.create(test.agent, { objective: 'fail startup closed' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')

    expect(goal?.phase).toBe('active')
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('contains an asynchronously rejected scheduler task', async () => {
    const test = await harness([])
    vi.spyOn(test.ctx.agents, 'withoutInitiator').mockImplementationOnce(
      () => Promise.reject(new Error('scheduler task rejected')),
    )
    test.ctx.goals.create(test.agent, { objective: 'fail task closed' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')

    expect(goal?.phase).toBe('active')
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('fails a pre-admission read closed even when the first disarm attempt throws', async () => {
    const test = await harness([textResponse('retry after containment')])
    let armed = true
    test.ctx.on('agent/inbox/enqueue', (agent, info) => {
      if (agent !== test.agent || info.source.kind !== 'goal' || !armed) return
      armed = false
      vi.spyOn(test.ctx.goals, 'get').mockImplementationOnce(() => {
        throw new Error('admission projection failed')
      })
      vi.spyOn(test.ctx.goals, 'disarm').mockImplementationOnce(() => {
        throw 'disarm failed'
      })
    })
    test.ctx.goals.create(test.agent, { objective: 'retry stale admission', maxGoalRounds: 1 })

    await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'blocked')

    expect(test.adapter.requests).toHaveLength(1)
  })

  it('fails a post-hook read closed before the prompt can enter history', async () => {
    const test = await harness([])
    let armed = true
    test.ctx.on('agent/prompt-submit', (_agent, _content, source, _signal, next) => {
      if (source.kind === 'goal' && armed) {
        armed = false
        vi.spyOn(test.ctx.goals, 'get').mockImplementationOnce(() => {
          throw new Error('post-hook projection failed')
        })
      }
      return next()
    })
    test.ctx.goals.create(test.agent, { objective: 'block post-hook failure' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')

    expect(goal).toMatchObject({ phase: 'active', roundsStarted: 0 })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('blocks forged goal attribution without touching an absent reservation', async () => {
    const test = await harness([])
    test.agent.followup({ content: [{ type: 'text', text: 'forged automatic work' }], source: { kind: 'goal', goalId: GoalId('forged-goal'), revision: 1, round: 1 } })
    await test.agent.whenIdle()

    expect(test.adapter.requests).toHaveLength(0)
    expect(test.agent.session.events.some(event => event.type === 'turn/start')).toBe(false)
  })

  it('does not invent goal state when ordinary queued work is cancelled', async () => {
    const test = await harness([])
    test.agent.followup({ content: [{ type: 'text', text: 'cancel ordinary work' }], source: { kind: 'user' } })
    test.agent.cancel({ kind: 'user' })
    await test.agent.whenIdle()

    expect(test.ctx.goals.get(test.agent)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('disarms without durably pausing when cancellation belongs to unrelated human work', async () => {
    const test = await harness(['hang'])
    test.agent.followup({ content: [{ type: 'text', text: 'inspect something first' }], source: { kind: 'user' } })
    await waitForRequests(test.adapter, 1)
    const created = test.ctx.goals.create(test.agent, { objective: 'continue after inspection' })

    test.agent.cancel({ kind: 'user' })
    await test.agent.whenIdle()

    expect(test.ctx.goals.get(test.agent)).toMatchObject({
      id: created.id,
      revision: created.revision,
      phase: 'active',
      activation: 'disarmed',
      roundsStarted: 0,
    })
  })

  it('falls back to disarming when a cancelled reservation cannot be paused', async () => {
    const test = await harness([])
    const cancel = test.ctx.on('agent/inbox/enqueue', (agent, info) => {
      if (agent !== test.agent || info.source.kind !== 'goal') return
      cancel()
      vi.spyOn(test.ctx.goals, 'pause').mockImplementationOnce(() => {
        throw new Error('pause failed')
      })
      agent.cancel({ kind: 'user' })
    })
    test.ctx.goals.create(test.agent, { objective: 'fail closed after cancellation' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')

    expect(goal).toMatchObject({ phase: 'active', revision: 1, roundsStarted: 0 })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('blocks admission when downstream cancellation clears the reservation', async () => {
    const test = await harness([])
    let cancelled = false
    test.ctx.on('agent/prompt-submit', (agent, _content, source, _signal, next) => {
      if (source.kind === 'goal' && !cancelled) {
        cancelled = true
        agent.cancel({ kind: 'user' })
      }
      return next()
    })
    test.ctx.goals.create(test.agent, { objective: 'cancel during admission' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    await test.agent.whenIdle()

    expect(goal?.roundsStarted).toBe(0)
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('disarms and cancels an admitted round before driver teardown completes', async () => {
    const test = await harness(['hang'])
    test.ctx.goals.create(test.agent, { objective: 'survive plugin unload' })
    await waitForRequests(test.adapter, 1)

    await test.driver.dispose()

    expect(test.ctx.goals.get(test.agent)).toMatchObject({
      phase: 'active',
      activation: 'disarmed',
      roundsStarted: 1,
    })
    await test.agent.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('cancels an accepted queued round and awaits its driver task during teardown', async () => {
    const test = await harness([])
    let unloading: Promise<void> | undefined
    test.ctx.on('agent/inbox/enqueue', (agent, info) => {
      if (agent === test.agent && info.source.kind === 'goal' && unloading === undefined) {
        unloading = Promise.resolve(test.driver.dispose())
      }
    })
    test.ctx.goals.create(test.agent, { objective: 'unload while queued' })
    await vi.waitFor(() => { expect(unloading).toBeDefined() })
    await unloading

    expect(test.ctx.goals.get(test.agent)).toMatchObject({
      phase: 'active',
      activation: 'disarmed',
      roundsStarted: 0,
    })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('resets process-local scheduling state at a session-start edge', async () => {
    const test = await harness([textResponse('after explicit resume')])
    const created = test.ctx.goals.create(test.agent, { objective: 'restart safely', maxGoalRounds: 1 })
    agentEvents(test.ctx, test.agent).emit('agent/session-start', 'resume')
    await Promise.resolve()

    expect(test.ctx.goals.get(test.agent)).toMatchObject({ activation: 'disarmed', roundsStarted: 0 })
    expect(test.adapter.requests).toHaveLength(0)

    test.ctx.goals.resume(test.agent, created)
    await waitForGoal(test.ctx, test.agent, goal => goal?.phase === 'blocked')
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('leaves a queued reservation pending when the driver runs before its turn settles', async () => {
    const test = await harness([textResponse('settled later')])
    let woken = false
    test.ctx.on('agent/prompt-submit', async (_agent, _content, source, _signal, next) => {
      if (source.kind === 'goal' && !woken) {
        woken = true
        // A concurrent driver pass must observe the still-unsettled attempt
        // and yield rather than double-book or clear the reservation.
        agentEvents(test.ctx, test.agent).emit('agent/status', 'idle')
        await new Promise<void>((resolve) => { setImmediate(resolve) })
      }
      return next()
    })
    test.ctx.goals.create(test.agent, { objective: 'wake early', maxGoalRounds: 1 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    expect(goal?.blockedReason?.code).toBe('round-limit')
    expect(goal?.roundsStarted).toBe(1)
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('yields to a round whose turn/end never committed instead of misreading it as settled', async () => {
    const test = await harness([textResponse('round ran')])
    // A persistent pre-commit turn/end rejection: the loop contains the close
    // failure and reaches idle, but the round's attempt holds a turn with no
    // terminal reason. The idle drive pass must yield to that unsettled
    // attempt rather than classify an absent reason or crash into disarm.
    test.ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const event = args[1] as { type: string }
      if (event.type === 'turn/end') throw new Error('turn close permanently rejected')
    })
    test.ctx.goals.create(test.agent, { objective: 'survive a lost turn end' })
    await waitForRequests(test.adapter, 1)
    await test.agent.whenIdle()
    await new Promise((resolve) => { setImmediate(resolve) })

    // One request ran; the unsettled attempt parked the driver without a
    // second reservation and without disarming the goal.
    expect(test.adapter.requests).toHaveLength(1)
    expect(test.ctx.goals.get(test.agent)).toMatchObject({
      phase: 'active',
      activation: 'armed',
    })
  })

  it('disarms instead of continuing when a plugin reports a post-turn persistence failure', async () => {
    const test = await harness([textResponse('round one')])
    test.ctx.on('session/event', (session, event) => {
      if (session === test.agent.session && event.type === 'turn/end') {
        agentEvents(test.ctx, test.agent).emit('agent/error', event.data.turn, 1, new Error('post-turn flush failed'))
      }
    })
    test.ctx.goals.create(test.agent, { objective: 'stop when durability is lost', maxGoalRounds: 8 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.activation === 'disarmed')
    await test.agent.whenIdle()

    expect(goal).toMatchObject({ phase: 'active', roundsStarted: 1 })
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('ignores a post-turn failure reported for a retired agent', async () => {
    const test = await harness([textResponse('ordinary work')])
    const handle = await test.ctx.agents.create({
      sessionId: SessionId('goal-session-retired'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup({ content: [{ type: 'text', text: 'one ordinary turn' }], source: { kind: 'user' } })
    await handle.agent.whenIdle()
    const closed = handle.agent.session.events.findLast(event => event.type === 'turn/end')
    if (closed?.type !== 'turn/end') throw new Error('expected a closed turn')
    await handle.dispose()
    const warn = vi.spyOn(test.ctx.logger, 'warn')

    agentEvents(test.ctx, handle.agent).emit('agent/error', closed.data.turn, 1, new Error('late flush failure'))

    expect(test.ctx.agents.get(handle.agent.id)).toBeUndefined()
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('goal-session'))
  })

  it('ignores the failed outcome of a round made stale by human work queued at turn start', async () => {
    const test = await harness([new Error('round one broke'), textResponse('human answer')])
    let queued = false
    test.ctx.on('session/event', (session, event) => {
      if (session !== test.agent.session || queued) return
      if (event.type === 'turn/start' && event.data.trigger.kind === 'message'
        && event.data.trigger.source.kind === 'goal') {
        queued = true
        test.agent.followup({ content: [{ type: 'text', text: 'human interleaved' }], source: { kind: 'user' } })
      }
    })
    test.ctx.goals.create(test.agent, { objective: 'survive a stale failure', maxGoalRounds: 1 })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'blocked')

    // The stale round's turn-error never blocks the goal; only the durable
    // round budget does, after the interleaved human turn ran.
    expect(goal?.blockedReason?.code).toBe('round-limit')
    expect(test.adapter.requests).toHaveLength(2)
    expect(requestText(test.adapter.requests[1]!)).toContain('human interleaved')
  })

  it('waits for work queued by a pause observer before considering the next round', async () => {
    const test = await harness(['hang', textResponse('inspection answer')])
    test.ctx.on('goal/changed', (agent, change) => {
      if (agent === test.agent && change.operation === 'pause') {
        agent.followup({ content: [{ type: 'text', text: 'inspect the pause' }], source: { kind: 'user' } })
      }
    })
    test.ctx.goals.create(test.agent, { objective: 'pause then inspect' })
    await waitForRequests(test.adapter, 1)

    test.agent.cancel({ kind: 'user' })
    await waitForRequests(test.adapter, 2)
    await test.agent.whenIdle()

    expect(test.ctx.goals.get(test.agent)).toMatchObject({
      phase: 'paused',
      roundsStarted: 1,
      activation: 'disarmed',
    })
    expect(requestText(test.adapter.requests[1]!)).toContain('inspect the pause')
  })

  it('does not re-block a goal the downstream veto already saw cancelled', async () => {
    const test = await harness([])
    let vetoed = false
    test.ctx.on('agent/prompt-submit', (agent, _content, source, _signal, next) => {
      if (source.kind === 'goal' && !vetoed) {
        vetoed = true
        agent.cancel({ kind: 'user' })
        return Promise.resolve<PromptDecision>({ kind: 'block', reason: 'cancelled by policy' })
      }
      return next()
    })
    test.ctx.goals.create(test.agent, { objective: 'veto after cancellation' })

    const goal = await waitForGoal(test.ctx, test.agent, current => current?.phase === 'paused')
    await test.agent.whenIdle()

    // Cancellation already cleared the reservation and paused the goal, so the
    // veto neither touches an absent attempt nor blocks the paused goal.
    expect(goal).toMatchObject({ roundsStarted: 0, activation: 'disarmed' })
    expect(goal?.blockedReason).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('awaits an unadmitted reservation stuck in admission during teardown without cancelling', async () => {
    const test = await harness([])
    let release: (() => void) | undefined
    test.ctx.on('agent/prompt-submit', async (_agent, _content, source, _signal, next) => {
      if (source.kind === 'goal' && release === undefined) {
        await new Promise<void>((resolve) => { release = resolve })
      }
      return next()
    })
    test.ctx.goals.create(test.agent, { objective: 'unload during admission' })
    await vi.waitFor(() => { expect(release).toBeDefined() })

    const disposal = Promise.resolve(test.driver.dispose())
    await waitForGoal(test.ctx, test.agent, goal => goal?.activation === 'disarmed')
    release?.()
    await disposal

    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'active', roundsStarted: 0 })
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.agent.session.events.some(event => event.type === 'turn/start')).toBe(false)
  })

  it('ignores session events without an exact owning agent and retires disposed agent state', async () => {
    const test = await harness([])
    const orphan = test.ctx.sessions.create(SessionId('goal-session-orphan'))
    orphan.append('turn/start', {
      turn: 1,
      trigger: { kind: 'injection', source: { kind: 'plugin', plugin: 'test' } },
    })
    orphan.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const handle = await test.ctx.agents.create({
      sessionId: SessionId('goal-session-disposed'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await handle.dispose()

    expect(test.ctx.agents.get(handle.agent.id)).toBeUndefined()
  })
})
