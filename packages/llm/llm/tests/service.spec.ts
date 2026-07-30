import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, {
  errorChain,
  GenerateOptions,
  HarnessError,
  isContextWindowExceededError,
  isQuotaExceededError,
  isLlmAdapterFailure,
  LlmAdapter,
  LlmError,
  llmFailureOf,
  llmRetryPolicyOf,
  ProviderRequestId,
  ReasoningEffortId,
  resolveRetryPolicy,
  StreamChunk,
  createMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  LlmModelContext,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm'

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

class ThrowingAdapter extends LlmAdapter {
  constructor(private readonly failure: Error) {
    super()
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw this.failure
  }
}

class CatalogAdapter extends ScriptedAdapter {
  constructor(
    private readonly provider: LlmProviderInfo,
    private readonly models: readonly LlmModelInfo[],
    private readonly contexts: Readonly<Record<string, LlmModelContext>> = {},
    private readonly reasoning: Readonly<Record<string, LlmModelReasoningInfo>> = {},
  ) {
    super(SCRIPT)
  }

  override providerInfo(_provider: string): LlmProviderInfo {
    return this.provider
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models)
  }

  override resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.contexts[model] === undefined ? {} : { context: this.contexts[model] },
      ...this.reasoning[model] === undefined ? {} : { reasoning: this.reasoning[model] },
    })
  }
}

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hi' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
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

  it('distinguishes exhausted account quota from transient rate limiting', () => {
    for (const detail of [
      'insufficient_quota',
      'account balance depleted',
      'usage-limit-exceeded',
      'out of credits',
      'OpenAI API error (429): You exceeded your current quota, please check your plan and billing details.',
    ]) expect(isQuotaExceededError(detail)).toBe(true)
    expect(isQuotaExceededError('HTTP 429: rate limit reached')).toBe(false)
    expect(isQuotaExceededError('quota resets in one minute')).toBe(false)
  })

  it('errorChain renders the full cause chain of a wrapped transport failure', () => {
    const chain = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:443') })
    expect(errorChain(chain)).toBe('fetch failed: connect ECONNREFUSED 127.0.0.1:443')
  })

  it('errorChain renders AggregateError members (Happy Eyeballs multi-address failures)', () => {
    const aggregate = new AggregateError(
      [new Error('connect ECONNREFUSED ::1:443'), new Error('connect ECONNREFUSED 127.0.0.1:443')],
      '',
    )
    const wrapped = new TypeError('fetch failed', { cause: aggregate })
    expect(errorChain(wrapped)).toBe(
      'fetch failed: AggregateError [connect ECONNREFUSED ::1:443; connect ECONNREFUSED 127.0.0.1:443]',
    )
  })

  it('errorChain survives non-Error values, hostile coercion, and circular causes', () => {
    expect(errorChain('plain string')).toBe('plain string')
    expect(errorChain({ toString: () => { throw new Error('hostile') } })).toBe('<unrenderable value>')
    const circular = new Error('outer')
    circular.cause = circular
    expect(errorChain(circular)).toBe('outer: <circular cause>')
    // A hostile accessor collapses only its own node, not the whole chain.
    const hostileNode = new Error('node')
    Object.defineProperty(hostileNode, 'message', { get() { throw new Error('hostile getter') } })
    expect(errorChain(new Error('outer', { cause: hostileNode }))).toBe('outer: <unrenderable value>')
    // A diamond-shared (non-cyclic) cause renders in full on both paths.
    const shared = new Error('shared')
    const diamond = new AggregateError([new Error('a', { cause: shared }), new Error('b', { cause: shared })], 'agg')
    expect(errorChain(diamond)).toBe('agg [a: shared; b: shared]')
  })

  it('errorChain falls back to the error name, skips empty aggregates, and stops at null causes', () => {
    expect(errorChain(new TypeError('', { cause: null }))).toBe('TypeError')
    expect(errorChain(new AggregateError([], 'all failed'))).toBe('all failed')
  })

  it('errorChain collapses a cause that repeats the wrapper message verbatim', () => {
    // The `new HarnessError(String(value), code, { cause: value })` normalization
    // pattern repeats its cause; rendering it twice would only add noise.
    const wrapped = new HarnessError('boom', 'UNKNOWN', { cause: 'boom' })
    expect(errorChain(wrapped)).toBe('boom')
  })

  it('routes stream() to the registered adapter', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-provider'], new ScriptedAdapter(SCRIPT))

    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'test-provider', model: 'test-model', messages: [] })) chunks.push(chunk)
    expect(chunks).toEqual(SCRIPT)
  })

  it('trusts the immutable message creation boundary for direct calls', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const adapter = new RecordingAdapter(SCRIPT)
    ctx.llm.registerAdapter(['test-provider'], adapter)
    const message = createMessage({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    })

    for await (const _chunk of ctx.llm.stream({
      provider: 'test-provider',
      model: 'test-model',
      messages: [message],
    })) { /* drain */ }

    expect(adapter.lastOptions?.messages[0]).toBe(message)
  })

  it('captures provider-owned retry policy at registration and defaults omission', async () => {
    const configured = resolveRetryPolicy({ mode: 'always' }, 'test retryPolicy')
    const adapter = new class extends ScriptedAdapter {
      override providerRetryPolicy(provider: string) {
        return provider === 'configured' ? configured : undefined
      }
    }(SCRIPT)
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['configured', 'defaulted'], adapter)

    expect(ctx.llm.providerRetryPolicy('configured')).toBe(configured)
    expect(ctx.llm.providerRetryPolicy('defaulted')).toMatchObject({
      mode: 'normal',
      maxRetries: 2,
    })
    expect(() => ctx.llm.providerRetryPolicy('missing')).toThrow(
      expect.objectContaining({ code: 'NO_ADAPTER' }),
    )
  })

  it('keeps the serving registration policy on an in-flight call after route replacement', async () => {
    const oldPolicy = resolveRetryPolicy({ mode: 'always' }, 'old retryPolicy')
    const newPolicy = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'new retryPolicy')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const failure = new LlmError('old route failed', 'AUTH')
    const oldAdapter = new class extends LlmAdapter {
      override providerRetryPolicy(): typeof oldPolicy {
        return oldPolicy
      }

      async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        entered.resolve(undefined)
        await release.promise
        throw failure
      }
    }()
    const newAdapter = new class extends ScriptedAdapter {
      override providerRetryPolicy(): typeof newPolicy {
        return newPolicy
      }
    }(SCRIPT)
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const disposeOld = ctx.llm.registerAdapter(['route'], oldAdapter)
    const stream = ctx.llm.stream({ provider: 'route', model: 'model', messages: [] })
    const outcome = (async (): Promise<unknown> => {
      try {
        for await (const _chunk of stream) { /* drain */ }
      } catch (error: unknown) {
        return error
      }
      return undefined
    })()
    await entered.promise

    disposeOld()
    ctx.llm.registerAdapter(['route'], newAdapter)
    release.resolve(undefined)

    expect(await outcome).toBe(failure)
    expect(llmRetryPolicyOf(stream)).toBe(oldPolicy)
    expect(ctx.llm.providerRetryPolicy('route')).toBe(newPolicy)
  })

  it('throws NO_ADAPTER for unregistered providers', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const stream = ctx.llm.stream({ provider: 'nope', model: 'any-model', messages: [] })
    let caught: unknown
    try {
      for await (const _ of stream) { /* drain */ }
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).code).toBe('NO_ADAPTER')
    expect((caught as LlmError).message).toContain('no adapter registered')
    expect(isLlmAdapterFailure(stream, caught)).toBe(true)
    expect(llmRetryPolicyOf(stream)).toBeUndefined()
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

    const stream = ctx.llm.stream({ provider: 'test-model', model: 'test-model', messages: [] })
    let caught: unknown
    try {
      for await (const _chunk of stream) { /* drain */ }
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBe(original)
    expect(isLlmAdapterFailure(stream, caught)).toBe(true)
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

    const stream = ctx.llm.stream({ provider: 'test-model', model: 'test-model', messages: [] })
    let caught: unknown
    try {
      for await (const _chunk of stream) { /* drain */ }
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBe(original)
    expect(isLlmAdapterFailure(stream, caught)).toBe(true)
    expect(llmFailureOf(stream, caught)).toEqual({
      message: `${boundary} failed`,
      code: 'BOUNDARY_FAILED',
    })
  })

  it('keeps structured provider facts beside a frozen third-party Error', async () => {
    const original = new LlmError('provider busy', 'RATE_LIMIT', {
      status: 429,
      providerRetryAfterMs: 1_500,
      requestId: ProviderRequestId('req-7'),
    })
    Object.freeze(original)
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-provider'], new ThrowingAdapter(original))

    const stream = ctx.llm.stream({ provider: 'test-provider', model: 'test-model', messages: [] })
    let caught: unknown
    try {
      for await (const _chunk of stream) { /* drain */ }
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBe(original)
    expect(llmFailureOf(stream, caught)).toEqual({
      message: 'provider busy',
      code: 'RATE_LIMIT',
      status: 429,
      providerRetryAfterMs: 1_500,
      requestId: ProviderRequestId('req-7'),
    })
  })

  it('does not trust retry facts carried by an unknown third-party Error', async () => {
    const carried = { message: 'busy', code: 'SERVER', status: 503 }
    const original = Object.assign(new Error('busy'), { failure: carried })
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-provider'], new ThrowingAdapter(original))

    const stream = ctx.llm.stream({ provider: 'test-provider', model: 'test-model', messages: [] })
    await expect((async () => {
      for await (const _chunk of stream) { /* drain */ }
    })()).rejects.toBe(original)
    const facts = llmFailureOf(stream, original)
    carried.status = 500

    expect(facts).toEqual({ message: 'busy', code: 'UNKNOWN' })
    expect(Object.isFrozen(facts)).toBe(true)
    expect(facts).not.toBe(carried)
  })

  it('keeps validated failure facts across package copies with matching own codes', async () => {
    const original = Object.assign(new Error('provider busy'), {
      code: 'RATE_LIMIT',
      failure: {
        message: 'provider busy',
        code: 'RATE_LIMIT',
        status: 429,
        providerRetryAfterMs: 1_500,
        requestId: 'req-cross-copy',
      },
    })
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-provider'], new ThrowingAdapter(original))

    const stream = ctx.llm.stream({ provider: 'test-provider', model: 'test-model', messages: [] })
    await expect((async () => {
      for await (const _chunk of stream) { /* drain */ }
    })()).rejects.toBe(original)
    expect(llmFailureOf(stream, original)).toEqual({
      message: 'provider busy',
      code: 'RATE_LIMIT',
      status: 429,
      providerRetryAfterMs: 1_500,
      requestId: 'req-cross-copy',
    })
  })

  it('keeps an unknown SDK Error exact without trusting its private code or accessors', async () => {
    const original = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })
    Object.defineProperty(original, 'failure', {
      get() { throw new Error('SDK failure accessor must not run') },
    })
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-provider'], new ThrowingAdapter(original))

    const stream = ctx.llm.stream({ provider: 'test-provider', model: 'test-model', messages: [] })
    await expect((async () => {
      for await (const _chunk of stream) { /* drain */ }
    })()).rejects.toBe(original)

    expect(original.code).toBe('ECONNRESET')
    expect(llmFailureOf(stream, original)).toEqual({ message: 'socket closed', code: 'UNKNOWN' })
  })

  it('keeps an SDK Error exact when its message accessor is hostile', async () => {
    const original = Object.defineProperty(new Error(), 'message', {
      get() { throw new Error('SDK message accessor trap') },
    })
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-provider'], new ThrowingAdapter(original))
    const stream = ctx.llm.stream({ provider: 'test-provider', model: 'test-model', messages: [] })

    await expect((async () => {
      for await (const _chunk of stream) { /* drain */ }
    })()).rejects.toBe(original)
    expect(llmFailureOf(stream, original)).toEqual({ message: 'LLM adapter failed', code: 'UNKNOWN' })
  })

  it('keeps an SDK Error exact without trusting accessor-backed carried facts', async () => {
    const original = Object.assign(new Error('busy'), {
      failure: { message: 'busy', code: 'SERVER', status: 503 },
    })
    Object.defineProperty(original, 'code', {
      get() { throw new Error('SDK code accessor must not escape') },
    })
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-provider'], new ThrowingAdapter(original))
    const stream = ctx.llm.stream({ provider: 'test-provider', model: 'test-model', messages: [] })

    await expect((async () => {
      for await (const _chunk of stream) { /* drain */ }
    })()).rejects.toBe(original)
    expect(llmFailureOf(stream, original)).toEqual({ message: 'busy', code: 'UNKNOWN' })
  })

  it('does not trust carried facts matched only by an inherited code', async () => {
    class InheritedCodeError extends Error {
      get code(): string { return 'SERVER' }
    }
    const original = Object.assign(new InheritedCodeError('busy'), {
      failure: { message: 'busy', code: 'SERVER', status: 503 },
    })
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-provider'], new ThrowingAdapter(original))
    const stream = ctx.llm.stream({ provider: 'test-provider', model: 'test-model', messages: [] })

    await expect((async () => {
      for await (const _chunk of stream) { /* drain */ }
    })()).rejects.toBe(original)
    expect(llmFailureOf(stream, original)).toEqual({ message: 'busy', code: 'UNKNOWN' })
  })

  it('keeps an SDK Error exact when code descriptor inspection is trapped', async () => {
    const target = Object.assign(new Error('busy'), {
      code: 'SERVER',
      failure: { message: 'busy', code: 'SERVER', status: 503 },
    })
    const original = new Proxy(target, {
      getOwnPropertyDescriptor(value, property) {
        if (property === 'code') throw new Error('SDK code descriptor trap')
        return Reflect.getOwnPropertyDescriptor(value, property)
      },
    })
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-provider'], new ThrowingAdapter(original))
    const stream = ctx.llm.stream({ provider: 'test-provider', model: 'test-model', messages: [] })

    await expect((async () => {
      for await (const _chunk of stream) { /* drain */ }
    })()).rejects.toBe(original)
    expect(llmFailureOf(stream, original)).toEqual({ message: 'busy', code: 'UNKNOWN' })
  })

  it('falls back safely when SDK objects trap failure inspection or expose malformed facts', async () => {
    const propertyTrap = new Proxy(new HarnessError('descriptor trapped', 'SERVER'), {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'failure') throw new Error('SDK descriptor trap')
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    const throwingFacts = Object.create(null) as Record<string, unknown>
    Object.defineProperty(throwingFacts, 'message', {
      get() { throw new Error('SDK fact getter trap') },
    })
    const carrying = (message: string, failure: unknown): HarnessError => Object.defineProperty(
      new HarnessError(message, 'SERVER'),
      'failure',
      { value: failure },
    )
    const factGetter = carrying('fact getter failed', throwingFacts)
    const malformed = carrying('malformed facts', { message: 'provider busy', code: 'SERVER', requestId: 1 })
    const primitive = carrying('primitive facts', 1)
    const nullFacts = carrying('null facts', null)
    const mismatched = carrying('mismatched facts', { message: 'busy', code: 'RATE_LIMIT' })

    for (const [original, expectedMessage] of [
      [propertyTrap, 'descriptor trapped'],
      [factGetter, 'fact getter failed'],
      [malformed, 'malformed facts'],
      [primitive, 'primitive facts'],
      [nullFacts, 'null facts'],
      [mismatched, 'mismatched facts'],
    ] as const) {
      const ctx = new Context()
      await ctx.plugin(LlmService)
      ctx.llm.registerAdapter(['test-provider'], new ThrowingAdapter(original))
      const stream = ctx.llm.stream({ provider: 'test-provider', model: 'test-model', messages: [] })

      await expect((async () => {
        for await (const _chunk of stream) { /* drain */ }
      })()).rejects.toBe(original)
      expect(llmFailureOf(stream, original)).toEqual({ message: expectedMessage, code: 'SERVER' })
    }
  })

  it('retains a stable code from a HarnessError without requiring LlmError facts', async () => {
    const original = new HarnessError('stable adapter failure', 'ADAPTER_STABLE')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-provider'], new ThrowingAdapter(original))
    const stream = ctx.llm.stream({ provider: 'test-provider', model: 'test-model', messages: [] })

    await expect((async () => {
      for await (const _chunk of stream) { /* drain */ }
    })()).rejects.toBe(original)
    expect(llmFailureOf(stream, original)).toEqual({
      message: 'stable adapter failure',
      code: 'ADAPTER_STABLE',
    })
    expect(llmFailureOf(stream, 'not an Error')).toBeUndefined()
    expect(llmFailureOf({ [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator]() }, original)).toBeUndefined()
  })

  it('keeps a nested adapter failure scoped to the nested model call', async () => {
    const original = new LlmError('nested provider failed', 'NESTED_FAILED')
    const outer = new RecordingAdapter(SCRIPT)
    const nested = new ThrowingAdapter(original)
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['outer'], outer)
    ctx.llm.registerAdapter(['nested'], nested)
    let nestedStream: AsyncIterable<StreamChunk> | undefined
    ctx.on('llm/stream', (options, next) => {
      if (options.provider !== 'outer') return next()
      return (async function* () {
        nestedStream = ctx.llm.stream({ provider: 'nested', model: 'nested', messages: [] })
        yield * nestedStream
      })()
    })

    const outerStream = ctx.llm.stream({ provider: 'outer', model: 'outer', messages: [] })
    let caught: unknown
    try {
      for await (const _chunk of outerStream) { /* drain */ }
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBe(original)
    expect(nestedStream).toBeDefined()
    expect(isLlmAdapterFailure(nestedStream!, caught)).toBe(true)
    expect(isLlmAdapterFailure(outerStream, caught)).toBe(false)
    expect(outer.lastOptions).toBeUndefined()
  })

  it('keeps call scopes distinct when middleware reuses an iterable', async () => {
    const firstFailure = new LlmError('first provider failed', 'FIRST_FAILED')
    const secondFailure = new LlmError('second provider failed', 'SECOND_FAILED')
    const delegates: AsyncIterable<StreamChunk>[] = []
    const shared: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
        const delegate = delegates.shift()
        if (delegate === undefined) throw new Error('shared stream has no call delegate')
        return delegate[Symbol.asyncIterator]()
      },
    }
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['first'], new ThrowingAdapter(firstFailure))
    ctx.llm.registerAdapter(['second'], new ThrowingAdapter(secondFailure))
    ctx.on('llm/stream', (_options, next) => {
      delegates.push(next())
      return shared
    })

    const firstStream = ctx.llm.stream({ provider: 'first', model: 'first', messages: [] })
    const secondStream = ctx.llm.stream({ provider: 'second', model: 'second', messages: [] })
    const catchFailure = async (stream: AsyncIterable<StreamChunk>): Promise<unknown> => {
      try {
        for await (const _chunk of stream) { /* drain */ }
      } catch (error: unknown) {
        return error
      }
      return new Error('expected adapter to fail')
    }

    expect(firstStream).not.toBe(secondStream)
    const firstCaught = await catchFailure(firstStream)
    expect(firstCaught).toBe(firstFailure)
    expect(isLlmAdapterFailure(firstStream, firstCaught)).toBe(true)
    expect(isLlmAdapterFailure(secondStream, firstCaught)).toBe(false)
    const secondCaught = await catchFailure(secondStream)
    expect(secondCaught).toBe(secondFailure)
    expect(isLlmAdapterFailure(secondStream, secondCaught)).toBe(true)
    expect(isLlmAdapterFailure(firstStream, secondCaught)).toBe(false)
    expect(delegates).toHaveLength(0)
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

    const stream = ctx.llm.stream({ provider: 'test-model', model: 'test-model', messages: [] })
    const failure = (async (): Promise<unknown> => {
      try {
        for await (const _chunk of stream) { /* drain */ }
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
    expect(isLlmAdapterFailure(stream, caught)).toBe(true)
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

    const stream = ctx.llm.stream({ provider: 'test-model', model: 'test-model', messages: [] })
    let caught: unknown
    try {
      for await (const _chunk of stream) break
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBe(cleanup)
    expect(isLlmAdapterFailure(stream, caught)).toBe(false)
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
    for await (const _chunk of ctx.llm.stream({ provider: 'test-model', model: 'test-model', messages: [] })) {
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
            // Third-party adapters can reject with arbitrary values.
            // oxlint-disable-next-line typescript/prefer-promise-reject-errors
            return { next: () => Promise.reject('plain provider failure') }
          },
        }
      }
    }()
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-model'], adapter)

    const stream = ctx.llm.stream({ provider: 'test-model', model: 'test-model', messages: [] })
    let caught: unknown
    try {
      for await (const _chunk of stream) { /* drain */ }
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HarnessError)
    expect(caught).toMatchObject({ code: 'UNKNOWN', cause: 'plain provider failure' })
    expect(isLlmAdapterFailure(stream, caught)).toBe(true)
  })

  it('does not tag a failure thrown downstream while consuming adapter output', async () => {
    const downstream = new Error('consumer failed')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-model'], new ScriptedAdapter(SCRIPT))

    const stream = ctx.llm.stream({ provider: 'test-model', model: 'test-model', messages: [] })
    let caught: unknown
    try {
      for await (const _chunk of stream) throw downstream
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBe(downstream)
    expect(isLlmAdapterFailure(stream, caught)).toBe(false)
    expect(isLlmAdapterFailure(new ScriptedAdapter(SCRIPT).stream({
      provider: 'unbound', model: 'unbound', messages: [],
    }), caught)).toBe(false)
    expect(isLlmAdapterFailure(stream, 'consumer failed')).toBe(false)
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
    await expect(ctx.llm.resolveModelInfo('plain', 'unlisted')).resolves.toEqual({
      provider: 'plain', id: 'unlisted', name: 'unlisted',
    })
    await expect(ctx.llm.resolveModelInfo('missing', 'm')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
  })

  it.each([
    [{ provider: 1, id: 'model', name: 'Model' }, 'non-string provider'],
    [{ provider: 'other', id: 'model', name: 'Model' }, 'mismatched provider'],
    [{ provider: 'route', id: 1, name: 'Model' }, 'non-string id'],
    [{ provider: 'route', id: 'other', name: 'Model' }, 'mismatched id'],
    [{ provider: 'route', id: 'model', name: 1 }, 'non-string name'],
    [{ provider: 'route', id: 'model', name: '' }, 'empty name'],
    [{ provider: 'route', id: 'model', name: 'Model', description: 1 }, 'non-string description'],
  ] as const)('rejects invalid exact model metadata (%s: %s)', async (metadata, _label) => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const adapter = new class extends ScriptedAdapter {
      override resolveModel(): Promise<LlmResolvedModelInfo> {
        return Promise.resolve(metadata as unknown as LlmResolvedModelInfo)
      }
    }(SCRIPT)
    ctx.llm.registerAdapter(['route'], adapter)

    await expect(ctx.llm.resolveModelInfo('route', 'model'))
      .rejects.toMatchObject({ code: 'INVALID_MODEL_INFO' })
  })

  it('resolves detached model context independently of advisory catalog membership', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const source = { contextWindow: 32_000 }
    ctx.llm.registerAdapter(['route'], new CatalogAdapter(
      { id: 'route', name: 'Route' },
      [],
      { unlisted: source },
    ))

    const resolved = await ctx.llm.resolveModelInfo('route', 'unlisted')
    expect(resolved.context).toEqual({ contextWindow: 32_000 })
    source.contextWindow = 64_000
    expect(resolved.context).toEqual({ contextWindow: 32_000 })
    await expect(ctx.llm.resolveModelInfo('route', 'other')).resolves.toEqual({
      provider: 'route', id: 'other', name: 'other',
    })
  })

  it('resolves detached adapter-owned reasoning metadata and materializes its default', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const source = {
      efforts: [
        { id: ReasoningEffortId('standard'), name: 'Standard' },
        { id: ReasoningEffortId('ultra'), name: 'Ultra', description: 'Largest budget' },
      ],
      defaultEffort: ReasoningEffortId('standard'),
    }
    ctx.llm.registerAdapter(['route'], new CatalogAdapter(
      { id: 'route', name: 'Route' },
      [],
      {},
      { model: source },
    ))

    const resolved = await ctx.llm.resolveModelInfo('route', 'model')
    expect(resolved.reasoning).toEqual(source)
    source.efforts[0]!.name = 'mutated'
    expect(resolved.reasoning?.efforts[0]?.name).toBe('Standard')
    await expect(ctx.llm.resolveCallConfig({ provider: 'route', model: 'model' })).resolves.toEqual({
      provider: 'route',
      model: 'model',
      reasoningEffort: ReasoningEffortId('standard'),
    })
    const explicit = { provider: 'route', model: 'model', reasoningEffort: ReasoningEffortId('ultra') }
    await expect(ctx.llm.resolveCallConfig(explicit)).resolves.toBe(explicit)
  })

  it.each([
    [{ efforts: [] }, 'empty effort list'],
    [{ efforts: [{ id: '', name: 'Empty' }] }, 'empty id'],
    [{ efforts: [{ id: 'valid', name: '' }] }, 'empty name'],
    [{ efforts: [{ id: 'valid', name: 'Valid', description: 1 }] }, 'non-string description'],
    [{ efforts: [{ id: 'same', name: 'One' }, { id: 'same', name: 'Two' }] }, 'duplicate id'],
    [{ efforts: [{ id: 'valid', name: 'Valid' }], defaultEffort: 'other' }, 'unknown default'],
  ] as const)('rejects invalid model reasoning metadata (%s: %s)', async (metadata, _label) => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['route'], new CatalogAdapter(
      { id: 'route', name: 'Route' },
      [],
      {},
      { model: metadata as unknown as LlmModelReasoningInfo },
    ))
    await expect(ctx.llm.resolveModelInfo('route', 'model'))
      .rejects.toMatchObject({ code: 'INVALID_MODEL_REASONING' })
  })

  it('rejects unsupported reasoning efforts without clamping', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['route'], new CatalogAdapter(
      { id: 'route', name: 'Route' },
      [],
      {},
      { model: { efforts: [{ id: ReasoningEffortId('ultra'), name: 'Ultra' }] } },
    ))

    await expect(ctx.llm.resolveCallConfig({
      provider: 'route',
      model: 'model',
      reasoningEffort: ReasoningEffortId('standard'),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    await expect(ctx.llm.resolveCallConfig({
      provider: 'route',
      model: 'plain',
      reasoningEffort: ReasoningEffortId('standard'),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
  })

  it('resolves reasoning defaults at the final adapter boundary after routing middleware', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const adapter = new class extends RecordingAdapter {
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        const reasoning: LlmModelReasoningInfo = {
          efforts: [{ id: ReasoningEffortId('standard'), name: 'Standard' }],
          defaultEffort: ReasoningEffortId('standard'),
        }
        return Promise.resolve({
          provider,
          id: model,
          name: model,
          reasoning,
        })
      }
    }(SCRIPT)
    ctx.llm.registerAdapter(['routed'], adapter)
    const disposeRouting = ctx.on('llm/stream', (options, next) => {
      options.provider = 'routed'
      return next()
    })

    for await (const _chunk of ctx.llm.stream({
      provider: 'initial',
      model: 'model',
      messages: [],
    })) { /* drain */ }

    expect(adapter.lastOptions?.reasoningEffort).toBe(ReasoningEffortId('standard'))
    disposeRouting()

    const frozenRequest: GenerateOptions = Object.freeze({
      provider: 'routed',
      model: 'model',
      messages: [],
    })
    for await (const _chunk of ctx.llm.stream(frozenRequest)) { /* drain */ }
    expect(adapter.lastOptions?.reasoningEffort).toBe(ReasoningEffortId('standard'))
    expect(Object.isFrozen(adapter.lastOptions)).toBe(true)
  })

  it('pins one adapter registration across asynchronous exact-model resolution and dispatch', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const started = Promise.withResolvers<undefined>()
    const reasoning = Promise.withResolvers<LlmModelReasoningInfo>()
    const first = new class extends RecordingAdapter {
      override async resolveModel(
        provider: string,
        model: string,
        _signal?: AbortSignal,
      ): Promise<LlmResolvedModelInfo> {
        started.resolve(undefined)
        return {
          provider,
          id: model,
          name: model,
          reasoning: await reasoning.promise,
        }
      }
    }(SCRIPT)
    const disposeFirst = ctx.llm.registerAdapter(['route'], first)
    const draining = (async () => {
      for await (const _chunk of ctx.llm.stream({
        provider: 'route',
        model: 'model',
        messages: [],
      })) { /* drain */ }
    })()

    await started.promise
    disposeFirst()
    const second = new RecordingAdapter(SCRIPT)
    ctx.llm.registerAdapter(['route'], second)
    reasoning.resolve({
      efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
      defaultEffort: ReasoningEffortId('high'),
    })
    await draining

    expect(first.lastOptions?.reasoningEffort).toBe(ReasoningEffortId('high'))
    expect(second.lastOptions).toBeUndefined()
  })

  it('prepares a one-shot registration-bound call and rejects config drift', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const adapter = new CatalogAdapter(
      { id: 'route', name: 'Route' },
      [],
      {},
      {
        model: {
          efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
          defaultEffort: ReasoningEffortId('high'),
        },
      },
    )
    ctx.llm.registerAdapter(['route'], adapter)
    const prepared = await ctx.llm.prepareCall({ provider: 'route', model: 'model' })
    expect(Object.isFrozen(prepared.config)).toBe(true)
    const stream = prepared.stream({
      ...prepared.config,
      model: 'other',
      messages: [],
    })

    await expect((async () => {
      for await (const _chunk of stream) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'INVALID_PREPARED_CALL' })
    expect(() => prepared.stream({
      ...prepared.config,
      messages: [],
    })).toThrow(expect.objectContaining({ code: 'INVALID_PREPARED_CALL' }))
  })

  it('passes cancellation through exact-model resolution', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const started = Promise.withResolvers<undefined>()
    const adapter = new class extends ScriptedAdapter {
      override resolveModel(
        _provider: string,
        _model: string,
        signal?: AbortSignal,
      ): Promise<LlmResolvedModelInfo> {
        started.resolve(undefined)
        return new Promise<LlmResolvedModelInfo>((_resolve, reject) => {
          if (signal === undefined) {
            reject(new Error('missing reasoning signal'))
            return
          }
          if (signal.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : new Error('reasoning aborted'))
            return
          }
          signal.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('reasoning aborted'))
          }, { once: true })
        })
      }
    }(SCRIPT)
    ctx.llm.registerAdapter(['route'], adapter)
    const controller = new AbortController()
    const resolving = ctx.llm.resolveCallConfig(
      { provider: 'route', model: 'model' },
      controller.signal,
    )

    await started.promise
    const reason = new Error('cancel reasoning')
    controller.abort(reason)
    await expect(resolving).rejects.toBe(reason)
  })

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects invalid adapter model context %s',
    async (contextWindow) => {
      const ctx = new Context()
      await ctx.plugin(LlmService)
      ctx.llm.registerAdapter(['route'], new CatalogAdapter(
        { id: 'route', name: 'Route' },
        [],
        { model: { contextWindow } },
      ))
      await expect(ctx.llm.resolveModelInfo('route', 'model'))
        .rejects.toMatchObject({ code: 'INVALID_MODEL_CONTEXT' })
    },
  )

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
        yield { type: 'block-end', index: 99, block: { type: 'text', text: '' } } satisfies StreamChunk
        yield * inner
      })()
    })

    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'test-model', model: 'dynamic-model', messages: [] })) chunks.push(chunk)
    expect(chunks).toHaveLength(6)
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
      messages: [createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'old response' }],
        source: {
          kind: 'model',
          ...{ provider: 'historical', model: 'old-model', replayState },
        },
      })],
    })) { /* drain */ }

    expect(adapter.lastOptions?.messages[0]?.source).toEqual({
      kind: 'model', provider: 'historical', model: 'old-model', replayState,
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
      messages: [createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'old response' }],
        source: {
          kind: 'model',
          ...{ provider: 'historical', model: 'old-model', replayState: { private: 'state' } },
        },
      })],
    })) { /* drain */ }

    expect(target.lastOptions?.messages[0]?.source).toEqual({
      kind: 'model',
      provider: 'historical',
      model: 'old-model',
    })
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
      messages: [createMessage({
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'old response' }],
        source: {
          kind: 'model',
          provider: 'historical',
          model: 'old-model',
          replayState: { private: 'state' },
        },
      })],
    })

    for await (const _chunk of ctx.llm.stream(options)) { /* drain */ }

    expect(target.lastOptions).not.toBe(options)
    expect(Object.isFrozen(target.lastOptions)).toBe(true)
    expect(target.lastOptions?.messages[0]?.source).toEqual({
      kind: 'model',
      provider: 'historical',
      model: 'old-model',
    })
  })

  it('creates LlmError with a code for programmatic handling', () => {
    const err = new LlmError('something went wrong', 'CUSTOM_CODE')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('LlmError')
    expect(err.message).toBe('something went wrong')
    expect(err.code).toBe('CUSTOM_CODE')
  })

  it('rejects non-serializable structured failure facts at construction', () => {
    expect(() => new LlmError('busy', 'RATE_LIMIT', { status: 42 })).toThrow(/status/)
    expect(() => new LlmError('busy', 'RATE_LIMIT', { providerRetryAfterMs: Number.NaN }))
      .toThrow(/providerRetryAfterMs/)
    expect(() => new LlmError('busy', 'RATE_LIMIT', { requestId: ProviderRequestId('') })).toThrow(/requestId/)
    expect(() => new LlmError(1 as never, 'RATE_LIMIT')).toThrow(/message/)
    expect(() => new LlmError('busy', 1 as never)).toThrow(/code/)
    expect(() => new LlmError('busy', 'RATE_LIMIT', { requestId: 1 as never })).toThrow(/requestId/)
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
