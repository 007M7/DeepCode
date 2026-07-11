import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { AgentId } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as agentCore from '@deepseek-ai/dsh-agent-core'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { HarnessSdkServer, type JsonRpcTransportPeer } from '../src/index.ts'

class FakeTransport implements JsonRpcTransportPeer {
  notifications: { method: string; params?: Record<string, unknown> }[] = []

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    throw new Error(`the SDK server should not call host JSON-RPC method ${method} with ${JSON.stringify(params)}`)
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.notifications.push(params === undefined ? { method } : { method, params })
  }
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  vi.unstubAllEnvs()
})

async function mockCompletionServer(): Promise<{ url: string; requests: unknown[]; headers: IncomingMessage['headers'][] }> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      headers.push(request.headers)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}\n\n')
      response.write('data: {"choices":[{"delta":{"content":"done"}}]}\n\n')
      response.write('data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n')
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, requests, headers }
}

async function makeHarness(storageDir: string) {
  const ctx = new Context()
  await ctx.plugin(agentCore)
  await ctx.plugin(SessionPersistenceJsonl, { root: storageDir })
  await new Promise(resolve => setTimeout(resolve, 50))
  return ctx
}

describe('HarnessSdkServer', () => {
  it('creates a harness agent and calls the configured OpenAI-compatible endpoint', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkServer(ctx, transport)

      const init = await server.handleRequest('initialize', {
        cwd: storageDir,
        model: 'dsagent-model',
        sessionRoot: storageDir,
        systemPrompt: 'Custom SDK instructions.',
      }) as { serverInfo: { name: string } }
      expect(init.serverInfo.name).toBe('deepseek-harness-sdk-runtime')

      await server.handleRequest('session/prompt', {
        sessionId: 'main',
        contentBlocks: [{ type: 'text', text: 'fix it' }],
        profile: 'build',
      })

      expect(llmServer.requests).toHaveLength(1)
      const body = llmServer.requests[0] as { model: string; messages: { role: string }[] }
      expect(body.model).toBe('dsagent-model')
      expect(body.messages[0]?.role).toBe('system')
      expect(body.messages.at(-1)?.role).toBe('user')
      expect(llmServer.headers[0]?.authorization).toBe('Bearer test-key')
      expect(transport.notifications.some(n => n.method === 'session.event')).toBe(true)
      expect(transport.notifications.at(-1)).toMatchObject({
        method: 'session.finished',
        params: { sessionId: 'main', status: 'ok' },
      })

      await server.handleRequest('session/prompt', {
        sessionId: 'main',
        contentBlocks: [{ type: 'text', text: 'again' }],
      })
      expect(llmServer.requests).toHaveLength(2)

      const orphanHandle = ctx.agents.create({
        agentId: AgentId('orphan-agent'),
        sessionId: SessionId('orphan-session'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'dsagent-model' },
      })
      orphanHandle.agent.send([{ type: 'text', text: 'outside the sdk session map' }])
      await orphanHandle.agent.whenIdle()
      await orphanHandle.dispose()
      expect(llmServer.requests).toHaveLength(3)

      await server.handleRequest('shutdown', undefined)
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('notifies the host when a child session is created with parent lineage', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkServer(ctx, transport)

      ctx.sessions.create(SessionId('root-session'), {
        meta: { cwd: storageDir },
      })
      ctx.sessions.create(SessionId('child-session'), {
        meta: { cwd: storageDir, parentSession: SessionId('main') },
      })

      expect(transport.notifications).toContainEqual({
        method: 'subagent.started',
        params: {
          parentSessionId: 'main',
          childSessionId: 'child-session',
        },
      })

      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('creates an SDK session without an optional system prompt', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-no-system-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const ctx = await makeHarness(storageDir)
    try {
      const server = new HarnessSdkServer(ctx, new FakeTransport())

      await server.initialize({ cwd: storageDir, model: 'plain-model' })
      await server.prompt({
        sessionId: 'plain',
        contentBlocks: [{ type: 'text', text: 'hello' }],
      })

      expect(llmServer.requests).toHaveLength(1)
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('notifies the host when a subagent run settles', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-end-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkServer(ctx, transport)

      const handle = ctx.agents.create({
        agentId: AgentId('child-agent'),
        sessionId: SessionId('child-session'),
        meta: { cwd: storageDir, parentSession: SessionId('main') },
      })
      ctx.emit('subagent/end', {
        provider: 'spawn',
        id: AgentId('child-agent'),
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'child done' }],
      })

      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'spawn',
          agentId: 'child-agent',
          parentSessionId: 'main',
          childSessionId: 'child-session',
          status: 'ok',
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: 'child done' }],
        },
      })

      await handle.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('falls back to live agent lineage for uncached subagent end events', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-fallback-'))
    const ctx = await makeHarness(storageDir)
    let handle: ReturnType<typeof ctx.agents.create> | undefined
    let failedHandle: ReturnType<typeof ctx.agents.create> | undefined
    try {
      handle = ctx.agents.create({
        agentId: AgentId('fallback-child-agent'),
        sessionId: SessionId('fallback-child-session'),
        meta: { cwd: storageDir, parentSession: SessionId('fallback-parent') },
      })
      failedHandle = ctx.agents.create({
        agentId: AgentId('failed-child-agent'),
        sessionId: SessionId('failed-child-session'),
        meta: { cwd: storageDir },
      })
      const transport = new FakeTransport()
      const server = new HarnessSdkServer(ctx, transport)

      ctx.emit('subagent/end', {
        provider: 'fork',
        id: AgentId('fallback-child-agent'),
        stopReason: 'max-tokens',
      })
      ctx.emit('subagent/end', {
        provider: 'fork',
        id: AgentId('failed-child-agent'),
        stopReason: 'error',
      })
      ctx.emit('subagent/end', {
        provider: 'fork',
        id: AgentId('missing-child-agent'),
        stopReason: 'error',
      })

      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'fork',
          agentId: 'fallback-child-agent',
          parentSessionId: 'fallback-parent',
          childSessionId: 'fallback-child-session',
          status: 'ok',
          stopReason: 'max-tokens',
        },
      })
      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'fork',
          agentId: 'failed-child-agent',
          childSessionId: 'failed-child-session',
          status: 'error',
          stopReason: 'error',
        },
      })
      expect(transport.notifications.some(n =>
        n.method === 'subagent.finished'
        && n.params?.agentId === 'missing-child-agent',
      )).toBe(false)

      await server.shutdown()
    } finally {
      await handle?.dispose()
      await failedHandle?.dispose()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('does not re-register an LLM adapter that already exists', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-existing-llm-'))
    const ctx = await makeHarness(storageDir)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    await ctx.plugin(LlmDeepSeek, { models: ['preinstalled-model'] })
    try {
      const server = new HarnessSdkServer(ctx, new FakeTransport())
      const inspect = server as unknown as { hasAdapterFor(model: string): boolean }

      expect(inspect.hasAdapterFor('preinstalled-model')).toBe(true)
      expect(inspect.hasAdapterFor('missing-model')).toBe(false)
      await server.initialize({ cwd: storageDir, model: 'preinstalled-model' })

      expect(ctx.get('llm')?.models().filter(model => model === 'preinstalled-model')).toEqual(['preinstalled-model'])
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('registers a missing model when an LLM service already exists', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-new-llm-'))
    const ctx = await makeHarness(storageDir)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    await ctx.plugin(LlmDeepSeek, { models: ['other-model'] })
    try {
      const server = new HarnessSdkServer(ctx, new FakeTransport())

      await server.initialize({ cwd: storageDir, model: 'new-model' })

      expect(ctx.get('llm')?.models()).toEqual(expect.arrayContaining(['other-model', 'new-model']))
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('classifies defensive finish states', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-finish-states-'))
    const ctx = await makeHarness(storageDir)
    try {
      const server = new HarnessSdkServer(ctx, new FakeTransport()) as unknown as {
        finishedStatus(reason: unknown): 'ok' | 'error'
        shutdown(): Promise<Record<string, never>>
      }

      expect(server.finishedStatus(undefined)).toBe('error')
      expect(server.finishedStatus({ kind: 'max-tokens' })).toBe('ok')
      expect(server.finishedStatus({ kind: 'error' })).toBe('error')
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('reports no adapter when the LLM service is absent', async () => {
    const ctx = new Context()
    try {
      const server = new HarnessSdkServer(ctx, new FakeTransport()) as unknown as {
        hasAdapterFor(model: string): boolean
        shutdown(): Promise<Record<string, never>>
      }

      expect(server.hasAdapterFor('missing-model')).toBe(false)
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects unknown JSON-RPC runtime methods', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-unknown-'))
    const ctx = await makeHarness(storageDir)
    try {
      const server = new HarnessSdkServer(ctx, new FakeTransport())

      await expect(server.handleRequest('does/not/exist', {}))
        .rejects
        .toThrow('unknown DeepSeek Harness SDK runtime method: does/not/exist')

      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })
})
