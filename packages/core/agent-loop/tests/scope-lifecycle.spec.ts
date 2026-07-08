import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import AgentLoop, { ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter = new MockAdapter([textResponse('ok')])) {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: ReactLoopAgent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }]

describe('agent scope lifecycle', () => {
  it('wires agent.ctx: tagged with the agent, DX field set, ctx.agent safe elsewhere', async () => {
    const ctx = await harness()
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    expect(scopeOf(agent.ctx)).toBe(agent)
    expect(agent.ctx.agent).toBe(agent)
    // The root accessor default: a plain context answers undefined, not a throw.
    expect(ctx.agent).toBeUndefined()
    await ctx.agents.get(AgentId('a1'))?.whenIdle()
  })

  it('scoped registrations live in the agent world and die with the agent', async () => {
    const ctx = await harness()
    const handle = ctx.agents.create({ agentId: AgentId('a1'), sessionId: SessionId('s1'), agentOptions: { model: 'mock' } })
    const { agent } = handle
    agent.ctx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: 'You run tests.' })
    agent.ctx.tools.register({
      name: 'mine', description: 'scoped', parameters: {},
      execute: () => Promise.resolve(text('ran')),
    })

    const scopedAssembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(scopedAssembly.sections.find(s => s.name === 'deployment:persona')?.text).toBe('You run tests.')
    expect(scopedAssembly.tools.map(t => t.name)).toContain('mine')
    // Other assemblies are untouched.
    const globalAssembly = await ctx.systemPrompt.assemble()
    expect(globalAssembly.sections.find(s => s.name === 'deployment:persona')?.text).toBe('You are the deployment.')
    expect(globalAssembly.tools.map(t => t.name)).not.toContain('mine')

    await handle.dispose()
    // The scoped world unwound with the agent: nothing leaked into the registries.
    expect(ctx.tools.get('mine', agent)).toBeUndefined()
    const after = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(after.sections.find(s => s.name === 'deployment:persona')?.text).toBe('You are the deployment.')
  })

  it('agent.ctx listeners hear only their own agent (scoped dispatch end to end)', async () => {
    const ctx = await harness(new MockAdapter([textResponse('one'), textResponse('two')]))
    const a = ctx.agentLoop.create(AgentId('a'), { model: 'mock' })
    const b = ctx.agentLoop.create(AgentId('b'), { model: 'mock' })

    const heard: string[] = []
    a.ctx.on('agent/status', (subject, status) => void heard.push(`a-sees:${subject.id}:${status}`))
    a.ctx.on('session/event', (_s, event) => {
      if (event.type === 'user/message') heard.push('a-sees:user-message')
    })

    b.send(text('for b'))
    await waitForIdle(ctx, b)
    expect(heard).toEqual([]) // nothing of b's leaked into a's scope

    a.send(text('for a'))
    await waitForIdle(ctx, a)
    expect(heard).toContain('a-sees:a:running')
    expect(heard).toContain('a-sees:user-message')
  })

  it('runs setup in the guaranteed slot: scoped world complete before session-start and the first assembly', async () => {
    const ctx = await harness()
    const order: string[] = []
    ctx.on('agent/session-start', (agent) => {
      order.push('session-start')
      // The scoped section is already registered by the time session-start fires.
      void ctx.systemPrompt.assemble(assembleContextFor(agent)).then((assembly) => {
        order.push(`persona:${assembly.sections.find(s => s.name === 'deployment:persona')?.text}`)
      })
    })

    const handle = ctx.agents.create({
      agentId: AgentId('child'),
      sessionId: SessionId('child-s'),
      agentOptions: { model: 'mock' },
      setup: (agentCtx) => {
        order.push('setup')
        agentCtx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: 'You are the child.' })
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(order).toEqual(['setup', 'session-start', 'persona:You are the child.'])
    await handle.dispose()
  })

  it('a throwing setup unwinds the half-created agent completely', async () => {
    const ctx = await harness()
    expect(() => ctx.agents.create({
      agentId: AgentId('bad'),
      sessionId: SessionId('bad-s'),
      agentOptions: { model: 'mock' },
      setup: () => { throw new Error('boom setup') },
    })).toThrow('boom setup')

    // Nothing leaked: no agent, no session, and the ids are reusable.
    expect(ctx.agents.get(AgentId('bad'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('bad-s'))).toBeUndefined()
    const retry = ctx.agents.create({ agentId: AgentId('bad'), sessionId: SessionId('bad-s'), agentOptions: { model: 'mock' } })
    await retry.dispose()
  })

  it('a throwing session/created listener disposes the scope (pre-nesting rollback window)', async () => {
    const ctx = await harness()
    let boom = true
    ctx.on('session/created', () => {
      if (boom) { boom = false; throw new Error('boom created') }
    })
    expect(() => ctx.agents.create({
      agentId: AgentId('bad'), sessionId: SessionId('bad-s'), agentOptions: { model: 'mock' },
    })).toThrow('boom created')
    expect(ctx.agents.get(AgentId('bad'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('bad-s'))).toBeUndefined()
    // The rollback also disposed the scope fiber: re-creating works cleanly.
    const retry = ctx.agents.create({ agentId: AgentId('bad'), sessionId: SessionId('bad-s'), agentOptions: { model: 'mock' } })
    expect(scopeOf(retry.agent.ctx)).toBe(retry.agent)
    await retry.dispose()
  })

  it('registrations through a disposed agent ctx throw INACTIVE_EFFECT', async () => {
    const ctx = await harness()
    const handle = ctx.agents.create({ agentId: AgentId('a1'), sessionId: SessionId('s1'), agentOptions: { model: 'mock' } })
    await handle.dispose()
    expect(() => handle.agent.ctx.on('agent/status', () => {})).toThrow(/inactive context/)
  })

  it('agentEvents fuses carrier and subject for custom drivers', async () => {
    const ctx = await harness()
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    const other = ctx.agentLoop.create(AgentId('a2'), { model: 'mock' })
    const heard: string[] = []
    agent.ctx.on('agent/error', (subject: Agent, turn: number) => void heard.push(`${subject.id}:${turn}`))

    agentEvents(ctx, other).emit('agent/error', 1, 0, new Error('not for a1'))
    agentEvents(ctx, agent).emit('agent/error', 2, 0, new Error('for a1'))
    expect(heard).toEqual(['a1:2'])
  })

  it('owner unload honors the documented teardown order: unregistration AFTER the drain, before detach', async () => {
    const ctx = await harness()
    let handle!: ReturnType<typeof ctx.agents.create>
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      handle = inner.agents.create({ agentId: AgentId('o1'), sessionId: SessionId('o1-s'), agentOptions: { model: 'mock' } })
    }, { inject: ['agents'] }))
    const { agent } = handle

    const order: string[] = []
    ctx.on('session/event', (_s, event) => {
      if (event.type === 'turn/end') order.push('turn-end')
    })
    ctx.on('agent/disposed', () => {
      order.push(`disposed(listed=${ctx.agents.get(AgentId('o1')) !== undefined})`)
      order.push(`session-still-stored=${ctx.sessions.get(SessionId('o1-s')) !== undefined}`)
    })

    // Open a turn so the drain has real work: the loop must finish it BEFORE
    // the registry entry goes away (the agent/disposed contract: "its fiber
    // and any in-flight turn have been torn down"). Wait for the turn to be
    // OPEN in the log — a dispose landing in the pre-step window would drop
    // the queued prompt without ever opening a turn.
    const turnOpen = new Promise<void>((resolve) => {
      const off = ctx.on('session/event', (_s, event) => {
        if (event.type === 'turn/start') { off(); resolve() }
      })
    })
    agent.send(text('work'))
    await turnOpen
    await owner.dispose()
    expect(order).toEqual(['turn-end', 'disposed(listed=false)', 'session-still-stored=true'])
    expect(ctx.sessions.get(SessionId('o1-s'))).toBeUndefined()
  })

  it('handle.dispose() during owner unload still awaits true quiescence (shared boundary)', async () => {
    const ctx = await harness()
    let handle!: ReturnType<typeof ctx.agents.create>
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      handle = inner.agents.create({ agentId: AgentId('h1'), sessionId: SessionId('h1-s'), agentOptions: { model: 'mock' } })
    }, { inject: ['agents'] }))

    const teardownDone: string[] = []
    ctx.on('agent/disposed', () => void teardownDone.push('unregistered'))

    // Owner unload begins FIRST (invokes the raw cordis wrapper)…
    const unload = owner.dispose()
    // …and a concurrent handle.dispose() must not resolve before the chain
    // actually finished (the raw wrapper returns undefined on a repeat call).
    await handle.dispose()
    expect(teardownDone).toContain('unregistered')
    expect(ctx.agents.get(AgentId('h1'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('h1-s'))).toBeUndefined()
    await unload
  })
})
