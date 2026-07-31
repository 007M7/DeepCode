/** Session-fork boundaries, lineage, and inherited model routing. */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`fork-${String(nextRpc++)}`), payload }
}

async function composed(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserInteractionService)
  ctx.provide('workspace', { list: () => [] } as never)
  ctx.agents.setFactory({
    createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const agent = {} as Agent
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, { id: session.id, session, status: 'idle', ctx: agentCtx })
      await options.setup?.(agentCtx)
      ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('fork test sources are live')),
  })
  return ctx
}

/** Tail turn appended after the completed ones: left open, or closed as aborted (a stopped turn). */
type Tail = 'none' | 'open' | 'aborted'

function liveAgent(ctx: Context, id: string, turns: number, tail: Tail = 'none'): Session {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
  for (let turn = 1; turn <= turns; turn++) {
    session.append('turn/start', { turn, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `prompt ${String(turn)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  if (tail !== 'none') {
    session.append('turn/start', { turn: turns + 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'open prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    if (tail === 'aborted') session.append('turn/end', { turn: turns + 1, reason: { kind: 'aborted' } })
  }
  ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return session
}

const api = (ctx: Context) => createApiProxy(ctx, {
  provider: 'default-provider',
  model: 'default-model',
  cwd: '/tmp',
  workspaceRoot: '/tmp',
})

describe('sessions.fork', () => {
  it('cuts at the anchored completed turn and records lineage and cwd', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-source', 2)
    const response = await api(ctx).sessions.fork(request({ sessionId: source.id, atSeq: 1 }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) return
    const child = ctx.sessions.get(response.result.value.sessionId)
    expect(child?.events.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'turn/end', 'session/end-seed',
    ])
    expect(child?.header.parentSession).toBe(source.id)
    expect(child?.header.cwd).toBe('/proj')
    await ctx.fiber.dispose()
  })

  it('uses the last completed turn only for omitted and past-end anchors', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-tail', 2, 'open')
    const proxy = api(ctx)
    const expectedTypes = [
      'turn/start', 'user/message', 'turn/end',
      'turn/start', 'user/message', 'turn/end',
      'session/end-seed',
    ]
    const omitted = await proxy.sessions.fork(request({ sessionId: source.id }))
    expect(omitted.result.ok).toBe(true)
    if (omitted.result.ok) {
      expect(ctx.sessions.get(omitted.result.value.sessionId)?.events.map(event => event.type))
        .toEqual(expectedTypes)
    }
    const pastEnd = await proxy.sessions.fork(request({ sessionId: source.id, atSeq: 999 }))
    expect(pastEnd.result.ok).toBe(true)
    if (pastEnd.result.ok) {
      expect(ctx.sessions.get(pastEnd.result.value.sessionId)?.events.map(event => event.type))
        .toEqual(expectedTypes)
    }
    await ctx.fiber.dispose()
  })

  it('cuts through an aborted turn: stopped is closed, not open', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-aborted', 1, 'aborted')
    // What a stopped message's fork button anchors on: the frozen node sits
    // one event before its turn/end, floored client-side to that event's seq.
    const anchor = (source.events.at(-1)?.seq ?? 0) - 1
    const response = await api(ctx).sessions.fork(request({ sessionId: source.id, atSeq: anchor }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) return
    expect(ctx.sessions.get(response.result.value.sessionId)?.events.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'turn/end',
      'turn/start', 'user/message', 'turn/end',
      'session/end-seed',
    ])
    await ctx.fiber.dispose()
  })

  it('rejects an in-log anchor whose turn is still open', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-open', 1, 'open')
    const anchor = source.events.at(-1)?.seq ?? 0
    const response = await api(ctx).sessions.fork(request({ sessionId: source.id, atSeq: anchor }))
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'fork-unavailable', details: { sessionId: source.id } },
    })
    if (!response.result.ok) expect(response.result.error.message).toMatch(/has not completed/)
    await ctx.fiber.dispose()
  })

  it('installs the latest logged model target before the child can run', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-routed', 1)
    source.append('request/header', {
      header: {
        config: {
          provider: 'inherited-provider',
          model: 'inherited-model',
          reasoningEffort: ReasoningEffortId('high'),
        },
      },
      reason: 'initial',
    })
    const response = await api(ctx).sessions.fork(request({ sessionId: source.id }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) return
    const child = ctx.agents.get(response.result.value.sessionId)
    if (child === undefined) throw new Error('fork did not publish the child agent')
    const assembly = await child.ctx.systemPrompt.assemble()
    expect(assembly.variables).toMatchObject({
      provider: 'inherited-provider',
      model: 'inherited-model',
    })
    const fallback: LlmCallConfig = { provider: 'default-provider', model: 'default-model' }
    await expect(agentEvents(child.ctx, child).waterfall(
      'agent/request', 1, 0, new AbortController().signal, () => Promise.resolve(fallback),
    )).resolves.toMatchObject({
      provider: 'inherited-provider',
      model: 'inherited-model',
      reasoningEffort: 'high',
    })
    await ctx.fiber.dispose()
  })
})
