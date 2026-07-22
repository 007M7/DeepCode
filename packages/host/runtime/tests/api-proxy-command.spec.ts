/**
 * Host-side slash-command dispatch in sessions.prompt: a leading-/
 * single-text-block prompt executes through the command registry and never
 * reaches the model — symmetric with the ACP adapter. Successful commands
 * return ok with the command slot; usage errors and unknown names return RPC
 * errors so the client restores the composer's draft. Non-command prompts
 * still route to agent.send/steer.
 *
 * The second suite covers the goals RPC surface over the same live harness:
 * get/create/edit/pause/resume/complete/clear project the goal service onto
 * the wire, service rejections (stale ref, duplicate create) become internal
 * RPC errors, and an unservable session id is an RPC error on every method.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, InjectOptions } from '@deepseek-ai/dsh-agent'
import CommandService from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import * as commandGoal from '@deepseek-ai/dsh-command-goal'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ApiProxy, GoalView } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  /** Content arguments of every agent.send/steer call, in order. */
  readonly sent: ContentBlock[][]
  readonly steered: ContentBlock[][]
}

/** Number the next balanced injection turn. */
function nextTurn(session: Session): number {
  return session.events.reduce(
    (maximum, event) => event.type === 'turn/start' ? Math.max(maximum, event.data.turn) : maximum,
    0,
  ) + 1
}

/** Build a live idle agent whose send/steer calls are recorded. */
function stubAgent(id: string): { agent: Agent; session: Session; sent: ContentBlock[][]; steered: ContentBlock[][] } {
  const session = new Session(SessionId(id))
  const sent: ContentBlock[][] = []
  const steered: ContentBlock[][] = []
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    ctx: new Context(),
    get status() { return status },
    send(content) { sent.push(content) },
    steer(content) { steered.push(content) },
    inject(content: ContentBlock[], options?: InjectOptions) {
      const source: MessageSource = options?.source ?? { kind: 'user' }
      const turn = nextTurn(session)
      session.append('turn/start', { turn, trigger: { kind: 'injection', source } })
      session.append('context/message', {
        content,
        source,
        ...options?.meta === undefined ? {} : { meta: options.meta },
      }, { surfaceOp: 'append' })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    },
    cancel() { status = 'idle' },
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session, sent, steered }
}

/** Mount the real command registry, goal domain, and /goal producer. */
async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(CommandService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  await ctx.plugin(commandGoal)
  const { agent, session, sent, steered } = stubAgent(`api-proxy-command-${Math.random()}`)
  ctx.agents.register(agent)
  return { ctx, agent, session, sent, steered }
}

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`command-${String(nextRpc++)}`), payload }
}

function promptPayload(test: Harness, text: string, mode: 'queue' | 'steer' = 'queue') {
  const content: ContentBlock[] = [{ type: 'text', text }]
  return request({ sessionId: test.session.id, mode, content })
}

describe('sessions.prompt slash-command dispatch', () => {
  it('executes /goal <objective>: goal created, command slot carried, no model turn', async () => {
    const test = await harness()
    const api = createApiProxy(test.ctx, { provider: 'p', model: 'm', cwd: '/tmp' })

    const response = await api.sessions.prompt(promptPayload(test, '/goal fix the flaky test'))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.accepted).toBe(true)
    expect(response.result.value.command?.kind).toBe('success')
    expect(response.result.value.command?.text).toContain('Goal created')

    const goal = test.ctx.goals.get(test.agent)
    expect(goal?.objective).toBe('fix the flaky test')
    // The prompt never reached the model: no send, no user/message event.
    expect(test.sent).toEqual([])
    expect(test.steered).toEqual([])
    expect(test.session.events.filter(event => event.type === 'user/message')).toEqual([])
  })

  it('dispatches commands regardless of mode (steer prompt never steers)', async () => {
    const test = await harness()
    const api = createApiProxy(test.ctx, { provider: 'p', model: 'm', cwd: '/tmp' })

    const response = await api.sessions.prompt(promptPayload(test, '/goal', 'steer'))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.command?.text).toContain('No goal is currently set')
    expect(test.sent).toEqual([])
    expect(test.steered).toEqual([])
  })

  it('returns unknown-command for an unregistered name', async () => {
    const test = await harness()
    const api = createApiProxy(test.ctx, { provider: 'p', model: 'm', cwd: '/tmp' })

    const response = await api.sessions.prompt(promptPayload(test, '/bogus do something'))
    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('unknown-command')
    expect(response.result.error.message).toBe('unknown command: /bogus')
    expect(test.sent).toEqual([])

    const bare = await api.sessions.prompt(promptPayload(test, '/bogus'))
    expect(bare.result.ok).toBe(false)
    if (!bare.result.ok) expect(bare.result.error.message).toBe('unknown command: /bogus')
  })

  it('carries a success without text when the command produced none', async () => {
    const test = await harness()
    const api = createApiProxy(test.ctx, { provider: 'p', model: 'm', cwd: '/tmp' })
    test.ctx.commands.register({ name: 'ping', description: 'test no-text success', handler: () => ({ kind: 'success' }) })

    const response = await api.sessions.prompt(promptPayload(test, '/ping'))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.command).toEqual({ kind: 'success' })
    expect(test.sent).toEqual([])
  })

  it('returns command-error for a usage error (bare /goal edit)', async () => {
    const test = await harness()
    const api = createApiProxy(test.ctx, { provider: 'p', model: 'm', cwd: '/tmp' })

    const response = await api.sessions.prompt(promptPayload(test, '/goal edit'))
    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('command-error')
    expect(response.result.error.message).toContain('Goal editing requires a replacement objective')
    expect(test.sent).toEqual([])
  })

  it('routes a non-command prompt to agent.send unchanged', async () => {
    const test = await harness()
    const api = createApiProxy(test.ctx, { provider: 'p', model: 'm', cwd: '/tmp' })

    const response = await api.sessions.prompt(promptPayload(test, 'hello there'))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.accepted).toBe(true)
    expect('command' in response.result.value).toBe(false)
    expect(test.sent).toEqual([[{ type: 'text', text: 'hello there' }]])
  })

  it('routes multi-block content starting with / to the model (never flattened)', async () => {
    const test = await harness()
    const api = createApiProxy(test.ctx, { provider: 'p', model: 'm', cwd: '/tmp' })

    const content: ContentBlock[] = [{ type: 'text', text: '/goal not a command' }, { type: 'text', text: 'second' }]
    const response = await api.sessions.prompt(request({ sessionId: test.session.id, mode: 'queue' as const, content }))
    expect(response.result.ok).toBe(true)
    expect(test.sent).toEqual([content])
  })

  it('routes degenerate content shapes to the model (empty array, single non-text block)', async () => {
    const test = await harness()
    const api = createApiProxy(test.ctx, { provider: 'p', model: 'm', cwd: '/tmp' })

    const empty: ContentBlock[] = []
    await api.sessions.prompt(request({ sessionId: test.session.id, mode: 'queue' as const, content: empty }))
    const nonText: ContentBlock[] = [{ type: 'reasoning', text: '/goal not a command' }]
    await api.sessions.prompt(request({ sessionId: test.session.id, mode: 'queue' as const, content: nonText }))
    expect(test.sent).toEqual([empty, nonText])
  })
})

describe('goals RPC surface', () => {
  /** Unwrap an ok goal value or fail the test. */
  function goalOf(response: Awaited<ReturnType<ApiProxy['goals']['get']>>): GoalView {
    if (!response.result.ok) throw new Error(`expected ok, got ${response.result.error.message}`)
    if (response.result.value.goal === null) throw new Error('expected a current goal')
    return response.result.value.goal
  }

  it('get returns null when no goal is set', async () => {
    const test = await harness()
    const api = createApiProxy(test.ctx, { provider: 'p', model: 'm', cwd: '/tmp' })

    const response = await api.goals.get(request({ sessionId: test.session.id }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.goal).toBeNull()
  })

  it('create arms a goal, defaulting and honoring the round cap; a duplicate create is an internal error', async () => {
    const test = await harness()
    const api = createApiProxy(test.ctx, { provider: 'p', model: 'm', cwd: '/tmp' })

    const created = goalOf(await api.goals.create(request({ sessionId: test.session.id, objective: 'first' })))
    expect(created.phase).toBe('active')
    expect(created.activation).toBe('armed')
    expect(created.maxGoalRounds).toBe(256) // service default

    const duplicate = await api.goals.create(request({ sessionId: test.session.id, objective: 'second' }))
    expect(duplicate.result.ok).toBe(false)
    if (duplicate.result.ok) throw new Error('unreachable')
    expect(duplicate.result.error.code).toBe('internal')
    expect(duplicate.result.error.message).toContain('already exists')

    const cleared = await api.goals.clear(request({ sessionId: test.session.id, ref: created }))
    expect(cleared.result.ok).toBe(true)

    const capped = goalOf(await api.goals.create(request({ sessionId: test.session.id, objective: 'capped', maxGoalRounds: 4 })))
    expect(capped.maxGoalRounds).toBe(4)
  })

  it('get projects the live goal, including the durable blocked reason', async () => {
    const test = await harness()
    const api = createApiProxy(test.ctx, { provider: 'p', model: 'm', cwd: '/tmp' })
    const created = goalOf(await api.goals.create(request({ sessionId: test.session.id, objective: 'block me' })))

    const before = goalOf(await api.goals.get(request({ sessionId: test.session.id })))
    expect(before.objective).toBe('block me')
    expect('blockedReason' in before).toBe(false)

    test.ctx.goals.block(test.agent, created, { code: 'stalled', message: 'no progress' })
    const after = goalOf(await api.goals.get(request({ sessionId: test.session.id })))
    expect(after.phase).toBe('blocked')
    expect(after.blockedReason).toEqual({ code: 'stalled', message: 'no progress' })
  })

  it('edit replaces the objective and/or the round cap, one field at a time', async () => {
    const test = await harness()
    const api = createApiProxy(test.ctx, { provider: 'p', model: 'm', cwd: '/tmp' })
    const created = goalOf(await api.goals.create(request({ sessionId: test.session.id, objective: 'v1', maxGoalRounds: 4 })))

    const renamed = goalOf(await api.goals.edit(request({ sessionId: test.session.id, ref: created, objective: 'v2' })))
    expect(renamed.objective).toBe('v2')
    expect(renamed.maxGoalRounds).toBe(4)
    expect(renamed.revision).toBe(created.revision + 1)

    const recapped = goalOf(await api.goals.edit(request({ sessionId: test.session.id, ref: renamed, maxGoalRounds: 8 })))
    expect(recapped.objective).toBe('v2')
    expect(recapped.maxGoalRounds).toBe(8)
  })

  it('pause, resume, complete, and clear drive the phase machine over the wire', async () => {
    const test = await harness()
    const api = createApiProxy(test.ctx, { provider: 'p', model: 'm', cwd: '/tmp' })
    const created = goalOf(await api.goals.create(request({ sessionId: test.session.id, objective: 'lifecycle' })))

    const paused = goalOf(await api.goals.pause(request({ sessionId: test.session.id, ref: created })))
    expect([paused.phase, paused.activation]).toEqual(['paused', 'disarmed'])

    const resumed = goalOf(await api.goals.resume(request({ sessionId: test.session.id, ref: paused })))
    expect([resumed.phase, resumed.activation]).toEqual(['active', 'armed'])

    const completed = goalOf(await api.goals.complete(request({ sessionId: test.session.id, ref: resumed })))
    expect([completed.phase, completed.activation]).toEqual(['complete', 'disarmed'])

    const cleared = await api.goals.clear(request({ sessionId: test.session.id, ref: completed }))
    expect(cleared.result.ok).toBe(true)
    if (!cleared.result.ok) throw new Error('unreachable')
    expect(cleared.result.value.cleared).toBe(true)
    expect(goalOfNull(await api.goals.get(request({ sessionId: test.session.id })))).toBeNull()
  })

  /** Unwrap a get value (goal or null) or fail the test. */
  function goalOfNull(response: Awaited<ReturnType<ApiProxy['goals']['get']>>): GoalView | null {
    if (!response.result.ok) throw new Error('unreachable')
    return response.result.value.goal
  }

  it('a stale ref surfaces as an internal RPC error on every mutating method', async () => {
    const test = await harness()
    const api = createApiProxy(test.ctx, { provider: 'p', model: 'm', cwd: '/tmp' })
    const created = goalOf(await api.goals.create(request({ sessionId: test.session.id, objective: 'cas' })))
    const stale = { id: created.id, revision: created.revision + 99 }

    const attempts = [
      () => api.goals.edit(request({ sessionId: test.session.id, ref: stale, objective: 'nope' })),
      () => api.goals.pause(request({ sessionId: test.session.id, ref: stale })),
      () => api.goals.resume(request({ sessionId: test.session.id, ref: stale })),
      () => api.goals.complete(request({ sessionId: test.session.id, ref: stale })),
      () => api.goals.clear(request({ sessionId: test.session.id, ref: stale })),
    ]
    for (const attempt of attempts) {
      const response = await attempt()
      expect(response.result.ok).toBe(false)
      if (!response.result.ok) expect(response.result.error.code).toBe('internal')
    }
    // None of the failed mutations touched the goal.
    const current = goalOfNull(await api.goals.get(request({ sessionId: test.session.id })))
    expect([current?.objective, current?.revision]).toEqual(['cas', created.revision])
  })

  it('an unservable session id is an RPC error on every goal method', async () => {
    const test = await harness()
    const api = createApiProxy(test.ctx, { provider: 'p', model: 'm', cwd: '/tmp' })
    const missing = SessionId('no-such-session')
    const ref = { id: 'goal-x' as GoalView['id'], revision: 1 }

    const attempts = [
      () => api.goals.get(request({ sessionId: missing })),
      () => api.goals.create(request({ sessionId: missing, objective: 'x' })),
      () => api.goals.edit(request({ sessionId: missing, ref, objective: 'x' })),
      () => api.goals.pause(request({ sessionId: missing, ref })),
      () => api.goals.resume(request({ sessionId: missing, ref })),
      () => api.goals.complete(request({ sessionId: missing, ref })),
      () => api.goals.clear(request({ sessionId: missing, ref })),
    ]
    for (const attempt of attempts) {
      const response = await attempt()
      expect(response.result.ok).toBe(false)
    }
  })
})
