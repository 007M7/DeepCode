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
  it('routes stream() to the registered adapter', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-model'], new ScriptedAdapter(SCRIPT))

    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ model: 'test-model', messages: [] })) chunks.push(chunk)
    expect(chunks).toEqual(SCRIPT)
  })

  it('throws NO_ADAPTER for unregistered models', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await expect((async () => {
      for await (const _ of ctx.llm.stream({ model: 'nope', messages: [] })) { /* drain */ }
    })()).rejects.toThrow('no adapter registered')
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

  it('creates LlmError with a code for programmatic handling', () => {
    const err = new LlmError('something went wrong', 'CUSTOM_CODE')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('LlmError')
    expect(err.message).toBe('something went wrong')
    expect(err.code).toBe('CUSTOM_CODE')
  })

  it('LlmError extends the shared HarnessError base', async () => {
    const { HarnessError, isHarnessError } = await import('@deepseek-ai/dsh-llm')
    const err = new LlmError('boom', 'AUTH', 401)
    expect(err).toBeInstanceOf(HarnessError)
    expect(isHarnessError(err)).toBe(true)
    expect(err.code).toBe('AUTH')
    expect(err.status).toBe(401)
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
    expect(ctx.llm.models()).toEqual(['m1'])
    dispose()
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

  it('re-registers a model after its prior registration is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)

    const dispose = ctx.llm.registerAdapter(['m1'], new ScriptedAdapter(SCRIPT))
    expect(ctx.llm.models()).toEqual(['m1'])
    dispose()
    expect(ctx.llm.models()).toEqual([])

    // The duplicate check is not wedged: the same model registers cleanly again.
    const disposeAgain = ctx.llm.registerAdapter(['m1'], new ScriptedAdapter(SCRIPT))
    expect(ctx.llm.models()).toEqual(['m1'])
    disposeAgain()
    expect(ctx.llm.models()).toEqual([])
  })
})
