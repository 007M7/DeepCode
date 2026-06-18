import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Agent, AgentId } from '@deepseek-ai/dsh-agent'

function stubAgent(rawId: string): Agent {
  const id = AgentId(rawId)
  return {
    id,
    options: {},
    session: new Session(SessionId(`${id}-session`)),
    status: 'idle',
    send() {},
    steer() {},
    inject() {},
    abort() {},
    whenIdle() { return Promise.resolve() },
  }
}

describe('AgentRegistry', () => {
  it('registers agents and emits created/disposed events', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)

    const created: string[] = []
    const disposed: string[] = []
    ctx.on('agent/created', agent => void created.push(agent.id))
    ctx.on('agent/disposed', agent => void disposed.push(agent.id))

    const agent = stubAgent('a1')
    const dispose = ctx.agents.register(agent)
    expect(created).toEqual(['a1'])
    expect(ctx.agents.get('a1')).toBe(agent)
    expect(ctx.agents.list()).toEqual([agent])

    dispose()
    expect(disposed).toEqual(['a1'])
    expect(ctx.agents.get('a1')).toBeUndefined()
  })

  it('rejects duplicate ids and unregisters on fiber dispose (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    ctx.agents.register(stubAgent('main'))
    expect(() => ctx.agents.register(stubAgent('main'))).toThrow('already registered')

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.agents.register(stubAgent('scoped'))
    }, { inject: ['agents'] }))
    expect(ctx.agents.list().map(a => a.id)).toEqual(['main', 'scoped'])

    await fiber.dispose()
    expect(ctx.agents.list().map(a => a.id)).toEqual(['main'])
  })

  it('rolls back the agent entry when an agent/created listener throws (P1-1)', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)

    let threw = false
    ctx.on('agent/created', () => {
      if (!threw) { threw = true; throw new Error('boom created listener') }
    })

    // The throwing emit must roll the entry back, not leak it.
    expect(() => ctx.agents.register(stubAgent('main'))).toThrow('boom created listener')
    expect(ctx.agents.get('main')).toBeUndefined() // rolled back, not leaked

    // A subsequent listener-free register of the SAME id succeeds and is
    // tracked exactly once (the duplicate-id check is not wedged).
    const dispose = ctx.agents.register(stubAgent('main'))
    expect(ctx.agents.list().map(a => a.id)).toEqual(['main'])
    dispose()
    expect(ctx.agents.get('main')).toBeUndefined()
  })
})

describe('AgentRegistry factory seam', () => {
  /** A stub AgentFactory that records calls and returns a stub agent. */
  function stubFactory() {
    const calls: { create: unknown[]; resume: unknown[] } = { create: [], resume: [] }
    const factory: import('@deepseek-ai/dsh-agent').AgentFactory = {
      createAgent(options) { calls.create.push(options); return stubAgent(options.agentId) },
      resume(options) { calls.resume.push(options); return Promise.resolve(stubAgent(options.agentId)) },
    }
    return { factory, calls }
  }

  it('create()/resume() throw when no factory is registered', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    expect(() => ctx.agents.create({ agentId: 'a', sessionId: 's' })).toThrow(/no agent factory/)
    await expect(ctx.agents.resume({ agentId: 'a', resumeSessionId: 's' })).rejects.toThrow(/no agent factory/)
  })

  it('setFactory registers a factory; create/resume delegate to it', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const { factory, calls } = stubFactory()
    ctx.agents.setFactory(factory)

    const created = ctx.agents.create({ agentId: 'c1', sessionId: 'sess-1', meta: { cwd: '/w' } })
    expect(created.id).toBe('c1')
    expect(calls.create).toEqual([{ agentId: 'c1', sessionId: 'sess-1', meta: { cwd: '/w' } }])

    const resumed = await ctx.agents.resume({ agentId: 'r1', resumeSessionId: 'old-sess' })
    expect(resumed.id).toBe('r1')
    expect(calls.resume).toEqual([{ agentId: 'r1', resumeSessionId: 'old-sess' }])
  })

  it('setFactory rejects a second factory', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    ctx.agents.setFactory(stubFactory().factory)
    expect(() => ctx.agents.setFactory(stubFactory().factory)).toThrow(/already registered/)
  })

  it('disposing the setFactory fiber clears the factory (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    let dispose!: () => void
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      dispose = inner.agents.setFactory(stubFactory().factory)
    }, { inject: ['agents'] }))
    expect(() => ctx.agents.create({ agentId: 'a', sessionId: 's' })).not.toThrow()
    void dispose
    await fiber.dispose()
    // factory slot cleared → create throws again
    expect(() => ctx.agents.create({ agentId: 'a2', sessionId: 's2' })).toThrow(/no agent factory/)
  })
})
