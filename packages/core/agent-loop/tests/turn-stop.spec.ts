import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent, type ContinuationStop } from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantService)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await mountInvariants(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function send(agent: Agent, text = 'go'): Promise<void> {
  agent.send([{ type: 'text', text }])
  return agent.whenIdle()
}

function registerEcho(ctx: Context): void {
  ctx.tools.register(defineContentToolFixture({
    name: 'echo',
    description: 'echo',
    parameters: { text: { type: 'string' } },
    async execute(args) {
      return [{ type: 'text', text: String(args.text) }]
    },
  }))
}

describe('agent/turn-stop', () => {
  it('runs after steering folding and discards terminal steering instead of creating another step or turn', async () => {
    const adapter = new MockAdapter([
      textResponse('the ordinary decision is stop'),
      textResponse('must not be requested'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('terminal-steering'), { provider: 'mock', model: 'mock' })
    agent.ctx.on('agent/turn-stop', (): ContinuationStop => ({ action: 'stop' }))

    let steered = false
    ctx.on('agent/turn-continuation', async (subject, _turn, _default, _signal, next) => {
      const downstream = await next()
      if (subject === agent && !steered) {
        steered = true
        subject.steer([{ type: 'text', text: 'late continuation steering' }])
      }
      return downstream
    }, { prepend: true })

    await send(agent)

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'steering/message')).toHaveLength(0)
  })

  it('discards steering that arrives from session/flush after the terminal checkpoint', async () => {
    const adapter = new MockAdapter([
      textResponse('terminal answer'),
      textResponse('must not become a late-steering turn'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('terminal-flush-steering'), { provider: 'mock', model: 'mock' })
    agent.ctx.on('agent/turn-stop', (): ContinuationStop => ({ action: 'stop' }))

    let injected = false
    ctx.on('session/flush', (session) => {
      if (session !== agent.session || injected) return
      injected = true
      agent.steer([{ type: 'text', text: 'steering from flush' }])
    })

    await send(agent)

    expect(injected).toBe(true)
    expect(agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'steering/message')).toHaveLength(0)
  })

  it('preserves an ordinary queued send that arrives during terminal flush', async () => {
    const adapter = new MockAdapter([
      textResponse('first terminal answer'),
      textResponse('queued follow-up answer'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('terminal-flush-send'), { provider: 'mock', model: 'mock' })
    agent.ctx.on('agent/turn-stop', (): ContinuationStop => ({ action: 'stop' }))

    let queued = false
    ctx.on('session/flush', (session) => {
      if (session !== agent.session || queued) return
      queued = true
      agent.send([{ type: 'text', text: 'ordinary queued follow-up' }])
    })

    await send(agent)

    expect(agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(agent.session.events.filter(event => event.type === 'step/start')).toHaveLength(2)
  })

  it('filters a scoped terminal listener to its own agent', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('a1', 'echo', { text: 'a' }),
      toolCallResponse('b1', 'echo', { text: 'b' }),
      textResponse('b continues normally'),
    ])
    const ctx = await harness(adapter)
    registerEcho(ctx)
    const stopped = ctx.agentLoop.create(SessionId('stopped'), { provider: 'mock', model: 'mock' })
    const ordinary = ctx.agentLoop.create(SessionId('ordinary'), { provider: 'mock', model: 'mock' })
    stopped.ctx.on('agent/turn-stop', (): ContinuationStop => ({ action: 'stop' }))

    await send(stopped)
    expect(adapter.requests).toHaveLength(1)
    await send(ordinary)

    expect(adapter.requests).toHaveLength(3)
    expect(stopped.session.events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(ordinary.session.events.filter(event => event.type === 'step/start')).toHaveLength(2)
  })

  it('unregisters with its scoped owner disposer', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('first', 'echo', { text: 'first' }),
      toolCallResponse('second', 'echo', { text: 'second' }),
      textResponse('continued after listener disposal'),
    ])
    const ctx = await harness(adapter)
    registerEcho(ctx)
    const agent = ctx.agentLoop.create(SessionId('owned-listener'), { provider: 'mock', model: 'mock' })
    const disposeStop = agent.ctx.on('agent/turn-stop', (): ContinuationStop => ({ action: 'stop' }))

    await send(agent, 'first turn')
    expect(adapter.requests).toHaveLength(1)

    disposeStop()
    await send(agent, 'second turn')
    expect(adapter.requests).toHaveLength(3)
  })

  it('fails a throwing terminal policy closed while the driver survives', async () => {
    const adapter = new MockAdapter([
      textResponse('throwing policy'),
      textResponse('healthy later turn'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('bad-policy'), { provider: 'mock', model: 'mock' })
    const reasons: TurnEndReason[] = []
    const errors: string[] = []
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'turn/end') reasons.push(event.data.reason)
    })
    agent.ctx.on('agent/error', (_subject, _turn, _step, error) => { errors.push(error.message) })

    const disposeThrowing = agent.ctx.on('agent/turn-stop', () => {
      throw new Error('terminal policy exploded')
    })
    await send(agent, 'first')
    disposeThrowing()

    await send(agent, 'healthy')

    expect(reasons.map(reason => reason.kind)).toEqual(['error', 'completed'])
    expect(errors).toContain('terminal policy exploded')
    expect(adapter.requests).toHaveLength(2)
  })
})
