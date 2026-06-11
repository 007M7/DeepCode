import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { GenerateOptions, LlmAdapter, LlmError, StreamChunk } from '@deepseek-ai/dsh-llm'

class ScriptedAdapter extends LlmAdapter {
  constructor(private script: StreamChunk[]) {
    super()
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield * this.script
  }
}

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hi' },
  { type: 'finish', reason: { kind: 'stop' } },
]

describe('LlmService', () => {
  it('routes stream() to the registered adapter and generate() assembles it', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-model'], new ScriptedAdapter(SCRIPT))

    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ model: 'test-model', messages: [] })) chunks.push(chunk)
    expect(chunks).toHaveLength(3)

    const result = await ctx.llm.generate({ model: 'test-model', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(result.finish).toEqual({ kind: 'stop' })
  })

  it('throws NO_ADAPTER for unregistered models', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await expect(ctx.llm.generate({ model: 'nope', messages: [] })).rejects.toThrow('no adapter registered')
  })

  it('unregisters adapters when the owning fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.llm.registerAdapter(['scoped-model'], new ScriptedAdapter(SCRIPT))
    }, { inject: ['llm'] }))
    expect(ctx.llm.models()).toEqual(['scoped-model'])

    await fiber.dispose()
    expect(ctx.llm.models()).toEqual([])
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
    for await (const chunk of ctx.llm.stream({ model: 'test-model', messages: [] })) chunks.push(chunk)
    expect(chunks).toHaveLength(4)
    expect(chunks[0]).toMatchObject({ index: 99 })
  })

  it('lets llm/generate waterfall listeners intercept and transform the result', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-model'], new ScriptedAdapter(SCRIPT))

    ctx.on('llm/generate', async function (_options, next) {
      const result = await next()
      return { ...result, finish: { kind: 'max-tokens' } as const }
    })

    const result = await ctx.llm.generate({ model: 'test-model', messages: [] })
    expect(result.finish).toEqual({ kind: 'max-tokens' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('creates LlmError with a code for programmatic handling', () => {
    const err = new LlmError('something went wrong', 'CUSTOM_CODE')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('LlmError')
    expect(err.message).toBe('something went wrong')
    expect(err.code).toBe('CUSTOM_CODE')
  })

  it('disposes adapter registration on adapter-change event emission', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)

    const changes: string[][] = []
    ctx.on('llm/adapter-change', () => {
      changes.push([...ctx.llm.models()])
    })

    const dispose = ctx.llm.registerAdapter(['m1'], new ScriptedAdapter(SCRIPT))
    expect(changes).toEqual([['m1']])

    dispose()
    expect(changes).toEqual([['m1'], []])
    expect(ctx.llm.models()).toEqual([])
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
})
