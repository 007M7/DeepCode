import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import LlmService, { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmConfigurableProvider, StreamChunk } from '@deepseek-ai/dsh-llm'

class NoopAdapter extends LlmAdapter {

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('not exercised')
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  return ctx
}

function entry(overrides: Partial<LlmConfigurableProvider> = {}): LlmConfigurableProvider {
  return {
    provider: 'openai',
    displayName: 'OpenAI',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'openai'],
    ...overrides,
  }
}

describe('llm/adapters-updated', () => {
  it('fires at both adapter registration commit points with the registry already readable', async () => {
    const ctx = await setup()
    const observed: string[][] = []
    ctx.on('llm/adapters-updated', () => {
      observed.push(ctx.llm.listProviders().map(provider => provider.id))
    })
    const dispose = ctx.llm.registerAdapter(['a', 'b'], new NoopAdapter())
    expect(observed).toEqual([['a', 'b']])
    dispose()
    expect(observed).toEqual([['a', 'b'], []])
  })

  it('contains a throwing listener without vetoing registration or starving later listeners', async () => {
    const ctx = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const later = vi.fn()
    ctx.on('llm/adapters-updated', () => {
      throw new Error('broken observer')
    })
    ctx.on('llm/adapters-updated', later)
    ctx.llm.registerAdapter(['a'], new NoopAdapter())
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['a'])
    expect(later).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('llm: an llm/adapters-updated listener failed')
  })

  it('rethrows the first INVARIANT-coded listener failure after notifying the rest', async () => {
    const ctx = await setup()
    const later = vi.fn()
    ctx.on('llm/adapters-updated', () => {
      throw Object.assign(new Error('registry incoherent'), { code: 'INVARIANT' })
    })
    ctx.on('llm/adapters-updated', later)
    expect(() => ctx.llm.registerAdapter(['a'], new NoopAdapter())).toThrow('registry incoherent')
    expect(later).toHaveBeenCalledTimes(1)
  })
})

describe('configurable-provider directory', () => {
  it('registers entries, lists detached copies in order, and fires the topology event', async () => {
    const ctx = await setup()
    const events = vi.fn()
    ctx.on('llm/adapters-updated', events)
    ctx.llm.registerConfigurableProviders([
      entry({ provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] }),
      entry(),
    ])
    expect(events).toHaveBeenCalledTimes(1)
    const listed = ctx.llm.listConfigurableProviders()
    expect(listed).toEqual([
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
    ])
    listed[0]!.displayName = 'mutated'
    ;(listed[1]!.settingsPath as string[]).push('mutated')
    expect(ctx.llm.listConfigurableProviders()[0]!.displayName).toBe('DeepSeek')
    expect(ctx.llm.listConfigurableProviders()[1]!.settingsPath).toEqual(['providers', 'openai'])
  })

  it('detaches stored entries from caller-owned objects', async () => {
    const ctx = await setup()
    const source = entry()
    ctx.llm.registerConfigurableProviders([source])
    source.displayName = 'mutated'
    expect(ctx.llm.listConfigurableProviders()[0]!.displayName).toBe('OpenAI')
  })

  it('withdraws every entry when the registration disposes', async () => {
    const ctx = await setup()
    const dispose = ctx.llm.registerConfigurableProviders([entry()])
    const events = vi.fn()
    ctx.on('llm/adapters-updated', events)
    dispose()
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
    expect(events).toHaveBeenCalledTimes(1)
  })

  it('withdraws entries when the contributing fiber disposes', async () => {
    const ctx = await setup()
    const fiber = await ctx.plugin({
      inject: ['llm'],
      apply: (child: Context) => {
        child.llm.registerConfigurableProviders([entry()])
      },
    })
    expect(ctx.llm.listConfigurableProviders()).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('rejects an empty registration', async () => {
    const ctx = await setup()
    expect(() => ctx.llm.registerConfigurableProviders([])).toThrow(LlmError)
    expect(() => ctx.llm.registerConfigurableProviders([])).toThrow(/at least one provider/)
  })

  it.each([
    [entry({ provider: '' }), /non-empty provider/],
    [entry({ displayName: '' }), /non-empty provider/],
    [entry({ settingsNs: '' }), /non-empty provider/],
    [entry({ settingsPath: ['providers', ''] }), /empty settingsPath segment/],
  ])('rejects invalid entries all-or-nothing', async (invalid, message) => {
    const ctx = await setup()
    expect(() => ctx.llm.registerConfigurableProviders([entry({ provider: 'valid-first' }), invalid])).toThrow(message)
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('rejects duplicates within one registration and across registrations', async () => {
    const ctx = await setup()
    expect(() => ctx.llm.registerConfigurableProviders([entry(), entry()])).toThrow(/already declared/)
    ctx.llm.registerConfigurableProviders([entry()])
    expect(() => ctx.llm.registerConfigurableProviders([entry({ displayName: 'Other' }), entry({ provider: 'unseen' })]))
      .toThrow(/already declared/)
    expect(ctx.llm.listConfigurableProviders()).toHaveLength(1)
  })
})
