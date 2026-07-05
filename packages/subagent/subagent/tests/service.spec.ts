import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { AgentId, type Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
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

const ALL_CAPS: SubagentCapabilities = { outputSchema: true, depthLimit: true, toolFilter: true }
const NO_CAPS: SubagentCapabilities = { outputSchema: false, depthLimit: false, toolFilter: false }

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

    dispose()
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
    expect(() => { dispose() }).not.toThrow()
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
    expect(ctx.subagents.getProvider('alpha')).toBe(provider)

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

  it('re-registers a name after its prior registration is disposed (not wedged)', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)

    const dispose = ctx.subagents.registerProvider(new StubProvider('reuse'))
    expect(ctx.subagents.list()).toEqual(['reuse'])
    dispose()
    expect(ctx.subagents.list()).toEqual([])

    const disposeAgain = ctx.subagents.registerProvider(new StubProvider('reuse'))
    expect(ctx.subagents.list()).toEqual(['reuse'])
    disposeAgain()
    expect(ctx.subagents.list()).toEqual([])
  })

  describe('start-time capability validation (fail loud, before any child)', () => {
    it.each([
      { field: 'outputSchema', request: baseRequest({ outputSchema: { x: { type: 'string' } } }) },
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
      ctx.subagents.start('strong', baseRequest({ outputSchema: { x: { type: 'string' } }, maxDepth: 1 }))
      expect(provider.startCount).toBe(1)
    })
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
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ provider: 'events', id: run.id }))

    await run.result
    // `subagent/end` fires from a `.then` on the result — let the microtask run.
    await Promise.resolve()
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ provider: 'events', id: run.id, stopReason: 'completed' }))
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

  it('observe-only: a subagent/end listener mutating lastAssistantMessage cannot corrupt the caller\'s result', async () => {
    // The subagent/end emit fires from a detached `.then` registered before
    // start() returns — i.e. BEFORE the caller's own `await run.result`
    // continuation. If the event shared the result.output reference, a mutating
    // listener would change the SubagentResult the caller consumes. The service
    // deep-clones output onto the event, so the listener mutates only its copy.
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

    const run = ctx.subagents.start('clone', baseRequest())
    const result = await run.result
    await Promise.resolve() // let the detached settle hook (and its listener) run
    // The caller's result.output is untouched by the listener's mutation.
    expect(result.output).toEqual([{ type: 'text', text: 'original' }])
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

  it('contains a structuredClone failure: emits subagent/end without lastAssistantMessage (no unhandled rejection)', async () => {
    // The clone runs inside onFulfilled, OUTSIDE emitLifecycle's per-listener
    // containment. An uncloneable output (here a content block carrying a
    // function) would otherwise throw and become an unhandled rejection on the
    // detached `.then`. The handler must instead log and emit the event WITHOUT
    // lastAssistantMessage, still carrying the real stopReason.
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const warn = vi.fn(); ctx.logger.warn = warn as never
    // An output value structuredClone cannot handle (a function is uncloneable).
    const uncloneable = [{ type: 'text', text: 'x', evil: () => 0 }] as unknown as SubagentResult['output']
    ctx.subagents.registerProvider({
      name: 'unclone',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => ({
        id: AgentId('unclone-child'),
        result: Promise.resolve({ output: uncloneable, stopReason: 'completed' } as SubagentResult),
        cancel() {},
        dispose: async () => {},
      }),
    })

    const ended = vi.fn()
    ctx.on('subagent/end', ended)
    const run = ctx.subagents.start('unclone', baseRequest())
    await run.result
    await Promise.resolve()

    const endInfo = ended.mock.calls[0]![0] as Record<string, unknown>
    expect(endInfo.stopReason).toBe('completed')        // the real outcome is preserved
    expect('lastAssistantMessage' in endInfo).toBe(false) // clone failed → omitted, not crashed
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not clone'))
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
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ provider: 'contain', id: run.id }))
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
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
