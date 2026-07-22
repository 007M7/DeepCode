/**
 * Host-side slash-command dispatch in sessions.prompt: a leading-/
 * single-text-block prompt executes through the command registry and never
 * reaches the model — symmetric with the ACP adapter. Successful commands
 * return ok with the command slot; usage errors and unknown names return RPC
 * errors so the client restores the composer's draft. Non-command prompts
 * still route to agent.send/steer.
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
