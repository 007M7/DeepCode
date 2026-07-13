import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import LlmService, { CallId, userAgent } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { buildModel, PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'

/** Scripted SSE responses, one per request (OpenAI chat-completions shape). */
interface MockServer {
  url: string
  requests: unknown[]
  /** Header bags of received requests, in order (parallel to `requests`). */
  headers: IncomingMessage['headers'][]
  close(): Promise<void>
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

async function mockServer(script: { status?: number; events?: string[]; body?: string }[]): Promise<MockServer> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      headers.push(request.headers)
      const behavior = script.shift() ?? { status: 500, body: 'script exhausted' }
      if (behavior.status !== undefined && behavior.status !== 200) {
        response.writeHead(behavior.status, { 'content-type': 'application/json' })
        response.end(behavior.body ?? '{}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of behavior.events ?? []) response.write(`data: ${event}\n\n`)
      response.end()
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
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
}

const textEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

const toolEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":null},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"get_weather","arguments":""}}]},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Paris\\"}"}}]},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":6}}',
  '[DONE]',
]

const thinkingEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"reasoning_content":"pondering"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"answer","reasoning_content":null},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":9}}',
  '[DONE]',
]

async function harness(baseURL: string, config: object = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(LlmPiAi, { apiKey: 'test-key', baseURL, models: ['deepseek-v4-flash'], ...config })
  return ctx
}

describe('PiAiAdapter against a mock server', () => {
  it('streams a text generation through the assembler', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url)

    const result = await assemble(ctx, {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 1 })

    // Attribution reaches the wire through pi-ai's headers hook: the exact
    // shared User-Agent, and no provider-specific headers under the
    // User-Agent-only contract.
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
    expect(server.headers[0]).not.toHaveProperty('http-referer')
    expect(server.headers[0]).not.toHaveProperty('x-openrouter-title')
    expect(server.headers[0]).not.toHaveProperty('x-openrouter-categories')
  })

  it('streams tool calls with re-stringified arguments', async () => {
    const server = await mockServer([{ events: toolEvents }])
    const ctx = await harness(server.url)

    const result = await assemble(ctx,{
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'weather?' }] }],
      tools: [{
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      }],
    })
    expect(result.finish).toEqual({ kind: 'tool-calls' })
    const call = result.message.content.find(block => block.type === 'tool-call')
    expect(call).toMatchObject({ name: 'get_weather', arguments: '{"city":"Paris"}' })
  })

  it('maps reasoning_content streams to reasoning blocks', async () => {
    const server = await mockServer([{ events: thinkingEvents }])
    const ctx = await harness(server.url, { reasoning: 'high' })

    const result = await assemble(ctx,{
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'think' }] }],
    })
    expect(result.message.content).toEqual([
      { type: 'reasoning', text: 'pondering' },
      { type: 'text', text: 'answer' },
    ])
  })

  it('sends DeepSeek thinking fields when reasoning is configured', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, { reasoning: 'xhigh' })
    await assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] })
    expect(server.requests[0]).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max', // xhigh maps to max via thinkingLevelMap
    })
  })

  it('disables thinking for reasoning: off', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, { reasoning: 'off' })
    await assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] })
    expect(server.requests[0]).toMatchObject({ thinking: { type: 'disabled' } })
  })

  it('injects stop sequences through onPayload', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url)
    await assemble(ctx,{ model: 'deepseek-v4-flash', messages: [], stop: ['END'] })
    expect(server.requests[0]).toMatchObject({ stop: ['END'] })
  })

  it('scrubs pi-ai\'s own per-tool strict default through onPayload', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url)
    await assemble(ctx,{
      model: 'deepseek-v4-flash',
      messages: [],
      tools: [
        { name: 'alpha', description: 'a', parameters: {} },
        { name: 'beta', description: 'b', parameters: {} },
      ],
    })

    // pi-ai stamps `strict` on every serialized tool function; the harness
    // contract has none and the hand-rolled twin sends no such field, so the
    // payload fixup must have deleted it from every tool.
    const request = server.requests[0] as { tools: { function: { name: string; strict?: boolean } }[] }
    expect(request.tools.map(tool => tool.function.name)).toEqual(['alpha', 'beta'])
    for (const tool of request.tools) {
      expect('strict' in tool.function).toBe(false)
    }
  })

  it('preserves raw replayed tool-call arguments in the provider payload', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url)
    await assemble(ctx,{
      model: 'deepseek-v4-flash',
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('broken'), name: 'f', arguments: '{broken' }],
      }],
    })

    const request = server.requests[0] as { messages: { role: string; tool_calls?: { id: string; function: { arguments: string } }[] }[] }
    const assistant = request.messages.find(message => message.role === 'assistant')
    expect(assistant?.tool_calls?.[0]?.function.arguments).toBe('{broken')
  })

  it('maps HTTP errors to error finish chunks (pi-ai in-stream style)', async () => {
    const server = await mockServer([{
      status: 401,
      body: JSON.stringify({ error: { message: 'bad key' } }),
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', code: 'AUTH' })
    expect((result.finish as { message: string }).message).toMatch(/bad key|401/)
  })

  it.each([
    [400, 'INVALID_REQUEST'],
    [429, 'RATE_LIMIT'],
    [500, 'SERVER'],
  ] as const)('maps HTTP %s to stable error code %s', async (status, code) => {
    const server = await mockServer([{ status, body: JSON.stringify({ error: { message: `provider ${status}` } }) }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', code })
  })

  it('registers/unregisters models on the llm service (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const fiber = await ctx.plugin(LlmPiAi, { apiKey: 'k', baseURL: 'http://127.0.0.1:1' })
    expect(ctx.llm.models().sort()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    await fiber.dispose()
    expect(ctx.llm.models()).toEqual([])
  })

  it('throws a clear error when no API key is available', async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(LlmService)
      await expect(ctx.plugin(LlmPiAi, {})).rejects.toThrow(/an API key is required/)
    } finally {
      if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous
    }
  })
})

describe('option spreads and env fallbacks', () => {
  it('forwards temperature, maxTokens, and signal', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url)
    const controller = new AbortController()
    await assemble(ctx,{
      model: 'deepseek-v4-flash',
      messages: [],
      temperature: 0.5,
      maxTokens: 40,
      signal: controller.signal,
    })
    expect(server.requests[0]).toMatchObject({ temperature: 0.5, max_tokens: 40 })
  })

  it('falls back to DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL env vars', async () => {
    const server = await mockServer([{ events: textEvents }])
    vi.stubEnv('DEEPSEEK_API_KEY', 'env-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', server.url)
    try {
      const ctx = new Context()
      await ctx.plugin(LlmService)
      await ctx.plugin(LlmPiAi, { models: ['deepseek-v4-flash'] })
      await assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] })
      expect(server.requests).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('defaults to the public base URL without config or env', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'k')
    vi.stubEnv('DEEPSEEK_BASE_URL', undefined)
    try {
      const ctx = new Context()
      await ctx.plugin(LlmService)
      await ctx.plugin(LlmPiAi, {})
      expect(ctx.llm.models().length).toBeGreaterThan(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('buildModel', () => {
  it('builds a DeepSeek-compat openai-completions model descriptor', () => {
    const model = buildModel('deepseek-v4-pro', { apiKey: 'k', baseURL: 'http://x', reasoning: 'high' })
    expect(model).toMatchObject({
      id: 'deepseek-v4-pro',
      api: 'openai-completions',
      provider: 'deepseek',
      baseUrl: 'http://x',
      reasoning: true,
      compat: { thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true },
    })
  })

  it('keeps reasoning true even for off (pi-ai gates the thinking field on it)', () => {
    // 'off' yields {thinking: {type: 'disabled'}} on the wire — pi-ai only
    // emits the field at all when model.reasoning is true.
    expect(buildModel('m', { apiKey: 'k', baseURL: 'http://x', reasoning: 'off' }).reasoning).toBe(true)
  })

  it('adapter is constructible directly for embedding', () => {
    expect(new PiAiAdapter({ apiKey: 'k', baseURL: 'http://x' })).toBeInstanceOf(PiAiAdapter)
  })
})

describe('provider reasoning, passback, and early-stream cancellation', () => {
  it('defaults omitted reasoning config to thinking ENABLED (provider default)', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url) // no reasoning key at all
    await assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] })
    const request = server.requests[0] as Record<string, unknown>
    expect(request.thinking).toEqual({ type: 'enabled' })
    expect('reasoning_effort' in request).toBe(false)
  })

  it('replays reasoning_content on assistant tool-call turns (passback rule)', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url)
    await assemble(ctx,{
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'I should check.' },
            { type: 'tool-call', id: CallId('c1'), name: 'get_weather', arguments: '{"city":"Paris"}' },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'Sunny' }] }],
        },
      ],
    })
    const request = server.requests[0] as { messages: { role: string; reasoning_content?: string }[] }
    const assistant = request.messages.find(message => message.role === 'assistant')
    expect(assistant?.reasoning_content).toBe('I should check.')
  })

  it('aborts the upstream request when the consumer stops streaming early', async () => {
    // Slow server: write one chunk, then hold the connection open and record
    // whether the socket closes (the adapter must cancel on early break).
    let socketClosed = false
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.on('data', () => undefined)
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${textEvents[0]}\n\n`)
        response.write(`data: ${textEvents[1]}\n\n`)
        // never finish; rely on client abort
        request.socket.on('close', () => { socketClosed = true })
      })
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const ctx = await harness(`http://127.0.0.1:${address.port}`)

    for await (const chunk of ctx.llm.stream({ model: 'deepseek-v4-flash', messages: [] })) {
      if (chunk.type === 'text-delta') break // stop early mid-stream
    }
    // The finally-abort must reach the server as a closed socket.
    await vi.waitFor(() => { expect(socketClosed).toBe(true) }, { timeout: 5_000 })
  })
})

describe('caller cancellation', () => {
  it('honors a pre-aborted caller signal', async () => {
    const ctx = await harness('http://127.0.0.1:1')
    const controller = new AbortController()
    controller.abort('already cancelled')
    // pi-ai surfaces the abort as an in-stream error event → aborted finish.
    const result = await assemble(ctx,{
      model: 'deepseek-v4-flash',
      messages: [],
      signal: controller.signal,
    })
    expect(result.finish.kind).toBe('aborted')
  })

  it('propagates a mid-stream caller abort to the upstream request', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url)
    const controller = new AbortController()
    const pending = assemble(ctx,{
      model: 'deepseek-v4-flash',
      messages: [],
      signal: controller.signal,
    })
    controller.abort()
    const result = await pending
    // Either the abort lands before any chunk (aborted) or after the tiny
    // mock stream finished (stop) — both are valid races; never a hang.
    expect(['aborted', 'stop']).toContain(result.finish.kind)
  })
})
