import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import LlmService, { createUserMessage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  errorChain,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  userAgent,
} from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { httpErrorCode } from '../src/adapter.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'
import type { Behavior } from './mock-server.ts'

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

async function harness(baseURL: string, config: object = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(LlmDeepSeek, { apiKey: 'test-key', baseURL, ...config })
  return ctx
}

/** Direct adapter over the plugin's real resolve step, with a static key. */
function adapterOf(config: Partial<LlmDeepSeek.Config> & { apiKey?: string } = {}): DeepSeekAdapter {
  const { apiKey, ...rest } = config
  return new DeepSeekAdapter({
    options: () => resolveAdapterOptions(rest),
    resolveApiKey: () => Promise.resolve(apiKey ?? 'k'),
  })
}

describe('DeepSeekAdapter against a mock server', () => {
  it('streams a text generation end to end through the assembler', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)

    const result = await assemble(ctx, {
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1 })

    // The wire request carried the auth header contents we configured.
    expect(server.requests[0]).toMatchObject({
      model: 'deepseek-v4-flash',
      reasoning_effort: 'high',
      stream: true,
      stream_options: { include_usage: true },
    })
    // Attribution reaches the wire: the exact shared User-Agent, and no
    // provider-specific headers under the User-Agent-only contract.
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
    expect(server.headers[0]).not.toHaveProperty('http-referer')
    expect(server.headers[0]).not.toHaveProperty('x-openrouter-title')
    expect(server.headers[0]).not.toHaveProperty('x-openrouter-categories')
    expect(server.headers[0]).not.toHaveProperty('x-deepseek-harness-compact')
  })

  it('streams raw chunks through ctx.llm.stream', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents, delayMs: 2 }])
    const ctx = await harness(server.url)

    const kinds: string[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })) {
      kinds.push(chunk.type)
    }
    expect(kinds).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })

  it('forwards the harness session id for host-side trajectory routing', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)

    await assemble(ctx, {
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
      sessionId: SessionId('child-session'),
    })

    expect(server.headers[0]?.['x-deepseek-harness-session-id']).toBe('child-session')
  })

  it('marks the auxiliary compaction call on the wire', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)

    await assemble(ctx, {
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
      purpose: 'compaction',
    })

    expect(server.headers[0]?.['x-deepseek-harness-compact']).toBe('1')
  })

  it('switches dynamically from the configured high default through off to max', async () => {
    const server = await mockServer([
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
    ])
    const ctx = await harness(server.url, { thinking: 'enabled', reasoningEffort: 'high' })

    await assemble(ctx,{
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    await assemble(ctx,{
      model: 'deepseek-v4-flash',
      reasoningEffort: ReasoningEffortId('off'),
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi again' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    await assemble(ctx,{
      model: 'deepseek-v4-flash',
      reasoningEffort: ReasoningEffortId('max'),
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'one more time' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(server.requests[0]).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
    expect(server.requests[1]).toMatchObject({
      thinking: { type: 'disabled' },
    })
    expect(server.requests[1]).not.toHaveProperty('reasoning_effort')
    expect(server.requests[2]).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    })
  })

  it('publishes only off and omits the wire effort when thinking is disabled', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url, { thinking: 'disabled' })

    await assemble(ctx,{
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(server.requests[0]).toMatchObject({
      thinking: { type: 'disabled' },
    })
    expect(server.requests[0]).not.toHaveProperty('reasoning_effort')
    await expect(ctx.llm.resolveModelInfo('deepseek', 'deepseek-v4-flash'))
      .resolves.toMatchObject({
        reasoning: {
          efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }],
          defaultEffort: ReasoningEffortId('off'),
        },
      })
  })

  it('rejects a per-request effort before I/O when thinking is disabled', async () => {
    const server = await mockServer([])
    const ctx = await harness(server.url, { thinking: 'disabled' })

    await expect(assemble(ctx, {
      model: 'deepseek-v4-flash',
      reasoningEffort: ReasoningEffortId('high'),
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    expect(server.requests).toHaveLength(0)
  })

  it.each(['high', 'max'])(
    'rejects direct adapter effort %s before I/O when thinking is disabled',
    async (effort) => {
      const server = await mockServer([])
      const adapter = adapterOf({ apiKey: 'test-key', baseURL: server.url, thinking: 'disabled' })

      const stream = adapter.stream({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        reasoningEffort: ReasoningEffortId(effort),
        messages: [createUserMessage({
          content: [{ type: 'text', text: 'hi' }],
          source: { kind: 'plugin', plugin: 'test' },
        })],
      })
      await expect(async () => {
        for await (const _chunk of stream) { /* drain */ }
      }).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
      expect(server.requests).toHaveLength(0)
    },
  )

  it.each([
    [401, 'AUTH'],
    [403, 'AUTH'],
    [429, 'RATE_LIMIT'],
    [400, 'INVALID_REQUEST'],
    [500, 'SERVER'],
    [503, 'SERVER'],
  ])('maps HTTP %d to LlmError code %s with the body message', async (status, code) => {
    const behavior: Behavior = {
      kind: 'http-error',
      status,
      body: JSON.stringify({ error: { message: `failed with ${status}`, type: 't', code: 'c' } }),
    }
    const server = await mockServer([behavior, behavior])
    const ctx = await harness(server.url)
    await expect(assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] }))
      .rejects.toThrow(`failed with ${status}`)
    await expect(
      assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] })
        .catch((error: unknown) => (error as LlmError).code),
    ).resolves.toBe(code)
  })

  it('classifies a thrown HTTP context-window rejection with the canonical code', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 400,
      body: JSON.stringify({
        error: {
          message: 'This model maximum context length is 128000 tokens; your input exceeds that limit.',
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
        },
      }),
    }])
    const ctx = await harness(server.url)
    const code = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
      .catch((error: unknown) => (error as LlmError).code)
    expect(code).toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
  })

  it('retains status, Retry-After seconds, and provider request id as structured facts', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 429,
      body: JSON.stringify({ error: { message: 'slow down' } }),
      headers: { 'retry-after': '2', 'x-request-id': 'req-429' },
    }])
    const ctx = await harness(server.url)
    let thrown: unknown
    try {
      await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LlmError)
    expect((thrown as LlmError).failure).toEqual({
      message: 'slow down',
      code: 'RATE_LIMIT',
      status: 429,
      providerRetryAfterMs: 2_000,
      requestId: ProviderRequestId('req-429'),
    })
  })

  it('parses a future Retry-After HTTP date and the DeepSeek request-id fallback', async () => {
    const now = 1_800_000_000_000
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const server = await mockServer([{
        kind: 'http-error',
        status: 503,
        body: JSON.stringify({ error: { message: 'come back later' } }),
        headers: {
          'retry-after': new Date(now + 3_000).toUTCString(),
          'x-deepseek-request-id': 'deepseek-503',
        },
      }])
      const ctx = await harness(server.url)
      await expect(assemble(ctx, { model: 'deepseek-v4-flash', messages: [] }))
        .rejects.toMatchObject({
          failure: {
            message: 'come back later',
            code: 'SERVER',
            status: 503,
            providerRetryAfterMs: 3_000,
            requestId: ProviderRequestId('deepseek-503'),
          },
        })
    } finally {
      dateNow.mockRestore()
    }
  })

  it('omits zero, non-finite, invalid, and past Retry-After values', async () => {
    const values = [
      '0',
      '9'.repeat(400),
      'not-a-date',
      new Date(0).toUTCString(),
    ]
    for (const value of values) {
      const server = await mockServer([{
        kind: 'http-error',
        status: 429,
        body: JSON.stringify({ error: { message: 'retry later' } }),
        headers: { 'retry-after': value },
      }])
      const ctx = await harness(server.url)
      let thrown: LlmError | undefined
      try {
        await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
      } catch (error: unknown) {
        if (error instanceof LlmError) thrown = error
      }
      expect(thrown?.failure).toEqual({ message: 'retry later', code: 'RATE_LIMIT', status: 429 })
    }
  })

  it('classifies only context-capacity HTTP 400 details as context overflow', () => {
    expect(httpErrorCode(400, { message: 'request too large for model context' }))
      .toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
    expect(httpErrorCode(400, { message: 'invalid input: temperature exceeds maximum allowed value' }))
      .toBe('INVALID_REQUEST')
    expect(httpErrorCode(413, { code: 'context_length_exceeded' })).toBe('HTTP_413')
  })

  it('distinguishes terminal quota exhaustion from transient HTTP 429 throttling', () => {
    expect(httpErrorCode(429, { code: 'insufficient_quota', message: 'account credits exhausted' }))
      .toBe(QUOTA_EXCEEDED_CODE)
    expect(httpErrorCode(429, { message: 'request rate limit exceeded' })).toBe('RATE_LIMIT')
  })

  it('keeps the status-line message for JSON error bodies without a message', async () => {
    const server = await mockServer([{ kind: 'http-error', status: 500, body: '{"error":{"type":"x"}}' }])
    const ctx = await harness(server.url)
    await expect(assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] }))
      .rejects.toThrow(/HTTP 500/)
  })

  it('keeps the status-line message for non-JSON error bodies', async () => {
    const server = await mockServer([{ kind: 'http-error', status: 502, body: 'Bad Gateway', contentType: 'text/plain' }])
    const ctx = await harness(server.url)
    await expect(assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] }))
      .rejects.toThrow(/HTTP 502/)
  })

  it('maps unusual statuses to HTTP_<status>', () => {
    expect(httpErrorCode(418)).toBe('HTTP_418')
  })

  it('wraps a transport failure in TRANSPORT with the fetch cause chain in the message', async () => {
    // Port 1 is reserved/unbound: fetch rejects with `TypeError: fetch failed`
    // whose actionable detail (ECONNREFUSED) lives on `cause`.
    const ctx = await harness('http://127.0.0.1:1')
    let caught: unknown
    try {
      await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(LlmError)
    const llmError = caught as LlmError
    expect(llmError.code).toBe('TRANSPORT')
    expect(llmError.message).toContain('http://127.0.0.1:1')
    expect(llmError.cause).toBeInstanceOf(TypeError)
    // The chain renderer reaches the transport diagnosis through the cause.
    expect(errorChain(llmError)).toMatch(/ECONNREFUSED|EADDRNOTAVAIL|bad port/)
  })

  it('classifies an aborted request without losing the transport rejection', async () => {
    const controller = new AbortController()
    controller.abort()
    const ctx = await harness('http://127.0.0.1:1')
    let caught: unknown
    try {
      await assemble(ctx, { model: 'deepseek-v4-flash', messages: [], signal: controller.signal })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(LlmError)
    expect(caught).toMatchObject({ code: 'ABORTED' })
    expect((caught as LlmError).cause).toMatchObject({ name: 'AbortError' })
  })

  it('throws EMPTY_RESPONSE when the response has no body', async () => {
    const adapter = adapterOf({ baseURL: 'http://127.0.0.1:1' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    )
    try {
      const iterate = async (): Promise<void> => {
        for await (const _chunk of adapter.stream({ provider: 'deepseek', model: 'm', messages: [] })) { /* drain */ }
      }
      await expect(iterate()).rejects.toThrow(/no response body/)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('classifies an abrupt body close as TRANSPORT and retains its cause', async () => {
    const server = await mockServer([{
      kind: 'close-early',
      events: ['{"choices":[{"delta":{"content":"par"}}]}'],
    }])
    const ctx = await harness(server.url)
    let caught: unknown
    try {
      await assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'TRANSPORT' })
    expect(errorChain(caught)).toMatch(/terminated|socket|without \[DONE\]/)
  })

  it('aborts mid-stream via the request signal', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents, delayMs: 50 }])
    const ctx = await harness(server.url)
    const controller = new AbortController()

    const pending = (async () => {
      const chunks = []
      for await (const chunk of ctx.llm.stream({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        messages: [],
        signal: controller.signal,
      })) {
        chunks.push(chunk)
      }
      return chunks
    })()

    setTimeout(() => { controller.abort() }, 30)
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('maps connection failures to TRANSPORT without losing the cause', async () => {
    const cause = new TypeError('connection refused')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(cause)
    const adapter = adapterOf({ baseURL: 'https://example.invalid' })
    try {
      const drain = async (): Promise<void> => {
        for await (const _chunk of adapter.stream({ provider: 'deepseek', model: 'm', messages: [] })) { /* drain */ }
      }
      await expect(drain()).rejects.toMatchObject({ code: 'TRANSPORT', cause })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('renders a non-Error transport rejection without losing its cause', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const failed = Promise.withResolvers<Response>()
      failed.reject('offline')
      return failed.promise
    })
    const adapter = adapterOf({ baseURL: 'https://example.invalid' })
    try {
      const drain = async (): Promise<void> => {
        for await (const _chunk of adapter.stream({ provider: 'deepseek', model: 'm', messages: [] })) { /* drain */ }
      }
      await expect(drain()).rejects.toMatchObject({
        message: 'DeepSeek API request to https://example.invalid failed',
        code: 'TRANSPORT',
        cause: 'offline',
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('aborts the underlying body when the stream stays idle past its watchdog', async () => {
    vi.useFakeTimers()
    let stopped = false
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => {
            stopped = true
            controller.error(signal.reason)
          }, { once: true })
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    })
    const adapter = adapterOf({ baseURL: 'https://example.invalid', streamIdleTimeoutMs: 100 })
    try {
      const drain = (async () => {
        for await (const _chunk of adapter.stream({ provider: 'deepseek', model: 'm', messages: [] })) { /* drain */ }
      })()
      const rejected = expect(drain).rejects.toMatchObject({ code: 'TIMEOUT' })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(100)
      await rejected
      expect(stopped).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('plugin registration and config', () => {
  it('keeps wire helpers off the package root', () => {
    for (const helper of [
      'httpErrorCode',
      'serializeMessages',
      'serializeRequest',
      'DONE',
      'parseSse',
      'mapFinishReason',
      'mapUsage',
      'translate',
    ]) expect(LlmDeepSeek).not.toHaveProperty(helper)
  })

  it('registers the deepseek provider and unregisters on dispose (HMR safety)', async () => {
    const server = await mockServer([])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const fiber = await ctx.plugin(LlmDeepSeek, {
      apiKey: 'k',
      baseURL: server.url,
    })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek', name: 'DeepSeek' }])
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('registers retryPolicy from the provider config', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(LlmDeepSeek, {
      apiKey: 'k',
      baseURL: 'http://127.0.0.1:1',
      retryPolicy: {
        mode: 'always',
        backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 },
      },
    })

    expect(ctx.llm.providerRetryPolicy('deepseek')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
  })

  it('owns the deepseek provider and advertises the default models', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(LlmDeepSeek, { apiKey: 'k', baseURL: 'http://127.0.0.1:1' })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek', name: 'DeepSeek' }])
    await expect(ctx.llm.listModels('deepseek')).resolves.toEqual([
      { provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
      { provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ])
    await expect(ctx.llm.resolveModelInfo('deepseek', 'deepseek-v4-flash'))
      .resolves.toMatchObject({
        provider: 'deepseek',
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        context: { contextWindow: 256_000 },
        reasoning: {
          efforts: [
            { id: ReasoningEffortId('off'), name: 'Off' },
            { id: ReasoningEffortId('high'), name: 'High' },
            { id: ReasoningEffortId('max'), name: 'Max' },
          ],
          defaultEffort: ReasoningEffortId('high'),
        },
      })
  })

  it.each(['off', 'max'] as const)('uses the configured %s reasoning default', async (effort) => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(LlmDeepSeek, {
      apiKey: 'k',
      baseURL: 'http://127.0.0.1:1',
      reasoningEffort: effort,
    })
    await expect(ctx.llm.resolveModelInfo('deepseek', 'unlisted-pass-through'))
      .resolves.toMatchObject({
        reasoning: {
          efforts: [
            { id: ReasoningEffortId('off'), name: 'Off' },
            { id: ReasoningEffortId('high'), name: 'High' },
            { id: ReasoningEffortId('max'), name: 'Max' },
          ],
          defaultEffort: ReasoningEffortId(effort),
        },
      })
  })

  it('accepts off as the default when thinking is deployment-disabled', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(LlmDeepSeek, {
      apiKey: 'k',
      baseURL: 'http://127.0.0.1:1',
      thinking: 'disabled',
      reasoningEffort: 'off',
    })
    await expect(ctx.llm.resolveModelInfo('deepseek', 'unlisted-pass-through'))
      .resolves.toMatchObject({
        reasoning: {
          efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }],
          defaultEffort: ReasoningEffortId('off'),
        },
      })
  })

  it.each(['high', 'max'] as const)(
    'rejects configured reasoning effort %s when thinking is disabled',
    async (reasoningEffort) => {
      const ctx = new Context()
      await ctx.plugin(LlmService)
      await expect(ctx.plugin(LlmDeepSeek, {
        apiKey: 'k',
        baseURL: 'http://127.0.0.1:1',
        thinking: 'disabled',
        reasoningEffort,
      })).rejects.toThrow(/only reasoningEffort "off"/)
      expect(ctx.llm.listProviders()).toEqual([])
    },
  )

  it.each(['high', 'max'] as const)(
    'rejects disabled-thinking effort %s at the resolver boundary',
    (reasoningEffort) => {
      expect(() => resolveAdapterOptions({ thinking: 'disabled', reasoningEffort }))
        .toThrow(/only reasoningEffort "off"/)
    },
  )

  it('accepts disabled thinking with off at the resolver boundary', async () => {
    const adapter = adapterOf({ thinking: 'disabled', reasoningEffort: 'off' })
    await expect(adapter.resolveModel('deepseek', 'pass-through')).resolves.toMatchObject({
      reasoning: {
        efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }],
        defaultEffort: ReasoningEffortId('off'),
      },
    })
  })

  it('uses the default model catalog when apply is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    LlmDeepSeek.apply(ctx, { apiKey: 'k', baseURL: 'http://127.0.0.1:1' })
    await expect(ctx.llm.listModels('deepseek')).resolves.toEqual([
      { provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
      { provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ])
  })

  it('advertises configured models without restricting arbitrary request ids', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(LlmDeepSeek, {
      apiKey: 'k',
      baseURL: 'http://127.0.0.1:1',
      models: [
        { id: 'private-fast', contextWindow: 32_000 },
        {
          id: 'private-reasoner',
          name: 'Private Reasoner',
          description: 'Higher reasoning budget',
          contextWindow: 64_000,
        },
      ],
    })
    await expect(ctx.llm.listModels('deepseek')).resolves.toEqual([
      { provider: 'deepseek', id: 'private-fast', name: 'private-fast' },
      { provider: 'deepseek', id: 'private-reasoner', name: 'Private Reasoner', description: 'Higher reasoning budget' },
    ])
    await expect(ctx.llm.resolveModelInfo('deepseek', 'private-fast'))
      .resolves.toMatchObject({ context: { contextWindow: 32_000 } })
    await expect(ctx.llm.resolveModelInfo('deepseek', 'private-reasoner'))
      .resolves.toMatchObject({
        name: 'Private Reasoner',
        description: 'Higher reasoning budget',
      })
    await expect(ctx.llm.resolveModelInfo('deepseek', 'arbitrary-unlisted'))
      .resolves.not.toHaveProperty('context')
  })

  it('uses exact model capacity before the adapter-wide default', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(LlmDeepSeek, {
      apiKey: 'k',
      baseURL: 'http://127.0.0.1:1',
      defaultContextWindow: 256_000,
      models: [
        { id: 'inherits-default' },
        { id: 'exact-override', contextWindow: 64_000 },
      ],
    })

    await expect(ctx.llm.resolveModelInfo('deepseek', 'inherits-default'))
      .resolves.toMatchObject({ context: { contextWindow: 256_000 } })
    await expect(ctx.llm.resolveModelInfo('deepseek', 'exact-override'))
      .resolves.toMatchObject({ context: { contextWindow: 64_000 } })
    await expect(ctx.llm.resolveModelInfo('deepseek', 'unlisted-pass-through'))
      .resolves.toMatchObject({ context: { contextWindow: 256_000 } })
  })

  it('allows an explicit empty model catalog', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(LlmDeepSeek, {
      apiKey: 'k',
      baseURL: 'http://127.0.0.1:1',
      models: [],
    })
    await expect(ctx.llm.listModels('deepseek')).resolves.toEqual([])
  })

  it.each([
    [[{ id: '' }], /ids must be non-empty/],
    [[{ id: 'm', name: '' }], /empty name/],
    [[{ id: 'm', contextWindow: 0 }], /contextWindow/],
    [[{ id: 'm', contextWindow: 1.5 }], /contextWindow/],
    [[{ id: 'm' }, { id: 'm' }], /duplicate catalog model/],
  ] as const)('rejects invalid advisory model config', async (models, message) => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await expect(ctx.plugin(LlmDeepSeek, {
      apiKey: 'k',
      baseURL: 'http://127.0.0.1:1',
      models: [...models],
    })).rejects.toThrow(message)
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('rejects invalid context capacity when apply is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    expect(() => {
      LlmDeepSeek.apply(ctx, {
        apiKey: 'k',
        baseURL: 'http://127.0.0.1:1',
        models: [{ id: 'invalid-context', contextWindow: 0 }],
      })
    }).toThrow(/contextWindow must be a positive integer/)
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it.each([0, 1.5])(
    'rejects invalid adapter-wide default context capacity %s',
    async (defaultContextWindow) => {
      expect(() => resolveAdapterOptions({ defaultContextWindow }))
        .toThrow(/defaultContextWindow must be a positive integer/)

      const ctx = new Context()
      await ctx.plugin(LlmService)
      await expect(ctx.plugin(LlmDeepSeek, {
        apiKey: 'k',
        baseURL: 'http://127.0.0.1:1',
        defaultContextWindow,
      })).rejects.toThrow(/defaultContextWindow/)
      expect(ctx.llm.listProviders()).toEqual([])
    },
  )

  it('falls back to DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL env vars', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'env-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', 'http://127.0.0.1:1')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(LlmDeepSeek, {})
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek', name: 'DeepSeek' }])
  })

  it('loads keyless, keeps the catalog browsable, and fails the request actionably', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(LlmDeepSeek, { baseURL: 'http://127.0.0.1:1' })
    // First-boot onboarding: the route registers so models stay discoverable;
    // only the request itself needs a key.
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek', name: 'DeepSeek' }])
    await expect(ctx.llm.listModels('deepseek')).resolves.toHaveLength(2)
    await expect(assemble(ctx, { model: 'deepseek-v4-flash', messages: [] }))
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    // The guidance leads with the credential store — the path that keeps the
    // secret out of configuration files — and mentions a literal key last.
    await expect(assemble(ctx, { model: 'deepseek-v4-flash', messages: [] }))
      .rejects.toThrow(/store DEEPSEEK_API_KEY through the credentials service.*as a last resort.*"apiKey"/s)
  })

  it('reads the ambient variable when no credentials seam is mounted', async () => {
    // The plain cordis.yml composition: no credential provider, the key in
    // the launching environment.
    vi.stubEnv('DEEPSEEK_API_KEY', 'ambient-key')
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(LlmDeepSeek, { baseURL: server.url })
    await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer ambient-key')
  })

  it('treats an empty ambient variable as no key when no credentials seam is mounted', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(LlmDeepSeek, { baseURL: 'http://127.0.0.1:1' })
    await expect(assemble(ctx, { model: 'deepseek-v4-flash', messages: [] }))
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('prefers explicit config over env for key and base URL', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'env-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', 'http://env-host:1')
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url) // harness passes explicit config
    await assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] })
    expect(server.requests).toHaveLength(1) // hit the explicit URL, not env
  })

  it('uses DEEPSEEK_BASE_URL when config omits baseURL', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    vi.stubEnv('DEEPSEEK_BASE_URL', server.url)
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(LlmDeepSeek, { apiKey: 'k' })
    await assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] })
    expect(server.requests).toHaveLength(1)
  })

  it('defaults to the public base URL without config or env', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'k')
    vi.stubEnv('DEEPSEEK_BASE_URL', undefined)
    const ctx = new Context()
    await ctx.plugin(LlmService)
    // Registration succeeds; no call is made (would hit api.deepseek.com).
    await ctx.plugin(LlmDeepSeek, {})
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek', name: 'DeepSeek' }])
  })

  it('adapter is constructible directly for embedding over the shared resolver', async () => {
    const adapter = adapterOf()
    expect(adapter).toBeInstanceOf(DeepSeekAdapter)
    // Direct embedding shares the plugin's one resolve step, so it advertises
    // the same default catalog instead of a divergent empty one.
    await expect(adapter.listModels('deepseek')).resolves.toHaveLength(2)
  })

  it('resolves connection facts and the credential exactly once per stream call', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const options = vi.fn(() => resolveAdapterOptions({ baseURL: server.url }))
    const resolveApiKey = vi.fn(() => Promise.resolve('per-request-key'))
    const adapter = new DeepSeekAdapter({ options, resolveApiKey })

    for await (const _chunk of adapter.stream({ provider: 'deepseek', model: 'm', messages: [] })) { /* drain */ }

    expect(options).toHaveBeenCalledTimes(1)
    expect(resolveApiKey).toHaveBeenCalledTimes(1)
    expect(server.headers[0]?.authorization).toBe('Bearer per-request-key')
  })

  it('rejects invalid idle watchdog bounds for direct and plugin composition', async () => {
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: Number.POSITIVE_INFINITY }))
      .toThrow(/streamIdleTimeoutMs.*positive finite/)
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .toThrow(/streamIdleTimeoutMs.*no greater/)

    const ctx = new Context()
    await ctx.plugin(LlmService)
    await expect(ctx.plugin(LlmDeepSeek, {
      apiKey: 'k',
      baseURL: 'http://127.0.0.1:1',
      streamIdleTimeoutMs: 0,
    })).rejects.toThrow(/streamIdleTimeoutMs/)
    await expect(ctx.plugin(LlmDeepSeek, {
      apiKey: 'k',
      baseURL: 'http://127.0.0.1:1',
      streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1,
    })).rejects.toThrow(/streamIdleTimeoutMs/)
  })

  it('rejects invalid nested retryPolicy before registering the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)

    await expect(ctx.plugin(LlmDeepSeek, {
      apiKey: 'k',
      baseURL: 'http://127.0.0.1:1',
      retryPolicy: { mode: 'normal', maxRetries: -1 },
    })).rejects.toThrow(/retryPolicy/)
    expect(ctx.llm.listProviders()).toEqual([])
  })
})
