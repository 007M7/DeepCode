import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, GenerateOptions, LlmModelInfo, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Config as SessionTitleConfig } from '@deepseek-ai/dsh-session-title'
import type { Config as SessionTitleLlmConfig } from '@deepseek-ai/dsh-session-title-first-message-llm'
import type { HostFrame, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { bootHost, startHost, type HostHandle, type RunningHost } from '../src/index.ts'

/** Scripted adapter: each model call consumes the next chunk list; 'hang' streams then waits for abort. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private script: (StreamChunk[] | 'hang')[],
    private readonly inputModalities: readonly ModelModality[] = ['text', 'image'],
    private readonly model = 'test-model',
  ) {
    super()
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{
      provider, id: this.model, name: this.model,
      inputModalities: this.inputModalities, outputModalities: ['text'],
    }])
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if ((options.tools?.length ?? 0) === 0) {
      yield * textResponse('Durable append-only session titles')
      return
    }
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('ScriptedAdapter: script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    yield * entry
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`req-${String(nextRpc++)}`), payload }
}
let nextRpc = 1

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject: Agent, status: string) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

async function nextMux(iterator: AsyncIterator<RpcRequest<MuxFrame>>): Promise<RpcRequest<MuxFrame>> {
  const next = await iterator.next()
  if (next.done === true) throw new Error('mux ended before the expected frame')
  return next.value
}

/** Durably append a title event without mounting title-generation policy. */
function appendTitle(ctx: Context, agent: Agent, title: string) {
  return ctx.sessions.appendOutOfBand(agent.session, 'session/title', {
    title,
    messageSeqs: [1],
    source: { kind: 'fallback' },
  }, { kind: 'session-title' })
}

let host: RunningHost | undefined

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'spec-placeholder-key')
})

afterEach(async () => {
  await host?.dispose()
  host = undefined
  vi.unstubAllEnvs()
})

async function boot(
  script: (StreamChunk[] | 'hang')[] = [],
  sessionTitle?: SessionTitleConfig,
  sessionTitleLlm?: true | SessionTitleLlmConfig,
): Promise<RunningHost> {
  host = await startHost({
    boot: {
      persistenceRoot: mkdtempSync(join(tmpdir(), 'dsh-host-runtime-')),
      workspaceContext: false,
      provider: 'scripted',
      model: 'test-model',
      ...(sessionTitle === undefined ? {} : { sessionTitle }),
      ...(sessionTitleLlm === undefined ? {} : { sessionTitleLlm }),
    },
  })
  host.ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter(script))
  return host
}

describe('bootHost / startHost', () => {
  it('falls back to the deepseek defaults and disposes idempotently', async () => {
    const handle: HostHandle = await bootHost({
      persistenceRoot: mkdtempSync(join(tmpdir(), 'dsh-boot-')),
      workspaceContext: false,
    })
    expect(handle.defaults).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-flash' })
    expect(typeof handle.defaults.cwd).toBe('string')
    await handle.dispose()
  })

  it('uses the JSONL backend compressed default', async () => {
    const handle: HostHandle = await bootHost({
      persistenceRoot: mkdtempSync(join(tmpdir(), 'dsh-boot-zstd-')),
      workspaceContext: false,
    })
    const session = handle.ctx.sessions.create()
    expect(handle.ctx.sessionPersistence.locate(session.header)?.path).toMatch(/\.jsonl\.zstd$/)
    await handle.dispose()
  })

  it('startHost assembles api + handler over the same defaults and dedupes dispose', async () => {
    const running = await boot()
    expect(running.defaults).toMatchObject({ provider: 'scripted', model: 'test-model' })
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r-h', method: 'host.describe', payload: {} })
    const response = await running.handler.fetch(new Request('http://x/api/host.describe', { method: 'POST', body }))
    const parsed = await response.json() as { result: { ok: boolean; value: { provider: string } } }
    expect(parsed.result.value.provider).toBe('scripted')
    const attachmentBody = JSON.stringify({
      type: 'client-request',
      rpcId: 'r-attachment',
      method: 'session.attachment',
      payload: { sessionId: 'session-missing', attachmentId: 'sha256:missing' },
    })
    const attachmentResponse = await running.handler.fetch(new Request('http://x/api/session.attachment', {
      method: 'POST',
      body: attachmentBody,
    }))
    expect((await attachmentResponse.json() as { result: { ok: boolean } }).result.ok).toBe(false)
    const first = running.dispose()
    expect(running.dispose()).toBe(first)
    await first
    host = undefined
  })

  it('mounts configured pi-ai providers while accepting an explicit empty list', async () => {
    const empty = await bootHost({
      persistenceRoot: mkdtempSync(join(tmpdir(), 'dsh-boot-pi-empty-')),
      workspaceContext: false,
      piAiProviders: [],
    })
    expect(empty.ctx.llm.listProviders()).toEqual([{ id: 'deepseek', name: 'DeepSeek' }])
    await empty.dispose()

    const configured = await bootHost({
      persistenceRoot: mkdtempSync(join(tmpdir(), 'dsh-boot-pi-')),
      workspaceContext: false,
      piAiProviders: [{ provider: 'openai' }],
    })
    expect(configured.ctx.llm.listProviders()).toContainEqual({ id: 'openai', name: 'openai' })
    await configured.dispose()
  })

  it('routes workspace instructions through the assembled agent request prefix', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-host-workspace-'))
    mkdirSync(join(workspace, '.git'))
    writeFileSync(join(workspace, 'AGENTS.md'), 'host-workspace-context-probe\n')
    const adapter = new ScriptedAdapter([textResponse('done')])
    host = await startHost({
      boot: {
        persistenceRoot: mkdtempSync(join(tmpdir(), 'dsh-host-workspace-sessions-')),
        workspaceContext: { dshHome: join(workspace, '.dsh'), maxBytes: 65_536 },
        provider: 'scripted',
        model: 'test-model',
        cwd: workspace,
      },
    })
    host.ctx.llm.registerAdapter(['scripted'], adapter)
    const { sessionId } = expectOk(await host.api.sessions.create(request({})))
    const agent = host.ctx.agents.get(sessionId) as Agent
    const idle = waitForIdle(host.ctx, agent)

    expectOk(await host.api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [{ type: 'text' as const, text: 'go' }],
    })))
    await idle

    const requestText = adapter.requests[0]?.messages
      .flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n') ?? ''
    expect(requestText).toContain('Instructions from: AGENTS.md')
    expect(requestText).toContain('host-workspace-context-probe')
  })

  it('keeps model title generation disabled when sessionTitleLlm is omitted', async () => {
    const running = await boot([textResponse('pong')])
    const { api, ctx } = running
    const { sessionId } = expectOk(await api.sessions.create(request({})))
    const agent = ctx.agents.get(sessionId) as Agent
    const idle = waitForIdle(ctx, agent)
    expectOk(await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [{ type: 'text' as const, text: 'Explain durable session titles.' }],
    })))
    await idle

    expect((await ctx.sessionTitle.refresh(agent.session))?.source).toEqual({ kind: 'fallback' })
    expect(agent.session.events.some(event => event.type === 'session/title-llm-request')).toBe(false)
  })
})

describe('host.describe', () => {
  it('reports version, cwd, defaults, and the attached count', async () => {
    const { api } = await boot()
    const value = expectOk(await api.host.describe(request({})))
    expect(value).toMatchObject({ version: '0.0.1', cwd: process.cwd(), provider: 'scripted', model: 'test-model', attachedSessions: 0 })
  })

  it('omits activeModel when the configured model is absent from the provider catalog', async () => {
    host = await startHost({
      boot: {
        persistenceRoot: mkdtempSync(join(tmpdir(), 'dsh-host-describe-missing-model-')),
        workspaceContext: false,
        provider: 'scripted',
        model: 'missing-model',
      },
    })
    host.ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter([], ['text'], 'other-model'))
    expect(expectOk(await host.api.host.describe(request({})))).not.toHaveProperty('activeModel')
  })
})

describe('sessions.create / list', () => {
  it('creates a session (echoing the request rpcId) and lists it newest-first', async () => {
    const { api } = await boot()
    const created = await api.sessions.create(request({ cwd: '/tmp' }))
    const { sessionId } = expectOk(created)
    expect(created.rpcId).toMatch(/^req-/)
    const second = expectOk(await api.sessions.create(request({}))).sessionId

    const { items } = expectOk(await api.sessions.list(request({})))
    expect(items.map(item => item.sessionId)).toContain(sessionId)
    expect(items.map(item => item.sessionId)).toContain(second)
    const first = items.find(item => item.sessionId === sessionId)
    expect(first?.cwd).toBe('/tmp')
    expect(first?.running).toBe(false)
    expect(first?.parentSessionId).toBeUndefined()
  })

  it('ensures a missing project directory before minting the session', async () => {
    const { api } = await boot()
    const root = mkdtempSync(join(tmpdir(), 'dsh-host-create-cwd-'))
    const cwd = join(root, 'nested', 'workspace')
    expect(existsSync(cwd)).toBe(false)
    const { sessionId } = expectOk(await api.sessions.create(request({ cwd })))
    expect(existsSync(cwd)).toBe(true)
    const { items } = expectOk(await api.sessions.list(request({})))
    expect(items.find(item => item.sessionId === sessionId)?.cwd).toBe(cwd)
  })

  it('fails loud when the project directory cannot be created', async () => {
    const { api } = await boot()
    const root = mkdtempSync(join(tmpdir(), 'dsh-host-create-cwd-fail-'))
    const blocker = join(root, 'file-not-dir')
    writeFileSync(blocker, 'x')
    const response = await api.sessions.create(request({ cwd: join(blocker, 'child') }))
    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('expected mkdir failure')
    expect(response.result.error.code).toBe('internal')
    expect(response.result.error.message).toMatch(/failed to ensure project directory/)
  })
})

describe('sessions.prompt / cancel', () => {
  it.each([
    { name: 'host default', config: true, target: '5 words', maxTokens: 64 },
    {
      name: 'configured policy',
      config: {
        targetWords: 3,
        targetCjkCharacters: 8,
        maxInputBytes: 2_048,
        maxOutputTokens: 24,
        timeoutMs: 2_000,
      },
      target: '3 words',
      maxTokens: 24,
    },
  ] satisfies {
    name: string
    config: true | SessionTitleLlmConfig
    target: string
    maxTokens: number
  }[])('replaces the fallback with a model-backed first-message title using the $name', async ({ config, target, maxTokens }) => {
    const modelTitle = 'Durable append-only session titles'
    const running = await boot([textResponse('pong')], undefined, config)
    const { api, ctx } = running
    const { sessionId } = expectOk(await api.sessions.create(request({})))
    const agent = ctx.agents.get(sessionId) as Agent
    const idle = waitForIdle(ctx, agent)
    expectOk(await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [{ type: 'text' as const, text: 'Explain why append-only logs make session titles durable.' }],
    })))
    await idle

    await vi.waitFor(() => {
      expect(agent.session.events.filter(event => event.type === 'session/title').map(event => event.data))
        .toEqual([
          {
            title: 'Explain why append-only logs make',
            messageSeqs: [1],
            source: { kind: 'fallback' },
          },
          {
            title: modelTitle,
            messageSeqs: [1],
            source: {
              kind: 'provider',
              provider: 'session-title-first-message-llm',
              model: { provider: 'scripted', model: 'test-model' },
            },
          },
        ])
    })
    const titleRequest = agent.session.events.find(event => event.type === 'session/title-llm-request')
    expect(titleRequest?.data.system).toContain(target)
    expect(titleRequest?.data.maxTokens).toBe(maxTokens)
  })

  it.each([
    { name: 'host default', config: undefined, expected: 'Show the Web UI durable' },
    {
      name: 'configured limit',
      config: { fallbackMaxWords: 2, fallbackMaxBytes: 40, maxTitleBytes: 80 },
      expected: 'Show the',
    },
  ] satisfies { name: string; config: SessionTitleConfig | undefined; expected: string }[])(
    'logs a durable fallback title with the $name',
    async ({ config, expected }) => {
      const running = await boot([textResponse('pong')], config)
      const { api, ctx } = running
      const { sessionId } = expectOk(await api.sessions.create(request({})))
      const agent = ctx.agents.get(sessionId) as Agent
      const idle = waitForIdle(ctx, agent)
      expectOk(await api.sessions.prompt(request({
        sessionId,
        mode: 'queue' as const,
        content: [{ type: 'text' as const, text: 'Show the Web UI durable session title' }],
      })))
      await idle

      const title = agent.session.events.find(event => event.type === 'session/title')
      expect(title?.data).toEqual({
        title: expected,
        messageSeqs: [1],
        source: { kind: 'fallback' },
      })
    },
  )

  it('queues a prompt whose rpcId rides into user/message, then the reply lands', async () => {
    const running = await boot([textResponse('pong')])
    const { api, ctx } = running
    const { sessionId } = expectOk(await api.sessions.create(request({})))
    const agent = ctx.agents.get(sessionId)
    expect(agent).toBeDefined()
    const idle = waitForIdle(ctx, agent as Agent)
    const promptRequest = request({ sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: 'ping' }] })
    expectOk(await api.sessions.prompt(promptRequest))
    await idle

    const value = expectOk(await api.sessions.history(request({ sessionId })))
    const events = value.events.map(entry => entry.event)
    const userEvent = events.find(event => event.type === 'user/message') as
      | { data: { source?: { rpcId?: string } } } | undefined
    expect(userEvent?.data.source?.rpcId).toBe(promptRequest.rpcId)
    const reply = events.find(event => event.type === 'assistant/message')
    expect(reply).toBeDefined()
  })

  it('steer on an idle agent falls through to send', async () => {
    const running = await boot([textResponse('steered')])
    const { api, ctx } = running
    const { sessionId } = expectOk(await api.sessions.create(request({})))
    const idle = waitForIdle(ctx, ctx.agents.get(sessionId) as Agent)
    expectOk(await api.sessions.prompt(request({ sessionId, mode: 'steer' as const, content: [{ type: 'text' as const, text: 'now' }] })))
    await idle
  })

  it('errors session-not-found on a ghost session', async () => {
    const { api } = await boot()
    const response = await api.sessions.prompt(request({ sessionId: 'session-void' as SessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: 'x' }] }))
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) expect(response.result.error.code).toBe('session-not-found')
  })

  it('maps a synchronous send throw to agent-busy', async () => {
    const { api, ctx } = await boot()
    const { sessionId } = expectOk(await api.sessions.create(request({})))
    vi.spyOn(ctx.agents.get(sessionId) as Agent, 'send').mockImplementation(() => {
      throw new Error('disposed during prompt')
    })
    const response = await api.sessions.prompt(request({
      sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: 'x' }],
    }))
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) expect(response.result.error.code).toBe('agent-busy')
  })

  it('persists uploaded bytes before the user event and serves them only through the owning session', async () => {
    const persistenceRoot = mkdtempSync(join(tmpdir(), 'dsh-image-session-'))
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-image-home-'))
    host = await startHost({
      boot: { persistenceRoot, workspaceContext: false, dshHome, provider: 'scripted', model: 'test-model' },
    })
    host.ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter([textResponse('seen')]))
    const { sessionId } = expectOk(await host.api.sessions.create(request({})))
    const agent = host.ctx.agents.get(sessionId) as Agent
    const idle = waitForIdle(host.ctx, agent)
    const response = await host.api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [
        { type: 'text' as const, text: 'describe' },
        { type: 'image' as const, mediaType: 'image/png' as const, data: PNG_BASE64, name: '/tmp/pixel.png' },
      ],
    }))
    expectOk(response)
    await idle

    const user = agent.session.events.find(event => event.type === 'user/message')
    const content = (user?.data as { content?: ContentBlock[] } | undefined)?.content ?? []
    const image = content.find(block => block.type === 'image')
    expect(image?.type).toBe('image')
    if (image?.type !== 'image') throw new Error('image block missing')
    expect(JSON.stringify(user)).not.toContain(PNG_BASE64)
    expect(image.attachment.name).toBe('pixel.png')
    const sha256 = String(image.attachment.attachmentId).slice('sha256:'.length)
    const object = join(dshHome, 'attachments', 'v1', 'objects', sha256.slice(0, 2), sha256)
    expect(existsSync(object)).toBe(true)
    expect(readFileSync(object).toString('base64')).toBe(PNG_BASE64)

    const loaded = expectOk(await host.api.sessions.attachment(request({
      sessionId, attachmentId: image.attachment.attachmentId,
    })))
    expect(loaded).toEqual({ attachment: image.attachment, data: PNG_BASE64 })
    const { sessionId: other } = expectOk(await host.api.sessions.create(request({})))
    const denied = await host.api.sessions.attachment(request({
      sessionId: other, attachmentId: image.attachment.attachmentId,
    }))
    expect(denied.result).toMatchObject({
      ok: false, error: { code: 'attachment-error', details: { reason: 'ATTACHMENT_NOT_REFERENCED' } },
    })

    const { sessionId: nestedSession } = expectOk(await host.api.sessions.create(request({})))
    const nestedAgent = host.ctx.agents.get(nestedSession) as Agent
    // Injected context is a user/message with a non-user source (send-unify).
    nestedAgent.session.append('user/message', {
      content: [
        null,
        [],
        {
          type: 'tool-result',
          toolCallId: 'nested-text' as never,
          content: [{ type: 'text', text: 'no image here' }],
        },
        {
          type: 'tool-result',
          toolCallId: 'nested-image' as never,
          content: [{ type: 'image', attachment: image.attachment }],
        },
      ] as never,
      source: { kind: 'plugin', plugin: 'spec' },
    }, { surfaceOp: 'append' })
    expectOk(await host.api.sessions.attachment(request({
      sessionId: nestedSession,
      attachmentId: image.attachment.attachmentId,
    })))

    const { sessionId: streamedSession } = expectOk(await host.api.sessions.create(request({})))
    const streamedAgent = host.ctx.agents.get(streamedSession) as Agent
    streamedAgent.session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'block-end', index: 0, block: { type: 'image', attachment: image.attachment } },
    })
    expectOk(await host.api.sessions.attachment(request({
      sessionId: streamedSession,
      attachmentId: image.attachment.attachmentId,
    })))

    const missingRef = {
      ...image.attachment,
      attachmentId: `sha256:${'b'.repeat(64)}` as never,
    }
    streamedAgent.session.append('user/message', {
      content: [{ type: 'image', attachment: missingRef }],
      source: { kind: 'plugin', plugin: 'spec' },
    }, { surfaceOp: 'append' })
    const missing = await host.api.sessions.attachment(request({
      sessionId: streamedSession,
      attachmentId: missingRef.attachmentId,
    }))
    expect(missing.result).toMatchObject({
      ok: false, error: { details: { reason: 'ATTACHMENT_NOT_FOUND' } },
    })

    const read = vi.spyOn(host.ctx.attachments, 'readImage').mockRejectedValueOnce(new Error('read failed'))
    const internal = await host.api.sessions.attachment(request({
      sessionId: nestedSession,
      attachmentId: image.attachment.attachmentId,
    }))
    expect(internal.result).toMatchObject({ ok: false, error: { code: 'internal' } })
    read.mockRestore()

    const ghost = await host.api.sessions.attachment(request({
      sessionId: 'session-ghost' as SessionId,
      attachmentId: image.attachment.attachmentId,
    }))
    expect(ghost.result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
  })

  it('rejects non-canonical, excessive-count, and excessive-byte image prompts', async () => {
    const running = await boot()
    const { sessionId } = expectOk(await running.api.sessions.create(request({})))
    for (const data of ['', 'AB==']) {
      const invalid = await running.api.sessions.prompt(request({
        sessionId,
        mode: 'queue' as const,
        content: [{ type: 'image' as const, mediaType: 'image/png' as const, data }],
      }))
      expect(invalid.result).toMatchObject({
        ok: false, error: { details: { reason: 'INVALID_IMAGE_BASE64' } },
      })
    }

    const attachmentService = running.ctx.attachments as unknown as {
      imageLimits: typeof running.ctx.attachments.imageLimits
    }
    attachmentService.imageLimits = {
      ...running.ctx.attachments.imageLimits,
      maxImagesPerMessage: 1,
    }
    const tooMany = await running.api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: Array.from({ length: 2 }, () => ({
        type: 'image' as const,
        mediaType: 'image/png' as const,
        data: PNG_BASE64,
      })),
    }))
    expect(tooMany.result).toMatchObject({
      ok: false, error: { details: { reason: 'TOO_MANY_IMAGES' } },
    })

    attachmentService.imageLimits = {
      ...running.ctx.attachments.imageLimits,
      maxImagesPerMessage: 10,
      maxMessageImageBytes: 100,
    }
    const excessiveBytes = await running.api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: Array.from({ length: 2 }, () => ({
        type: 'image' as const,
        mediaType: 'image/png' as const,
        data: PNG_BASE64,
      })),
    }))
    expect(excessiveBytes.result).toMatchObject({
      ok: false, error: { details: { reason: 'IMAGES_TOO_LARGE' } },
    })
  })

  it('publishes nothing when one member of a multi-image prompt is malformed', async () => {
    const persistenceRoot = mkdtempSync(join(tmpdir(), 'dsh-batch-session-'))
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-batch-home-'))
    host = await startHost({
      boot: { persistenceRoot, workspaceContext: false, dshHome, provider: 'scripted', model: 'test-model' },
    })
    host.ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter([textResponse('unused')]))
    const { sessionId } = expectOk(await host.api.sessions.create(request({})))
    const response = await host.api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [
        { type: 'image' as const, mediaType: 'image/png' as const, data: PNG_BASE64 },
        // Canonical base64, but the bytes are not a PNG: the whole batch must
        // be validated before any member persists, or the valid image above
        // would become a permanently unreferenced object (this store has no GC).
        { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQID' },
      ],
    }))
    expect(response.result).toMatchObject({
      ok: false, error: { details: { reason: 'INVALID_IMAGE' } },
    })
    expect(existsSync(join(dshHome, 'attachments'))).toBe(false)
  })

  it('rejects images for an explicitly text-only model without creating a session event', async () => {
    const persistenceRoot = mkdtempSync(join(tmpdir(), 'dsh-text-session-'))
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-text-home-'))
    host = await startHost({
      boot: { persistenceRoot, workspaceContext: false, dshHome, provider: 'scripted', model: 'test-model' },
    })
    host.ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter([], ['text']))
    const { sessionId } = expectOk(await host.api.sessions.create(request({})))
    const response = await host.api.sessions.prompt(request({
      sessionId, mode: 'queue' as const,
      content: [{ type: 'image' as const, mediaType: 'image/png' as const, data: PNG_BASE64 }],
    }))
    expect(response.result).toMatchObject({
      ok: false, error: { code: 'attachment-error', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } },
    })
    expect(host.ctx.agents.get(sessionId)?.session.events.some(event => event.type === 'user/message')).toBe(false)
    expect(existsSync(join(dshHome, 'attachments'))).toBe(false)
  })

  it('preflights the session route instead of the host default model', async () => {
    const persistenceRoot = mkdtempSync(join(tmpdir(), 'dsh-routed-session-'))
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-routed-home-'))
    host = await startHost({
      boot: { persistenceRoot, workspaceContext: false, dshHome, provider: 'scripted', model: 'test-model' },
    })
    host.ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter([], ['text']))
    host.ctx.llm.registerAdapter(
      ['visual'],
      new ScriptedAdapter([textResponse('seen')], ['text', 'image'], 'visual-model'),
    )
    const { sessionId } = expectOk(await host.api.sessions.create(request({})))
    const agent = host.ctx.agents.get(sessionId) as Agent
    agent.options.provider = 'visual'
    agent.options.model = 'visual-model'
    const idle = waitForIdle(host.ctx, agent)

    expectOk(await host.api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [{ type: 'image' as const, mediaType: 'image/png' as const, data: PNG_BASE64 }],
    })))
    await idle

    expect(agent.session.events.some(event => event.type === 'user/message')).toBe(true)
    expect(existsSync(join(dshHome, 'attachments'))).toBe(true)
  })

  it('falls back to host routing when a session has no routed or agent model options', async () => {
    host = await startHost({
      boot: {
        persistenceRoot: mkdtempSync(join(tmpdir(), 'dsh-host-route-default-')),
        workspaceContext: false,
        provider: 'scripted',
        model: 'test-model',
      },
    })
    host.ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter([], ['text']))
    const { sessionId } = expectOk(await host.api.sessions.create(request({})))
    const agent = host.ctx.agents.get(sessionId) as Agent
    agent.options.provider = undefined as never
    agent.options.model = undefined as never
    const response = await host.api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [{ type: 'image' as const, mediaType: 'image/png' as const, data: PNG_BASE64 }],
    }))
    expect(response.result).toMatchObject({
      ok: false, error: { details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } },
    })
  })

  it('cancels an attached agent and rejects an unattached one', async () => {
    const running = await boot(['hang'])
    const { api, ctx } = running
    const { sessionId } = expectOk(await api.sessions.create(request({})))
    const agent = ctx.agents.get(sessionId) as Agent
    agent.followup([{ type: 'text', text: 'run forever' }])
    expectOk(await api.sessions.cancel(request({ sessionId })))

    const missing = await api.sessions.cancel(request({ sessionId: 'session-none' as SessionId }))
    expect(missing.result.ok).toBe(false)
    if (!missing.result.ok) expect(missing.result.error.code).toBe('session-not-found')
  })
})

describe('sessions.history', () => {
  it('implicitly resumes a cold session, deduplicating concurrent calls to one attach', async () => {
    const persistenceRoot = mkdtempSync(join(tmpdir(), 'dsh-host-resume-'))
    const first = await startHost({
      boot: { persistenceRoot, workspaceContext: false, provider: 'scripted', model: 'test-model' },
    })
    first.ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter([textResponse('persisted')]))
    const { sessionId } = expectOk(await first.api.sessions.create(request({})))
    const agent = first.ctx.agents.get(sessionId) as Agent
    const idle = waitForIdle(first.ctx, agent)
    agent.followup([{ type: 'text', text: 'save me' }])
    await idle
    const titleEvent = await appendTitle(first.ctx, agent, 'Persisted title')
    await first.dispose()

    host = await startHost({
      boot: { persistenceRoot, workspaceContext: false, provider: 'scripted', model: 'test-model' },
    })
    host.ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter([]))
    expect(host.ctx.agents.get(sessionId)).toBeUndefined()
    const abort = new AbortController()
    const mux = host.api.events.mux(request({}), abort.signal)[Symbol.asyncIterator]()
    const [a, b] = await Promise.all([
      host.api.sessions.history(request({ sessionId })),
      host.api.sessions.history(request({ sessionId })),
    ])
    for (const response of [a, b]) {
      const value = expectOk(response)
      expect(value.events.some(entry => entry.event.type === 'assistant/message')).toBe(true)
    }
    expect(host.ctx.agents.get(sessionId)).toBeDefined()
    expect(host.ctx.agents.list()).toHaveLength(1)
    expect((await nextMux(mux)).payload).toMatchObject({ type: 'session/subscribed', sessionId })
    expect((await nextMux(mux)).payload).toEqual(expect.objectContaining({
      type: 'session/title', sessionId, title: 'Persisted title', eventSeq: titleEvent.seq,
    }))
    abort.abort()
  })

  it('errors session-not-found when resume fails, deduplicating concurrent resumes', async () => {
    const { api } = await boot()
    const ghost = 'session-ghost' as SessionId
    const [first, second] = await Promise.all([
      api.sessions.history(request({ sessionId: ghost })),
      api.sessions.history(request({ sessionId: ghost })),
    ])
    for (const response of [first, second]) {
      expect(response.result.ok).toBe(false)
      if (!response.result.ok) expect(response.result.error.code).toBe('session-not-found')
    }
  })

  it('paginates backwards on message boundaries with hasMore', async () => {
    const running = await boot([textResponse('a1'), textResponse('a2'), textResponse('a3')])
    const { api, ctx } = running
    const { sessionId } = expectOk(await api.sessions.create(request({})))
    const agent = ctx.agents.get(sessionId) as Agent
    for (const text of ['q1', 'q2', 'q3']) {
      const idle = waitForIdle(ctx, agent)
      agent.followup([{ type: 'text', text }])
      await idle
    }

    const all = expectOk(await api.sessions.history(request({ sessionId })))
    expect(all.hasMore).toBe(false)
    const messageCount = all.events.filter(entry => entry.event.type === 'user/message' || entry.event.type === 'assistant/message').length
    expect(messageCount).toBe(6)

    const lastPage = expectOk(await api.sessions.history(request({ sessionId, maxMessages: 1 })))
    expect(lastPage.hasMore).toBe(true)
    expect(lastPage.events.filter(entry => entry.event.type === 'assistant/message')).toHaveLength(1)
    expect(lastPage.events.filter(entry => entry.event.type === 'user/message')).toHaveLength(0)

    const firstSeq = lastPage.events[0]?.event.seq as number
    const olderPage = expectOk(await api.sessions.history(request({ sessionId, beforeSeq: firstSeq, maxMessages: 2 })))
    expect(olderPage.events.at(-1)?.event.seq).toBeLessThan(firstSeq)
    expect(olderPage.hasMore).toBe(true)
    expect(olderPage.events.filter(entry => entry.event.type === 'user/message' || entry.event.type === 'assistant/message').length).toBe(2)
  })
})

describe('events streams', () => {
  it('mux: a pending pull wakes when a frame arrives (waiter path)', async () => {
    const running = await boot()
    const { api } = running
    const ac = new AbortController()
    const stream = api.events.mux(request({}), ac.signal)[Symbol.asyncIterator]()
    // no sessions yet: next() must pend on the queue's waiter, not the buffer
    const pending = stream.next()
    const { sessionId } = expectOk(await api.sessions.create(request({})))
    const frame = (await pending).value as RpcRequest<MuxFrame>
    expect(frame.payload).toMatchObject({ type: 'session/subscribed', sessionId })
    ac.abort()
    expect((await stream.next()).done).toBe(true)
  })

  it('lists fork lineage and announces it on the host stream', async () => {
    const running = await boot()
    const { api, ctx } = running
    const { sessionId: parent } = expectOk(await api.sessions.create(request({})))
    const ac = new AbortController()
    const stream = api.events.host(request({}), ac.signal)[Symbol.asyncIterator]()
    const child = `session-child-${String(Date.now())}` as SessionId
    const handle = await ctx.agents.create({ sessionId: child, meta: { parentSession: parent }, agentOptions: { provider: 'scripted', model: 'test-model' } })
    expect(handle.agent.id).toBe(child)
    const added = (await stream.next()).value as RpcRequest<HostFrame>
    expect(added.payload).toMatchObject({ type: 'host/session-added', sessionId: child, parentSessionId: parent })
    const { items } = expectOk(await api.sessions.list(request({})))
    expect(items.find(item => item.sessionId === child)?.parentSessionId).toBe(parent)

    await handle.dispose()
    let frame: RpcRequest<HostFrame>
    do frame = (await stream.next()).value as RpcRequest<HostFrame>
    while (frame.payload.type !== 'host/session-removed')
    expect(frame.payload).toMatchObject({ type: 'host/session-removed', sessionId: child })
    ac.abort()
  })

  it('mux: emits subscribed baselines, live session events, and new-session subscriptions until abort', async () => {
    const running = await boot([textResponse('live')])
    const { api, ctx } = running
    const { sessionId } = expectOk(await api.sessions.create(request({})))

    const ac = new AbortController()
    const stream = api.events.mux(request({}), ac.signal)[Symbol.asyncIterator]()
    const baseline = await stream.next()
    expect((baseline.value as RpcRequest<MuxFrame>).payload).toMatchObject({ type: 'session/subscribed', sessionId })

    const agent = ctx.agents.get(sessionId) as Agent
    const idle = waitForIdle(ctx, agent)
    agent.followup([{ type: 'text', text: 'go' }])
    await idle
    const live = await stream.next()
    expect((live.value as RpcRequest<MuxFrame>).payload.type).toBe('session/event')

    const other = expectOk(await api.sessions.create(request({}))).sessionId
    let frame: RpcRequest<MuxFrame>
    do frame = (await stream.next()).value as RpcRequest<MuxFrame>
    while (!(frame.payload.type === 'session/subscribed' && frame.payload.sessionId === other))

    ac.abort()
    expect((await stream.next()).done).toBe(true)
  })

  it('mux: projects durable titles after open baselines and immediately after live raw events', async () => {
    const running = await boot()
    const { api, ctx } = running
    const { sessionId } = expectOk(await api.sessions.create(request({})))
    const agent = ctx.agents.get(sessionId) as Agent
    const initial = await appendTitle(ctx, agent, 'Initial title')

    const ac = new AbortController()
    const stream = api.events.mux(request({}), ac.signal)[Symbol.asyncIterator]()
    expect((await nextMux(stream)).payload).toMatchObject({ type: 'session/subscribed', sessionId })
    expect((await nextMux(stream)).payload).toEqual(expect.objectContaining({
      type: 'session/title', sessionId, title: 'Initial title', eventSeq: initial.seq, updatedAt: initial.time,
    }))

    const revised = await appendTitle(ctx, agent, 'Revised title')
    let raw: RpcRequest<MuxFrame>
    do raw = await nextMux(stream)
    while (!(raw.payload.type === 'session/event' && raw.payload.event.type === 'session/title'))
    expect(raw.payload).toMatchObject({ type: 'session/event', sessionId, event: { seq: revised.seq } })
    expect((await nextMux(stream)).payload).toEqual(expect.objectContaining({
      type: 'session/title', sessionId, title: 'Revised title', eventSeq: revised.seq, updatedAt: revised.time,
    }))
    ac.abort()
  })

  it('mux: emits no title control for untitled subscriptions', async () => {
    const { api } = await boot()
    const first = expectOk(await api.sessions.create(request({}))).sessionId
    const ac = new AbortController()
    const stream = api.events.mux(request({}), ac.signal)[Symbol.asyncIterator]()
    expect((await nextMux(stream)).payload).toMatchObject({ type: 'session/subscribed', sessionId: first })

    const second = expectOk(await api.sessions.create(request({}))).sessionId
    expect((await nextMux(stream)).payload).toMatchObject({ type: 'session/subscribed', sessionId: second })
    ac.abort()
  })

  it('host: session lifecycle, status flips (disposed suppressed), and agent errors', async () => {
    const running = await boot([textResponse('x')])
    const { api, ctx } = running
    const ac = new AbortController()
    const stream = api.events.host(request({}), ac.signal)[Symbol.asyncIterator]()

    const { sessionId } = expectOk(await api.sessions.create(request({})))
    const added = await stream.next()
    expect((added.value as RpcRequest<HostFrame>).payload).toMatchObject({ type: 'host/session-added', sessionId })

    const agent = ctx.agents.get(sessionId) as Agent
    const idle = waitForIdle(ctx, agent)
    agent.followup([{ type: 'text', text: 'run' }])
    await idle
    const runningFrame = await stream.next()
    expect((runningFrame.value as RpcRequest<HostFrame>).payload).toMatchObject({ type: 'host/session-status', running: true })
    const idleFrame = await stream.next()
    expect((idleFrame.value as RpcRequest<HostFrame>).payload).toMatchObject({ type: 'host/session-status', running: false })

    // Raw ctx.emit lacks the scope carrier the mounted invariants plugin now
    // enforces; dispatch the way the loop does.
    agentEvents(ctx, agent).emit('agent/error', 1, 1, new Error('boom'))
    const errorFrame = await stream.next()
    expect((errorFrame.value as RpcRequest<HostFrame>).payload).toMatchObject({ type: 'host/agent-error', message: 'Error: boom' })

    ac.abort()
    // Push-after-done: an event landing between abort and generator wind-down
    // must be dropped silently, not crash the queue.
    agentEvents(ctx, agent).emit('agent/error', 1, 1, new Error('late'))
    expect((await stream.next()).done).toBe(true)
  })
})

describe('question request / response', () => {
  const questions = [{
    id: 'mode', question: 'Choose a mode',
    options: [
      { label: 'Fast (Recommended)', description: 'Move quickly.' },
      { label: 'Careful', description: 'Review first.' },
    ],
  }]

  it('waits, replays the same rpcId on reconnect, validates, and resolves first-wins', async () => {
    const running = await boot()
    const { api, ctx } = running
    const { sessionId } = expectOk(await api.sessions.create(request({})))
    const agent = ctx.agents.get(sessionId) as Agent
    const ac = new AbortController()
    const stream = api.events.mux(request({}), ac.signal)[Symbol.asyncIterator]()
    await stream.next() // subscribed baseline starts the generator and installs the queue

    const answerPromise = ctx.userInteraction.ask({ questions, agent })
    const requested = (await stream.next()).value as RpcRequest<MuxFrame>
    expect(requested.payload).toMatchObject({ type: 'question/requested', sessionId, questions })

    const wrongSession = await api.respond({
      type: 'client-response', rpcId: requested.rpcId,
      result: {
        ok: true,
        value: { sessionId: 'session-other', answer: { answers: [{ id: 'mode', selected: ['Fast (Recommended)'] }] } },
      },
    })
    expect(wrongSession).toEqual({ accepted: false, reason: 'bad-response' })
    const badChoice = await api.respond({
      type: 'client-response', rpcId: requested.rpcId,
      result: {
        ok: true,
        value: { sessionId, answer: { answers: [{ id: 'mode', selected: ['Unknown'] }] } },
      },
    })
    expect(badChoice).toEqual({ accepted: false, reason: 'bad-response' })
    const invalidResults = [
      { ok: true as const, value: null },
      { ok: true as const, value: { sessionId, answer: { answers: [] } } },
      { ok: true as const, value: { sessionId, answer: { answers: [{ id: 'wrong', selected: ['Fast (Recommended)'] }] } } },
      { ok: true as const, value: { sessionId, answer: { answers: [{ id: 'mode', selected: ['Fast (Recommended)', 'Fast (Recommended)'] }] } } },
      { ok: true as const, value: { sessionId, answer: { answers: [{ id: 'mode', selected: ['Fast (Recommended)', 'Careful'] }] } } },
      { ok: true as const, value: { sessionId, answer: { answers: [{ id: 'mode', selected: [], custom: '   ' }] } } },
      { ok: true as const, value: { sessionId, answer: { answers: [{ id: 'mode', selected: ['Careful'], custom: 'Other' }] } } },
      { ok: false as const, error: { code: 'internal' as const, message: 'wrong error', details: {} } },
    ]
    for (const result of invalidResults) {
      expect(await api.respond({
        type: 'client-response', rpcId: requested.rpcId, result,
      })).toEqual({ accepted: false, reason: 'bad-response' })
    }

    const reconnectAbort = new AbortController()
    const replay = api.events.mux(request({}), reconnectAbort.signal)[Symbol.asyncIterator]()
    await replay.next()
    const replayed = (await replay.next()).value as RpcRequest<MuxFrame>
    expect(replayed.rpcId).toBe(requested.rpcId)
    expect(replayed.payload).toEqual(requested.payload)

    const response = {
      type: 'client-response' as const,
      rpcId: requested.rpcId,
      result: {
        ok: true as const,
        value: { sessionId, answer: { answers: [{ id: 'mode', selected: ['Fast (Recommended)'] }] } },
      },
    }
    const [first, duplicate] = await Promise.all([api.respond(response), api.respond(response)])
    expect([first, duplicate]).toContainEqual({ accepted: true })
    expect([first, duplicate]).toContainEqual({ accepted: false, reason: 'not-pending' })
    await expect(answerPromise).resolves.toEqual({
      answers: [{ id: 'mode', selected: ['Fast (Recommended)'] }],
    })

    const resolved = (await stream.next()).value as RpcRequest<MuxFrame>
    expect(resolved.payload).toMatchObject({
      type: 'question/resolved', sessionId, questionRpcId: requested.rpcId, outcome: 'answered',
    })
    expect(await api.respond(response)).toEqual({ accepted: false, reason: 'not-pending' })

    const customQuestions = [{ id: 'detail', question: 'What else?' }]
    const customAnswer = ctx.userInteraction.ask({ questions: customQuestions, agent })
    const customRequested = (await stream.next()).value as RpcRequest<MuxFrame>
    expect(await api.respond({
      type: 'client-response', rpcId: customRequested.rpcId,
      result: {
        ok: true,
        value: { sessionId, answer: { answers: [{ id: 'detail', selected: [], custom: 'Keep traces' }] } },
      },
    })).toEqual({ accepted: true })
    await expect(customAnswer).resolves.toEqual({
      answers: [{ id: 'detail', selected: [], custom: 'Keep traces' }],
    })
    expect(((await stream.next()).value as RpcRequest<MuxFrame>).payload).toMatchObject({
      type: 'question/resolved', questionRpcId: customRequested.rpcId, outcome: 'answered',
    })

    const blankAnswer = ctx.userInteraction.ask({ questions, agent })
    const blankRequested = (await stream.next()).value as RpcRequest<MuxFrame>
    expect(await api.respond({
      type: 'client-response', rpcId: blankRequested.rpcId,
      result: {
        ok: true,
        value: { sessionId, answer: { answers: [{ id: 'mode', selected: [] }] } },
      },
    })).toEqual({ accepted: true })
    await expect(blankAnswer).resolves.toEqual({
      answers: [{ id: 'mode', selected: [] }],
    })
    expect(((await stream.next()).value as RpcRequest<MuxFrame>).payload).toMatchObject({
      type: 'question/resolved', questionRpcId: blankRequested.rpcId, outcome: 'answered',
    })
    ac.abort()
    reconnectAbort.abort()
  })

  it('distinguishes user cancellation from owner abort and rejects late responses', async () => {
    const running = await boot()
    const { api, ctx } = running
    const { sessionId } = expectOk(await api.sessions.create(request({})))
    const agent = ctx.agents.get(sessionId) as Agent
    const streamAbort = new AbortController()
    const stream = api.events.mux(request({}), streamAbort.signal)[Symbol.asyncIterator]()
    await stream.next()

    const cancelled = ctx.userInteraction.ask({ questions, agent }).catch((error: unknown) => error)
    const requested = (await stream.next()).value as RpcRequest<MuxFrame>
    expect(await api.respond({
      type: 'client-response', rpcId: requested.rpcId,
      result: { ok: false, error: { code: 'cancelled', message: 'skip', details: {} } },
    })).toEqual({ accepted: true })
    await expect(cancelled).resolves.toMatchObject({ code: 'ASK_CANCELLED' })
    expect(((await stream.next()).value as RpcRequest<MuxFrame>).payload).toMatchObject({
      type: 'question/resolved', outcome: 'cancelled',
    })

    const ownerAbort = new AbortController()
    const aborted = ctx.userInteraction.ask({ questions, agent, signal: ownerAbort.signal })
      .catch((error: unknown) => error)
    const abortRequest = (await stream.next()).value as RpcRequest<MuxFrame>
    ownerAbort.abort()
    await expect(aborted).resolves.toMatchObject({ code: 'ASK_ABORTED' })
    expect(((await stream.next()).value as RpcRequest<MuxFrame>).payload).toMatchObject({
      type: 'question/resolved', questionRpcId: abortRequest.rpcId, outcome: 'cancelled',
    })
    expect(await api.respond({
      type: 'client-response', rpcId: abortRequest.rpcId,
      result: { ok: false, error: { code: 'cancelled', message: 'late', details: {} } },
    })).toEqual({ accepted: false, reason: 'not-pending' })
    streamAbort.abort()
  })

  it('rejects missing routing and pre-abort, then aborts outstanding waits on disposal', async () => {
    const running = await boot()
    const { ctx } = running
    await expect(ctx.userInteraction.ask({ questions })).rejects.toMatchObject({ code: 'ASK_MISSING_AGENT' })
    const { sessionId } = expectOk(await running.api.sessions.create(request({})))
    const agent = ctx.agents.get(sessionId) as Agent
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(ctx.userInteraction.ask({ questions, agent, signal: alreadyAborted.signal }))
      .rejects.toMatchObject({ code: 'ASK_ABORTED' })

    const outstanding = ctx.userInteraction.ask({ questions, agent })
    const disposed = running.dispose()
    host = undefined
    await expect(outstanding).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await disposed
  })
})
