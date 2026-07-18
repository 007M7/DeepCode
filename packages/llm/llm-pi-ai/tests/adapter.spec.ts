import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import LlmService, { LlmError, userAgent } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter, resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'

interface MockServer {
  url: string
  paths: string[]
  requests: unknown[]
  headers: IncomingMessage['headers'][]
}

const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

async function mockServer(script: { status?: number; events?: string[]; body?: string; delayMs?: number }[]): Promise<MockServer> {
  const paths: string[] = []
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      paths.push(request.url ?? '')
      requests.push(body.length === 0 ? undefined : JSON.parse(body))
      headers.push(request.headers)
      const behavior = script.shift() ?? { status: 500, body: 'script exhausted' }
      if (behavior.status !== undefined && behavior.status !== 200) {
        response.writeHead(behavior.status, { 'content-type': 'application/json' })
        response.end(behavior.body ?? '{}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      let index = 0
      const writeNext = (): void => {
        const event = behavior.events?.[index++]
        if (event === undefined) { response.end(); return }
        response.write(`data: ${event}\n\n`)
        if (behavior.delayMs === undefined) writeNext()
        else setTimeout(writeNext, behavior.delayMs)
      }
      writeNext()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, paths, requests, headers }
}

const textEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

async function harness(baseURL: string, overrides: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(LlmPiAi, {
    providers: [{ provider: 'deepseek', apiKey: 'test-key', baseURL, ...overrides }],
  })
  return ctx
}

describe('PiAiAdapter provider routing', () => {
  it('resolves a catalog model dynamically and uses a private endpoint', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1 })
    expect(server.paths).toEqual(['/chat/completions'])
  })

  it('merges profile headers with Harness attribution winning', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, {
      headers: { 'x-company': 'private', 'User-Agent': 'wrong' },
    })
    await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[0]?.['x-company']).toBe('private')
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
  })

  it('forwards common stream options and profile reasoning', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, {
      reasoning: 'xhigh',
      cacheRetention: 'none',
      transport: 'sse',
      timeoutMs: 5000,
      websocketConnectTimeoutMs: 3000,
      maxRetries: 0,
      maxRetryDelayMs: 10,
      thinkingBudgets: { high: 2048 },
    })
    await assemble(ctx, {
      model: 'deepseek-v4-flash',
      messages: [],
      temperature: 0.2,
      maxTokens: 77,
      sessionId: 'session-for-pi' as never,
    })
    expect(server.requests[0]).toMatchObject({
      model: 'deepseek-v4-flash',
      temperature: 0.2,
      max_completion_tokens: 77,
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    })
  })

  it('preserves omitted profile options when constructing the adapter directly', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['deepseek'], new PiAiAdapter({
      profiles: [{ provider: 'deepseek', apiKey: 'test-key', baseURL: server.url }],
    }))

    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })

    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('rejects stop sequences rather than silently ignoring them', async () => {
    const server = await mockServer([])
    const ctx = await harness(server.url)
    await expect(assemble(ctx, { model: 'deepseek-v4-flash', messages: [], stop: ['END'] }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(server.requests).toEqual([])
  })

  it('rejects unknown catalog models before network I/O', async () => {
    const server = await mockServer([])
    const ctx = await harness(server.url)
    await expect(assemble(ctx, { model: 'not-in-the-catalog', messages: [] }))
      .rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    expect(server.requests).toEqual([])
  })

  it('uses the catalog API implementation, including OpenAI Responses', async () => {
    const server = await mockServer([{ status: 401, body: JSON.stringify({ error: { message: 'expected mock failure' } }) }])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(LlmPiAi, {
      providers: [{ provider: 'openai', apiKey: 'test-key', baseURL: `${server.url}/v1`, maxRetries: 0 }],
    })
    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    expect(result.finish.kind).toBe('error')
    expect(server.paths).toEqual(['/v1/responses'])
  })

  it.each([
    [401, 'AUTH'],
    [400, 'INVALID_REQUEST'],
    [429, 'RATE_LIMIT'],
    [500, 'SERVER'],
  ] as const)('maps HTTP %s failures to %s', async (status, code) => {
    const server = await mockServer([{ status, body: JSON.stringify({ error: { message: `provider ${status}` } }) }])
    const ctx = await harness(server.url, { maxRetries: 0 })
    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', code })
  })
})

describe('provider profile lifecycle', () => {
  it('registers every profile atomically and unregisters on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const fiber = await ctx.plugin(LlmPiAi, {
      providers: [{ provider: 'openai' }, { provider: 'anthropic' }],
    })
    expect(ctx.llm.listProviders()).toEqual([
      { id: 'openai', name: 'openai' },
      { id: 'anthropic', name: 'anthropic' },
    ])
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('exposes the installed pi-ai model catalog through provider-neutral metadata', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(LlmPiAi, { providers: [{ provider: 'openai' }] })
    const models = await ctx.llm.listModels('openai')
    expect(models.find(model => model.id === 'gpt-4.1')).toEqual({
      provider: 'openai', id: 'gpt-4.1', name: 'GPT-4.1',
    })
    expect(models.every(model => model.provider === 'openai')).toBe(true)
  })

  it('accepts absent credentials for pi-ai ambient authentication', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'ambient-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, { apiKey: undefined })
    await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer ambient-key')
  })

  it('validates empty, duplicate, unknown, and explicitly blank profiles', () => {
    expect(() => resolveProfiles([])).toThrow(/at least one/)
    expect(() => resolveProfiles([{ provider: '' }])).toThrow(/non-empty/)
    expect(() => resolveProfiles([{ provider: 'not-real' }])).toThrow(/unknown/)
    expect(() => resolveProfiles([{ provider: 'openai' }, { provider: 'openai' }])).toThrow(/duplicate/)
    expect(() => resolveProfiles([{ provider: 'openai', apiKey: '' }])).toThrow(/empty apiKey/)
    expect(() => resolveProfiles([{ provider: 'openai', apiKey: '  ' }])).toThrow(/empty apiKey/)
    expect(() => resolveProfiles([{ provider: 'openai', baseURL: '' }])).toThrow(/empty baseURL/)
  })

  it('rejects negative or fractional stream tunables at schema validation', () => {
    const invalid = [
      { timeoutMs: -1 },
      { websocketConnectTimeoutMs: -1 },
      { maxRetries: -1 },
      { maxRetries: 0.5 },
      { maxRetryDelayMs: -1 },
    ]
    for (const entry of invalid) {
      expect(() => new LlmPiAi.Config({ providers: [{ provider: 'openai', ...entry }] })).toThrow()
    }
  })

  it('constructs the adapter directly and rejects routes it does not own', async () => {
    const adapter = new PiAiAdapter({ profiles: [{ provider: 'openai' }] })
    await expect(adapter.listModels('anthropic')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    await expect((async () => {
      for await (const _chunk of adapter.stream({ provider: 'anthropic', model: 'claude-sonnet-4', messages: [] })) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect(new LlmError('x', 'X')).toBeInstanceOf(Error)
  })
})

describe('abort wiring', () => {
  it('resolves catalog endpoints without an override before honoring pre-abort', async () => {
    const adapter = new PiAiAdapter({ profiles: [{ provider: 'deepseek', apiKey: 'test-key', maxRetries: 0 }] })
    const controller = new AbortController()
    controller.abort('already stopped')
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [],
      signal: controller.signal,
    })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
  })

  it('honors a pre-aborted caller signal', async () => {
    const server = await mockServer([{ events: textEvents, delayMs: 20 }])
    const ctx = await harness(server.url)
    const controller = new AbortController()
    controller.abort('already stopped')
    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [], signal: controller.signal })
    expect(result.finish.kind).toBe('aborted')
  })

  it('forwards an abort that arrives while provider streaming is active', async () => {
    const server = await mockServer([{ events: textEvents, delayMs: 30 }])
    const ctx = await harness(server.url)
    const controller = new AbortController()
    const resultPromise = assemble(ctx, {
      model: 'deepseek-v4-flash', messages: [], signal: controller.signal,
    })
    setTimeout(() => { controller.abort('stopped during stream') }, 10)
    const result = await resultPromise
    expect(result.finish.kind).toBe('aborted')
  })

  it('aborts upstream when a consumer stops early', async () => {
    const server = await mockServer([{ events: textEvents, delayMs: 30 }])
    const ctx = await harness(server.url)
    for await (const chunk of ctx.llm.stream({ provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })) {
      if (chunk.type === 'block-start') break
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(server.requests).toHaveLength(1)
  })
})
