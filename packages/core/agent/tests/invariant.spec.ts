import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { AgentMessageId, type Agent } from '@deepseek-ai/dsh-agent'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import InvariantService from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantService)
  await ctx.plugin(AgentInvariant)
  return ctx
}

function mockAgent(id: string): Agent {
  return { id } as unknown as Agent
}

describe('agent status invariants', () => {
  it('accepts lifecycle transitions through idle, running, and disposed', async () => {
    const ctx = await setup()
    const agent = mockAgent('a1')
    expect(() => {
      ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'idle')
      ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'running')
      ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'idle')
      ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'disposed')
    }).not.toThrow()

    const running = mockAgent('a2')
    ctx.emit(scopeTarget(running, running), 'agent/status', running, 'running')
    expect(() => { ctx.emit(scopeTarget(running, running), 'agent/status', running, 'disposed') }).not.toThrow()
  })

  it('rejects a no-op transition', async () => {
    const ctx = await setup()
    const agent = mockAgent('a3')
    ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'running')
    expect(() => { ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'running') })
      .toThrow(/no-op transition/)
  })

  it('rejects leaving the terminal disposed state', async () => {
    const ctx = await setup()
    const agent = mockAgent('a4')
    ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'disposed')
    expect(() => { ctx.emit(scopeTarget(agent, agent), 'agent/status', agent, 'idle') })
      .toThrow(/left terminal state disposed/)
  })

  it('tracks agents independently', async () => {
    const ctx = await setup()
    const a = mockAgent('a5')
    const b = mockAgent('b5')
    ctx.emit(scopeTarget(a, a), 'agent/status', a, 'running')
    expect(() => { ctx.emit(scopeTarget(b, b), 'agent/status', b, 'running') }).not.toThrow()
  })
})

describe('agent inbox invariants', () => {
  const info = (steering: boolean) => ({ id: AgentMessageId('m'), content: [], source: { kind: 'user' as const }, contexts: [], steering, wakeup: true })

  it('accepts a dequeue and a discard covered by prior enqueues', async () => {
    const ctx = await setup()
    const agent = mockAgent('i1')
    const at = scopeTarget(agent, agent)
    expect(() => {
      ctx.emit(at, 'agent/inbox/enqueue', agent, info(false))
      ctx.emit(at, 'agent/inbox/enqueue', agent, info(true))
      ctx.emit(at, 'agent/inbox/dequeue', agent, info(false))
      ctx.emit(at, 'agent/inbox/discard', agent, [info(true)])
    }).not.toThrow()
  })

  it('rejects a dequeue with no outstanding item', async () => {
    const ctx = await setup()
    const agent = mockAgent('i2')
    expect(() => { ctx.emit(scopeTarget(agent, agent), 'agent/inbox/dequeue', agent, info(false)) })
      .toThrow(/without a matching prior enqueue/)
  })

  it('rejects a discard larger than the outstanding count', async () => {
    const ctx = await setup()
    const agent = mockAgent('i3')
    const at = scopeTarget(agent, agent)
    ctx.emit(at, 'agent/inbox/enqueue', agent, info(false))
    expect(() => { ctx.emit(at, 'agent/inbox/discard', agent, [info(false), info(true)]) })
      .toThrow(/dropped 2 items but only 1 were outstanding/)
  })

  it('accepts an empty discard against a fresh agent', async () => {
    const ctx = await setup()
    const agent = mockAgent('i4')
    expect(() => { ctx.emit(scopeTarget(agent, agent), 'agent/inbox/discard', agent, []) }).not.toThrow()
  })
})
