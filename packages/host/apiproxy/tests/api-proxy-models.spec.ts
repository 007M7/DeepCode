/**
 * Web session model-directory and selection behavior: dynamic provider grouping,
 * provider-local catalog failures, logged-target restoration, advisory unlisted
 * models, and the prompt-assembly boundary for a running selection change.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { Fiber } from 'cordis'
import AgentRegistry, { agentEvents, installAgentLlmTarget } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentLlmTargetRef } from '@deepseek-ai/dsh-agent'
import LlmService, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmCallConfig, LlmModelInfo, LlmModelReasoningInfo, LlmProviderInfo,
  LlmResolvedModelInfo, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
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
      context: { contextWindow: model === 'private-preview' ? 128_000 : 64_000 },
      ...this.reasoning === undefined ? {} : { reasoning: this.reasoning },
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Catalog tests never enter provider streaming.
  }
}

class DeferredCatalogAdapter extends CatalogAdapter {
  readonly pending: PromiseWithResolvers<LlmResolvedModelInfo>[] = []

  constructor() {
    super('Deferred', [
      { provider: 'deferred', id: 'lifecycle-model', name: 'Lifecycle model' },
    ])
  }

  override resolveModel(_provider: string, _model: string): Promise<LlmResolvedModelInfo> {
    const result = Promise.withResolvers<LlmResolvedModelInfo>()
    this.pending.push(result)
    return result.promise
  }

  resolve(index: number, contextWindow: number): void {
    const pending = this.pending[index]
    if (pending === undefined) throw new Error(`no pending resolution at index ${String(index)}`)
    pending.resolve({
      provider: 'deferred',
      id: 'lifecycle-model',
      name: 'Lifecycle model',
      context: { contextWindow },
    })
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

async function hostContext(onSessions?: (fiber: Fiber) => void): Promise<Context> {
  const ctx = new Context()
  const sessionsFiber = await ctx.plugin(SessionStore)
  onSessions?.(sessionsFiber)
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
  return ctx
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
  const ctx = await hostContext()
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

async function nextMetrics(
  iterator: AsyncIterator<RpcRequest<MuxFrame>>,
): Promise<Extract<MuxFrame, { type: 'session/metrics' }>['metrics']> {
  for (;;) {
    const next = await iterator.next()
    if (next.done) throw new Error('mux ended before a metrics frame')
    if (next.value.payload.type === 'session/metrics') return next.value.payload.metrics
  }
}

function attachLifecycleSession(
  ctx: Context,
  sessionId: SessionId,
  withMarker = false,
): { session: Session; detach: () => void } {
  const session = ctx.sessions.prepare(sessionId)
  session.append('request/header', {
    header: { config: { provider: 'deferred', model: 'lifecycle-model' } },
    reason: 'initial',
  })
  if (withMarker) {
    session.append('user/message', {
      content: [{ type: 'text', text: 'replacement marker' }],
      source: { kind: 'plugin', plugin: 'test' },
    }, { surfaceOp: 'append' })
  }
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  return { session, detach }
}

function attachLifecycleAgent(
  ctx: Context,
  session: Session,
): () => void {
  const agent = {
    id: session.id,
    session,
    status: 'running',
    ctx,
  } as Agent
  const detach = ctx.agents.enter(agent, undefined)
  ctx.agents.announce(agent)
  return detach
}

function settleCapacityCompletion(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve) })
}

function installDeferredAdapter(
  ctx: Context,
  adapter: DeferredCatalogAdapter,
): Fiber & PromiseLike<Fiber> {
  return ctx.plugin(Object.assign((inner: Context) => {
    inner.llm.registerAdapter(['deferred'], adapter)
  }, { inject: ['llm'] }))
}

describe('Web session model selection', () => {
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

  it('publishes unknown capacity immediately on selection, then the exact selected route capacity', async () => {
    const { ctx, sessionId } = await harness()
    const api = createApiProxy(ctx, { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })
    expectValue(await api.sessions.models(request({ sessionId })))
    const controller = new AbortController()
    const iterator = api.events.mux(request({}), controller.signal)[Symbol.asyncIterator]()

    expect((await nextMetrics(iterator)).contextWindow).toBeUndefined()
    expect((await nextMetrics(iterator)).contextWindow).toBe(64_000)

    expectValue(await api.sessions.selectModel(request({
      sessionId,
      provider: 'deepseek',
      model: 'private-preview',
    })))
    expect((await nextMetrics(iterator)).contextWindow).toBeUndefined()
    expect((await nextMetrics(iterator)).contextWindow).toBe(128_000)

    controller.abort()
    await iterator.return?.()
    await ctx.fiber.dispose()
  })

  it('uses logged capacity without installing Web routing while scheduling foreign metrics', async () => {
    const ctx = await hostContext()
    const api = createApiProxy(ctx, {
      provider: 'deepseek',
      model: 'deepseek-chat',
      cwd: '/tmp',
      workspaceRoot: '/tmp',
    })
    const controller = new AbortController()
    const iterator = api.events.mux(request({}), controller.signal)[Symbol.asyncIterator]()
    const initialMetrics = nextMetrics(iterator)
    const session = ctx.sessions.create()
    expect((await initialMetrics).contextWindow).toBeUndefined()
    session.append('request/header', {
      header: { config: { provider: 'deepseek', model: 'private-preview' } },
      reason: 'change',
    })
    const foreign = {
      id: session.id,
      session,
      status: 'running',
      ctx,
    } as Agent
    const foreignTarget: AgentLlmTargetRef = {
      current: { provider: 'foreign', model: 'foreign-model' },
      assembled: undefined,
    }
    const disposeForeignTarget = installAgentLlmTarget(foreign.ctx, foreignTarget)
    const scheduledMetrics = nextMetrics(iterator)
    ctx.agents.register(foreign)

    expect((await scheduledMetrics).contextWindow).toBeUndefined()
    expect((await nextMetrics(iterator)).contextWindow).toBe(128_000)
    expect((await ctx.systemPrompt.assemble()).variables)
      .toMatchObject({ provider: 'foreign', model: 'foreign-model' })
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
    const signal = new AbortController().signal
    await expect(agentEvents(ctx, foreign).waterfall(
      'agent/request', 1, 0, signal, () => Promise.resolve(seed),
    )).resolves.toMatchObject({ provider: 'foreign', model: 'foreign-model' })

    disposeForeignTarget()
    expect((await ctx.systemPrompt.assemble()).variables).not.toHaveProperty('provider')
    await expect(agentEvents(ctx, foreign).waterfall(
      'agent/request', 1, 1, signal, () => Promise.resolve(seed),
    )).resolves.toBe(seed)

    controller.abort()
    await iterator.return?.()
    await ctx.fiber.dispose()
  })

  it('drops capacity completion from a replaced agent that retains the exact session', async () => {
    const ctx = await hostContext()
    const deferred = new DeferredCatalogAdapter()
    ctx.llm.registerAdapter(['deferred'], deferred)
    const lifecycle = attachLifecycleSession(ctx, SessionId('capacity-agent-lifecycle'))
    const retire = attachLifecycleAgent(ctx, lifecycle.session)
    const api = createApiProxy(ctx, { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })
    const controller = new AbortController()
    const iterator = api.events.mux(request({}), controller.signal)[Symbol.asyncIterator]()

    expect((await nextMetrics(iterator)).contextWindow).toBeUndefined()
    await vi.waitFor(() => { expect(deferred.pending).toHaveLength(1) })
    retire()
    const detachLive = attachLifecycleAgent(ctx, lifecycle.session)
    expect((await nextMetrics(iterator)).contextWindow).toBeUndefined()
    await vi.waitFor(() => { expect(deferred.pending).toHaveLength(2) })

    deferred.resolve(0, 64_000)
    await settleCapacityCompletion()
    deferred.resolve(1, 128_000)
    await settleCapacityCompletion()
    expect((await nextMetrics(iterator)).contextWindow).toBe(128_000)

    controller.abort()
    await iterator.return?.()
    detachLive()
    lifecycle.detach()
    await ctx.fiber.dispose()
  })

  it('drops capacity completion from a replaced session while its old agent remains live', async () => {
    const ctx = await hostContext()
    const deferred = new DeferredCatalogAdapter()
    ctx.llm.registerAdapter(['deferred'], deferred)
    const sessionId = SessionId('capacity-session-lifecycle')
    const retiredSession = attachLifecycleSession(ctx, sessionId)
    const retireAgent = attachLifecycleAgent(ctx, retiredSession.session)
    const api = createApiProxy(ctx, { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })
    const controller = new AbortController()
    const iterator = api.events.mux(request({}), controller.signal)[Symbol.asyncIterator]()

    expect((await nextMetrics(iterator)).contextWindow).toBeUndefined()
    await vi.waitFor(() => { expect(deferred.pending).toHaveLength(1) })
    retiredSession.detach()
    const liveSession = attachLifecycleSession(ctx, sessionId, true)
    expect((await nextMetrics(iterator)).contextWindow).toBeUndefined()
    deferred.resolve(0, 64_000)
    await settleCapacityCompletion()
    retireAgent()
    const detachLiveAgent = attachLifecycleAgent(ctx, liveSession.session)
    const scheduled = await nextMetrics(iterator)
    expect(scheduled.logRevision).toBe(2)
    expect(scheduled.contextWindow).toBeUndefined()
    await vi.waitFor(() => { expect(deferred.pending).toHaveLength(2) })
    deferred.resolve(1, 128_000)
    await settleCapacityCompletion()
    expect((await nextMetrics(iterator)).contextWindow).toBe(128_000)

    controller.abort()
    await iterator.return?.()
    detachLiveAgent()
    liveSession.detach()
    await ctx.fiber.dispose()
  })

  it('does not project retired agent capacity into replacement session snapshots', async () => {
    const ctx = await hostContext()
    const deferred = new DeferredCatalogAdapter()
    ctx.llm.registerAdapter(['deferred'], deferred)
    const sessionId = SessionId('capacity-snapshot-lifecycle')
    const retiredSession = attachLifecycleSession(ctx, sessionId)
    const retireAgent = attachLifecycleAgent(ctx, retiredSession.session)
    const api = createApiProxy(ctx, { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })
    const primaryController = new AbortController()
    const primary = api.events.mux(request({}), primaryController.signal)[Symbol.asyncIterator]()

    expect((await nextMetrics(primary)).contextWindow).toBeUndefined()
    await vi.waitFor(() => { expect(deferred.pending).toHaveLength(1) })
    deferred.resolve(0, 64_000)
    await settleCapacityCompletion()
    expect((await nextMetrics(primary)).contextWindow).toBe(64_000)

    retiredSession.detach()
    const replacement = attachLifecycleSession(ctx, sessionId)
    const createdBaseline = await nextMetrics(primary)
    replacement.session.append('user/message', {
      content: [{ type: 'text', text: 'replacement marker' }],
      source: { kind: 'plugin', plugin: 'test' },
    }, { surfaceOp: 'append' })
    const scheduledFlush = await nextMetrics(primary)
    const reconnectController = new AbortController()
    const reconnect = api.events.mux(request({}), reconnectController.signal)[Symbol.asyncIterator]()
    const reconnectBaseline = await nextMetrics(reconnect)
    expect(createdBaseline.logRevision).toBe(1)
    for (const metrics of [scheduledFlush, reconnectBaseline]) {
      expect(metrics.logRevision).toBe(2)
    }
    expect({
      created: createdBaseline.contextWindow,
      scheduled: scheduledFlush.contextWindow,
      reconnect: reconnectBaseline.contextWindow,
    }).toEqual({ created: undefined, scheduled: undefined, reconnect: undefined })

    retireAgent()
    const detachReplacementAgent = attachLifecycleAgent(ctx, replacement.session)
    expect((await nextMetrics(primary)).contextWindow).toBeUndefined()
    await vi.waitFor(() => { expect(deferred.pending).toHaveLength(2) })
    deferred.resolve(1, 128_000)
    await settleCapacityCompletion()
    expect((await nextMetrics(primary)).contextWindow).toBe(128_000)

    primaryController.abort()
    reconnectController.abort()
    await primary.return?.()
    await reconnect.return?.()
    detachReplacementAgent()
    replacement.detach()
    await ctx.fiber.dispose()
  })

  it('refreshes same-route capacity after adapter owner replacement', async () => {
    const ctx = await hostContext()
    const retiredAdapter = new DeferredCatalogAdapter()
    const retiredFiber = await installDeferredAdapter(ctx, retiredAdapter)
    const lifecycle = attachLifecycleSession(ctx, SessionId('capacity-adapter-lifecycle'))
    const detachAgent = attachLifecycleAgent(ctx, lifecycle.session)
    const api = createApiProxy(ctx, { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })
    const controller = new AbortController()
    const iterator = api.events.mux(request({}), controller.signal)[Symbol.asyncIterator]()

    expect((await nextMetrics(iterator)).contextWindow).toBeUndefined()
    await vi.waitFor(() => { expect(retiredAdapter.pending).toHaveLength(1) })
    retiredAdapter.resolve(0, 64_000)
    await settleCapacityCompletion()
    expect((await nextMetrics(iterator)).contextWindow).toBe(64_000)

    await retiredFiber.dispose()
    expect((await nextMetrics(iterator)).contextWindow).toBeUndefined()
    const replacementAdapter = new DeferredCatalogAdapter()
    const replacementFiber = await installDeferredAdapter(ctx, replacementAdapter)
    expect((await nextMetrics(iterator)).contextWindow).toBeUndefined()
    await vi.waitFor(() => { expect(replacementAdapter.pending).toHaveLength(1) })
    replacementAdapter.resolve(0, 128_000)
    await settleCapacityCompletion()
    expect((await nextMetrics(iterator)).contextWindow).toBe(128_000)
    expect(lifecycle.session.requestHeader()?.config).toMatchObject({
      provider: 'deferred',
      model: 'lifecycle-model',
    })

    controller.abort()
    await iterator.return?.()
    detachAgent()
    lifecycle.detach()
    await replacementFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('does not read the sessions service after its disposal status', async () => {
    let sessionsFiber: Fiber | undefined
    const ctx = await hostContext((fiber) => { sessionsFiber = fiber })
    if (sessionsFiber === undefined) throw new Error('sessions fiber missing')
    createApiProxy(ctx, { provider: 'deepseek', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })
    const sessions = ctx.get('sessions')
    if (sessions === undefined) throw new Error('sessions service missing')
    const list = vi.spyOn(sessions, 'list').mockImplementation(() => {
      throw new Error('disposed sessions service read')
    })

    await expect(sessionsFiber.dispose()).resolves.toBeUndefined()
    expect(list).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
