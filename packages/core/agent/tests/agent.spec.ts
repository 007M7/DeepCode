import { describe, expect, it } from 'vitest'
import { Context, Service, symbols } from 'cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Agent, AgentId, agentEvents } from '@deepseek-ai/dsh-agent'
import type { AgentFactory, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'

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

  it('observes async agent/created rejection without rolling back or starving peers', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const hostile = { [Symbol.toPrimitive]() { throw new Error('cannot stringify') } }
    const heard: string[] = []
    ctx.on('agent/created', () => Promise.reject(new Error('ordinary async failure')) as never)
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- hostile thrown values are the boundary under test
    ctx.on('agent/created', () => Promise.reject(hostile) as never)
    ctx.on('agent/created', (agent) => { heard.push(agent.id) })

    const agent = stubAgent('async-created')
    const dispose = ctx.agents.register(agent)
    await Promise.resolve()
    await Promise.resolve()

    expect(ctx.agents.get(agent.id)).toBe(agent)
    expect(heard).toEqual(['async-created'])
    expect(warnings).toEqual([
      'agent "async-created": agent/created listener rejected: Error: ordinary async failure',
      'agent "async-created": agent/created listener rejected: <unrenderable thrown value>',
    ])
    await dispose()
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

  it('captures and pins one runtime id before insertion, announcement, and detach', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const existing = stubAgent('occupied')
    const disposeExisting = ctx.agents.register(existing)
    const candidate = stubAgent('placeholder')
    let reads = 0
    Object.defineProperty(candidate, 'id', {
      configurable: true,
      get() {
        reads += 1
        return reads === 1 ? AgentId('accepted') : AgentId('occupied')
      },
    })

    const detach = ctx.agents.enter(candidate)
    expect(reads).toBe(1)
    expect(candidate.id).toBe('accepted')
    expect(reads).toBe(1)
    expect(Object.getOwnPropertyDescriptor(candidate, 'id')).toMatchObject({
      configurable: false,
      writable: false,
      value: 'accepted',
    })
    expect(ctx.agents.get(AgentId('accepted'))).toBe(candidate)
    expect(ctx.agents.get(AgentId('occupied'))).toBe(existing)
    expect(() => ctx.agents.enter(candidate)).toThrow(/already registered/)

    ctx.agents.announce(candidate)
    detach()
    expect(ctx.agents.get(AgentId('accepted'))).toBeUndefined()
    expect(ctx.agents.get(AgentId('occupied'))).toBe(existing)
    await disposeExisting()

    expect(() => ctx.agents.enter({ ...stubAgent('bad'), id: 42 } as unknown as Agent))
      .toThrow(/id must be a string/)
    const pinnedAccessor = stubAgent('pinned')
    Object.defineProperty(pinnedAccessor, 'id', {
      configurable: false,
      get: () => AgentId('pinned'),
    })
    expect(() => ctx.agents.enter(pinnedAccessor)).toThrow(/installable as a stable own property/)
  })

  it('claims an id across a Proxy defineProperty trap before committing the exact entry', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const id = AgentId('reentrant-enter')
    const nested = stubAgent(id)
    let nestedError = ''
    let attempted = false
    const target = stubAgent(id)
    const outer = new Proxy(target, {
      defineProperty(inner, property, descriptor) {
        if (property === 'id' && !attempted) {
          attempted = true
          try {
            ctx.agents.enter(nested)
          } catch (error: unknown) {
            nestedError = String(error)
          }
        }
        return Reflect.defineProperty(inner, property, descriptor)
      },
    })

    const detach = ctx.agents.enter(outer)
    expect(nestedError).toMatch(/already registered/)
    expect(ctx.agents.get(id)).toBe(outer)
    detach()
    expect(ctx.agents.get(id)).toBeUndefined()
  })

  it('captures one lifecycle carrier before commit so a filter getter cannot invert edges', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const events: string[] = []
    const agent = stubAgent('reentrant-carrier')
    let detach = (): void => {}
    Object.defineProperty(agent, Context.filter, {
      configurable: true,
      get() {
        events.push('filter-getter')
        detach()
        return undefined
      },
    })
    detach = ctx.agents.enter(agent)
    ctx.on('agent/created', () => { events.push('created') })
    ctx.on('agent/disposed', () => { events.push('disposed') })

    ctx.agents.announce(agent)
    expect(events).toEqual(['filter-getter', 'created'])
    expect(ctx.agents.get(agent.id)).toBe(agent)
    detach()
    expect(events).toEqual(['filter-getter', 'created', 'disposed'])
    expect(ctx.agents.get(agent.id)).toBeUndefined()
  })

  it('revalidates an exact reservation after carrier construction runs caller code', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const reservation = ctx.agents.reserve(AgentId('released-during-enter'))
    const agent = stubAgent('released-during-enter')
    Object.defineProperty(agent, Context.filter, {
      configurable: true,
      get() {
        reservation.release()
        return undefined
      },
    })

    expect(() => ctx.agents.enter(agent, reservation)).toThrow(/reservation is not active/)
    expect(ctx.agents.get(agent.id)).toBeUndefined()
  })

  it('observes an async agent/disposed rejection through the stable carrier', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    ctx.on('agent/disposed', () => Promise.reject(new Error('late disposal failure')) as never)
    const agent = stubAgent('async-disposed')
    const detach = ctx.agents.enter(agent)
    ctx.agents.announce(agent)

    detach()
    await Promise.resolve()
    await Promise.resolve()
    expect(warnings).toEqual([
      'agent "async-disposed": agent/disposed listener rejected: Error: late disposal failure',
    ])
  })

  it('uses an opaque one-id reservation to gate unpublished factory insertion', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const held = ctx.agents.reserve(AgentId('held'))

    expect(() => ctx.agents.reserve(AgentId('held'))).toThrow(/already registered or reserved/)
    expect(() => ctx.agents.enter(stubAgent('held'))).toThrow(/reserved for unpublished creation/)
    const other = ctx.agents.reserve(AgentId('other'))
    expect(() => ctx.agents.enter(stubAgent('held'), other)).toThrow(/not active for this id/)

    const agent = stubAgent('held')
    const detach = ctx.agents.enter(agent, held)
    ctx.agents.announce(agent)
    held.release()
    held.release()
    expect(ctx.agents.get(AgentId('held'))).toBe(agent)
    expect(() => ctx.agents.reserve(AgentId('held'))).toThrow(/already registered or reserved/)
    detach()
    other.release()

    const expired = ctx.agents.reserve(AgentId('expired'))
    expired.release()
    expect(() => ctx.agents.enter(stubAgent('expired'), expired)).toThrow(/not active for this id/)
    expect(() => ctx.agents.reserve(42 as unknown as AgentId)).toThrow(/id must be a string/)
  })

  it('owns reservations by the calling fiber and rolls back failed ownership registration', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    let held!: import('@deepseek-ai/dsh-agent').AgentRegistrationReservation
    let scopedAgents!: AgentRegistry
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      scopedAgents = inner.agents
      held = inner.agents.reserve(AgentId('fiber-held'))
    }, { inject: ['agents'] }))

    expect(() => ctx.agents.reserve(AgentId('fiber-held'))).toThrow(/already registered or reserved/)
    await owner.dispose()
    const reused = ctx.agents.reserve(AgentId('fiber-held'))
    reused.release()
    held.release() // idempotent after the automatic owner-disposal release

    // A disposed tracker cannot own a new effect. The failed effect install
    // must remove the map entry it tentatively reserved before propagating.
    expect(() => scopedAgents.reserve(AgentId('inactive-owner'))).toThrow(/inactive context/)
    const recovered = ctx.agents.reserve(AgentId('inactive-owner'))
    recovered.release()
  })

  it('rejects direct and reentrant repeat announcements to preserve one lifecycle pair', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    let created = 0
    let disposed = 0
    let reentrantError = ''
    ctx.on('agent/created', (agent) => {
      created += 1
      try {
        ctx.agents.announce(agent)
      } catch (error: unknown) {
        reentrantError = String(error)
      }
    })
    ctx.on('agent/disposed', () => { disposed += 1 })

    const agent = stubAgent('once')
    const detach = ctx.agents.enter(agent)
    ctx.agents.announce(agent)
    expect(reentrantError).toMatch(/already announced/)
    expect(() => { ctx.agents.announce(agent) }).toThrow(/already announced/)
    detach()
    expect({ created, disposed }).toEqual({ created: 1, disposed: 1 })
  })

  it('defers a reentrant detach until the creation dispatch unwinds', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const order: string[] = []
    const agent = stubAgent('reentrant-detach')
    const detach = ctx.agents.enter(agent)

    ctx.on('agent/created', (created) => {
      order.push('created:first')
      detach()
      expect(ctx.agents.get(created.id)).toBe(created)
    })
    ctx.on('agent/created', (created) => {
      order.push('created:second')
      expect(ctx.agents.get(created.id)).toBe(created)
    })
    ctx.on('agent/disposed', (disposed) => {
      order.push('disposed')
      expect(ctx.agents.get(disposed.id)).toBeUndefined()
    })

    ctx.agents.announce(agent)

    expect(order).toEqual(['created:first', 'created:second', 'disposed'])
    expect(ctx.agents.get(agent.id)).toBeUndefined()
    detach()
  })
})

describe('agentEvents()', () => {
  it('contains synchronous throws and returned-promise rejections per listener', async () => {
    const ctx = new Context()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const agent = stubAgent('contained')
    const heard: string[] = []
    const hostile = { [Symbol.toPrimitive]() { throw new Error('cannot stringify') } }

    ctx.on('agent/status', () => { throw hostile })
    ctx.on('agent/status', () => Promise.reject(new Error('async listener')) as never)
    ctx.on('agent/status', (_subject, status) => { heard.push(status) })

    expect(() => { agentEvents(ctx, agent).emit('agent/status', 'running') }).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()

    expect(heard).toEqual(['running'])
    expect(warnings).toEqual([
      'agent event "agent/status" listener threw: <unrenderable thrown value>',
      'agent event "agent/status" listener rejected: Error: async listener',
    ])
  })
})

describe('AgentRegistry factory seam', () => {
  /** A stub AgentFactory that records calls and returns a stub agent. */
  function stubFactory() {
    const calls: {
      create: Array<{ ownerCtx: Context; options: CreateAgentOptions }>
      resume: Array<{ ownerCtx: Context; options: ResumeAgentOptions }>
    } = { create: [], resume: [] }
    const factory: AgentFactory = {
      async createAgent(ownerCtx, options) {
        calls.create.push({ ownerCtx, options })
        return { agent: stubAgent(options.agentId), dispose: () => Promise.resolve() }
      },
      resume(ownerCtx, options) {
        calls.resume.push({ ownerCtx, options })
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
    expect(calls.create).toHaveLength(1)
    expect(calls.create[0]!.ownerCtx.fiber).toBe(ctx.fiber)
    expect(calls.create[0]!.options)
      .toEqual({ agentId: AgentId('c1'), sessionId: SessionId('sess-1'), meta: { cwd: '/w' } })

    const resumed = await ctx.agents.resume({ agentId: AgentId('r1'), resumeSessionId: SessionId('old-sess') })
    expect(resumed.agent.id).toBe('r1')
    expect(calls.resume).toHaveLength(1)
    expect(calls.resume[0]!.ownerCtx.fiber).toBe(ctx.fiber)
    expect(calls.resume[0]!.options).toEqual({ agentId: AgentId('r1'), resumeSessionId: SessionId('old-sess') })
  })

  it('passes the calling fiber to a plain factory for create and resume ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const { factory, calls } = stubFactory()
    ctx.agents.setFactory(factory)
    let callerFiber: Context['fiber'] | undefined

    const owner = await ctx.plugin(Object.assign(async (inner: Context) => {
      callerFiber = inner.fiber
      await inner.agents.create({ agentId: AgentId('owned-create'), sessionId: SessionId('owned-session') })
      await inner.agents.resume({ agentId: AgentId('owned-resume'), resumeSessionId: SessionId('persisted') })
    }, { inject: ['agents'] }))

    expect(calls.create[0]!.ownerCtx.fiber).toBe(callerFiber)
    expect(calls.resume[0]!.ownerCtx.fiber).toBe(callerFiber)
    await owner.dispose()
  })

  it('captures factory callbacks once while retaining the intentional target receiver', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const reads = { create: 0, resume: 0 }
    const receivers: unknown[] = []
    const replacements: string[] = []
    const target = { label: 'accepted-target' } as { label: string } & AgentFactory

    Object.defineProperties(target, {
      createAgent: {
        configurable: true,
        get() {
          reads.create += 1
          return function (this: typeof target, _ownerCtx: Context, options: CreateAgentOptions) {
            receivers.push(this)
            return Promise.resolve({ agent: stubAgent(options.agentId), dispose: () => Promise.resolve() })
          }
        },
      },
      resume: {
        configurable: true,
        get() {
          reads.resume += 1
          return function (this: typeof target, _ownerCtx: Context, options: ResumeAgentOptions) {
            receivers.push(this)
            return Promise.resolve({ agent: stubAgent(options.agentId), dispose: () => Promise.resolve() })
          }
        },
      },
    })

    ctx.agents.setFactory(target)
    Object.defineProperties(target, {
      createAgent: {
        value: () => {
          replacements.push('create')
          return Promise.resolve({ agent: stubAgent('replacement'), dispose: () => Promise.resolve() })
        },
      },
      resume: {
        value: () => {
          replacements.push('resume')
          return Promise.resolve({ agent: stubAgent('replacement'), dispose: () => Promise.resolve() })
        },
      },
    })

    await ctx.agents.create({ agentId: AgentId('captured-create'), sessionId: SessionId('captured-session') })
    await ctx.agents.resume({ agentId: AgentId('captured-resume'), resumeSessionId: SessionId('captured-persisted') })

    expect(reads).toEqual({ create: 1, resume: 1 })
    expect(receivers).toEqual([target, target])
    expect(replacements).toEqual([])
  })

  it('reserves the factory slot before reading reentrant callback accessors', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const nested = stubFactory().factory
    const reads: string[] = []
    const reentrantCreate: Promise<unknown>[] = []
    const target = {} as AgentFactory

    Object.defineProperties(target, {
      createAgent: {
        get() {
          reads.push('createAgent')
          expect(() => ctx.agents.setFactory(nested)).toThrow(/already registered/)
          reentrantCreate.push(ctx.agents.create({
            agentId: AgentId('during-acceptance'),
            sessionId: SessionId('during-acceptance-session'),
          }))
          return (_ownerCtx: Context, options: CreateAgentOptions) => Promise.resolve({
            agent: stubAgent(options.agentId),
            dispose: () => Promise.resolve(),
          })
        },
      },
      resume: {
        get() {
          reads.push('resume')
          return (_ownerCtx: Context, options: ResumeAgentOptions) => Promise.resolve({
            agent: stubAgent(options.agentId),
            dispose: () => Promise.resolve(),
          })
        },
      },
    })

    ctx.agents.setFactory(target)
    expect(reentrantCreate).toHaveLength(1)
    await expect(Promise.all(reentrantCreate)).rejects.toThrow(/no agent factory/)
    await expect(ctx.agents.create({
      agentId: AgentId('after-acceptance'),
      sessionId: SessionId('after-acceptance-session'),
    })).resolves.toMatchObject({ agent: { id: 'after-acceptance' } })
    expect(reads).toEqual(['createAgent', 'resume'])
  })

  it('validates the complete factory shape when accepting it', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)

    expect(() => ctx.agents.setFactory(null as unknown as AgentFactory)).toThrow(/non-null object or function/)
    expect(() => ctx.agents.setFactory(42 as unknown as AgentFactory)).toThrow(/non-null object or function/)
    expect(() => ctx.agents.setFactory({ resume() { return Promise.resolve() } } as unknown as AgentFactory))
      .toThrow(/createAgent must be a function/)
    expect(() => ctx.agents.setFactory({ createAgent() { return Promise.resolve() } } as unknown as AgentFactory))
      .toThrow(/resume must be a function/)

    const callable = Object.assign(() => undefined, stubFactory().factory)
    const dispose = ctx.agents.setFactory(callable)
    await expect(ctx.agents.create({ agentId: AgentId('callable'), sessionId: SessionId('callable-session') }))
      .resolves.toBeDefined()
    await dispose()
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

  it('canonicalizes an already traced Service factory before caller retracing', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const states = new WeakMap<object, string[]>()
    class TracedFactory extends Service implements AgentFactory {
      constructor(inner: Context) {
        super(inner, 'tracedFactory')
        states.set(this, [])
      }

      private calls(): string[] {
        const original = (this as unknown as { [symbols.original]?: TracedFactory })[symbols.original] ?? this
        const calls = states.get(original)
        if (calls === undefined) throw new Error('factory receiver did not canonicalize to the raw service')
        return calls
      }

      createAgent(_ownerCtx: Context, options: CreateAgentOptions) {
        this.calls().push('create')
        return Promise.resolve({ agent: stubAgent(options.agentId), dispose: () => Promise.resolve() })
      }

      resume(_ownerCtx: Context, options: ResumeAgentOptions) {
        this.calls().push('resume')
        return Promise.resolve({ agent: stubAgent(options.agentId), dispose: () => Promise.resolve() })
      }
    }
    await ctx.plugin(TracedFactory)
    const traced = (ctx as Context & { tracedFactory: TracedFactory }).tracedFactory
    ctx.agents.setFactory(traced)

    await ctx.agents.create({ agentId: AgentId('traced-create'), sessionId: SessionId('traced-session') })
    await ctx.agents.resume({ agentId: AgentId('traced-resume'), resumeSessionId: SessionId('traced-persisted') })
    const raw = (traced as unknown as { [symbols.original]?: TracedFactory })[symbols.original]
    expect(states.get(raw!)).toEqual(['create', 'resume'])
  })

  it('rolls back register and factory acceptance when their owner unloads reentrantly', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    let ownerCtx!: Context
    const owner = await ctx.plugin(Object.assign((inner: Context) => { ownerCtx = inner }, { inject: ['agents'] }))
    const agent = stubAgent('register-unload-race')
    ctx.on('agent/created', (created) => {
      if (created === agent) void owner.dispose()
    })

    ownerCtx.agents.register(agent)
    await owner.dispose()
    expect(ctx.agents.get(agent.id)).toBeUndefined()

    let factoryOwnerCtx!: Context
    const factoryOwner = await ctx.plugin(Object.assign((inner: Context) => { factoryOwnerCtx = inner }, { inject: ['agents'] }))
    const target = {} as AgentFactory
    Object.defineProperties(target, {
      createAgent: {
        get() {
          void factoryOwner.dispose()
          return (_inner: Context, options: CreateAgentOptions) => Promise.resolve({
            agent: stubAgent(options.agentId),
            dispose: () => Promise.resolve(),
          })
        },
      },
      resume: {
        value: (_inner: Context, options: ResumeAgentOptions) => Promise.resolve({
          agent: stubAgent(options.agentId),
          dispose: () => Promise.resolve(),
        }),
      },
    })
    factoryOwnerCtx.agents.setFactory(target)
    await factoryOwner.dispose()
    await expect(ctx.agents.create({ agentId: AgentId('after-owner'), sessionId: SessionId('after-owner-s') }))
      .rejects.toThrow(/no agent factory/)
  })
})
