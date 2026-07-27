import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import AgentRegistry, { AgentMessageId } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandService from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import type { GoalRef } from '@deepseek-ai/dsh-goal'
import { Session, SessionId, type UserMessageData } from '@deepseek-ai/dsh-session'
import * as commandGoal from '@deepseek-ai/dsh-command-goal'

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

/** Append one idle injection using the public Agent contract. */
function appendInjection(session: Session, input: UserMessageData): void {
  session.append('user/message', input, { surfaceOp: 'append' })
}

/** Build a live idle agent accepted by the exact-identity goal service. */
function stubAgent(id: string): { agent: Agent; session: Session } {
  const session = new Session(SessionId(id))
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    ctx: new Context(),
    get status() { return status },
    get acceptsNextStep() { return status === 'running' },
    send: () => AgentMessageId('stub'),
    followup: () => AgentMessageId('stub'),
    steer: () => AgentMessageId('stub'),
    inject(input) { appendInjection(session, input); return AgentMessageId('stub') },
    cancel() { status = 'idle' },
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

/** Mount the real command registry, goal domain, and producer. */
async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(CommandService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  const plugin = await ctx.plugin(commandGoal)
  const { agent, session } = stubAgent(`command-goal-${Math.random()}`)
  ctx.agents.register(agent)
  return { ctx, agent, session, plugin }
}

/** Execute `/goal` through the same registry boundary as a UI adapter. */
async function run(test: Harness, suffix = ''): Promise<NonNullable<Awaited<ReturnType<CommandService['execute']>>>> {
  const result = await test.ctx.commands.execute(
    test.agent,
    `/goal${suffix}`,
    new AbortController().signal,
  )
  if (result === undefined) throw new Error('goal command was not registered')
  return result
}

/** Current exact compare-and-set ref. */
function ref(goal: NonNullable<ReturnType<GoalService['get']>>): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

describe('@deepseek-ai/dsh-command-goal registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    const test = await harness()
    expect(commandGoal.name).toBe('command-goal')
    expect(commandGoal.inject).toEqual(['commands', 'goals'])
    expect('default' in commandGoal).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandGoal)).toBe(commandGoal)

    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'goal',
      description: 'set or view the goal for a long-running task',
      input: { hint: '[<objective>|clear|edit <objective>|pause|resume]' },
    })
    expect(test.ctx.commands.find(test.agent, 'goal')).toBeDefined()

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'goal')).toBeUndefined()
  })
})

describe('/goal human command', () => {
  it('shows an empty status without mutating the session', async () => {
    const test = await harness()
    await expect(run(test)).resolves.toEqual({
      kind: 'success',
      text: 'No goal is currently set.\nUsage: /goal [<objective>|clear|edit <objective>|pause|resume]',
    })
    expect(test.session.events).toEqual([])
  })

  it('creates a trimmed objective and refuses silent replacement of unfinished work', async () => {
    const test = await harness()
    const created = await run(test, '\n  finish the release  ')
    expect(created.kind).toBe('success')
    expect(created.text).toContain('Goal created\nStatus: active')
    expect(created.text).toContain('Objective: finish the release')
    expect(created.text).toContain('Rounds: 0/256')
    expect(created.text).toContain('Activation: armed')
    expect(test.ctx.goals.get(test.agent)?.objective).toBe('finish the release')
    expect(test.session.events.map(event => event.type)).toEqual(['user/message'])

    const count = test.session.events.length
    await expect(run(test, ' replacement')).resolves.toEqual({
      kind: 'error',
      text: 'A goal is already active. Use /goal edit <objective> to change it or /goal clear before replacing it.',
    })
    expect(test.session.events).toHaveLength(count)
  })

  it('treats only exact control words as controls', async () => {
    const test = await harness()
    await run(test, ' pause everything only after verification')
    expect(test.ctx.goals.get(test.agent)?.objective).toBe('pause everything only after verification')
  })

  it('edits inline, requires an objective, and starts a new goal when the old one is complete', async () => {
    const empty = await harness()
    const invalidEdit = await run(empty, ' edit')
    expect(invalidEdit.kind).toBe('error')
    expect(invalidEdit.text).toContain('requires a replacement objective')
    const missingEdit = await run(empty, ' edit replacement')
    expect(missingEdit.kind).toBe('error')
    expect(missingEdit.text).toContain('/goal edit requires one')

    const test = await harness()
    await run(test, ' first')
    const first = test.ctx.goals.get(test.agent)!
    const updated = await run(test, ' EDIT\n  second  ')
    expect(updated.kind).toBe('success')
    expect(updated.text).toContain('Goal updated')
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ id: first.id, objective: 'second', revision: 2 })

    const current = test.ctx.goals.get(test.agent)!
    test.ctx.goals.complete(test.agent, ref(current))
    const replacement = await run(test, ' edit third')
    expect(replacement.kind).toBe('success')
    expect(replacement.text).toContain('Goal created')
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ objective: 'third', revision: 1 })
    expect(test.ctx.goals.get(test.agent)?.id).not.toBe(first.id)
  })

  it('returns direct missing-state results for pause, resume, and clear', async () => {
    const test = await harness()
    const missingPause = await run(test, ' pause')
    expect(missingPause.kind).toBe('error')
    expect(missingPause.text).toContain('/goal pause requires one')
    const missingResume = await run(test, ' resume')
    expect(missingResume.kind).toBe('error')
    expect(missingResume.text).toContain('/goal resume requires one')
    await expect(run(test, ' clear')).resolves.toEqual({ kind: 'success', text: 'No goal to clear.' })
  })

  it('pauses, resumes, clears, and converts expected domain rejections to command errors', async () => {
    const test = await harness()
    await run(test, ' work')
    const redundantResume = await run(test, ' RESUME')
    expect(redundantResume).toEqual({
      kind: 'error',
      text: 'The goal command is not valid for the current state. Run /goal to view available commands.',
    })
    const paused = await run(test, ' PAUSE')
    expect(paused.kind).toBe('success')
    expect(paused.text).toContain('Goal paused')
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    const resumed = await run(test, ' resume')
    expect(resumed.kind).toBe('success')
    expect(resumed.text).toContain('Goal resumed')
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'active', activation: 'armed' })
    await expect(run(test, ' clear')).resolves.toEqual({ kind: 'success', text: 'Goal cleared.' })
    expect(test.ctx.goals.get(test.agent)).toBeUndefined()
  })

  it('shows every durable phase and distinguishes disarmed active state', async () => {
    const test = await harness()
    test.ctx.goals.create(test.agent, { objective: 'state matrix', maxGoalRounds: 1 })
    test.ctx.goals.disarm(test.agent)
    expect((await run(test)).text)
      .toContain('Status: active\nObjective: state matrix\nRounds: 0/1\nActivation: disarmed')
    expect((await run(test)).text).toContain('/goal resume')

    let goal = test.ctx.goals.get(test.agent)!
    goal = test.ctx.goals.resume(test.agent, ref(goal))
    goal = test.ctx.goals.pause(test.agent, ref(goal))
    expect((await run(test)).text).toContain('Status: paused')

    goal = test.ctx.goals.resume(test.agent, ref(goal))
    goal = test.ctx.goals.block(test.agent, ref(goal), {
      code: 'upstream-unavailable',
      message: 'Provider unavailable',
    })
    const blocked = await run(test)
    expect(blocked.text).toContain('Status: blocked')
    expect(blocked.text).toContain('Blocker: upstream-unavailable: Provider unavailable')

    goal = test.ctx.goals.resume(test.agent, ref(goal))
    test.ctx.goals.complete(test.agent, ref(goal))
    const complete = await run(test)
    expect(complete.text).toContain('Status: complete')
    expect(complete.text).toContain('Commands: /goal <objective>, /goal clear')
  })

  it('does not turn unexpected implementation failures into expected command results', async () => {
    const test = await harness()
    vi.spyOn(test.ctx.goals, 'get').mockImplementationOnce(() => { throw new Error('unexpected failure') })
    await expect(run(test)).rejects.toThrow('unexpected failure')
  })
})
