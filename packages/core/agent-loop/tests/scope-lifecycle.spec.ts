import { describe, expect, it } from 'vitest'
import { Context, symbols, type EffectMeta, type Fiber } from 'cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import AgentLoop, { ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harnessWithLoop(adapter: MockAdapter = new MockAdapter([textResponse('ok')])): Promise<{ ctx: Context; loopFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, loopFiber }
}

async function harness(adapter: MockAdapter = new MockAdapter([textResponse('ok')])): Promise<Context> {
  return (await harnessWithLoop(adapter)).ctx
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

/** Throw an arbitrary callback value to exercise the public unknown-error boundary. */
function throwUnknown(value: unknown): never {
  throw value
}

/** Invoke the exact lifecycle effect to exercise same-stack reentrant teardown. */
function disposeCurrentLifecycle(ownerCtx: Context): void {
  const lifecycle = [...ownerCtx.fiber._disposables]
    .find((dispose) => {
      const effect = (dispose as typeof dispose & { [symbols.effect]?: EffectMeta })[symbols.effect]
      return effect?.label.startsWith('agentLoop.lifecycle(') === true
    })
  if (lifecycle === undefined) throw new Error('agent lifecycle effect not found')
  void lifecycle()
}

describe('agent scope lifecycle', () => {
  it('rejects an already-aborted creation signal before publishing either identity', async () => {
    const ctx = await harness()
    const reason = new Error('cancelled before creation')
    const controller = new AbortController()
    controller.abort(reason)

    await expect(ctx.agents.create({
      agentId: AgentId('pre-aborted'),
      sessionId: SessionId('pre-aborted-s'),
      signal: controller.signal,
    })).rejects.toBe(reason)

    expect(ctx.agents.get(AgentId('pre-aborted'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('pre-aborted-s'))).toBeUndefined()

    const valueController = new AbortController()
    valueController.abort('plain cancellation reason')
    await expect(ctx.agents.create({
      agentId: AgentId('pre-aborted-value'),
      sessionId: SessionId('pre-aborted-value-s'),
      signal: valueController.signal,
    })).rejects.toMatchObject({
      message: 'agent "pre-aborted-value" creation aborted',
      cause: 'plain cancellation reason',
    })

    expect(ctx.agents.get(AgentId('pre-aborted-value'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('pre-aborted-value-s'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('joins cleanup when an abort lands reentrantly during scope preparation', async () => {
    const ctx = await harness()
    const reason = new Error('cancelled while preparing')
    const controller = new AbortController()
    let aborted = false
    ctx.on('internal/plugin', (fiber) => {
      if (aborted || fiber.name !== 'scope') return
      aborted = true
      controller.abort(reason)
    })

    await expect(ctx.agents.create({
      agentId: AgentId('prepare-abort'),
      sessionId: SessionId('prepare-abort-s'),
      signal: controller.signal,
    })).rejects.toBe(reason)

    expect(ctx.agents.get(AgentId('prepare-abort'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('prepare-abort-s'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('normalizes non-Error create failures for rollback while rethrowing the original value', async () => {
    const ctx = await harness()
    let thrown: unknown
    ctx.on('session/created', () => {
      if (thrown === undefined) return
      const value = thrown
      thrown = undefined
      throwUnknown(value)
    })

    const createFailure = { source: 'create' }
    thrown = createFailure
    let createCaught: unknown
    try {
      ctx.agentLoop.create(AgentId('unknown-create'))
    } catch (error: unknown) {
      createCaught = error
    }
    expect(createCaught).toBe(createFailure)

    const ownedFailure = { source: 'createAgent' }
    thrown = ownedFailure
    await expect(ctx.agents.create({
      agentId: AgentId('unknown-owned-create'),
      sessionId: SessionId('unknown-owned-create-s'),
    })).rejects.toBe(ownedFailure)

    expect(ctx.agents.get(AgentId('unknown-create'))).toBeUndefined()
    expect(ctx.agents.get(AgentId('unknown-owned-create'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

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
    gate.resolve(undefined)
    const handle = await creating
    expect(handle.agent.options).toBe(acceptedOptions)
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

  it('lets the final enter arbitrate unsupported concurrent same-id creation and rolls the loser back', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<undefined>()
    const bothStarted = Promise.withResolvers<undefined>()
    let started = 0
    const setup = async (): Promise<void> => {
      started += 1
      if (started === 2) bothStarted.resolve(undefined)
      await gate.promise
    }
    const agentId = AgentId('concurrent-final-enter')
    const first = ctx.agents.create({
      agentId,
      sessionId: SessionId('concurrent-final-enter-a'),
      agentOptions: { model: 'mock' },
      setup,
    })
    const second = ctx.agents.create({
      agentId,
      sessionId: SessionId('concurrent-final-enter-b'),
      agentOptions: { model: 'mock' },
      setup,
    })
    await bothStarted.promise
    expect(ctx.agents.list()).toEqual([])
    expect(ctx.sessions.list()).toEqual([])

    gate.resolve(undefined)
    const outcomes = await Promise.allSettled([first, second])
    const fulfilled = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<typeof first>> => outcome.status === 'fulfilled')
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0]!.reason)).toMatch(/already registered/)
    expect(ctx.agents.list()).toEqual([fulfilled[0]!.value.agent])
    expect(ctx.sessions.list()).toEqual([fulfilled[0]!.value.agent.session])

    await fulfilled[0]!.value.dispose()
    expect(ctx.agents.list()).toEqual([])
    expect(ctx.sessions.list()).toEqual([])
  })

  it('uses signal only for creation: aborts pending setup but not a returned live handle', async () => {
    const ctx = await harness()
    const pendingController = new AbortController()
    const setupStarted = Promise.withResolvers<undefined>()
    const pending = ctx.agents.create({
      agentId: AgentId('signal-pending'),
      sessionId: SessionId('signal-pending-s'),
      agentOptions: { model: 'mock' },
      signal: pendingController.signal,
      setup: async () => {
        setupStarted.resolve(undefined)
        await new Promise<never>(() => {})
      },
    })
    await setupStarted.promise
    pendingController.abort(new Error('cancel pending creation'))
    await expect(pending).rejects.toThrow('cancel pending creation')
    expect(ctx.agents.get(AgentId('signal-pending'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('signal-pending-s'))).toBeUndefined()

    const liveController = new AbortController()
    const live = await ctx.agents.create({
      agentId: AgentId('signal-live'),
      sessionId: SessionId('signal-live-s'),
      agentOptions: { model: 'mock' },
      signal: liveController.signal,
    })
    liveController.abort(new Error('too late'))
    await Promise.resolve()
    expect(ctx.agents.get(live.agent.id)).toBe(live.agent)
    expect(live.agent.status).toBe('idle')
    await live.dispose()
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

  it('an AgentLoop unload aborts pending setup, awaits cleanup, and releases both ids', async () => {
    const { ctx, loopFiber } = await harnessWithLoop()
    const gate = Promise.withResolvers<undefined>()
    const setupStarted = Promise.withResolvers<undefined>()
    const published: string[] = []
    ctx.on('session/created', () => void published.push('session/created'))
    ctx.on('agent/created', () => void published.push('agent/created'))

    const creating = ctx.agents.create({
      agentId: AgentId('factory-setup-race'),
      sessionId: SessionId('factory-setup-race-s'),
      agentOptions: { model: 'mock' },
      setup: async () => {
        setupStarted.resolve(undefined)
        await gate.promise
      },
    })
    await setupStarted.promise

    await loopFiber.dispose()
    await expect(creating).rejects.toThrow(/agent loop is not active/)
    expect(published).toEqual([])
    expect(ctx.agents.get(AgentId('factory-setup-race'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('factory-setup-race-s'))).toBeUndefined()

    gate.resolve(undefined)
    await ctx.fiber.dispose()
  })

  it('factory unload during scope minting skips setup and awaits provisional cleanup', async () => {
    const { ctx, loopFiber } = await harnessWithLoop()
    let unloaded = false
    let setupCalls = 0
    ctx.on('internal/plugin', (fiber) => {
      if (unloaded || fiber.name !== 'scope') return
      unloaded = true
      void loopFiber.dispose()
    })

    const creating = ctx.agents.create({
      agentId: AgentId('factory-scope-race'),
      sessionId: SessionId('factory-scope-race-s'),
      agentOptions: { model: 'mock' },
      setup: () => { setupCalls += 1 },
    })
    await expect(creating).rejects.toThrow(/agent loop is not active/)
    await loopFiber.dispose()
    expect(setupCalls).toBe(0)
    expect(ctx.agents.get(AgentId('factory-scope-race'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('factory-scope-race-s'))).toBeUndefined()

    await ctx.fiber.dispose()
  })

  it('caller unload during scope minting owns and drains the half-built child', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<undefined>()
    const cleanupStarted = Promise.withResolvers<undefined>()
    let ownerFiber!: Fiber
    let ownerDisposal!: Promise<void>
    let scopeFiber: Fiber | undefined
    let creating!: ReturnType<typeof ctx.agents.create>
    ctx.on('internal/plugin', (fiber) => {
      if (fiber.name !== 'scope' || scopeFiber !== undefined) return
      scopeFiber = fiber
      fiber.ctx.effect(() => async () => {
        cleanupStarted.resolve(undefined)
        await gate.promise
      })
      ownerDisposal = ownerFiber.dispose()
    })

    const owner = ctx.plugin(Object.assign((inner: Context) => {
      ownerFiber = inner.fiber
      creating = inner.agents.create({
        agentId: AgentId('caller-scope-race'),
        sessionId: SessionId('caller-scope-race-s'),
        agentOptions: { model: 'mock' },
      })
    }, { inject: ['agents'] }))

    await cleanupStarted.promise
    let ownerSettled = false
    void ownerDisposal.then(() => { ownerSettled = true })
    await Promise.resolve()
    expect(ownerSettled).toBe(false)
    gate.resolve(undefined)
    await expect(creating).rejects.toThrow(/owner disposed during setup/)
    await ownerDisposal
    await owner
    expect(scopeFiber?.uid).toBeNull()
    expect(ctx.agents.get(AgentId('caller-scope-race'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('caller-scope-race-s'))).toBeUndefined()
    await owner.dispose()
    await ctx.fiber.dispose()
  })

  it('synchronous create rechecks provider liveness before its first publication edge', async () => {
    const { ctx, loopFiber } = await harnessWithLoop()
    const sessionsBefore = ctx.sessions.list().length
    let unloaded = false
    ctx.on('internal/plugin', (fiber) => {
      if (unloaded || fiber.name !== 'scope') return
      unloaded = true
      void loopFiber.dispose()
    })

    expect(() => ctx.agentLoop.create(AgentId('config-scope-race'), { model: 'mock' }))
      .toThrow(/agent loop is not active/)
    await loopFiber.dispose()
    expect(ctx.agents.get(AgentId('config-scope-race'))).toBeUndefined()
    expect(ctx.sessions.list()).toHaveLength(sessionsBefore)
    await ctx.fiber.dispose()
  })

  it('synchronous create leaves no lifecycle state when session preparation fails', async () => {
    const ctx = await harness()
    const id = AgentId('config-prepare-failure')

    expect(() => ctx.agentLoop.create(id, { model: 'mock' }, { cwd: 'relative' }))
      .toThrow(/absolute path/)
    const replacement = ctx.agentLoop.create(id, { model: 'mock' }, { cwd: '/recovered' })
    expect(ctx.agents.get(id)).toBe(replacement)
    await replacement.whenIdle()
    await ctx.fiber.dispose()
  })

  it('factory unload awaits provisional cleanup when scope preparation throws', async () => {
    const { ctx, loopFiber } = await harnessWithLoop()
    let triggered = false
    ctx.on('internal/plugin', (fiber) => {
      if (triggered || fiber.name !== 'scope') return
      triggered = true
      void loopFiber.dispose()
      throw new Error('scope preparation failed')
    })

    await expect(ctx.agents.create({
      agentId: AgentId('factory-scope-throw'),
      sessionId: SessionId('factory-scope-throw-s'),
      agentOptions: { model: 'mock' },
    })).rejects.toThrow('scope preparation failed')
    await loopFiber.dispose()
    expect(ctx.agents.get(AgentId('factory-scope-throw'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('factory-scope-throw-s'))).toBeUndefined()

    await ctx.fiber.dispose()
  })

  it('AgentLoop unload is a structural co-owner of every live programmatic agent', async () => {
    const { ctx, loopFiber } = await harnessWithLoop()
    const loop = ctx.agentLoop
    const agentId = AgentId('factory-live')
    const handle = await ctx.agents.create({
      agentId,
      sessionId: SessionId('factory-live-s'),
      agentOptions: { model: 'mock' },
    })

    await loopFiber.dispose()
    expect(handle.agent.status).toBe('disposed')
    expect(ctx.agents.get(agentId)).toBeUndefined()
    expect(ctx.sessions.get(SessionId('factory-live-s'))).toBeUndefined()
    expect(ctx.fiber.getEffects().filter(effect => effect.label === `agentLoop.owner(${agentId})`)).toEqual([])
    // The consumer handle shares the provider's completed quiescence boundary.
    await handle.dispose()

    await expect(loop.createAgent(ctx, {
      agentId: AgentId('factory-inactive'),
      sessionId: SessionId('factory-inactive-s'),
    })).rejects.toThrow('agent loop is not active')
    await ctx.fiber.dispose()
  })

  it('keeps AgentLoop dependencies available when the caller injects only agents', async () => {
    const ctx = await harness()
    let creating!: ReturnType<typeof ctx.agents.create>
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      creating = inner.agents.create({
        agentId: AgentId('dependency-origin'),
        sessionId: SessionId('dependency-origin-s'),
        agentOptions: { model: 'mock' },
        setup: (agentCtx) => {
          agentCtx.tools.register({
            name: 'dependency-origin-tool',
            description: 'proves AgentLoop dependency origin',
            parameters: {},
            execute: () => Promise.resolve(text('ok')),
          })
          agentCtx.systemPrompt.section({
            name: 'dependency-origin-section',
            order: 1,
            text: 'factory dependency surface',
          })
        },
      })
    }, { inject: ['agents'] }))

    const handle = await creating
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(handle.agent))
    expect(assembly.tools.map(tool => tool.name)).toContain('dependency-origin-tool')
    expect(assembly.sections.map(section => section.name)).toContain('dependency-origin-section')
    await handle.dispose()
    await owner.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps both entries and the scope live through a reentrant session/created teardown', async () => {
    const ctx = await harness()
    let ownerCtx!: Context
    let creating!: ReturnType<typeof ctx.agents.create>
    const lifecycle: string[] = []
    ctx.on('session/created', (session) => {
      if (session.id !== SessionId('session-created-barrier-s')) return
      lifecycle.push('session-created:dispose')
      disposeCurrentLifecycle(ownerCtx)
    })
    ctx.on('session/created', (session) => {
      if (session.id !== SessionId('session-created-barrier-s')) return
      const agent = ctx.agents.get(AgentId('session-created-barrier'))!
      expect(ctx.sessions.get(session.id)).toBe(session)
      expect(agent.session).toBe(session)
      agent.ctx.effect(() => () => { lifecycle.push('scope-disposed') })
      lifecycle.push('session-created:observer')
    })
    ctx.on('agent/created', () => void lifecycle.push('agent-created'))
    ctx.on('agent/disposed', () => void lifecycle.push('agent-disposed'))
    ctx.on('session/disposed', (session) => {
      if (session.id === SessionId('session-created-barrier-s')) lifecycle.push('session-disposed')
    })

    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      ownerCtx = inner
      creating = inner.agents.create({
        agentId: AgentId('session-created-barrier'),
        sessionId: SessionId('session-created-barrier-s'),
        agentOptions: { model: 'mock' },
      })
    }, { inject: ['agents'] }))

    await expect(creating).rejects.toThrow(/lifecycle disposed/)
    await owner.dispose()
    expect(lifecycle).toEqual([
      'session-created:dispose',
      'session-created:observer',
      'session-disposed',
      'scope-disposed',
    ])
    expect(ctx.agents.get(AgentId('session-created-barrier'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('session-created-barrier-s'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('keeps both entries and the scope live through a reentrant agent/created teardown', async () => {
    const ctx = await harness()
    let ownerCtx!: Context
    let creating!: ReturnType<typeof ctx.agents.create>
    const lifecycle: string[] = []
    ctx.on('session/created', (session) => {
      if (session.id === SessionId('agent-created-barrier-s')) lifecycle.push('session-created')
    })
    ctx.on('agent/created', (agent) => {
      if (agent.id !== AgentId('agent-created-barrier')) return
      lifecycle.push('agent-created:dispose')
      disposeCurrentLifecycle(ownerCtx)
    })
    ctx.on('agent/created', (agent) => {
      if (agent.id !== AgentId('agent-created-barrier')) return
      expect(ctx.agents.get(agent.id)).toBe(agent)
      expect(ctx.sessions.get(agent.session.id)).toBe(agent.session)
      agent.ctx.effect(() => () => { lifecycle.push('scope-disposed') })
      lifecycle.push('agent-created:observer')
    })
    ctx.on('agent/disposed', (agent) => {
      if (agent.id === AgentId('agent-created-barrier')) lifecycle.push('agent-disposed')
    })
    ctx.on('session/disposed', (session) => {
      if (session.id === SessionId('agent-created-barrier-s')) lifecycle.push('session-disposed')
    })

    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      ownerCtx = inner
      creating = inner.agents.create({
        agentId: AgentId('agent-created-barrier'),
        sessionId: SessionId('agent-created-barrier-s'),
        agentOptions: { model: 'mock' },
      })
    }, { inject: ['agents'] }))

    await expect(creating).rejects.toThrow(/lifecycle disposed/)
    await owner.dispose()
    expect(lifecycle).toEqual([
      'session-created',
      'agent-created:dispose',
      'agent-created:observer',
      'agent-disposed',
      'session-disposed',
      'scope-disposed',
    ])
    expect(ctx.agents.get(AgentId('agent-created-barrier'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('agent-created-barrier-s'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('rechecks caller liveness after creation listeners before unlocking the driver', async () => {
    const ctx = await harness()
    const starts: string[] = []
    let ownerCtx!: Context
    let creating!: ReturnType<typeof ctx.agents.create>
    ctx.on('agent/session-start', agent => void starts.push(agent.id))
    ctx.on('agent/created', (agent) => {
      if (agent.id === AgentId('listener-dispose')) void ownerCtx.fiber.dispose()
    })

    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      ownerCtx = inner
      creating = inner.agents.create({
        agentId: AgentId('listener-dispose'),
        sessionId: SessionId('listener-dispose-s'),
        agentOptions: { model: 'mock' },
      })
    }, { inject: ['agents'] }))

    await expect(creating).rejects.toThrow(/owner disposed during setup/)
    await owner.dispose()
    expect(starts).toEqual([])
    expect(ctx.agents.get(AgentId('listener-dispose'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('listener-dispose-s'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('rechecks caller liveness after session-start before starting the driver', async () => {
    const ctx = await harness()
    let ownerCtx!: Context
    let creating!: ReturnType<typeof ctx.agents.create>
    let announced!: ReactLoopAgent
    const statuses: string[] = []
    let scopeDisposed = false
    let observerSawLive = false
    ctx.on('agent/status', (agent, status) => {
      if (agent.id === AgentId('session-start-dispose')) statuses.push(status)
    })
    ctx.on('agent/session-start', (agent) => {
      if (agent.id !== AgentId('session-start-dispose')) return
      announced = agent as ReactLoopAgent
      disposeCurrentLifecycle(ownerCtx)
    })
    ctx.on('agent/session-start', (agent) => {
      if (agent.id !== AgentId('session-start-dispose')) return
      expect(ctx.agents.get(agent.id)).toBe(agent)
      expect(ctx.sessions.get(agent.session.id)).toBe(agent.session)
      agent.ctx.effect(() => () => { scopeDisposed = true })
      observerSawLive = true
    })

    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      ownerCtx = inner
      creating = inner.agents.create({
        agentId: AgentId('session-start-dispose'),
        sessionId: SessionId('session-start-dispose-s'),
        agentOptions: { model: 'mock' },
      })
    }, { inject: ['agents'] }))

    await expect(creating).rejects.toThrow(/lifecycle disposed/)
    await owner.dispose()
    expect(announced.status).toBe('disposed')
    expect(statuses).toEqual(['disposed'])
    expect(observerSawLive).toBe(true)
    expect(scopeDisposed).toBe(true)
    expect(announced.session.events).toEqual([])
    expect(ctx.agents.get(AgentId('session-start-dispose'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('session-start-dispose-s'))).toBeUndefined()
    await ctx.fiber.dispose()
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

  it('rejects an exotic durable seed before publishing either identity', async () => {
    const ctx = await harness()
    const published: string[] = []
    ctx.on('session/created', () => { published.push('session') })
    ctx.on('agent/created', () => { published.push('agent') })
    class ExoticData { readonly value = 'not durable JSON' }
    const seed = [{
      seq: 0,
      type: 'test/exotic-seed',
      data: new ExoticData(),
    }] as unknown as SessionEvent[]

    await expect(ctx.agents.create({
      agentId: AgentId('exotic-seed'),
      sessionId: SessionId('exotic-seed-session'),
      agentOptions: { model: 'mock' },
      seed,
    })).rejects.toThrow(/seed event at index 0 is not losslessly JSON-serializable/)

    expect(published).toEqual([])
    expect(ctx.agents.get(AgentId('exotic-seed'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('exotic-seed-session'))).toBeUndefined()
    const retry = await ctx.agents.create({
      agentId: AgentId('exotic-seed'),
      sessionId: SessionId('exotic-seed-session'),
      agentOptions: { model: 'mock' },
    })
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

  it('pairs session and agent announcements when agent creation aborts publication', async () => {
    const ctx = await harness()
    const lifecycle: string[] = []
    ctx.on('session/created', (session) => { lifecycle.push(`session-created:${session.id}`) })
    ctx.on('session/disposed', (session) => { lifecycle.push(`session-disposed:${session.id}`) })
    ctx.on('agent/created', (agent) => {
      lifecycle.push(`agent-created:${agent.id}`)
      throw new Error('agent observer failed')
    })
    ctx.on('agent/disposed', (agent) => { lifecycle.push(`agent-disposed:${agent.id}`) })

    await expect(ctx.agents.create({
      agentId: AgentId('partial-agent'),
      sessionId: SessionId('partial-session'),
      agentOptions: { model: 'mock' },
    })).rejects.toThrow('agent observer failed')

    expect(lifecycle).toEqual([
      'session-created:partial-session',
      'agent-created:partial-agent',
      'agent-disposed:partial-agent',
      'session-disposed:partial-session',
    ])
    expect(ctx.agents.get(AgentId('partial-agent'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('partial-session'))).toBeUndefined()
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

  it('successful handle disposal retires its caller ownership effect', async () => {
    const ctx = await harness()
    const agentId = AgentId('retired-owner-effect')
    const handle = await ctx.agents.create({
      agentId,
      sessionId: SessionId('retired-owner-effect-s'),
      agentOptions: { model: 'mock' },
    })

    expect(ctx.fiber.getEffects().map(effect => effect.label)).toContain(`agentLoop.owner(${agentId})`)
    await handle.dispose()
    expect(ctx.fiber.getEffects().filter(effect => effect.label === `agentLoop.owner(${agentId})`)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('owner unload after handle-first teardown follows the same in-flight boundary', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<undefined>()
    const cleanupStarted = Promise.withResolvers<undefined>()
    let handle!: Awaited<ReturnType<typeof ctx.agents.create>>
    const owner = await ctx.plugin(Object.assign(async (inner: Context) => {
      handle = await inner.agents.create({
        agentId: AgentId('manual-first'),
        sessionId: SessionId('manual-first-s'),
        agentOptions: { model: 'mock' },
        setup(agentCtx) {
          agentCtx.effect(() => async () => {
            cleanupStarted.resolve(undefined)
            await gate.promise
          })
        },
      })
    }, { inject: ['agents'] }))

    const disposing = handle.dispose()
    await cleanupStarted.promise
    let ownerSettled = false
    const unloading = owner.dispose().then(() => { ownerSettled = true })
    await Promise.resolve()
    expect(ownerSettled).toBe(false)
    gate.resolve(undefined)
    await Promise.all([disposing, unloading])
    expect(ctx.agents.get(AgentId('manual-first'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('manual-first-s'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('reopens ids after detach while the prior private scope finishes quiescing', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<undefined>()
    const cleanupStarted = Promise.withResolvers<undefined>()
    const sessionDisposed = Promise.withResolvers<undefined>()
    const agentId = AgentId('quiescent-reuse')
    const sessionId = SessionId('quiescent-reuse-s')
    ctx.on('session/disposed', (session) => {
      if (session.id === sessionId) sessionDisposed.resolve(undefined)
    })
    const first = await ctx.agents.create({
      agentId,
      sessionId,
      agentOptions: { model: 'mock' },
      setup(agentCtx) {
        agentCtx.effect(() => async () => {
          cleanupStarted.resolve(undefined)
          await gate.promise
        })
      },
    })

    const disposing = first.dispose()
    await Promise.all([sessionDisposed.promise, cleanupStarted.promise])
    expect(ctx.agents.get(agentId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    const replacement = await ctx.agents.create({ agentId, sessionId, agentOptions: { model: 'mock' } })
    expect(ctx.agents.get(agentId)).toBe(replacement.agent)
    expect(ctx.sessions.get(sessionId)).toBe(replacement.agent.session)

    gate.resolve(undefined)
    await disposing
    await replacement.dispose()
    await ctx.fiber.dispose()
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
