import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { GenerateOptions, LlmAdapter, LlmError, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'

class ScriptedAdapter extends LlmAdapter {
  constructor(private script: StreamChunk[]) {
    super()
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield * this.script
  }
}

class RecordingAdapter extends ScriptedAdapter {
  lastOptions: GenerateOptions | undefined

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.lastOptions = options
    yield * super.stream(options)
  }
}

class CatalogAdapter extends ScriptedAdapter {
  constructor(
    private readonly provider: LlmProviderInfo,
    private readonly models: readonly LlmModelInfo[],
  ) {
    super(SCRIPT)
  }

  override providerInfo(_provider: string): LlmProviderInfo {
    return this.provider
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models)
  }
}

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hi' },
  { type: 'finish', reason: { kind: 'stop' } },
]

describe('LlmService', () => {
  it('routes stream() to the registered adapter', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-provider'], new ScriptedAdapter(SCRIPT))

    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'test-provider', model: 'test-model', messages: [] })) chunks.push(chunk)
    expect(chunks).toEqual(SCRIPT)
  })

  it('throws NO_ADAPTER for unregistered providers', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await expect((async () => {
      for await (const _ of ctx.llm.stream({ provider: 'nope', model: 'any-model', messages: [] })) { /* drain */ }
    })()).rejects.toThrow('no adapter registered')
  })

  it('unregisters adapters when the owning fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.llm.registerAdapter(['scoped-model'], new ScriptedAdapter(SCRIPT))
    }, { inject: ['llm'] }))
    expect(ctx.llm.listProviders()).toEqual([{ id: 'scoped-model', name: 'scoped-model' }])

    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('discovers detached provider and advisory model metadata', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const provider = { id: 'catalog', name: 'Catalog Provider' }
    const model = { provider: 'catalog', id: 'fast', name: 'Fast', description: 'Low latency' }
    ctx.llm.registerAdapter(['catalog'], new CatalogAdapter(provider, [model]))

    const providers = ctx.llm.listProviders()
    const models = await ctx.llm.listModels('catalog')
    expect(providers).toEqual([provider])
    expect(models).toEqual([model])

    providers[0]!.name = 'mutated'
    models[0]!.name = 'mutated'
    provider.name = 'source mutated'
    model.name = 'source mutated'
    expect(ctx.llm.listProviders()).toEqual([{ id: 'catalog', name: 'Catalog Provider' }])
    await expect(ctx.llm.listModels('catalog')).resolves.toEqual([{
      provider: 'catalog', id: 'fast', name: 'source mutated', description: 'Low latency',
    }])
  })

  it('defaults adapters to their route name and an empty advisory model list', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['plain'], new ScriptedAdapter(SCRIPT))
    expect(ctx.llm.listProviders()).toEqual([{ id: 'plain', name: 'plain' }])
    await expect(ctx.llm.listModels('plain')).resolves.toEqual([])
    await expect(ctx.llm.listModels('missing')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
  })

  it.each([
    [{ id: 1, name: 'Name' }, 'non-string id'],
    [{ id: 'other', name: 'Name' }, 'mismatched id'],
    [{ id: 'route', name: 1 }, 'non-string name'],
    [{ id: 'route', name: '' }, 'empty name'],
  ] as const)('rejects invalid provider metadata atomically (%s: %s)', async (metadata, _label) => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const adapter = new CatalogAdapter(metadata as unknown as LlmProviderInfo, [])
    expect(() => ctx.llm.registerAdapter(['route'], adapter)).toThrow(expect.objectContaining({ code: 'INVALID_ADAPTER' }))
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it.each([
    [{ provider: 1, id: 'm', name: 'M' }, 'non-string provider'],
    [{ provider: 'other', id: 'm', name: 'M' }, 'mismatched provider'],
    [{ provider: 'route', id: 1, name: 'M' }, 'non-string id'],
    [{ provider: 'route', id: '', name: 'M' }, 'empty id'],
    [{ provider: 'route', id: 'm', name: 1 }, 'non-string name'],
    [{ provider: 'route', id: 'm', name: '' }, 'empty name'],
    [{ provider: 'route', id: 'm', name: 'M', description: 1 }, 'non-string description'],
  ] as const)('rejects invalid model metadata (%s: %s)', async (metadata, _label) => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['route'], new CatalogAdapter(
      { id: 'route', name: 'Route' },
      [metadata as unknown as LlmModelInfo],
    ))
    await expect(ctx.llm.listModels('route')).rejects.toMatchObject({ code: 'INVALID_CATALOG' })
  })

  it('rejects duplicate model ids in one provider catalog', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const model = { provider: 'route', id: 'same', name: 'Same' }
    ctx.llm.registerAdapter(['route'], new CatalogAdapter({ id: 'route', name: 'Route' }, [model, model]))
    await expect(ctx.llm.listModels('route')).rejects.toMatchObject({ code: 'INVALID_CATALOG' })
  })

  it('lets llm/stream waterfall listeners wrap the underlying stream', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-model'], new ScriptedAdapter(SCRIPT))

    ctx.on('llm/stream', function (_options, next) {
      const inner = next()
      return (async function * () {
        yield { type: 'block-start', index: 99, blockType: 'text' } satisfies StreamChunk
        yield * inner
      })()
    })

    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'test-model', model: 'dynamic-model', messages: [] })) chunks.push(chunk)
    expect(chunks).toHaveLength(4)
    expect(chunks[0]).toMatchObject({ index: 99 })
  })

  it('resolves the provider after llm/stream listeners have had a chance to route it', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const adapter = new RecordingAdapter(SCRIPT)
    ctx.llm.registerAdapter(['routed'], adapter)
    ctx.on('llm/stream', (options, next) => {
      options.provider = 'routed'
      return next()
    })

    for await (const _chunk of ctx.llm.stream({ provider: 'initial', model: 'm', messages: [] })) { /* drain */ }
    expect(adapter.lastOptions?.provider).toBe('routed')
  })

  it('keeps replay state when historical and target providers belong to the same adapter instance', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const adapter = new RecordingAdapter(SCRIPT)
    ctx.llm.registerAdapter(['historical', 'target'], adapter)
    const replayState = { private: 'state' }

    for await (const _chunk of ctx.llm.stream({
      provider: 'target',
      model: 'new-model',
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'old response' }],
        provenance: { provider: 'historical', model: 'old-model', replayState },
      }],
    })) { /* drain */ }

    expect(adapter.lastOptions?.messages[0]?.provenance).toEqual({
      provider: 'historical', model: 'old-model', replayState,
    })
  })

  it('strips replay state but preserves provenance when the target uses a different adapter instance', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['historical'], new RecordingAdapter(SCRIPT))
    const target = new RecordingAdapter(SCRIPT)
    ctx.llm.registerAdapter(['target'], target)

    for await (const _chunk of ctx.llm.stream({
      provider: 'target',
      model: 'new-model',
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'old response' }],
        provenance: { provider: 'historical', model: 'old-model', replayState: { private: 'state' } },
      }],
    })) { /* drain */ }

    expect(target.lastOptions?.messages[0]?.provenance).toEqual({ provider: 'historical', model: 'old-model' })
  })

  it('preserves immutability while stripping replay state from frozen requests', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['historical'], new RecordingAdapter(SCRIPT))
    const target = new RecordingAdapter(SCRIPT)
    ctx.llm.registerAdapter(['target'], target)
    const options = Object.freeze({
      provider: 'target',
      model: 'new-model',
      messages: [{
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'old response' }],
        provenance: { provider: 'historical', model: 'old-model', replayState: { private: 'state' } },
      }],
    })

    for await (const _chunk of ctx.llm.stream(options)) { /* drain */ }

    expect(target.lastOptions).not.toBe(options)
    expect(Object.isFrozen(target.lastOptions)).toBe(true)
    expect(target.lastOptions?.messages[0]?.provenance).toEqual({ provider: 'historical', model: 'old-model' })
  })

  it('creates LlmError with a code for programmatic handling', () => {
    const err = new LlmError('something went wrong', 'CUSTOM_CODE')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('LlmError')
    expect(err.message).toBe('something went wrong')
    expect(err.code).toBe('CUSTOM_CODE')
  })

  it('LlmError extends the shared HarnessError base', async () => {
    const { HarnessError, isHarnessError } = await import('@deepseek-ai/dsh-llm')
    const cause = new Error('root cause')
    const err = new LlmError('boom', 'AUTH', { cause })
    expect(err).toBeInstanceOf(HarnessError)
    expect(isHarnessError(err)).toBe(true)
    expect(err.code).toBe('AUTH')
    expect(err.cause).toBe(cause)
  })

  it('HarnessError carries a code, names itself by subclass, and chains cause', async () => {
    const { HarnessError, isHarnessError } = await import('@deepseek-ai/dsh-llm')
    const root = new Error('root cause')
    const err = new HarnessError('wrapper', 'UNKNOWN', { cause: root })
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('HarnessError')
    expect(err.code).toBe('UNKNOWN')
    expect(err.cause).toBe(root)
    expect(isHarnessError(err)).toBe(true)
    expect(isHarnessError(root)).toBe(false)
    expect(isHarnessError('nope')).toBe(false)
  })

  it('removes the adapter when the returned disposer is called', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)

    const dispose = ctx.llm.registerAdapter(['m1'], new ScriptedAdapter(SCRIPT))
    expect(ctx.llm.listProviders()).toEqual([{ id: 'm1', name: 'm1' }])
    dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('rejects duplicate adapter registration with DUPLICATE_ADAPTER code', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['m1'], new ScriptedAdapter(SCRIPT))
    try {
      ctx.llm.registerAdapter(['m1'], new ScriptedAdapter(SCRIPT))
      expect.fail('expected error')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).message).toContain('already registered')
      expect((error as LlmError).code).toBe('DUPLICATE_ADAPTER')
    }
  })

  it('rejects empty and internally duplicated provider registrations atomically', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const adapter = new ScriptedAdapter(SCRIPT)

    expect(() => ctx.llm.registerAdapter([], adapter)).toThrow(expect.objectContaining({ code: 'INVALID_ADAPTER' }))
    expect(() => ctx.llm.registerAdapter([''], adapter)).toThrow(expect.objectContaining({ code: 'INVALID_ADAPTER' }))
    expect(() => ctx.llm.registerAdapter(['first', 'first'], adapter)).toThrow(expect.objectContaining({ code: 'DUPLICATE_ADAPTER' }))
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('re-registers a model after its prior registration is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)

    const dispose = ctx.llm.registerAdapter(['m1'], new ScriptedAdapter(SCRIPT))
    expect(ctx.llm.listProviders()).toEqual([{ id: 'm1', name: 'm1' }])
    dispose()
    expect(ctx.llm.listProviders()).toEqual([])

    // The duplicate check is not wedged: the same model registers cleanly again.
    const disposeAgain = ctx.llm.registerAdapter(['m1'], new ScriptedAdapter(SCRIPT))
    expect(ctx.llm.listProviders()).toEqual([{ id: 'm1', name: 'm1' }])
    disposeAgain()
    expect(ctx.llm.listProviders()).toEqual([])
  })
})
