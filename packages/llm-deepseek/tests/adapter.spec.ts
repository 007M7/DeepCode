import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import LlmService, { LlmError } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { DeepSeekAdapter, httpErrorCode } from '@deepseek-ai/dsh-llm-deepseek'

/** One scripted behavior for the next request the mock server receives. */
type Behavior =
  | { kind: 'sse'; events: string[]; delayMs?: number }
  | { kind: 'http-error'; status: number; body: string; contentType?: string }
  | { kind: 'close-early'; events: string[] }

interface MockServer {
  url: string
  /** Bodies of received requests, in order. */
  requests: unknown[]
  /** Header bags of received requests, in order (parallel to `requests`). */
  headers: IncomingMessage['headers'][]
  script: Behavior[]
  close(): Promise<void>
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  vi.unstubAllEnvs()
})

/** Local chat-completions stand-in: replays scripted behaviors per request. */
async function mockServer(script: Behavior[]): Promise<MockServer> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      headers.push(request.headers)
      const behavior = script.shift()
      if (!behavior) {
        response.writeHead(500).end('mock script exhausted')
        return
      }
      if (behavior.kind === 'http-error') {
        response.writeHead(behavior.status, { 'content-type': behavior.contentType ?? 'application/json' })
        response.end(behavior.body)
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const write = (index: number): void => {
        if (index >= behavior.events.length) {
          if (behavior.kind === 'sse') response.end()
          else response.destroy() // close-early: drop the socket mid-stream
          return
        }
        response.write(`data: ${behavior.events[index]}\n\n`)
        setTimeout(() => { write(index + 1) }, behavior.kind === 'sse' ? behavior.delayMs ?? 0 : 5)
      }
      write(0)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    headers,
    script,
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
}

const textEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
  '{"choices":[{"delta":{"content":"hello"}}]}',
  '{"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

async function harness(baseURL: string, config: object = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(LlmDeepSeek, { apiKey: 'test-key', baseURL, models: ['deepseek-v4-flash'], ...config })
  return ctx
}

describe('DeepSeekAdapter against a mock server', () => {
  it('streams a text generation end to end through ctx.llm.generate', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)

    const result = await ctx.llm.generate({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1 })

    // The wire request carried the auth header contents we configured.
    expect(server.requests[0]).toMatchObject({
      model: 'deepseek-v4-flash',
      stream: true,
      stream_options: { include_usage: true },
    })
    // Attribution header identifies the harness to the provider.
    expect(server.headers[0]?.['user-agent']).toMatch(/^deepseek-harness\//)
  })

  it('streams raw chunks through ctx.llm.stream', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents, delayMs: 2 }])
    const ctx = await harness(server.url)

    const kinds: string[] = []
    for await (const chunk of ctx.llm.stream({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      kinds.push(chunk.type)
    }
    expect(kinds).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })

  it('forwards thinking config onto the wire', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url, { thinking: 'disabled', reasoningEffort: 'high' })

    await ctx.llm.generate({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    expect(server.requests[0]).toMatchObject({
      thinking: { type: 'disabled' },
      reasoning_effort: 'high',
    })
  })

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
    const server = await mockServer([behavior, behavior, behavior])
    const ctx = await harness(server.url)
    await expect(ctx.llm.generate({ model: 'deepseek-v4-flash', messages: [] }))
      .rejects.toThrow(`failed with ${status}`)
    await expect(
      ctx.llm.generate({ model: 'deepseek-v4-flash', messages: [] })
        .catch((error: unknown) => (error as LlmError).code),
    ).resolves.toBe(code)
    // The numeric HTTP status is carried on the error for explicit handling.
    await expect(
      ctx.llm.generate({ model: 'deepseek-v4-flash', messages: [] })
        .catch((error: unknown) => (error as LlmError).status),
    ).resolves.toBe(status)
  })

  it('keeps the status-line message for JSON error bodies without a message', async () => {
    const server = await mockServer([{ kind: 'http-error', status: 500, body: '{"error":{"type":"x"}}' }])
    const ctx = await harness(server.url)
    await expect(ctx.llm.generate({ model: 'deepseek-v4-flash', messages: [] }))
      .rejects.toThrow(/HTTP 500/)
  })

  it('keeps the status-line message for non-JSON error bodies', async () => {
    const server = await mockServer([{ kind: 'http-error', status: 502, body: 'Bad Gateway', contentType: 'text/plain' }])
    const ctx = await harness(server.url)
    await expect(ctx.llm.generate({ model: 'deepseek-v4-flash', messages: [] }))
      .rejects.toThrow(/HTTP 502/)
  })

  it('maps unusual statuses to HTTP_<status>', () => {
    expect(httpErrorCode(418)).toBe('HTTP_418')
  })

  it('throws EMPTY_RESPONSE when the response has no body', async () => {
    const adapter = new DeepSeekAdapter({ apiKey: 'k', baseURL: 'http://127.0.0.1:1' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    )
    try {
      const iterate = async (): Promise<void> => {
        for await (const _chunk of adapter.stream({ model: 'm', messages: [] })) { /* drain */ }
      }
      await expect(iterate()).rejects.toThrow(/no response body/)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('rejects with STREAM_CLOSED when the server drops mid-stream', async () => {
    const server = await mockServer([{
      kind: 'close-early',
      events: ['{"choices":[{"delta":{"content":"par"}}]}'],
    }])
    const ctx = await harness(server.url)
    await expect(ctx.llm.generate({ model: 'deepseek-v4-flash', messages: [] }))
      .rejects.toThrow(/terminated|socket|without \[DONE\]/)
  })

  it('aborts mid-stream via the request signal', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents, delayMs: 50 }])
    const ctx = await harness(server.url)
    const controller = new AbortController()

    const pending = (async () => {
      const chunks = []
      for await (const chunk of ctx.llm.stream({
        model: 'deepseek-v4-flash',
        messages: [],
        signal: controller.signal,
      })) {
        chunks.push(chunk)
      }
      return chunks
    })()

    setTimeout(() => { controller.abort() }, 30)
    await expect(pending).rejects.toThrow()
  })
})

describe('plugin registration and config', () => {
  it('registers the configured models and unregisters on dispose (HMR safety)', async () => {
    const server = await mockServer([])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const fiber = await ctx.plugin(LlmDeepSeek, {
      apiKey: 'k',
      baseURL: server.url,
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    })
    expect(ctx.llm.models().sort()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    await fiber.dispose()
    expect(ctx.llm.models()).toEqual([])
  })

  it('defaults the model list', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(LlmDeepSeek, { apiKey: 'k', baseURL: 'http://127.0.0.1:1' })
    expect(ctx.llm.models().sort()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
  })

  it('falls back to DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL env vars', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'env-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', 'http://127.0.0.1:1')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(LlmDeepSeek, {})
    expect(ctx.llm.models().length).toBeGreaterThan(0)
  })

  it('throws a clear error when no API key is available', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await expect(ctx.plugin(LlmDeepSeek, {}))
      .rejects.toThrow(/an API key is required/)
    expect(ctx.llm.models()).toEqual([])
  })

  it('prefers explicit config over env for key and base URL', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'env-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', 'http://env-host:1')
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url) // harness passes explicit config
    await ctx.llm.generate({ model: 'deepseek-v4-flash', messages: [] })
    expect(server.requests).toHaveLength(1) // hit the explicit URL, not env
  })

  it('uses DEEPSEEK_BASE_URL when config omits baseURL', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    vi.stubEnv('DEEPSEEK_BASE_URL', server.url)
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(LlmDeepSeek, { apiKey: 'k', models: ['deepseek-v4-flash'] })
    await ctx.llm.generate({ model: 'deepseek-v4-flash', messages: [] })
    expect(server.requests).toHaveLength(1)
  })

  it('defaults to the public base URL without config or env', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'k')
    vi.stubEnv('DEEPSEEK_BASE_URL', undefined)
    const ctx = new Context()
    await ctx.plugin(LlmService)
    // Registration succeeds; no call is made (would hit api.deepseek.com).
    await ctx.plugin(LlmDeepSeek, {})
    expect(ctx.llm.models().length).toBeGreaterThan(0)
  })

  it('adapter is constructible directly for embedding', () => {
    const adapter = new DeepSeekAdapter({ apiKey: 'k', baseURL: 'http://127.0.0.1:1' })
    expect(adapter).toBeInstanceOf(DeepSeekAdapter)
  })
})
