import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { AgentId, type Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import SubagentService, {
  SubagentError,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'

/** A minimal parent Agent stand-in — the service only reads `parent.id`. */
function fakeParent(id = 'parent-1'): Agent {
  return { id: AgentId(id) } as unknown as Agent
}

const ALL_CAPS: SubagentCapabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: false }
const NO_CAPS: SubagentCapabilities = { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }

/** A scripted provider whose run settles immediately with a fixed result. */
class StubProvider implements SubagentProvider {
  startCount = 0
  readonly inheritsParentContext = false
  constructor(
    readonly name: string,
    readonly capabilities: SubagentCapabilities = ALL_CAPS,
    private readonly result: SubagentResult = { output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' },
  ) {}

  start(request: SubagentStartRequest): SubagentRun {
    this.startCount++
    return {
      id: AgentId(`child:${this.name}:${request.parent.id}`),
      started: Promise.resolve(),
      result: Promise.resolve(this.result),
      cancel() {},
      async dispose() {},
    }
  }
}

function baseRequest(overrides: Partial<SubagentStartRequest> = {}): SubagentStartRequest {
  return { prompt: [{ type: 'text', text: 'do a thing' }], parent: fakeParent(), ...overrides }
}

describe('SubagentService', () => {
  it('announces provider lifecycle: added on register, removed on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const added: string[] = []
    const removed: string[] = []
    ctx.on('subagent/provider-added', provider => void added.push(provider.name))
    ctx.on('subagent/provider-removed', name => void removed.push(name))

    const dispose = ctx.subagents.registerProvider(new StubProvider('alpha'))
    expect(added).toEqual(['alpha'])
    expect(removed).toEqual([])

    await dispose()
    expect(removed).toEqual(['alpha'])
  })

  it('rolls back the registration when a provider-added listener throws', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    let threw = false
    const off = ctx.on('subagent/provider-added', () => {
      if (!threw) { threw = true; throw new Error('boom added listener') }
    })

    expect(() => ctx.subagents.registerProvider(new StubProvider('alpha'))).toThrow('boom added listener')
    expect(ctx.subagents.getProvider('alpha')).toBeUndefined() // nothing leaked

    off()
    ctx.subagents.registerProvider(new StubProvider('alpha'))
    expect(ctx.subagents.getProvider('alpha')).toBeDefined()
  })

  it('contains a throwing provider-removed listener: later mirrors still hear it, teardown completes', async () => {
    // provider-removed fires inside the registration's DISPOSER, so a
    // propagating listener would disrupt the backend's teardown; and cordis
    // emit halts on the first throw, so an uncontained one would starve every
    // mirror registered after it (a stale model-facing tool). Both are
    // prevented by per-listener containment.
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => void warnings.push(String(message))) as typeof ctx.logger.warn
    ctx.on('subagent/provider-removed', () => { throw new Error('boom removed listener') })
    const heard: string[] = []
    ctx.on('subagent/provider-removed', name => void heard.push(name))

    const dispose = ctx.subagents.registerProvider(new StubProvider('alpha'))
    expect(() => void dispose()).not.toThrow()
    expect(heard).toEqual(['alpha']) // the listener AFTER the thrower still ran
    expect(ctx.subagents.getProvider('alpha')).toBeUndefined() // teardown reached quiescence
    expect(warnings.some(w => w.includes('boom removed listener'))).toBe(true)
  })

  it('registers a provider and starts a run on it by name', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const provider = new StubProvider('alpha')
    ctx.subagents.registerProvider(provider)

    expect(ctx.subagents.list()).toEqual(['alpha'])
    expect(ctx.subagents.getProvider('alpha')).toMatchObject({ name: 'alpha' })

    const run = ctx.subagents.start('alpha', baseRequest())
    expect(provider.startCount).toBe(1)
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
  })

  it('lets multiple providers coexist (the defining requirement)', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider(new StubProvider('spawn'))
    ctx.subagents.registerProvider(new StubProvider('acp'))

    expect(ctx.subagents.list()).toEqual(['spawn', 'acp'])
    expect(ctx.subagents.getProvider('spawn')).toBeDefined()
    expect(ctx.subagents.getProvider('acp')).toBeDefined()
  })

  it('throws NO_PROVIDER when starting on an unregistered name', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    try {
      ctx.subagents.start('missing', baseRequest())
      expect.fail('expected NO_PROVIDER')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(SubagentError)
      expect((error as SubagentError).code).toBe('NO_PROVIDER')
    }
  })

  it('rejects duplicate provider names with DUPLICATE_PROVIDER', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider(new StubProvider('dup'))
    try {
      ctx.subagents.registerProvider(new StubProvider('dup'))
      expect.fail('expected DUPLICATE_PROVIDER')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(SubagentError)
      expect((error as SubagentError).code).toBe('DUPLICATE_PROVIDER')
    }
  })

  it('claims wrapper disposal before a raw provider disposer can reenter it', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const observed: { reentrant?: Promise<void> } = {}
    const providerDispose = vi.fn(() => {
      observed.reentrant = run.dispose()
      return Promise.resolve()
    })
    ctx.subagents.registerProvider({
      name: 'dispose-reentry',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => ({
        id: AgentId('dispose-reentry-child'),
        started: Promise.resolve(),
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        cancel() {},
        dispose: providerDispose,
      }),
    })
    const run = ctx.subagents.start('dispose-reentry', baseRequest())

    const disposal = run.dispose()

    expect(observed.reentrant).toBe(disposal)
    await disposal
    expect(providerDispose).toHaveBeenCalledOnce()
  })

  it('rejects a raw disposer that directly returns its reentrant wrapper promise instead of hanging', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const providerDispose = vi.fn(() => run.dispose())
    ctx.subagents.registerProvider({
      name: 'dispose-self-cycle',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => ({
        id: AgentId('dispose-self-cycle-child'),
        started: Promise.resolve(),
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        cancel() {},
        dispose: providerDispose,
      }),
    })
    const run = ctx.subagents.start('dispose-self-cycle', baseRequest())

    await expect(run.dispose()).rejects.toThrow('run dispose returned its own wrapper disposal promise')
    expect(providerDispose).toHaveBeenCalledOnce()
  })

  it.each([
    { label: 'a non-string name', patch: { name: 42 }, message: 'name must be a string' },
    { label: 'null capabilities', patch: { capabilities: null }, message: 'capabilities must be an object' },
    { label: 'primitive capabilities', patch: { capabilities: 42 }, message: 'capabilities must be an object' },
    { label: 'array capabilities', patch: { capabilities: [] }, message: 'capabilities must be an object' },
    {
      label: 'a non-boolean outputSchema capability',
      patch: { capabilities: { ...NO_CAPS, outputSchema: 'yes' } },
      message: 'capability "outputSchema" must be a boolean',
    },
    {
      label: 'a non-boolean depthLimit capability',
      patch: { capabilities: { ...NO_CAPS, depthLimit: 'yes' } },
      message: 'capability "depthLimit" must be a boolean',
    },
    {
      label: 'a non-boolean toolFilter capability',
      patch: { capabilities: { ...NO_CAPS, toolFilter: 'yes' } },
      message: 'capability "toolFilter" must be a boolean',
    },
    {
      label: 'a non-boolean persona capability',
      patch: { capabilities: { ...NO_CAPS, persona: 'yes' } },
      message: 'capability "persona" must be a boolean',
    },
    { label: 'a non-boolean conversation-history descriptor', patch: { inheritsParentContext: 'yes' }, message: 'inheritsParentContext must be a boolean' },
    { label: 'a non-callable start field', patch: { start: 42 }, message: 'start must be a function' },
  ])('rejects a provider registration with $label before entering the registry', async ({ patch, message }) => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const provider = Object.assign(new StubProvider('invalid'), patch)

    expect(() => ctx.subagents.registerProvider(provider as unknown as SubagentProvider)).toThrow(message)
    expect(ctx.subagents.list()).toEqual([])
    expect(Object.isFrozen(provider)).toBe(false)
  })

  it('reads every registration field once and binds the accepted start callback to the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const reads = {
      name: 0,
      capabilities: 0,
      outputSchema: 0,
      depthLimit: 0,
      toolFilter: 0,
      persona: 0,
      inheritsParentContext: 0,
      start: 0,
    }
    const capabilities = Object.defineProperties({}, {
      outputSchema: { enumerable: true, get: () => { reads.outputSchema += 1; return false } },
      depthLimit: { enumerable: true, get: () => { reads.depthLimit += 1; return false } },
      toolFilter: { enumerable: true, get: () => { reads.toolFilter += 1; return false } },
      persona: { enumerable: true, get: () => { reads.persona += 1; return false } },
    }) as SubagentCapabilities
    const acceptedStart = function (this: SubagentProvider, request: SubagentStartRequest): SubagentRun {
      expect(this).toBe(provider)
      return {
        id: AgentId(`one-read:${request.parent.id}`),
        started: Promise.resolve(),
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        cancel() {},
        async dispose() {},
      }
    }
    const provider = Object.defineProperties({}, {
      name: { enumerable: true, get: () => { reads.name += 1; return 'one-read' } },
      capabilities: { enumerable: true, get: () => { reads.capabilities += 1; return capabilities } },
      inheritsParentContext: { enumerable: true, get: () => { reads.inheritsParentContext += 1; return false } },
      start: { enumerable: true, get: () => { reads.start += 1; return acceptedStart } },
    }) as SubagentProvider

    ctx.subagents.registerProvider(provider)
    await expect(ctx.subagents.start('one-read', baseRequest()).result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(reads).toEqual({
      name: 1,
      capabilities: 1,
      outputSchema: 1,
      depthLimit: 1,
      toolFilter: 1,
      persona: 1,
      inheritsParentContext: 1,
      start: 1,
    })
  })

  it('unregisters a provider when its owning fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.subagents.registerProvider(new StubProvider('scoped'))
    }, { inject: ['subagents'] }))
    expect(ctx.subagents.list()).toEqual(['scoped'])

    await fiber.dispose()
    expect(ctx.subagents.list()).toEqual([])
  })

  it('snapshots a provider registration so caller mutation cannot corrupt dispatch or HMR cleanup', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const capabilities: SubagentCapabilities = {
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    }
    const provider = new StubProvider('stable', capabilities)
    let capabilityReads = 0
    let capabilityValue = capabilities
    Object.defineProperty(provider, 'capabilities', {
      configurable: true,
      get: () => {
        capabilityReads += 1
        return capabilityValue
      },
      set: (value: SubagentCapabilities) => { capabilityValue = value },
    })
    const added: SubagentProvider[] = []
    const removed: string[] = []
    ctx.on('subagent/provider-added', registered => void added.push(registered))
    ctx.on('subagent/provider-removed', name => void removed.push(name))
    const owner = await ctx.plugin({
      name: 'mutable-provider-owner',
      inject: ['subagents'],
      apply(pluginCtx: Context) {
        pluginCtx.subagents.registerProvider(provider)
      },
    })
    expect(capabilityReads).toBe(1)
    const accepted = ctx.subagents.getProvider('stable')

    const mutable = provider as unknown as {
      name: string
      capabilities: SubagentCapabilities
      inheritsParentContext: boolean
      start: SubagentProvider['start']
    }
    mutable.name = 'mutated'
    capabilities.outputSchema = false
    capabilities.depthLimit = false
    capabilities.toolFilter = false
    capabilities.persona = false
    mutable.capabilities = NO_CAPS
    mutable.inheritsParentContext = true
    const replacementStart = vi.fn((_request: SubagentStartRequest): SubagentRun => {
      throw new Error('replacement start must not run')
    })
    mutable.start = replacementStart

    expect(added).toEqual([accepted])
    expect(accepted).not.toBe(provider)
    expect(Object.isFrozen(accepted)).toBe(true)
    expect(Object.isFrozen(accepted?.capabilities)).toBe(true)
    expect(accepted).toMatchObject({
      name: 'stable',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
    })
    expect(ctx.subagents.list()).toEqual(['stable'])
    expect(ctx.subagents.getProvider('mutated')).toBeUndefined()

    const controller = new AbortController()
    const run = ctx.subagents.start('stable', baseRequest({
      signal: controller.signal,
      agentOptions: { model: 'mock' },
      outputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
      maxDepth: 2,
      toolFilter: { deny: ['bash'] },
      persona: 'reviewer',
    }))
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(provider.startCount).toBe(1)
    expect(replacementStart).not.toHaveBeenCalled()

    await owner.dispose()
    expect(removed).toEqual(['stable'])
    expect(ctx.subagents.list()).toEqual([])
    expect(() => ctx.subagents.registerProvider(new StubProvider('stable'))).not.toThrow()
  })

  it('re-registers a name after its prior registration is disposed (not wedged)', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)

    const dispose = ctx.subagents.registerProvider(new StubProvider('reuse'))
    expect(ctx.subagents.list()).toEqual(['reuse'])
    await dispose()
    expect(ctx.subagents.list()).toEqual([])

    const disposeAgain = ctx.subagents.registerProvider(new StubProvider('reuse'))
    expect(ctx.subagents.list()).toEqual(['reuse'])
    await disposeAgain()
    expect(ctx.subagents.list()).toEqual([])
  })

  describe('start-time capability validation (fail loud, before any child)', () => {
    it.each([
      { field: 'outputSchema', request: baseRequest({ outputSchema: { type: 'object', properties: { x: { type: 'string' } } } }) },
      { field: 'maxDepth', request: baseRequest({ maxDepth: 2 }) },
      { field: 'toolFilter', request: baseRequest({ toolFilter: { deny: ['bash'] } }) },
    ])('rejects $field against a provider that lacks the capability — before start() runs', ({ request }) => {
      const ctx = new Context()
      return ctx.plugin(SubagentService).then(() => {
        const provider = new StubProvider('weak', NO_CAPS)
        ctx.subagents.registerProvider(provider)
        try {
          ctx.subagents.start('weak', request)
          expect.fail('expected UNSUPPORTED_CAPABILITY')
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(SubagentError)
          expect((error as SubagentError).code).toBe('UNSUPPORTED_CAPABILITY')
        }
        // The child was never started — the check is pre-spawn.
        expect(provider.startCount).toBe(0)
      })
    })

    it('allows a capability request when the provider supports it', async () => {
      const ctx = new Context()
      await ctx.plugin(SubagentService)
      const provider = new StubProvider('strong', ALL_CAPS)
      ctx.subagents.registerProvider(provider)
      ctx.subagents.start('strong', baseRequest({ outputSchema: { type: 'object', properties: { x: { type: 'string' } } }, maxDepth: 1 }))
      expect(provider.startCount).toBe(1)
    })

    it.each([
      { label: 'null', value: null as unknown as number },
      { label: 'a string', value: '1' as unknown as number },
      { label: 'NaN', value: Number.NaN },
      { label: 'positive infinity', value: Number.POSITIVE_INFINITY },
      { label: 'negative infinity', value: Number.NEGATIVE_INFINITY },
      { label: 'a fraction', value: 1.5 },
      { label: 'a negative integer', value: -1 },
      { label: 'negative zero', value: -0 },
      { label: 'an unsafe integer', value: Number.MAX_SAFE_INTEGER + 1 },
    ])('rejects maxDepth=$label before the provider starts', async ({ value }) => {
      const ctx = new Context()
      await ctx.plugin(SubagentService)
      const provider = new StubProvider('invalid-depth', ALL_CAPS)
      ctx.subagents.registerProvider(provider)

      expect(() => ctx.subagents.start('invalid-depth', baseRequest({ maxDepth: value })))
        .toThrow('subagent maxDepth must be a non-negative safe integer')
      expect(provider.startCount).toBe(0)
    })

    it('rejects a non-string persona before the provider starts', async () => {
      const ctx = new Context()
      await ctx.plugin(SubagentService)
      const provider = new StubProvider('invalid-persona', { ...ALL_CAPS, persona: true })
      ctx.subagents.registerProvider(provider)

      expect(() => ctx.subagents.start('invalid-persona', baseRequest({
        persona: 42 as unknown as string,
      }))).toThrow('subagent persona must be a string')
      expect(provider.startCount).toBe(0)
    })

    it('reads an optional capability accessor once so it cannot appear after validation', async () => {
      const ctx = new Context()
      await ctx.plugin(SubagentService)
      let accepted: SubagentStartRequest | undefined
      const provider: SubagentProvider = {
        name: 'weak-getter',
        capabilities: NO_CAPS,
        inheritsParentContext: false,
        start: (request) => {
          accepted = request
          return {
            id: AgentId('weak-getter-child'),
            started: Promise.resolve(),
            result: Promise.resolve({ output: [], stopReason: 'completed' }),
            cancel() {},
            async dispose() {},
          }
        },
      }
      ctx.subagents.registerProvider(provider)
      let reads = 0
      const request = baseRequest()
      Object.defineProperty(request, 'toolFilter', {
        enumerable: true,
        get: () => {
          reads += 1
          return reads === 1 ? undefined : { deny: ['bash'] }
        },
      })

      ctx.subagents.start('weak-getter', request)

      expect(reads).toBe(1)
      expect(accepted?.toolFilter).toBeUndefined()
    })
  })

  it('rejects an exotic public prompt before the provider starts', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const provider = new StubProvider('prompt-boundary')
    ctx.subagents.registerProvider(provider)
    class ExoticTextBlock {
      readonly type = 'text'
      readonly text = 'hello'
    }

    expect(() => ctx.subagents.start('prompt-boundary', baseRequest({
      prompt: [new ExoticTextBlock()] as unknown as SubagentStartRequest['prompt'],
    }))).toThrow('subagent prompt must be losslessly JSON-serializable')
    expect(provider.startCount).toBe(0)
  })

  it.each([
    {
      label: 'agent options',
      overrides: { agentOptions: { model: Number.NaN as unknown as string } },
      message: 'subagent agent options must be losslessly JSON-serializable',
    },
    {
      label: 'tool filter',
      overrides: { toolFilter: { deny: [Number.NaN as unknown as string] } },
      message: 'subagent tool filter must be losslessly JSON-serializable',
    },
    {
      label: 'output schema',
      overrides: {
        outputSchema: {
          type: 'object',
          properties: { answer: { type: Number.NaN } },
        } as unknown as NonNullable<SubagentStartRequest['outputSchema']>,
      },
      message: 'schema annotation must be JSON data',
    },
  ])('rejects non-JSON $label before the provider starts', async ({ overrides, message }) => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const provider = new StubProvider('invalid-request-data', ALL_CAPS)
    ctx.subagents.registerProvider(provider)

    expect(() => ctx.subagents.start('invalid-request-data', baseRequest(overrides)))
      .toThrow(message)
    expect(provider.startCount).toBe(0)
  })

  it('reads each nested prompt value once into the provider snapshot', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const provider = new StubProvider('unstable-prompt')
    ctx.subagents.registerProvider(provider)
    let reads = 0
    const block = Object.defineProperties({}, {
      type: { enumerable: true, value: 'text' },
      text: {
        enumerable: true,
        get: () => {
          reads += 1
          return reads === 1 ? 'hello' : new Map([['not', 'json']])
        },
      },
    })

    expect(() => ctx.subagents.start('unstable-prompt', baseRequest({
      prompt: [block] as unknown as SubagentStartRequest['prompt'],
    }))).not.toThrow()
    expect(reads).toBe(1)
    expect(provider.startCount).toBe(1)
  })

  it('emits subagent/start then subagent/end around a run', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider(new StubProvider('events'))

    const started = vi.fn()
    const ended = vi.fn()
    ctx.on('subagent/start', started)
    ctx.on('subagent/end', ended)

    const run = ctx.subagents.start('events', baseRequest())
    await run.started
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ provider: 'events', id: run.id }))

    await run.result
    // `subagent/end` fires from a `.then` on the result — let the microtask run.
    await Promise.resolve()
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ provider: 'events', id: run.id, stopReason: 'completed' }))
  })

  it('captures a provider run once and gives callers and telemetry one normalized result', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const reads = {
      id: 0,
      started: 0,
      result: 0,
      cancel: 0,
      sendMessage: 0,
      dispose: 0,
      resume: 0,
      output: 0,
      structured: 0,
      stopReason: 0,
    }
    const methodReceivers: string[] = []
    const providerResult = Object.defineProperties({}, {
      output: {
        enumerable: true,
        get: () => {
          reads.output += 1
          return reads.output === 1
            ? [{ type: 'text', text: 'accepted output' }]
            : [{ type: 'text', text: 'drifted output' }]
        },
      },
      structured: {
        enumerable: true,
        get: () => {
          reads.structured += 1
          return { verdict: reads.structured === 1 ? 'accepted' : 'drifted' }
        },
      },
      stopReason: {
        enumerable: true,
        get: () => {
          reads.stopReason += 1
          return reads.stopReason === 1 ? 'completed' : 'error'
        },
      },
    }) as SubagentResult
    const providerRun = Object.defineProperties({}, {
      id: {
        enumerable: true,
        get: () => {
          reads.id += 1
          return AgentId(reads.id === 1 ? 'accepted-child' : 'drifted-child')
        },
      },
      started: {
        enumerable: true,
        get: () => {
          reads.started += 1
          if (reads.started !== 1) throw new Error('started reread')
          return Promise.resolve()
        },
      },
      result: {
        enumerable: true,
        get: () => {
          reads.result += 1
          if (reads.result !== 1) throw new Error('result reread')
          return Promise.resolve(providerResult)
        },
      },
      cancel: {
        enumerable: true,
        get: () => {
          reads.cancel += 1
          if (reads.cancel !== 1) throw new Error('cancel reread')
          return function (this: SubagentRun): void {
            expect(this).toBe(providerRun)
            methodReceivers.push('cancel')
          }
        },
      },
      sendMessage: {
        enumerable: true,
        get: () => {
          reads.sendMessage += 1
          if (reads.sendMessage !== 1) throw new Error('sendMessage reread')
          return function (this: SubagentRun): void {
            expect(this).toBe(providerRun)
            methodReceivers.push('sendMessage')
          }
        },
      },
      dispose: {
        enumerable: true,
        get: () => {
          reads.dispose += 1
          if (reads.dispose !== 1) throw new Error('dispose reread')
          return async function (this: SubagentRun): Promise<void> {
            expect(this).toBe(providerRun)
            methodReceivers.push('dispose')
          }
        },
      },
      resume: {
        enumerable: true,
        get: () => {
          reads.resume += 1
          if (reads.resume !== 1) throw new Error('resume reread')
          return function (this: SubagentRun): SubagentRun {
            expect(this).toBe(providerRun)
            methodReceivers.push('resume')
            return providerRun
          }
        },
      },
    }) as SubagentRun
    ctx.subagents.registerProvider({
      name: 'stateful-run',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => providerRun,
    })
    const ended = vi.fn()
    ctx.on('subagent/end', ended)

    const run = ctx.subagents.start('stateful-run', baseRequest())
    expect(Object.is(run, providerRun)).toBe(false)
    expect(Object.isFrozen(run)).toBe(true)
    run.cancel()
    run.sendMessage?.([])
    expect(Object.is(run.resume?.([]), providerRun)).toBe(true)
    await run.dispose()
    const result = await run.result
    await run.started
    await Promise.resolve()

    expect(reads).toEqual({
      id: 1,
      started: 1,
      result: 1,
      cancel: 1,
      sendMessage: 1,
      dispose: 1,
      resume: 1,
      output: 1,
      structured: 1,
      stopReason: 1,
    })
    expect(methodReceivers).toEqual(['cancel', 'sendMessage', 'resume', 'dispose'])
    expect(result).toEqual({
      output: [{ type: 'text', text: 'accepted output' }],
      structured: { verdict: 'accepted' },
      stopReason: 'completed',
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.output)).toBe(true)
    expect(ended).toHaveBeenCalledWith({
      provider: 'stateful-run',
      id: 'accepted-child',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'accepted output' }],
    })
  })

  it.each([
    { label: 'a non-string id', field: 'id', value: 42, message: 'run id must be a string' },
    { label: 'a non-Promise started field', field: 'started', value: undefined, message: 'run started must be a Promise' },
    { label: 'a non-Promise result field', field: 'result', value: undefined, message: 'run result must be a Promise' },
    { label: 'a non-callable cancel field', field: 'cancel', value: undefined, message: 'run cancel must be a function' },
    { label: 'a non-callable sendMessage field', field: 'sendMessage', value: 42, message: 'run sendMessage must be a function' },
    { label: 'a non-callable resume field', field: 'resume', value: 42, message: 'run resume must be a function' },
  ])('rolls back a provider run with $label', async ({ field, value, message }) => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const providerDispose = vi.fn(async () => {})
    const providerRun = {
      id: AgentId('invalid-handle-child'),
      started: Promise.resolve(),
      result: Promise.resolve({ output: [], stopReason: 'completed' } satisfies SubagentResult),
      cancel() {},
      dispose: providerDispose,
      [field]: value,
    } as unknown as SubagentRun
    ctx.subagents.registerProvider({
      name: 'invalid-handle',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => providerRun,
    })

    expect(() => ctx.subagents.start('invalid-handle', baseRequest())).toThrow(message)
    expect(providerDispose).toHaveBeenCalledOnce()
  })

  it.each([
    { label: 'null', value: null },
    { label: 'a primitive', value: 42 },
  ])('rejects $label returned by provider.start before reading a disposer', async ({ value }) => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'invalid-run-shell',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => value as unknown as SubagentRun,
    })

    expect(() => ctx.subagents.start('invalid-run-shell', baseRequest())).toThrow('must return a SubagentRun object')
  })

  it('rejects a run without a callable disposer before accepting ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'invalid-dispose',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => ({ dispose: 42 }) as unknown as SubagentRun,
    })

    expect(() => ctx.subagents.start('invalid-dispose', baseRequest())).toThrow('run dispose must be a function')
  })

  it('observes accepted provider promises when a later handle field is malformed', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const providerDispose = vi.fn(async () => {})
    ctx.subagents.registerProvider({
      name: 'rejected-malformed-handle',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => ({
        id: AgentId('rejected-malformed-child'),
        started: Promise.reject(new Error('readiness already rejected')),
        result: Promise.reject(new Error('result already rejected')),
        cancel: 42,
        dispose: providerDispose,
      }) as unknown as SubagentRun,
    })

    expect(() => ctx.subagents.start('rejected-malformed-handle', baseRequest())).toThrow('run cancel must be a function')
    expect(providerDispose).toHaveBeenCalledOnce()
    // Let both provider rejections run: the seam's immediate observers keep
    // them from surfacing as unhandled after no wrapper was returned.
    await Promise.resolve()
  })

  it('starts rollback before surfacing a hostile run accessor failure', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const disposalGate = Promise.withResolvers<undefined>()
    const order: string[] = []
    const providerRun = Object.defineProperties({}, {
      dispose: {
        get: () => {
          order.push('dispose:get')
          return async function (this: SubagentRun): Promise<void> {
            expect(this).toBe(providerRun)
            order.push('dispose:call')
            await disposalGate.promise
            order.push('dispose:quiescent')
          }
        },
      },
      id: { get: () => { order.push('id:get'); return AgentId('hostile-handle-child') } },
      started: { get: () => { order.push('started:get'); return Promise.resolve() } },
      result: { get: () => { order.push('result:get'); throw new Error('result accessor exploded') } },
    }) as SubagentRun
    ctx.subagents.registerProvider({
      name: 'hostile-handle',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => providerRun,
    })

    expect(() => ctx.subagents.start('hostile-handle', baseRequest())).toThrow('result accessor exploded')
    expect(order).toEqual(['dispose:get', 'id:get', 'started:get', 'result:get', 'dispose:call'])
    disposalGate.resolve(undefined)
    await vi.waitFor(() => { expect(order).toContain('dispose:quiescent') })
  })

  it('rolls back when binding a hostile optional run method fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const providerDispose = vi.fn(async () => {})
    const hostileCancel = new Proxy(() => {}, {
      get(_target, property) {
        if (property === 'length') throw new Error('cancel bind exploded')
        return undefined
      },
    })
    ctx.subagents.registerProvider({
      name: 'hostile-bind',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => ({
        id: AgentId('hostile-bind-child'),
        started: Promise.resolve(),
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        cancel: hostileCancel,
        dispose: providerDispose,
      }),
    })

    expect(() => ctx.subagents.start('hostile-bind', baseRequest())).toThrow('cancel bind exploded')
    expect(providerDispose).toHaveBeenCalledOnce()
  })

  it.each([
    { label: 'an Error', thrown: new Error('cleanup exploded'), warning: 'cleanup exploded' },
    { label: 'a non-Error value', thrown: 'naked cleanup fault', warning: 'dispose threw a non-Error value' },
  ])('contains rollback failure from $label while preserving the malformed-handle fault', async ({ thrown, warning }) => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    ctx.subagents.registerProvider({
      name: 'rollback-failure',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => ({
        id: 42,
        started: Promise.resolve(),
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        cancel() {},
        dispose: () => {
          // Deliberately violate the seam contract to exercise normalization.
          throw thrown
        },
      }) as unknown as SubagentRun,
    })

    expect(() => ctx.subagents.start('rollback-failure', baseRequest())).toThrow('run id must be a string')
    await vi.waitFor(() => { expect(warnings.some(message => message.includes(warning))).toBe(true) })
  })

  it('waits for provider readiness and observes an early result rejection without reordering lifecycle', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const readiness = Promise.withResolvers<undefined>()
    ctx.subagents.registerProvider({
      name: 'delayed-start',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => ({
        id: AgentId('delayed-child'),
        started: readiness.promise,
        // Already rejected: SubagentService must attach its result handler in
        // the same synchronous start() call, before awaiting readiness.
        result: Promise.reject(new Error('early infrastructure fault')),
        cancel() {},
        async dispose() {},
      }),
    })
    const lifecycle: string[] = []
    ctx.on('subagent/start', () => void lifecycle.push('start'))
    ctx.on('subagent/end', info => void lifecycle.push(`end:${info.stopReason}`))

    const run = ctx.subagents.start('delayed-start', baseRequest())
    await expect(run.result).rejects.toThrow('early infrastructure fault')
    expect(lifecycle).toEqual([])

    readiness.resolve(undefined)
    await run.started
    expect(lifecycle).toEqual(['start', 'end:error'])
  })

  it('emits no lifecycle pair when readiness rejects before a child exists', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const readiness = Promise.withResolvers<undefined>()
    const result = Promise.withResolvers<SubagentResult>()
    ctx.subagents.registerProvider({
      name: 'never-started',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => ({
        id: AgentId('never-started-child'),
        started: readiness.promise,
        result: result.promise,
        cancel() {},
        async dispose() {},
      }),
    })
    const lifecycle = vi.fn()
    ctx.on('subagent/start', lifecycle)
    ctx.on('subagent/end', lifecycle)

    const run = ctx.subagents.start('never-started', baseRequest())
    readiness.reject(new Error('publication rolled back'))
    await expect(run.started).rejects.toThrow('publication rolled back')
    result.resolve({ output: [], stopReason: 'aborted' })
    await run.result
    await Promise.resolve()
    expect(lifecycle).not.toHaveBeenCalled()
  })

  it('pins start and end to the parent accepted at start despite caller mutation', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const gate = Promise.withResolvers<SubagentResult>()
    let acceptedRequest: SubagentStartRequest | undefined
    ctx.subagents.registerProvider({
      name: 'deferred',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: (accepted) => {
        acceptedRequest = accepted
        return {
          id: AgentId('deferred-child'),
          started: Promise.resolve(),
          result: gate.promise,
          cancel() {},
          async dispose() {},
        }
      },
    })
    const accepted = fakeParent('accepted-parent')
    const replacement = fakeParent('replacement-parent')
    const keys: unknown[] = []
    ctx.on('subagent/start', function () { keys.push(carrierKeyOf(this)) })
    ctx.on('subagent/end', function () { keys.push(carrierKeyOf(this)) })
    const request = baseRequest({ parent: accepted })

    const run = ctx.subagents.start('deferred', request)
    request.parent = replacement
    request.prompt[0] = { type: 'text', text: 'mutated prompt' }
    expect(acceptedRequest?.parent).toBe(accepted)
    expect(acceptedRequest?.prompt).toEqual([{ type: 'text', text: 'do a thing' }])
    expect(acceptedRequest?.prompt).not.toBe(request.prompt)
    gate.resolve({ output: [], stopReason: 'completed' })
    await run.result
    await Promise.resolve()

    expect(keys).toEqual([accepted, accepted])
  })

  it('carries lastAssistantMessage (the child output) onto the end event', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider(new StubProvider(
      'enriched',
      ALL_CAPS,
      { output: [{ type: 'text', text: 'the child answer' }], stopReason: 'completed' },
    ))

    const started = vi.fn()
    const ended = vi.fn()
    ctx.on('subagent/start', started)
    ctx.on('subagent/end', ended)

    const run = ctx.subagents.start('enriched', baseRequest())
    await run.started
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ provider: 'enriched', id: run.id }))

    await run.result
    await Promise.resolve()
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'enriched',
      id: run.id,
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'the child answer' }],
    }))
  })

  it('observe-only: a mutating subagent/end listener cannot corrupt the caller or later listeners', async () => {
    // The subagent/end emit fires from a detached `.then` registered before
    // start() returns — i.e. BEFORE the caller's own `await run.result`
    // continuation. If the event shared the result.output reference, a mutating
    // listener would change the SubagentResult the caller consumes or the value
    // a later observer sees. The service freezes one normalized result and the
    // lifecycle payload before dispatching either public surface.
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider(new StubProvider(
      'clone',
      ALL_CAPS,
      { output: [{ type: 'text', text: 'original' }], stopReason: 'completed' },
    ))

    ctx.on('subagent/end', (info) => {
      // A hostile/buggy listener reaches in and mutates the event's array.
      const blocks = info.lastAssistantMessage
      if (blocks?.[0]?.type === 'text') blocks[0].text = 'HIJACKED'
      blocks?.push({ type: 'text', text: 'injected' })
    })
    const later = vi.fn()
    ctx.on('subagent/end', later)

    const run = ctx.subagents.start('clone', baseRequest())
    const result = await run.result
    await Promise.resolve() // let the detached settle hook (and its listener) run
    // The caller and the listener after the mutator both retain the accepted value.
    expect(result.output).toEqual([{ type: 'text', text: 'original' }])
    expect(Object.isFrozen(result.output)).toBe(true)
    expect(later).toHaveBeenCalledWith(expect.objectContaining({
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'original' }],
    }))
    const laterInfo = later.mock.calls[0]![0] as Record<string, unknown>
    expect(Object.isFrozen(laterInfo)).toBe(true)
    expect(Object.isFrozen(laterInfo.lastAssistantMessage)).toBe(true)
  })

  it('omits lastAssistantMessage on the reject path (no SubagentResult was produced)', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'rej',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => ({
        id: AgentId('rej-child'),
        started: Promise.resolve(),
        result: Promise.reject(new Error('infra fault')),
        cancel() {},
        dispose: async () => {},
      }),
    })

    const ended = vi.fn()
    ctx.on('subagent/end', ended)
    const run = ctx.subagents.start('rej', baseRequest())
    await run.result.catch(() => {})
    await Promise.resolve()

    const endInfo = ended.mock.calls[0]![0] as Record<string, unknown>
    expect(endInfo.stopReason).toBe('error')
    expect('lastAssistantMessage' in endInfo).toBe(false) // no output exists on reject
  })

  it('rejects an invalid provider output and maps the contract fault to error telemetry', async () => {
    // A function is outside the lossless JSON vocabulary. The service-owned
    // result promise rejects instead of exposing the malformed provider value;
    // its already-attached lifecycle observer maps that infrastructure fault to
    // error telemetry without producing an unhandled rejection.
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const nonJsonOutput = [{ type: 'text', text: 'x', evil: () => 0 }] as unknown as SubagentResult['output']
    const disposalGate = Promise.withResolvers<undefined>()
    const providerDispose = vi.fn(async () => { await disposalGate.promise })
    ctx.subagents.registerProvider({
      name: 'unclone',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => ({
        id: AgentId('unclone-child'),
        started: Promise.resolve(),
        result: Promise.resolve({ output: nonJsonOutput, stopReason: 'completed' } as SubagentResult),
        cancel() {},
        dispose: providerDispose,
      }),
    })

    const ended = vi.fn()
    ctx.on('subagent/end', ended)
    const run = ctx.subagents.start('unclone', baseRequest())
    let resultSettled = false
    void run.result.catch(() => { resultSettled = true })
    await vi.waitFor(() => { expect(providerDispose).toHaveBeenCalledOnce() })
    expect(resultSettled).toBe(false)
    disposalGate.resolve(undefined)
    await expect(run.result).rejects.toThrow('subagent result must be losslessly JSON-serializable')
    await run.dispose()
    await Promise.resolve()

    expect(providerDispose).toHaveBeenCalledOnce()
    const endInfo = ended.mock.calls[0]![0] as Record<string, unknown>
    expect(endInfo.stopReason).toBe('error')
    expect('lastAssistantMessage' in endInfo).toBe(false)
  })

  it.each([
    {
      label: 'a non-array output',
      value: { output: { type: 'text', text: 'not an array' }, stopReason: 'completed' },
      message: 'subagent result output must be an array',
    },
    {
      label: 'a non-string stopReason',
      value: { output: [], stopReason: 42 },
      message: 'subagent result stopReason must be a string',
    },
  ])('rejects a provider result with $label', async ({ value, message }) => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'invalid-shape',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => ({
        id: AgentId('invalid-shape-child'),
        started: Promise.resolve(),
        result: Promise.resolve(value as unknown as SubagentResult),
        cancel() {},
        async dispose() {},
      }),
    })
    const ended = vi.fn()
    ctx.on('subagent/end', ended)

    const run = ctx.subagents.start('invalid-shape', baseRequest())
    await expect(run.result).rejects.toThrow(message)
    await Promise.resolve()

    expect(ended).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'invalid-shape',
      id: 'invalid-shape-child',
      stopReason: 'error',
    }))
  })

  it('emits subagent/end with stopReason "error" when the run result promise rejects', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    // A provider whose run.result REJECTS (an infrastructure fault — the seam
    // contract says child-level failures resolve with stopReason 'error', but a
    // rejection is still surfaced as an 'error' telemetry event).
    ctx.subagents.registerProvider({
      name: 'rejecter',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => ({
        id: AgentId('rej-child'),
        started: Promise.resolve(),
        result: Promise.reject(new Error('infra fault')),
        cancel() {},
        dispose: async () => {},
      }),
    })

    const ended = vi.fn()
    ctx.on('subagent/end', ended)
    const run = ctx.subagents.start('rejecter', baseRequest())
    // Observe (and swallow) the rejection the consumer would see, then let the
    // detached `.then` settle the telemetry emit.
    await run.result.catch(() => {})
    await Promise.resolve()
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ provider: 'rejecter', id: run.id, stopReason: 'error' }))
  })

  it('contains a throwing subagent/start listener per-listener: a later listener still observes the event and start() returns the run', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider(new StubProvider('contain'))
    // Two listeners; the FIRST throws. Per-listener containment means the second
    // must STILL run (a single try/catch around ctx.emit would let the first
    // throw halt the dispatch and starve the second — the round-2 regression).
    const second = vi.fn()
    ctx.on('subagent/start', () => { throw new Error('bad start listener') })
    ctx.on('subagent/start', second)

    const run = ctx.subagents.start('contain', baseRequest())
    expect(run.id).toBeDefined()
    await run.started
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ provider: 'contain', id: run.id }))
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
  })

  it('contains asynchronous lifecycle-listener rejections without serializing later listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const laterStart = vi.fn()
    const laterEnd = vi.fn()
    const laterRemoved = vi.fn()
    const asyncStart = (async () => { await Promise.resolve(); throw new Error('async start listener') }) as unknown as () => void
    const asyncEnd = (async () => { await Promise.resolve(); throw new Error('async end listener') }) as unknown as () => void
    const asyncRemoved = (async () => { await Promise.resolve(); throw new Error('async removed listener') }) as unknown as () => void
    ctx.on('subagent/start', asyncStart)
    ctx.on('subagent/start', laterStart)
    ctx.on('subagent/end', asyncEnd)
    ctx.on('subagent/end', laterEnd)
    ctx.on('subagent/provider-removed', asyncRemoved)
    ctx.on('subagent/provider-removed', laterRemoved)
    const unregister = ctx.subagents.registerProvider(new StubProvider('async-listeners'))

    const run = ctx.subagents.start('async-listeners', baseRequest())
    await run.started
    expect(laterStart).toHaveBeenCalledOnce()
    await run.result
    await vi.waitFor(() => {
      expect(laterEnd).toHaveBeenCalledOnce()
      expect(warnings.some(message => message.includes('async start listener'))).toBe(true)
      expect(warnings.some(message => message.includes('async end listener'))).toBe(true)
    })

    await unregister()
    expect(laterRemoved).toHaveBeenCalledWith('async-listeners')
    await vi.waitFor(() => {
      expect(warnings.some(message => message.includes('async removed listener'))).toBe(true)
    })
  })

  it('contains a listener whose thrown value cannot be stringified', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider(new StubProvider('hostile-listener'))
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const hostile = {
      [Symbol.toPrimitive]() { throw new Error('render failed') },
    }
    const second = vi.fn()
    ctx.on('subagent/start', () => { throw hostile })
    ctx.on('subagent/start', second)

    const run = ctx.subagents.start('hostile-listener', baseRequest())
    await run.started

    expect(second).toHaveBeenCalledOnce()
    expect(warnings.some(message => message.includes('<unrenderable thrown value>'))).toBe(true)
    await run.result
  })

  it('rejects a throwing provider result accessor and maps it to error telemetry', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider({
      name: 'hostile-result',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => ({
        id: AgentId('hostile-result-child'),
        started: Promise.resolve(),
        result: Promise.resolve({
          output: [],
          get stopReason(): 'completed' { throw new Error('stop reason exploded') },
        }),
        cancel() {},
        async dispose() {},
      }),
    })
    const ended = vi.fn()
    ctx.on('subagent/end', ended)

    const run = ctx.subagents.start('hostile-result', baseRequest())
    await run.started
    await expect(run.result).rejects.toThrow('stop reason exploded')
    await Promise.resolve()

    expect(ended).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'hostile-result',
      id: 'hostile-result-child',
      stopReason: 'error',
    }))
  })

  it('contains a throwing subagent/end listener per-listener: a later listener still observes the settle, no unhandled rejection', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    ctx.subagents.registerProvider(new StubProvider('contain-end'))
    const second = vi.fn()
    ctx.on('subagent/end', () => { throw new Error('bad end listener') })
    ctx.on('subagent/end', second)

    const run = ctx.subagents.start('contain-end', baseRequest())
    await run.result
    // Let the detached `.then` + the contained emit run.
    await Promise.resolve()
    await Promise.resolve()
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ provider: 'contain-end', id: run.id, stopReason: 'completed' }))
  })

  it('SubagentError extends the shared HarnessError base', () => {
    const err = new SubagentError('boom', 'NO_PROVIDER')
    expect(err).toBeInstanceOf(HarnessError)
    expect(err.name).toBe('SubagentError')
    expect(err.code).toBe('NO_PROVIDER')
  })
})
