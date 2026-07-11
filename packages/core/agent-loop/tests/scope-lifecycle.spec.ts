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
import * as concreteAgentModule from '../src/agent.ts'
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
    const handle = await ctx.agents.create({ agentId: AgentId('a1'), sessionId: SessionId('s1'), agentOptions: { model: 'mock' } })
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

    const handle = await ctx.agents.create({
      agentId: AgentId('child'),
      sessionId: SessionId('child-s'),
      agentOptions: { model: 'mock' },
      setup: async (agentCtx) => {
        order.push('setup')
        await Promise.resolve()
        agentCtx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: 'You are the child.' })
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(order).toEqual(['setup', 'session-start', 'persona:You are the child.'])
    await handle.dispose()
  })

  it('keeps both identities unpublished until async setup completes, then announces in order', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<undefined>()
    const setupStarted = Promise.withResolvers<undefined>()
    const order: string[] = []
    ctx.on('session/created', (session) => {
      expect(ctx.sessions.get(session.id)).toBe(session)
      expect(ctx.agents.get(AgentId('atomic'))?.session).toBe(session)
      order.push('session/created')
    })
    ctx.on('agent/created', () => void order.push('agent/created'))
    ctx.on('agent/session-start', () => void order.push('agent/session-start'))
    const acceptedOptions = { model: 'mock' }

    const creating = ctx.agents.create({
      agentId: AgentId('atomic'),
      sessionId: SessionId('atomic-s'),
      agentOptions: acceptedOptions,
      setup: async (agentCtx) => {
        expect(agentCtx.agent?.id).toBe(AgentId('atomic'))
        agentCtx.on('session/created', () => void order.push('setup-listener:session/created'))
        agentCtx.on('agent/created', () => void order.push('setup-listener:agent/created'))
        order.push('setup:start')
        setupStarted.resolve(undefined)
        await gate.promise
        order.push('setup:end')
      },
    })
    await setupStarted.promise
    expect(ctx.agents.get(AgentId('atomic'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('atomic-s'))).toBeUndefined()
    expect(order).toEqual(['setup:start'])
    acceptedOptions.model = 'mutated while setup was pending'

    gate.resolve(undefined)
    const handle = await creating
    expect(handle.agent.options.model).toBe('mock')
    expect(order).toEqual([
      'setup:start',
      'setup:end',
      'session/created',
      'setup-listener:session/created',
      'agent/created',
      'setup-listener:agent/created',
      'agent/session-start',
    ])
    await handle.dispose()
  })

  it('reserves agent and session ids across concurrent async setup', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<undefined>()
    const first = ctx.agents.create({
      agentId: AgentId('reserved'),
      sessionId: SessionId('reserved-s'),
      agentOptions: { model: 'mock' },
      setup: () => gate.promise,
    })

    await expect(ctx.agents.create({
      agentId: AgentId('reserved'),
      sessionId: SessionId('other-s'),
      agentOptions: { model: 'mock' },
    })).rejects.toThrow(/already registered/)
    await expect(ctx.agents.create({
      agentId: AgentId('other'),
      sessionId: SessionId('reserved-s'),
      agentOptions: { model: 'mock' },
    })).rejects.toThrow(/already exists/)
    expect(ctx.agents.list()).toEqual([])
    expect(ctx.sessions.list()).toEqual([])

    gate.resolve(undefined)
    const handle = await first
    await handle.dispose()
  })

  it('structurally rejects every driving verb during setup', async () => {
    const ctx = await harness()
    const handle = await ctx.agents.create({
      agentId: AgentId('no-drive'),
      sessionId: SessionId('no-drive-s'),
      agentOptions: { model: 'mock' },
      setup: (agentCtx) => {
        const agent = agentCtx.agent!
        // Even JavaScript or a cast to the exported concrete class cannot name
        // a public start method. Driver startup is behind a module-private
        // symbol used only by AgentLoop after rollback-covered publication.
        expect(Reflect.get(agent as ReactLoopAgent, 'start')).toBeUndefined()
        expect(Reflect.get(concreteAgentModule, 'enableAgentDrive')).toBeUndefined()
        expect(Reflect.get(concreteAgentModule, 'startAgentDriver')).toBeUndefined()
        expect(() => concreteAgentModule.prepareReactLoopAgent(
          agentCtx, agent.id, agent.options, agent.session,
        )).toThrow(/already has a concrete agent driver/)
        expect(Reflect.get(agent as ReactLoopAgent, 'inbox')).toBeUndefined()
        expect(() => { agent.send(text('queued too soon')) }).toThrow(/cannot send before creation setup completes/)
        expect(() => { agent.steer(text('steered too soon')) }).toThrow(/cannot steer before creation setup completes/)
        expect(() => { agent.inject(text('injected too soon')) }).toThrow(/cannot inject before creation setup completes/)
        expect(() => { agent.cancel('cancel too soon') }).toThrow(/cannot cancel before creation setup completes/)
        expect(agent.session.events).toEqual([])
      },
    })
    expect(handle.agent.session.events).toEqual([])
    await handle.dispose()
  })

  it('owner unload aborts a pending setup and publishes nothing', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<undefined>()
    const setupStarted = Promise.withResolvers<undefined>()
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))

    let creating!: ReturnType<typeof ctx.agents.create>
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      creating = inner.agents.create({
        agentId: AgentId('owner-race'),
        sessionId: SessionId('owner-race-s'),
        agentOptions: { model: 'mock' },
        setup: async () => {
          setupStarted.resolve(undefined)
          await gate.promise
        },
      })
    }, { inject: ['agents'] }))
    await setupStarted.promise

    await owner.dispose()
    await expect(creating).rejects.toThrow(/owner disposed during setup/)
    expect(published).toEqual([])
    expect(ctx.agents.get(AgentId('owner-race'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('owner-race-s'))).toBeUndefined()
    // Let the losing callback settle; Promise.race already observes it.
    gate.resolve(undefined)
    await Promise.resolve()

    // The other ordering in the same race: setup resolves first (its reaction
    // is queued), then owner disposal flips active before that continuation can
    // publish. The post-race active check must still reject.
    const gate2 = Promise.withResolvers<undefined>()
    const setupStarted2 = Promise.withResolvers<undefined>()
    let creating2!: ReturnType<typeof ctx.agents.create>
    const owner2 = await ctx.plugin(Object.assign((inner: Context) => {
      creating2 = inner.agents.create({
        agentId: AgentId('owner-race-2'),
        sessionId: SessionId('owner-race-s-2'),
        agentOptions: { model: 'mock' },
        setup: async () => {
          setupStarted2.resolve(undefined)
          await gate2.promise
        },
      })
    }, { inject: ['agents'] }))
    await setupStarted2.promise
    gate2.resolve(undefined)
    const unload2 = owner2.dispose()
    await expect(creating2).rejects.toThrow(/owner disposed during setup/)
    await unload2
    expect(ctx.agents.get(AgentId('owner-race-2'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('owner-race-s-2'))).toBeUndefined()
  })

  it('a rejecting setup publishes nothing and unwinds the unpublished scope', async () => {
    const ctx = await harness()
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))
    ctx.on('agent/session-start', () => void published.push('agent/session-start'))
    await expect(ctx.agents.create({
      agentId: AgentId('bad'),
      sessionId: SessionId('bad-s'),
      agentOptions: { model: 'mock' },
      setup: async () => {
        await Promise.resolve()
        throw new Error('boom setup')
      },
    })).rejects.toThrow('boom setup')

    // Nothing leaked: no agent, no session, and the ids are reusable.
    expect(published).toEqual([])
    expect(ctx.agents.get(AgentId('bad'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('bad-s'))).toBeUndefined()
    const retry = await ctx.agents.create({ agentId: AgentId('bad'), sessionId: SessionId('bad-s'), agentOptions: { model: 'mock' } })
    await retry.dispose()
  })

  it('a throwing session/created listener disposes the scope (pre-nesting rollback window)', async () => {
    const ctx = await harness()
    let boom = true
    const disposed: string[] = []
    ctx.on('agent/disposed', agent => void disposed.push(agent.id))
    ctx.on('session/created', () => {
      if (boom) { boom = false; throw new Error('boom created') }
    })
    await expect(ctx.agents.create({
      agentId: AgentId('bad'), sessionId: SessionId('bad-s'), agentOptions: { model: 'mock' },
    })).rejects.toThrow('boom created')
    expect(ctx.agents.get(AgentId('bad'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('bad-s'))).toBeUndefined()
    expect(disposed).toEqual([]) // inserted but never announced: no impossible disposed edge
    // The rollback also disposed the scope fiber: re-creating works cleanly.
    const retry = await ctx.agents.create({ agentId: AgentId('bad'), sessionId: SessionId('bad-s'), agentOptions: { model: 'mock' } })
    expect(scopeOf(retry.agent.ctx)).toBe(retry.agent)
    await retry.dispose()
  })

  it('the synchronous config helper rolls back when publication throws', async () => {
    const ctx = await harness()
    const sessionsBefore = ctx.sessions.list().length
    let boom = true
    ctx.on('session/created', () => {
      if (boom) {
        boom = false
        throw new Error('config publish failed')
      }
    })

    expect(() => ctx.agentLoop.create(AgentId('config-bad'), { model: 'mock' }))
      .toThrow('config publish failed')
    expect(ctx.agents.get(AgentId('config-bad'))).toBeUndefined()
    expect(ctx.sessions.list()).toHaveLength(sessionsBefore)
  })

  it('registrations through a disposed agent ctx throw INACTIVE_EFFECT', async () => {
    const ctx = await harness()
    const handle = await ctx.agents.create({ agentId: AgentId('a1'), sessionId: SessionId('s1'), agentOptions: { model: 'mock' } })
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

  it('a listener may drive the agent through its declared `this` (the carrier is method-transparent)', async () => {
    // ds-review-bot regression: agent/* listeners are typed `this: Scoped<Agent>`, and
    // ReactLoopAgent's send/steer/cancel read the native-private #carrier — a proxy-receiver
    // carrier made `this.send(...)` throw TypeError.
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('a1'), { model: 'mock' })
    let followUpSent = false
    ctx.on('agent/session-start', function (this: Agent) {
      // Deliberately through `this`, not the args subject.
      this.send(text('driven through this'))
      followUpSent = true
    })
    const second = ctx.agentLoop.create(AgentId('a2'), { model: 'mock' })
    expect(followUpSent).toBe(true)
    await second.whenIdle()
    // The send actually reached the loop: the prompt ran a turn.
    expect(second.session.events.some(e => e.type === 'turn/start')).toBe(true)
    await agent.whenIdle()
  })

  it('owner unload honors the documented teardown order: unregistration AFTER the drain, before detach', async () => {
    const ctx = await harness()
    let handle!: Awaited<ReturnType<typeof ctx.agents.create>>
    const owner = await ctx.plugin(Object.assign(async (inner: Context) => {
      handle = await inner.agents.create({ agentId: AgentId('o1'), sessionId: SessionId('o1-s'), agentOptions: { model: 'mock' } })
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

    // Open a turn so the drain has real work: the loop must finish it before the registry entry
    // goes away (the agent/disposed contract: "its fiber and any in-flight turn have been torn
    // down").
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
    let handle!: Awaited<ReturnType<typeof ctx.agents.create>>
    const owner = await ctx.plugin(Object.assign(async (inner: Context) => {
      handle = await inner.agents.create({ agentId: AgentId('h1'), sessionId: SessionId('h1-s'), agentOptions: { model: 'mock' } })
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

  it('handle.dispose() awaits an idle-injection flush before unregistering or detaching', async () => {
    const ctx = await harness()
    const handle = await ctx.agents.create({
      agentId: AgentId('idle-flush'),
      sessionId: SessionId('idle-flush-s'),
      agentOptions: { model: 'mock' },
    })
    const gate = Promise.withResolvers<undefined>()
    let flushStarted = false
    ctx.on('session/flush', (session) => {
      if (session !== handle.agent.session) return
      flushStarted = true
      return gate.promise
    })

    handle.agent.inject(text('durable idle context'), { source: { kind: 'plugin', plugin: 'test' } })
    expect(flushStarted).toBe(true)

    let disposed = false
    const disposal = handle.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(disposed).toBe(false)
    expect(ctx.agents.get(AgentId('idle-flush'))).toBe(handle.agent)
    expect(ctx.sessions.get(SessionId('idle-flush-s'))).toBe(handle.agent.session)

    gate.resolve(undefined)
    await disposal
    expect(ctx.agents.get(AgentId('idle-flush'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('idle-flush-s'))).toBeUndefined()
  })
})
