import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, {
  GenerateOptions,
  HarnessError,
  isContextWindowExceededError,
  isLlmAdapterFailure,
  LlmAdapter,
  LlmError,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'

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
  it('recognizes structured and model-capacity context-window overflow details', () => {
    expect(isContextWindowExceededError('context_length_exceeded maximum context length')).toBe(true)
    expect(isContextWindowExceededError('context-window-overflowed')).toBe(true)
    expect(isContextWindowExceededError('This model maximum context length is 128000 tokens')).toBe(true)
    expect(isContextWindowExceededError('input is too long for this model')).toBe(true)
    expect(isContextWindowExceededError('request too large for model context')).toBe(true)
    expect(isContextWindowExceededError('input exceeds the model context window limit')).toBe(true)
  })

  it('does not mistake unrelated input validation for context-window overflow', () => {
    expect(isContextWindowExceededError('invalid request: malformed tool arguments')).toBe(false)
    expect(isContextWindowExceededError('invalid input: temperature exceeds maximum allowed value')).toBe(false)
    expect(isContextWindowExceededError('input exceeds maximum allowed value')).toBe(false)
    expect(isContextWindowExceededError('context window size must be positive')).toBe(false)
  })

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
    let caught: unknown
    try {
      for await (const _ of ctx.llm.stream({ model: 'nope', messages: [] })) { /* drain */ }
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).code).toBe('NO_ADAPTER')
    expect((caught as LlmError).message).toContain('no adapter registered')
    expect(isLlmAdapterFailure(caught)).toBe(true)
  })

  it.each(['done', 'value'] as const)('tags a throwing IteratorResult.%s getter without replacing its Error', async (field) => {
    const original = new LlmError(`${field} getter failed`, 'RESULT_GETTER_FAILED')
    const result = field === 'done' ? {} : { done: false }
    Object.defineProperty(result, field, { get: () => { throw original } })
    let cleanupLookups = 0
    const iterator: AsyncIterator<StreamChunk> = {
      next: () => Promise.resolve(result as unknown as IteratorResult<StreamChunk>),
    }
    Object.defineProperty(iterator, 'return', {
      get: () => {
        cleanupLookups += 1
        throw new Error('return getter must not run after iteration fails')
      },
    })
    const adapter = new class extends LlmAdapter {
      stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        return {
          [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
            return iterator
          },
        }
      }
    }()
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-model'], adapter)

    let caught: unknown
    try {
      for await (const _chunk of ctx.llm.stream({ model: 'test-model', messages: [] })) { /* drain */ }
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBe(original)
    expect(isLlmAdapterFailure(caught)).toBe(true)
    expect(cleanupLookups).toBe(0)
  })

  it.each(['dispatch', 'iterator'] as const)('tags synchronous adapter %s failures without replacing their Error', async (boundary) => {
    const original = new LlmError(`${boundary} failed`, 'BOUNDARY_FAILED')
    const adapter = new class extends LlmAdapter {
      stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (boundary === 'dispatch') throw original
        return { [Symbol.asyncIterator]: () => { throw original } }
      }
    }()
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-model'], adapter)

    let caught: unknown
    try {
      for await (const _chunk of ctx.llm.stream({ model: 'test-model', messages: [] })) { /* drain */ }
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBe(original)
    expect(isLlmAdapterFailure(caught)).toBe(true)
  })

  it('propagates a rejected next promptly without awaiting a non-settling return', async () => {
    const original = new LlmError('provider failed', 'PROVIDER_FAILED')
    let cleanupCalls = 0
    const adapter = new class extends LlmAdapter {
      stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        return {
          [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
            return {
              next: () => Promise.reject(original),
              return: () => {
                cleanupCalls += 1
                return new Promise<IteratorResult<StreamChunk>>(() => {})
              },
            }
          },
        }
      }
    }()
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-model'], adapter)

    const failure = (async (): Promise<unknown> => {
      try {
        for await (const _chunk of ctx.llm.stream({ model: 'test-model', messages: [] })) { /* drain */ }
      } catch (error: unknown) {
        return error
      }
      return new Error('expected adapter iteration to fail')
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<Error>((resolve) => {
      timer = setTimeout(() => { resolve(new Error('adapter failure did not settle promptly')) }, 100)
    })
    const caught = await Promise.race([failure, timeout])
    if (timer !== undefined) clearTimeout(timer)

    expect(caught).toBe(original)
    expect(isLlmAdapterFailure(caught)).toBe(true)
    expect(cleanupCalls).toBe(0)
  })

  it('awaits one adapter return on downstream close and leaves its rejection unclassified', async () => {
    const cleanup = new Error('cleanup failed')
    let cleanupCalls = 0
    const adapter = new class extends LlmAdapter {
      stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        return {
          [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
            return {
              next: () => Promise.resolve({ done: false, value: SCRIPT[0]! }),
              return: () => {
                cleanupCalls += 1
                return Promise.reject(cleanup)
              },
            }
          },
        }
      }
    }()
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-model'], adapter)

    let caught: unknown
    try {
      for await (const _chunk of ctx.llm.stream({ model: 'test-model', messages: [] })) break
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBe(cleanup)
    expect(isLlmAdapterFailure(caught)).toBe(false)
    expect(cleanupCalls).toBe(1)
  })

  it('allows downstream close when the adapter iterator has no return method', async () => {
    const adapter = new class extends LlmAdapter {
      stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        return {
          [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
            return { next: () => Promise.resolve({ done: false, value: SCRIPT[0]! }) }
          },
        }
      }
    }()
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-model'], adapter)

    let chunks = 0
    for await (const _chunk of ctx.llm.stream({ model: 'test-model', messages: [] })) {
      chunks += 1
      break
    }

    expect(chunks).toBe(1)
  })

  it('normalizes and tags non-Error adapter failures once', async () => {
    const adapter = new class extends LlmAdapter {
      stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        return {
          [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
            // Third-party adapters can reject with arbitrary values; normalization is under test.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            return { next: () => Promise.reject('plain provider failure') }
          },
        }
      }
    }()
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-model'], adapter)

    let caught: unknown
    try {
      for await (const _chunk of ctx.llm.stream({ model: 'test-model', messages: [] })) { /* drain */ }
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HarnessError)
    expect(caught).toMatchObject({ code: 'UNKNOWN', cause: 'plain provider failure' })
    expect(isLlmAdapterFailure(caught)).toBe(true)
  })

  it('does not tag a failure thrown downstream while consuming adapter output', async () => {
    const downstream = new Error('consumer failed')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-model'], new ScriptedAdapter(SCRIPT))

    let caught: unknown
    try {
      for await (const _chunk of ctx.llm.stream({ model: 'test-model', messages: [] })) throw downstream
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBe(downstream)
    expect(isLlmAdapterFailure(caught)).toBe(false)
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
