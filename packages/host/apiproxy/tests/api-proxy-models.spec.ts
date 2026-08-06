/**
 * Web session model-directory and selection behavior: dynamic provider grouping,
 * provider-local catalog failures, logged-target restoration without stale
 * catalog injection, advisory pass-through models, and the prompt-assembly
 * boundary for a running selection change.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmService, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmCallConfig, LlmModelInfo, LlmModelReasoningInfo, LlmProviderInfo,
  LlmResolvedModelInfo, StreamChunk,
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
  ctx.llm.registerAdapter(['deepseek-official'], new CatalogAdapter('DeepSeek', [
    { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { provider: 'deepseek-official', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', description: 'Reasoning model' },
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

describe('Web session model selection', () => {
  it('groups successful providers and leaves an unlisted current target out of the catalog', async () => {
    const { ctx, sessionId } = await harness({
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: ReasoningEffortId('max'),
    })
    const api = createApiProxy(ctx, { provider: 'deepseek-official', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })

    const catalog = expectValue(await api.sessions.models(request({ sessionId })))
    expect(catalog.current).toEqual({
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'max',
    })
    expect(catalog.groups).toEqual([{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: REASONING },
        {
          id: 'deepseek-reasoner',
          name: 'DeepSeek Reasoner',
          description: 'Reasoning model',
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
    const api = createApiProxy(ctx, { provider: 'deepseek-official', model: 'deepseek-chat', cwd: '/tmp', workspaceRoot: '/tmp' })
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
    const signal = new AbortController().signal

    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect((await ctx.systemPrompt.assemble()).variables)
      .toMatchObject({ provider: 'deepseek-official', model: 'deepseek-chat' })

    const selected = expectValue(await api.sessions.selectModel(request({
      sessionId,
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'max',
    })))
    expect(selected.selected).toEqual({
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'max',
    })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toMatchObject({ provider: 'deepseek-official', model: 'deepseek-chat' })

    expect((await ctx.systemPrompt.assemble()).variables)
      .toMatchObject({ provider: 'deepseek-official', model: 'private-preview' })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 1, signal }, () => Promise.resolve(seed),
    )).resolves.toMatchObject({
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'max',
    })

    const unsupported = await api.sessions.selectModel(request({
      sessionId,
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'medium',
    }))
    expect(unsupported.result).toMatchObject({
      ok: false,
      error: {
        code: 'model-unavailable',
        message: 'provider "deepseek-official" model "private-preview" does not support reasoning effort "medium"',
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
      .toEqual({ provider: 'deepseek-official', model: 'private-preview', reasoningEffort: 'max' })
    await ctx.fiber.dispose()
  })
})
