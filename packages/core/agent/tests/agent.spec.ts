import { describe, expect, it, vi } from 'vitest'
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

    dispose()
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
    dispose()
    expect(ctx.agents.get(AgentId('main'))).toBeUndefined()
  })
})

describe('AgentRegistry.onCleanup / drainCleanups', () => {
  it('drains cleanups in registration order, awaiting each', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const agent = stubAgent('a1')
    ctx.agents.register(agent)

    const ran: string[] = []
    ctx.agents.onCleanup(agent.id, async () => {
      ran.push('first:start')
      await new Promise(r => setTimeout(r, 10))
      ran.push('first:end')
    })
    ctx.agents.onCleanup(agent.id, () => {
      ran.push('second')
      return Promise.resolve()
    })

    await ctx.agents.drainCleanups(agent.id)
    // Sequential await: the second cleanup starts only after the first settled.
    expect(ran).toEqual(['first:start', 'first:end', 'second'])
    // Drained cleanups are detached: a second drain is a no-op.
    await ctx.agents.drainCleanups(agent.id)
    expect(ran).toEqual(['first:start', 'first:end', 'second'])
  })

  it('contains a rejecting cleanup: logged, later cleanups still run', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const agent = stubAgent('a1')
    ctx.agents.register(agent)

    let ranAfter = false
    ctx.agents.onCleanup(agent.id, () => Promise.reject(new Error('cleanup boom')))
    ctx.agents.onCleanup(agent.id, () => {
      ranAfter = true
      return Promise.resolve()
    })

    await expect(ctx.agents.drainCleanups(agent.id)).resolves.toBeUndefined()
    expect(ranAfter).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cleanup boom'))
  })

  it('rejects a cleanup for an agent that is not registered', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    expect(() => ctx.agents.onCleanup(AgentId('ghost'), () => Promise.resolve()))
      .toThrow('agent "ghost" is not registered')
  })

  it('detaches without running on disposer call and on fiber dispose (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const agent = stubAgent('a1')
    ctx.agents.register(agent)

    let ranA = false
    let ranB = false
    const detach = ctx.agents.onCleanup(agent.id, () => {
      ranA = true
      return Promise.resolve()
    })
    detach()

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.agents.onCleanup(agent.id, () => {
        ranB = true
        return Promise.resolve()
      })
    }, { inject: ['agents'] }))
    await fiber.dispose()

    await ctx.agents.drainCleanups(agent.id)
    expect(ranA).toBe(false)
    expect(ranB).toBe(false)
  })

  it('runs a cleanup registered during the drain instead of leaking it', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const agent = stubAgent('a1')
    ctx.agents.register(agent)

    const ran: string[] = []
    ctx.agents.onCleanup(agent.id, () => {
      ran.push('outer')
      // A settling task registering follow-up cleanup mid-drain: the drain
      // loop must pick up the fresh set rather than strand it.
      ctx.agents.onCleanup(agent.id, () => {
        ran.push('mid-drain')
        return Promise.resolve()
      })
      return Promise.resolve()
    })

    await ctx.agents.drainCleanups(agent.id)
    expect(ran).toEqual(['outer', 'mid-drain'])
  })

  it('a stale disposer from a drained set does not remove a fresh registration', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const agent = stubAgent('a1')
    ctx.agents.register(agent)

    const detachOld = ctx.agents.onCleanup(agent.id, () => Promise.resolve())
    await ctx.agents.drainCleanups(agent.id)

    let ranFresh = false
    ctx.agents.onCleanup(agent.id, () => {
      ranFresh = true
      return Promise.resolve()
    })
    // The old registration's disposer fires after its set was drained; the
    // identity guard must keep it away from the fresh set under the same id.
    detachOld()
    await ctx.agents.drainCleanups(agent.id)
    expect(ranFresh).toBe(true)
  })
})

describe('AgentRegistry factory seam', () => {
  /** A stub AgentFactory that records calls and returns a stub agent. */
  function stubFactory() {
    const calls: { create: unknown[]; resume: unknown[] } = { create: [], resume: [] }
    const factory: import('@deepseek-ai/dsh-agent').AgentFactory = {
      createAgent(options) {
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
    expect(() => ctx.agents.create({ agentId: AgentId('a'), sessionId: SessionId('s') })).toThrow(/no agent factory/)
    await expect(ctx.agents.resume({ agentId: AgentId('a'), resumeSessionId: SessionId('s') })).rejects.toThrow(/no agent factory/)
  })

  it('setFactory registers a factory; create/resume delegate to it', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const { factory, calls } = stubFactory()
    ctx.agents.setFactory(factory)

    const created = ctx.agents.create({ agentId: AgentId('c1'), sessionId: SessionId('sess-1'), meta: { cwd: '/w' } })
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
    let dispose!: () => void
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      dispose = inner.agents.setFactory(stubFactory().factory)
    }, { inject: ['agents'] }))
    expect(() => ctx.agents.create({ agentId: AgentId('a'), sessionId: SessionId('s') })).not.toThrow()
    void dispose
    await fiber.dispose()
    // factory slot cleared → create throws again
    expect(() => ctx.agents.create({ agentId: AgentId('a2'), sessionId: SessionId('s2') })).toThrow(/no agent factory/)
  })
})
