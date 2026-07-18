import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { AgentId, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as agentCore from '@deepseek-ai/dsh-agent-spine-demo'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SubagentService, { type SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
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
  await ctx.plugin(agentCore, { workspaceContext: false })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SessionPersistenceJsonl, { root: storageDir })
  await new Promise(resolve => setTimeout(resolve, 50))
  return ctx
}

/** Drive the owning service so test lifecycle events carry the real parent scope. */
async function settleSubagent(ctx: Context, parent: Agent, info: SubagentRunEndInfo): Promise<void> {
  const disposeProvider = ctx.subagents.registerProvider({
    name: info.provider,
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    async start() {
      return {
        id: info.id,
        result: info.lastAssistantMessage === undefined
          ? Promise.reject(new Error('synthetic infrastructure failure'))
          : Promise.resolve({ output: info.lastAssistantMessage, stopReason: info.stopReason }),
        dispose: () => Promise.resolve(),
      }
    },
  })
  try {
    const run = await ctx.subagents.start(info.provider, {
      parent,
      prompt: [],
      signal: new AbortController().signal,
    })
    await run.result.then(() => undefined, () => undefined)
    await run.dispose()
  } finally {
    disposeProvider()
  }
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
        provider: 'deepseek',
        model: 'dsagent-model',
      }) as { serverInfo: { name: string } }
      expect(init.serverInfo.name).toBe('deepseek-harness-sdk-runtime')

      await server.handleRequest('session/prompt', {
        sessionId: 'main',
        contentBlocks: [{ type: 'text', text: 'fix it' }],
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

      const orphanHandle = await ctx.agents.create({
        agentId: AgentId('orphan-agent'),
        sessionId: SessionId('orphan-session'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek', model: 'dsagent-model' },
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

  it('rejects overlapping prompts for one session without serializing other sessions', async () => {
    let releaseMain: (() => void) | undefined
    const firstMainIdle = new Promise<void>((resolve) => { releaseMain = resolve })
    const mainWhenIdle = vi.fn<() => Promise<void>>()
      .mockReturnValueOnce(firstMainIdle)
      .mockResolvedValue(undefined)
    const mainSend = vi.fn()
    const mainAgent = {
      send: mainSend,
      whenIdle: mainWhenIdle,
    } as unknown as Agent
    const otherSend = vi.fn()
    const otherAgent = {
      send: otherSend,
      whenIdle: vi.fn(() => Promise.resolve()),
    } as unknown as Agent
    const mainHandle = { agent: mainAgent, dispose: vi.fn(() => Promise.resolve()) }
    const otherHandle = { agent: otherAgent, dispose: vi.fn(() => Promise.resolve()) }
    const create = vi.fn(async (options: { agentId: AgentId }) =>
      String(options.agentId) === 'main' ? mainHandle : otherHandle)
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: { create, get: () => undefined },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkServer(ctx, new FakeTransport())
    const prompt = (sessionId: string, text: string) => server.prompt({
      sessionId,
      contentBlocks: [{ type: 'text', text }],
    })

    const first = prompt('main', 'first')
    await vi.waitFor(() => { expect(mainSend).toHaveBeenCalledOnce() })

    await expect(prompt('main', 'overlap')).rejects.toThrow('session already has an active prompt: main')
    await expect(prompt('other', 'independent')).resolves.toEqual({ accepted: true })
    releaseMain?.()
    await expect(first).resolves.toEqual({ accepted: true })
    await expect(prompt('main', 'sequential')).resolves.toEqual({ accepted: true })

    mainWhenIdle.mockRejectedValueOnce(new Error('turn wait failed'))
    await expect(prompt('main', 'failing')).rejects.toThrow('turn wait failed')
    await expect(prompt('main', 'after failure')).resolves.toEqual({ accepted: true })

    expect(mainSend).toHaveBeenCalledTimes(4)
    expect(otherSend).toHaveBeenCalledOnce()
    await server.shutdown()
    expect(mainHandle.dispose).toHaveBeenCalledOnce()
    expect(otherHandle.dispose).toHaveBeenCalledOnce()
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

      await server.initialize({ cwd: storageDir, provider: 'deepseek', model: 'plain-model' })
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

      const parentHandle = await ctx.agents.create({
        agentId: AgentId('parent-agent'),
        sessionId: SessionId('main'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek', model: 'deepseek' },
      })
      const handle = await ctx.agents.create({
        agentId: AgentId('child-agent'),
        sessionId: SessionId('child-session'),
        meta: { cwd: storageDir, parentSession: SessionId('main') },
        agentOptions: { provider: 'deepseek', model: 'deepseek' },
      })
      await settleSubagent(ctx, parentHandle.agent, {
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
      await parentHandle.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('falls back to live agent lineage for uncached subagent end events', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-fallback-'))
    const ctx = await makeHarness(storageDir)
    let parentHandle: AgentHandle | undefined
    let handle: AgentHandle | undefined
    let failedHandle: AgentHandle | undefined
    try {
      parentHandle = await ctx.agents.create({
        agentId: AgentId('fallback-parent-agent'),
        sessionId: SessionId('fallback-parent'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek', model: 'deepseek' },
      })
      handle = await ctx.agents.create({
        agentId: AgentId('fallback-child-agent'),
        sessionId: SessionId('fallback-child-session'),
        meta: { cwd: storageDir, parentSession: SessionId('fallback-parent') },
        agentOptions: { provider: 'deepseek', model: 'deepseek' },
      })
      failedHandle = await ctx.agents.create({
        agentId: AgentId('failed-child-agent'),
        sessionId: SessionId('failed-child-session'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek', model: 'deepseek' },
      })
      const transport = new FakeTransport()
      const server = new HarnessSdkServer(ctx, transport)

      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'fork',
        id: AgentId('fallback-child-agent'),
        stopReason: 'max-tokens',
        lastAssistantMessage: [],
      })
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'fork',
        id: AgentId('failed-child-agent'),
        stopReason: 'error',
      })
      await settleSubagent(ctx, parentHandle.agent, {
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
          status: 'error',
          stopReason: 'max-tokens',
          lastAssistantMessage: [],
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
      await parentHandle?.dispose()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('does not re-register an LLM adapter whose provider already has an owner', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-existing-llm-'))
    const ctx = await makeHarness(storageDir)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    await ctx.plugin(LlmDeepSeek)
    try {
      const server = new HarnessSdkServer(ctx, new FakeTransport())
      const inspect = server as unknown as { hasAdapterFor(provider: string): boolean }

      expect(inspect.hasAdapterFor('deepseek')).toBe(true)
      expect(inspect.hasAdapterFor('missing-provider')).toBe(false)
      await server.initialize({ cwd: storageDir, provider: 'deepseek', model: 'preinstalled-model' })

      expect(ctx.get('llm')?.listProviders().filter(provider => provider.id === 'deepseek')).toEqual([{ id: 'deepseek', name: 'DeepSeek' }])
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('rejects a missing non-DeepSeek provider when an LLM service already exists', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-new-llm-'))
    const ctx = await makeHarness(storageDir)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    await ctx.plugin(LlmDeepSeek)
    try {
      const server = new HarnessSdkServer(ctx, new FakeTransport())

      await expect(server.initialize({ cwd: storageDir, provider: 'private', model: 'new-model' }))
        .rejects.toThrow('no adapter registered for provider "private"')

      expect(ctx.get('llm')?.listProviders()).toEqual([{ id: 'deepseek', name: 'DeepSeek' }])
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
      expect(server.finishedStatus({ kind: 'max-tokens' })).toBe('error')
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

  it('coalesces concurrent session creation and retries a failed creation', async () => {
    let resolveShared: ((handle: AgentHandle) => void) | undefined
    const sharedCreation = new Promise<AgentHandle>((resolve) => { resolveShared = resolve })
    const sharedHandle = { agent: {} as Agent, dispose: vi.fn(() => Promise.resolve()) }
    const retryHandle = { agent: {} as Agent, dispose: vi.fn(() => Promise.resolve()) }
    const create = vi.fn<(options: unknown) => Promise<AgentHandle>>()
      .mockReturnValueOnce(sharedCreation)
      .mockRejectedValueOnce(new Error('creation failed'))
      .mockResolvedValueOnce(retryHandle)
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: { create, get: () => undefined },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkServer(ctx, new FakeTransport()) as unknown as {
      getOrCreateSession(sessionId: string): Promise<{ handle: AgentHandle }>
      shutdown(): Promise<Record<string, never>>
    }

    const first = server.getOrCreateSession('shared')
    const second = server.getOrCreateSession('shared')
    expect(create).toHaveBeenCalledTimes(1)
    resolveShared?.(sharedHandle)
    const [firstRecord, secondRecord] = await Promise.all([first, second])
    expect(firstRecord).toBe(secondRecord)

    await expect(server.getOrCreateSession('retry')).rejects.toThrow('creation failed')
    await expect(server.getOrCreateSession('retry')).resolves.toMatchObject({ handle: retryHandle })
    expect(create).toHaveBeenCalledTimes(3)

    await server.shutdown()
    expect(sharedHandle.dispose).toHaveBeenCalledOnce()
    expect(retryHandle.dispose).toHaveBeenCalledOnce()
    await expect(server.getOrCreateSession('after-shutdown')).rejects.toThrow('SDK server is shutting down')
  })

  it('resolves a relative cwd before creating the session', async () => {
    const create = vi.fn<(options: unknown) => Promise<AgentHandle>>()
      .mockResolvedValue({ agent: {} as Agent, dispose: () => Promise.resolve() })
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: { create, get: () => undefined },
      get: () => ({ listProviders: () => [{ id: 'mock', name: 'Mock' }] }),
    } as unknown as Context
    const server = new HarnessSdkServer(ctx, new FakeTransport()) as unknown as {
      initialize(params: { cwd: string; provider: string; model: string }): Promise<unknown>
      getOrCreateSession(sessionId: string): Promise<unknown>
      shutdown(): Promise<Record<string, never>>
    }

    await server.initialize({ cwd: '.', provider: 'mock', model: 'model' })
    await server.getOrCreateSession('relative')

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ meta: { cwd: process.cwd() } }))
    await server.shutdown()
  })

  it('settles every teardown and aggregates multiple failures', async () => {
    const firstDispose = vi.fn(() => { throw new Error('first teardown failed') })
    const secondDispose = vi.fn(() => Promise.reject(new Error('second teardown failed')))
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: { create: vi.fn(), get: () => undefined },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkServer(ctx, new FakeTransport()) as unknown as {
      sessions: Map<string, { handle: AgentHandle; lastTurnEnd: undefined; activePrompt: boolean }>
      shutdown(): Promise<Record<string, never>>
    }
    server.sessions.set('first', { handle: { agent: {} as Agent, dispose: firstDispose }, lastTurnEnd: undefined, activePrompt: false })
    server.sessions.set('second', { handle: { agent: {} as Agent, dispose: secondDispose }, lastTurnEnd: undefined, activePrompt: false })

    await expect(server.shutdown()).rejects.toThrow('SDK server teardown failed')
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(secondDispose).toHaveBeenCalledOnce()
  })

  it('continues teardown after a subscription disposer fails', async () => {
    let subscription = 0
    const listenerFailure = new Error('listener teardown failed')
    const on = vi.fn(() => {
      subscription += 1
      return subscription === 1 ? () => { throw listenerFailure } : () => undefined
    })
    const ctx = {
      on,
      agents: { create: vi.fn(), get: () => undefined },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkServer(ctx, new FakeTransport())

    await expect(server.shutdown()).rejects.toBe(listenerFailure)
    expect(on).toHaveBeenCalledTimes(4)
  })
})
