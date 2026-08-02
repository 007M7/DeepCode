import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

describe('Agent', () => {
  it('does not echo caller-owned message identities from delivery methods', async () => {
    const adapter = new MockAdapter([
      textResponse('one'),
      textResponse('two'),
      textResponse('three'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const message = (text: string) => createUserMessage({
      content: [{ type: 'text' as const, text }],
      source: { kind: 'user' as const },
    })
    const call = (method: 'send' | 'inject' | 'followup' | 'steer', args: unknown[]): unknown => {
      const implementation: unknown = Reflect.get(agent, method)
      if (typeof implementation !== 'function') throw new Error(`missing Agent.${method}`)
      return Reflect.apply(implementation, agent, args)
    }

    expect(call('send', [message('quiet'), {
      target: 'next-turn',
      wakeup: false,
    }])).toBeUndefined()
    expect(call('inject', [message('context')])).toBeUndefined()
    expect(call('followup', [message('followup')])).toBeUndefined()
    const receipt = agent.steer(message('steering'))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(3)
    expect(await receipt.outcome).toEqual({ status: 'admitted', turn: 3, step: 1 })
  })

  it('idle inject() appends context without opening a turn or requesting a flush', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    let flushes = 0
    ctx.on('session/flush', () => { flushes += 1 })

    agent.inject(createUserMessage({ content: [{ type: 'text', text: 'context' }], source: { kind: 'plugin', plugin: 'p' } }))

    expect(agent.session.events.map(event => event.type)).toEqual(['user/message'])
    expect(agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(0)
    await agent.whenIdle()
    expect(flushes).toBe(0)
  })

  it('inject() preserves an explicitly empty plugin source', async () => {
    const ctx = await harness(new MockAdapter([textResponse('ok')]))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.inject(createUserMessage({ content: [{ type: 'text', text: 'empty plugin source' }], source: { kind: 'plugin', plugin: '' } }))

    const injected = agent.session.events.at(-1)
    expect(injected?.type === 'user/message' && injected.data.source)
      .toEqual({ kind: 'plugin', plugin: '' })
  })

  it('idle inject() rejects invalid input before append', async () => {
    const ctx = await harness(new MockAdapter([textResponse('ok')]))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    expect(() => {
      agent.inject(createUserMessage({ content: [{ type: 'text', text: 'x', bad: 1n } as never], source: { kind: 'plugin', plugin: 'p' } }))
    }).toThrow(/non-JSON-serializable/)
    expect(agent.session.events).toHaveLength(0)
  })

  it('steer() while idle becomes a woken prompt turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.steer(createUserMessage({ content: [{ type: 'text', text: 'steer idle' }], source: { kind: 'plugin', plugin: 'test' } }))
    await agent.whenIdle()

    expect(agent.session.events.some(event => event.type === 'user/message')).toBe(true)
    expect(adapter.requests).toHaveLength(1)
  })

  it('emits one running and idle transition for one completed turn', async () => {
    const ctx = await harness(new MockAdapter([textResponse('ok')]))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const statuses: string[] = []
    ctx.on('agent/status', (subject, status) => {
      if (subject === agent) statuses.push(status)
    })

    send(agent, 'hi')
    await agent.whenIdle()

    expect(statuses).toEqual(['running', 'idle'])
  })

  it('awaits the turn-end checkpoint before claiming the next queued turn', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const firstFlush = Promise.withResolvers<undefined>()
    const flushedTurns: number[] = []
    ctx.on('session/flush', async (session) => {
      const turnEnd = session.events.findLast(event => event.type === 'turn/end')
      flushedTurns.push(turnEnd?.data.turn ?? 0)
      if (turnEnd?.data.turn === 1) await firstFlush.promise
    })

    send(agent, 'first')
    send(agent, 'second')

    await vi.waitFor(() => { expect(flushedTurns).toEqual([1]) })
    expect(adapter.requests).toHaveLength(1)
    firstFlush.resolve(undefined)
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(flushedTurns).toEqual([1, 2])
  })

  it('keeps whenIdle pending through the final turn checkpoint', async () => {
    const ctx = await harness(new MockAdapter([textResponse('done')]))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const flush = Promise.withResolvers<undefined>()
    let flushStarted = false
    ctx.on('session/flush', () => {
      flushStarted = true
      return flush.promise
    })

    send(agent, 'go')
    await vi.waitFor(() => { expect(flushStarted).toBe(true) })
    let idleSettled = false
    const idle = agent.whenIdle().then(() => { idleSettled = true })
    await Promise.resolve()
    expect(idleSettled).toBe(false)

    flush.resolve(undefined)
    await idle
    expect(agent.status).toBe('idle')
  })

  it('reports a rejected turn-end checkpoint and continues queued work', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const failure = new Error('disk unavailable')
    const errors: { turn: number; step: number; error: unknown }[] = []
    let flushes = 0
    ctx.on('session/flush', () => {
      flushes += 1
      if (flushes === 1) throw failure
    })
    ctx.on('agent/error', (subject, turn, step, error) => {
      if (subject === agent) errors.push({ turn, step, error })
    })

    send(agent, 'first')
    send(agent, 'second')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(flushes).toBe(2)
    expect(errors).toEqual([{ turn: 1, step: 1, error: failure }])
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('session/flush failed at turn 1: disk unavailable'))
    warning.mockRestore()
  })

  it('whenIdle() resolves immediately without active work', async () => {
    const ctx = await harness(new MockAdapter([textResponse('ok')]))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    await agent.whenIdle()

    expect(agent.status).toBe('idle')
  })

  it('whenIdle() waits for active work until explicit cancellation', async () => {
    const ctx = await harness(new MockAdapter(['hang']))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'queued')
    let settled = false
    const idle = agent.whenIdle().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    agent.cancel({ kind: 'user' })
    await idle
    expect(agent.status).toBe('idle')
  })

  it('contains a throwing status listener on both transitions', async () => {
    const ctx = await harness(new MockAdapter([textResponse('ok')]))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/status', (_subject, status) => {
      throw new Error(`bad ${status} listener`)
    })

    send(agent, 'go')
    await agent.whenIdle()

    expect(agent.status).toBe('idle')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('agent event "agent/status" listener threw'),
    )
  })
})
