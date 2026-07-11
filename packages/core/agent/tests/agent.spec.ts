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
    // A bare context stands in for the agent scope: registry tests never
    // register through it, they only need the field present.
    ctx: new Context(),
    send() {},
    steer() {},
    inject() {},
    cancel() {},
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
    expect(ctx.agents.get(AgentId('a1'))).toBe(agent)
    expect(ctx.agents.list()).toEqual([agent])

    await dispose()
    expect(disposed).toEqual(['a1'])
    expect(ctx.agents.get(AgentId('a1'))).toBeUndefined()
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
    expect(ctx.agents.get(AgentId('main'))).toBeUndefined() // rolled back, not leaked

    // A subsequent listener-free register of the SAME id succeeds and is
    // tracked exactly once (the duplicate-id check is not wedged).
    const dispose = ctx.agents.register(stubAgent('main'))
    expect(ctx.agents.list().map(a => a.id)).toEqual(['main'])
    await dispose()
    expect(ctx.agents.get(AgentId('main'))).toBeUndefined()
  })

  it('splits insertion from announcement and makes the detach exact/idempotent', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const created: Agent[] = []
    const disposed: Agent[] = []
    ctx.on('agent/created', agent => void created.push(agent))
    ctx.on('agent/disposed', agent => void disposed.push(agent))

    const first = stubAgent('split')
    const detachFirst = ctx.agents.enter(first)
    expect(ctx.agents.get(first.id)).toBe(first)
    expect(created).toEqual([])
    ctx.agents.announce(first)
    expect(created).toEqual([first])
    detachFirst()
    detachFirst()
    expect(disposed).toEqual([first])

    const replacement = stubAgent('split')
    const detachReplacement = ctx.agents.enter(replacement)
    // A stale repeated detach cannot remove the replacement.
    detachFirst()
    expect(ctx.agents.get(replacement.id)).toBe(replacement)
    expect(() => { ctx.agents.announce(first) }).toThrow(/not live/)
    detachReplacement()
    // The replacement was inserted but never announced, so rollback produces
    // no disposed-without-created notification.
    expect(disposed).toEqual([first])
  })
})

describe('AgentRegistry factory seam', () => {
  /** A stub AgentFactory that records calls and returns a stub agent. */
  function stubFactory() {
    const calls: { create: unknown[]; resume: unknown[] } = { create: [], resume: [] }
    const factory: import('@deepseek-ai/dsh-agent').AgentFactory = {
      async createAgent(options) {
        calls.create.push(options)
        return { agent: stubAgent(options.agentId), dispose: () => Promise.resolve() }
      },
      resume(options) {
        calls.resume.push(options)
        return Promise.resolve({ agent: stubAgent(options.agentId), dispose: () => Promise.resolve() })
      },
    }
    return { factory, calls }
  }

  it('create()/resume() throw when no factory is registered', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await expect(ctx.agents.create({ agentId: AgentId('a'), sessionId: SessionId('s') })).rejects.toThrow(/no agent factory/)
    await expect(ctx.agents.resume({ agentId: AgentId('a'), resumeSessionId: SessionId('s') })).rejects.toThrow(/no agent factory/)
  })

  it('setFactory registers a factory; create/resume delegate to it', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const { factory, calls } = stubFactory()
    ctx.agents.setFactory(factory)

    const created = await ctx.agents.create({ agentId: AgentId('c1'), sessionId: SessionId('sess-1'), meta: { cwd: '/w' } })
    expect(created.agent.id).toBe('c1')
    expect(calls.create).toEqual([{ agentId: AgentId('c1'), sessionId: SessionId('sess-1'), meta: { cwd: '/w' } }])

    const resumed = await ctx.agents.resume({ agentId: AgentId('r1'), resumeSessionId: SessionId('old-sess') })
    expect(resumed.agent.id).toBe('r1')
    expect(calls.resume).toEqual([{ agentId: AgentId('r1'), resumeSessionId: SessionId('old-sess') }])
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
    let dispose!: () => Promise<void> | void
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      dispose = inner.agents.setFactory(stubFactory().factory)
    }, { inject: ['agents'] }))
    await expect(ctx.agents.create({ agentId: AgentId('a'), sessionId: SessionId('s') })).resolves.toBeDefined()
    void dispose
    await fiber.dispose()
    // factory slot cleared → create throws again
    await expect(ctx.agents.create({ agentId: AgentId('a2'), sessionId: SessionId('s2') })).rejects.toThrow(/no agent factory/)
  })
})
