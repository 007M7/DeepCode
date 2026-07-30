/**
 * Web session model-directory and selection behavior: dynamic provider grouping,
 * provider-local catalog failures, logged-target restoration, advisory unlisted
 * models, and the prompt-assembly boundary for a running selection change.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmService, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmCallConfig, LlmModelInfo, LlmModelReasoningInfo, LlmProviderInfo,
  LlmResolvedModelInfo, StreamChunk, UserMessage,
} from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`models-${String(nextRpc++)}`), payload }
}

class CatalogAdapter extends LlmAdapter {
  constructor(
    private readonly name: string,
    private readonly models: readonly LlmModelInfo[] | Error,
    private readonly reasoning?: LlmModelReasoningInfo,
    private readonly exactError?: Error,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.name }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return this.models instanceof Error
      ? Promise.reject(this.models)
      : Promise.resolve(this.models)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (this.exactError !== undefined) return Promise.reject(this.exactError)
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.reasoning === undefined ? {} : { reasoning: this.reasoning },
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Catalog tests never enter provider streaming.
  }
}

const REASONING: LlmModelReasoningInfo = {
  efforts: [
    { id: ReasoningEffortId('off'), name: 'Off' },
    { id: ReasoningEffortId('high'), name: 'High' },
    { id: ReasoningEffortId('max'), name: 'Max' },
  ],
  defaultEffort: ReasoningEffortId('high'),
}

async function harness(logged?: {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
}): Promise<{
  ctx: Context
  agent: Agent
  sessionId: SessionId
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmService)
  await ctx.plugin(UserInteractionService)
  await ctx.plugin(AgentRegistry)
  ctx.llm.registerAdapter(['deepseek'], new CatalogAdapter('DeepSeek', [
    { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { provider: 'deepseek', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', description: 'Reasoning model' },
  ], REASONING))
  ctx.llm.registerAdapter(['broken'], new CatalogAdapter('Broken Provider', new Error('catalog offline')))
  ctx.llm.registerAdapter(['metadata-broken'], new CatalogAdapter('Metadata Broken', [
    { provider: 'metadata-broken', id: 'listed', name: 'Listed' },
  ], undefined, new Error('reasoning metadata offline')))
  ctx.llm.registerAdapter(['empty'], new CatalogAdapter('Empty Provider', []))
  ctx.llm.registerAdapter(['duplicate'], new CatalogAdapter('Duplicate Provider', [
    { provider: 'duplicate', id: 'same', name: 'Same' },
    { provider: 'duplicate', id: 'same', name: 'Same Again' },
  ]))
  const session = ctx.sessions.create()
  if (logged !== undefined) {
    session.append('request/header', { header: { config: logged }, reason: 'initial' })
  }
  const agent = {
    id: session.id,
    session,
    status: 'running',
    ctx,
  } as Agent
  ctx.agents.register(agent)
  return { ctx, agent, sessionId: session.id }
}

function expectValue<T>(response: { result: { ok: true; value: T } | { ok: false } }): T {
  if (!response.result.ok) throw new Error('expected successful response')
  return response.result.value
}

function registerTextOnly(ctx: Context): void {
  ctx.llm.registerAdapter(['text-only'], new class extends CatalogAdapter {
    override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
    }
  }('Text Only', []))
}

describe('Web session model selection', () => {
  it('accepts ordered multi-image prompts and rejects configured batch-limit excess before persistence', async () => {
    const { ctx, agent, sessionId } = await harness()
    let secondValidationStarted!: () => void
    let releaseSecondValidation!: () => void
    const secondStarted = new Promise<void>((resolve) => { secondValidationStarted = resolve })
    const secondReleased = new Promise<void>((resolve) => { releaseSecondValidation = resolve })
    const validateImage = vi.fn(async (input: { data: Uint8Array }): Promise<void> => {
      if (input.data[0] !== 2) return
      secondValidationStarted()
      await secondReleased
    })
    const saveImage = vi.fn((input: { data: Uint8Array; mediaType: 'image/png'; name?: string }) => {
      return Promise.resolve({
        attachmentId: `att-${String(input.data[0])}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
        ...(input.name === undefined ? {} : { name: input.name }),
      })
    })
    const followup = vi.fn((_message: UserMessage): void => {})
    Object.assign(agent, { followup })
    ctx.provide('attachments', {
      imageLimits: { maxImageBytes: 4, maxImagesPerMessage: 2, maxMessageImageBytes: 4, maxImagePixels: 4, mediaTypes: ['image/png'] },
      validateImage,
      saveImage,
    } as never)
    const api = createApiProxy(ctx, { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })
    const first = { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==', name: 'first.png' }
    const second = { type: 'image' as const, mediaType: 'image/png' as const, data: 'Ag==', name: 'second.png' }
    const accepting = api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [first, { type: 'text' as const, text: 'compare' }, second],
    }))
    await secondStarted
    expect(saveImage).not.toHaveBeenCalled()
    releaseSecondValidation()
    const accepted = await accepting
    expect(accepted.result).toMatchObject({ ok: true, value: { accepted: true } })
    expect(validateImage.mock.calls.map(([input]) => [...input.data])).toEqual([[1], [2]])
    expect(saveImage.mock.calls.map(([input]) => [...input.data])).toEqual([[1], [2]])
    expect(followup.mock.calls[0]?.[0].content).toEqual([
      { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'first.png' } },
      { type: 'text', text: 'compare' },
      { type: 'image', attachment: { attachmentId: 'att-2', mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'second.png' } },
    ])

    const tooMany = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [first, second, first],
    }))
    expect(tooMany.result).toMatchObject({
      ok: false, error: { code: 'attachment-error', details: { reason: 'TOO_MANY_IMAGES' } },
    })
    const tooLarge = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [
        { ...first, data: 'AQID' },
        { ...second, data: 'BAUG' },
      ],
    }))
    expect(tooLarge.result).toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'IMAGES_TOO_LARGE' } },
    })
    expect(validateImage).toHaveBeenCalledTimes(2)
    expect(saveImage).toHaveBeenCalledTimes(2)
    expect(followup).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('groups successful providers, isolates failures, and preserves an unlisted current model', async () => {
    const { ctx, sessionId } = await harness({
      provider: 'deepseek',
      model: 'private-preview',
      reasoningEffort: ReasoningEffortId('max'),
    })
    const api = createApiProxy(ctx, { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })

    const catalog = expectValue(await api.sessions.models(request({ sessionId })))
    expect(catalog.current).toEqual({
      provider: 'deepseek',
      model: 'private-preview',
      reasoningEffort: 'max',
    })
    expect(catalog.groups).toEqual([{
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: REASONING },
        {
          id: 'deepseek-reasoner',
          name: 'DeepSeek Reasoner',
          description: 'Reasoning model',
          reasoning: REASONING,
        },
        {
          id: 'private-preview',
          name: 'private-preview',
          unlisted: true,
          reasoning: REASONING,
        },
      ],
    }])
    expect(catalog.failures).toEqual([
      { id: 'broken', name: 'Broken Provider', message: 'catalog offline' },
      { id: 'metadata-broken', name: 'Metadata Broken', message: 'reasoning metadata offline' },
      {
        id: 'duplicate',
        name: 'Duplicate Provider',
        message: 'adapter returned invalid or duplicate model metadata for provider "duplicate"',
      },
    ])
    await ctx.fiber.dispose()
  })

  it('accepts an advisory-unlisted model, rejects an unavailable provider, and switches only after the next assembly', async () => {
    const { ctx, agent, sessionId } = await harness()
    const api = createApiProxy(ctx, { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
    const signal = new AbortController().signal

    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect((await ctx.systemPrompt.assemble()).variables)
      .toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })

    const selected = expectValue(await api.sessions.selectModel(request({
      sessionId,
      provider: 'deepseek',
      model: 'private-preview',
      reasoningEffort: 'max',
    })))
    expect(selected.selected).toEqual({
      provider: 'deepseek',
      model: 'private-preview',
      reasoningEffort: 'max',
    })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', 1, 0, signal, () => Promise.resolve(seed),
    )).resolves.toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })

    expect((await ctx.systemPrompt.assemble()).variables)
      .toMatchObject({ provider: 'deepseek', model: 'private-preview' })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', 1, 1, signal, () => Promise.resolve(seed),
    )).resolves.toMatchObject({
      provider: 'deepseek',
      model: 'private-preview',
      reasoningEffort: 'max',
    })

    const unsupported = await api.sessions.selectModel(request({
      sessionId,
      provider: 'deepseek',
      model: 'private-preview',
      reasoningEffort: 'medium',
    }))
    expect(unsupported.result).toMatchObject({
      ok: false,
      error: {
        code: 'model-unavailable',
        message: 'provider "deepseek" model "private-preview" does not support reasoning effort "medium"',
      },
    })

    const rejected = await api.sessions.selectModel(request({
      sessionId,
      provider: 'missing',
      model: 'model',
    }))
    expect(rejected.result).toEqual({
      ok: false,
      error: {
        code: 'model-unavailable',
        message: 'no adapter registered for provider "missing"',
        details: { provider: 'missing', model: 'model' },
      },
    })
    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek', model: 'private-preview', reasoningEffort: 'max' })
    await ctx.fiber.dispose()
  })

  it('refuses a text-only selection while current derived history carries an image', async () => {
    const { ctx, sessionId, agent } = await harness()
    registerTextOnly(ctx)
    ctx.llm.registerAdapter(['vision'], new class extends CatalogAdapter {
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
      }
    }('Vision', []))
    const api = createApiProxy(ctx, { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })

    // Before any image lands, a text-only selection is legitimate.
    expect(expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'text-only', model: 'plain',
    }))).selected).toEqual({ provider: 'text-only', model: 'plain' })

    agent.session.append('user/message', {
      id: 'msg-image', role: 'user', source: { kind: 'user' },
      content: [{ type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 8, width: 1, height: 1 } }],
    } as never, { surfaceOp: 'append' })

    // The image remains on the current request surface, so a text-only route would fail the next turn.
    const stranded = await api.sessions.selectModel(request({
      sessionId, provider: 'text-only', model: 'plain',
    }))
    expect(stranded.result).toMatchObject({
      ok: false,
      error: { code: 'model-unavailable', message: expect.stringMatching(/history already contains images/) as unknown },
    })

    // Image-capable and modality-unknown routes stay selectable.
    expect(expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'vision', model: 'sees',
    }))).selected).toEqual({ provider: 'vision', model: 'sees' })
    expect(expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'deepseek', model: 'deepseek-chat',
    }))).selected).toEqual({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
    await ctx.fiber.dispose()
  })

  it('keeps a dequeued image pending until publication, then follows the compacted surface', async () => {
    const { ctx, sessionId, agent } = await harness()
    registerTextOnly(ctx)
    const api = createApiProxy(ctx, { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })
    const queued = {
      id: 'q-1', role: 'user', source: { kind: 'user' },
      content: [{ type: 'image', attachment: { attachmentId: 'att-q', mediaType: 'image/png', bytes: 8, width: 1, height: 1 } }],
    } as never
    const queuedItem = { id: 'i-q-1', message: queued, placement: 'queued' } as never
    ctx.emit('agent/inbox/enqueue', agent, queuedItem)
    expect((await api.sessions.selectModel(request({ sessionId, provider: 'text-only', model: 'plain' }))).result.ok).toBe(false)

    // Dequeue precedes the authoritative append, so it cannot open a switch window.
    ctx.emit('agent/inbox/dequeue', agent, queuedItem)
    expect((await api.sessions.selectModel(request({ sessionId, provider: 'text-only', model: 'plain' }))).result.ok).toBe(false)

    const imageEvent = agent.session.append('user/message', queued, { surfaceOp: 'append' })
    expect((await api.sessions.selectModel(request({ sessionId, provider: 'text-only', model: 'plain' }))).result.ok).toBe(false)

    // Publication retires the mirror; once compaction shadows the image, the
    // current model-visible surface no longer requires an image-capable route.
    agent.session.append('user/message', {
      id: 'summary', role: 'user', source: { kind: 'plugin', plugin: 'compact' },
      content: [{ type: 'text', text: 'image summarized' }],
    } as never, {
      surfaceOp: { op: 'replace', start: imageEvent.seq, end: imageEvent.seq },
      sourceEventSeqs: [imageEvent.seq],
    })
    expect(expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'text-only', model: 'plain',
    }))).selected).toEqual({ provider: 'text-only', model: 'plain' })
    await ctx.fiber.dispose()
  })

  it('gates selection on a steering image from enqueue until its event publishes', async () => {
    const { ctx, sessionId, agent } = await harness()
    registerTextOnly(ctx)
    const api = createApiProxy(ctx, { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })
    const steering = {
      id: 's-1', role: 'user', source: { kind: 'user' },
      content: [{ type: 'image', attachment: { attachmentId: 'att-s', mediaType: 'image/png', bytes: 8, width: 1, height: 1 } }],
    } as never
    const steeringItem = { id: 'i-s-1', message: steering, placement: 'steering' } as never
    // A steering carrier never enters the queued mirror, yet the outbox hop
    // between steer() and its append must not open a text-only switch window.
    ctx.emit('agent/inbox/enqueue', agent, steeringItem)
    expect((await api.sessions.selectModel(request({ sessionId, provider: 'text-only', model: 'plain' }))).result.ok).toBe(false)

    ctx.emit('agent/inbox/dequeue', agent, steeringItem)
    expect((await api.sessions.selectModel(request({ sessionId, provider: 'text-only', model: 'plain' }))).result.ok).toBe(false)

    // Publication hands the gate over to the durable surface.
    agent.session.append('steering/message', { turn: 1, message: steering }, { surfaceOp: 'append' })
    expect((await api.sessions.selectModel(request({ sessionId, provider: 'text-only', model: 'plain' }))).result.ok).toBe(false)
    await ctx.fiber.dispose()
  })

  it('re-opens selection when an admission ends idle without publication', async () => {
    const { ctx, sessionId, agent } = await harness()
    registerTextOnly(ctx)
    const api = createApiProxy(ctx, { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })
    const rejected = {
      id: 'r-1', role: 'user', source: { kind: 'user' },
      content: [{ type: 'image', attachment: { attachmentId: 'att-r', mediaType: 'image/png', bytes: 8, width: 1, height: 1 } }],
    } as never
    const rejectedItem = { id: 'i-r-1', message: rejected, placement: 'queued' } as never
    ctx.emit('agent/inbox/enqueue', agent, rejectedItem)
    ctx.emit('agent/inbox/dequeue', agent, rejectedItem)
    expect((await api.sessions.selectModel(request({ sessionId, provider: 'text-only', model: 'plain' }))).result.ok).toBe(false)

    // Idle proves the admission ended without publication; nothing durable
    // requires an image route, so the text-only switch must be accepted again.
    ctx.emit('agent/status', agent, 'idle')
    expect(expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'text-only', model: 'plain',
    }))).selected).toEqual({ provider: 'text-only', model: 'plain' })
    await ctx.fiber.dispose()
  })

  it('rejects a queue edit that injects unadmitted image content', async () => {
    const { ctx, sessionId, agent } = await harness()
    const api = createApiProxy(ctx, { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })
    Object.assign(agent, { updateInbox: () => 'applied' })
    const denied = await api.sessions.updateQueue(request({
      sessionId,
      itemId: 'i-x' as never,
      action: {
        kind: 'edit' as const,
        content: [{ type: 'image', attachment: { attachmentId: 'att-x', mediaType: 'image/png', bytes: 8, width: 1, height: 1 } }] as never,
      },
    }))
    expect(denied.result).toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'QUEUE_EDIT_NON_TEXT' } },
    })
    await ctx.fiber.dispose()
  })

  it('serializes an image save with a concurrent model selection', async () => {
    const { ctx, sessionId, agent } = await harness()
    registerTextOnly(ctx)
    let saveStarted!: () => void
    let releaseSave!: () => void
    const started = new Promise<void>((resolve) => { saveStarted = resolve })
    const released = new Promise<void>((resolve) => { releaseSave = resolve })
    const ref = { attachmentId: 'att-race', mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 }
    ctx.provide('attachments', {
      imageLimits: {
        maxImageBytes: 1,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 1,
        maxImagePixels: 1,
        mediaTypes: ['image/png'],
      },
      validateImage: () => Promise.resolve(),
      saveImage: async () => {
        saveStarted()
        await released
        return ref
      },
    } as never)
    Object.assign(agent, {
      followup(message: UserMessage) {
        ctx.emit('agent/inbox/enqueue', agent, { id: `i-${message.id}`, message, placement: 'queued' } as never)
      },
    })
    const api = createApiProxy(ctx, { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })

    const prompt = api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'AA==' }],
    }))
    await started
    const selection = api.sessions.selectModel(request({ sessionId, provider: 'text-only', model: 'plain' }))
    expect(await Promise.race([
      selection.then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => { setTimeout(() => { resolve('pending') }, 0) }),
    ])).toBe('pending')

    releaseSave()
    expect((await prompt).result.ok).toBe(true)
    expect((await selection).result.ok).toBe(false)
    await ctx.fiber.dispose()
  })

  it('authorizes an attachment read referenced only from wrapped message content', async () => {
    const { ctx, sessionId, agent } = await harness()
    const ref = { attachmentId: 'att-w', mediaType: 'image/png' as const, bytes: 4, width: 1, height: 1 }
    ctx.provide('attachments', {
      readImage: () => Promise.resolve({ ref, data: new Uint8Array([1, 2, 3, 4]) }),
    } as never)
    const api = createApiProxy(ctx, { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })
    // The only reference lives inside an assistant/message wrapper; the
    // authorization walk must follow that durable event shape.
    agent.session.append('assistant/message', {
      turn: 1, step: 0,
      message: { id: 'a-1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'image', attachment: ref }] },
    } as never, { surfaceOp: 'append' })
    const got = await api.sessions.attachment(request({ sessionId, attachmentId: 'att-w' as never }))
    expect(got.result).toMatchObject({ ok: true, value: { attachment: ref } })
    const denied = await api.sessions.attachment(request({ sessionId, attachmentId: 'att-other' as never }))
    expect(denied.result).toMatchObject({ ok: false, error: { details: { reason: 'ATTACHMENT_NOT_REFERENCED' } } })
    await ctx.fiber.dispose()
  })

  it('detects images in wrapped messages and nested tool results on the current surface', async () => {
    const image = { type: 'image', attachment: { attachmentId: 'att-x', mediaType: 'image/png', bytes: 8, width: 1, height: 1 } }
    const cases: { label: string; append: (agent: Agent) => void }[] = [
      {
        label: 'steering message wrapper',
        append: (agent) => {
          agent.session.append('steering/message', {
            turn: 1, message: { id: 'st-1', role: 'user', source: { kind: 'user' }, content: [image] },
          } as never, { surfaceOp: 'append' })
        },
      },
      {
        label: 'nested tool-result content',
        append: (agent) => {
          agent.session.append('user/message', {
            id: 'tr-1', role: 'user', source: { kind: 'tool', callId: 'c1' },
            content: [{ type: 'tool-result', toolCallId: 'c1', content: [image], isError: false }],
          } as never, { surfaceOp: 'append' })
        },
      },
    ]
    for (const { label, append } of cases) {
      const { ctx, sessionId, agent } = await harness()
      registerTextOnly(ctx)
      const api = createApiProxy(ctx, { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })
      append(agent)
      const stranded = await api.sessions.selectModel(request({ sessionId, provider: 'text-only', model: 'plain' }))
      expect(stranded.result.ok, label).toBe(false)
      await ctx.fiber.dispose()
    }
  })
})
