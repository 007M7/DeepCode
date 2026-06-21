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

  it('SubagentError extends the shared HarnessError base', () => {
    const err = new SubagentError('boom', 'NO_PROVIDER')
    expect(err).toBeInstanceOf(HarnessError)
    expect(err.name).toBe('SubagentError')
    expect(err.code).toBe('NO_PROVIDER')
  })
})
