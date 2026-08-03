import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { resolveProfiles } from '../src/config.ts'
import { buildProvider } from '../src/provider.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => { await closeMockServers() })

/** A complete hand-declared route: nothing about it exists in pi-ai's catalog. */
function gateway(baseURL: string, overrides: Record<string, unknown> = {}): LlmPiAi.Config {
  return {
    providers: {
      'acme-gateway': {
        apiKey: 'gw-key',
        displayName: 'Acme Gateway',
        api: 'openai-completions',
        baseURL,
        models: [{ id: 'acme-large', name: 'Acme Large', contextWindow: 65_536, maxTokens: 4096 }],
        ...overrides,
      },
    },
  }
}

async function harness(config: LlmPiAi.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(LlmPiAi, config)
  return ctx
}

describe('hand-declared providers', () => {
  it('serves a route pi-ai has never heard of from its own declaration', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(gateway(`${server.url}/v1`))

    const result = await assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-large',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })

    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.paths).toEqual(['/v1/chat/completions'])
    expect(server.headers[0]?.authorization).toBe('Bearer gw-key')
  })

  it('lists and resolves the declared models rather than a catalog', async () => {
    const server = await mockServer([])
    const ctx = await harness(gateway(`${server.url}/v1`))

    expect(await ctx.llm.listModels('acme-gateway')).toEqual([
      { provider: 'acme-gateway', id: 'acme-large', name: 'Acme Large' },
    ])
    const info = await ctx.llm.resolveModelInfo('acme-gateway', 'acme-large')
    expect(info).toMatchObject({
      provider: 'acme-gateway',
      id: 'acme-large',
      name: 'Acme Large',
      context: { contextWindow: 65_536 },
      defaultMaxTokens: 4096,
    })
  })

  it('joins the configurable-provider directory so a settings surface can reach it', async () => {
    const server = await mockServer([])
    const ctx = await harness(gateway(`${server.url}/v1`))

    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'acme-gateway',
      displayName: 'Acme Gateway',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'acme-gateway'],
    })
  })

  it('rejects a model whose capacity the catalog cannot supply', () => {
    const declare = (model: LlmPiAi.PiAiModelProfile): (() => unknown) =>
      () => resolveProfiles({ 'acme-gateway': { api: 'openai-completions', baseURL: 'https://acme.test', models: [model] } })

    expect(declare({ id: 'acme-large', maxTokens: 1 })).toThrow(/needs a contextWindow/)
    expect(declare({ id: 'acme-large', contextWindow: 1 })).toThrow(/needs a maxTokens/)
    expect(declare({ id: '', contextWindow: 1, maxTokens: 1 })).toThrow(/empty id/)
    expect(() => resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'dup', contextWindow: 1, maxTokens: 1 }, { id: 'dup', contextWindow: 2, maxTokens: 2 }],
      },
    })).toThrow(/more than once/)
  })

  it('rejects a declaration that names no wire protocol or endpoint', () => {
    expect(() => resolveProfiles({
      'acme-gateway': { baseURL: 'https://acme.test', models: [{ id: 'm', contextWindow: 1, maxTokens: 1 }] },
    })).toThrow(/needs an api/)
    expect(() => resolveProfiles({
      'acme-gateway': { api: 'openai-completions', models: [{ id: 'm', contextWindow: 1, maxTokens: 1 }] },
    })).toThrow(/needs a baseURL/)
  })

  it('rejects a protocol this build cannot serve, and a route that names none', () => {
    const spec = { provider: 'acme-gateway', displayName: 'Acme Gateway', models: [] }
    expect(() => buildProvider({ ...spec, api: 'quantum-telepathy' }))
      .toThrow(/cannot serve; supported protocols are/)
    expect(() => buildProvider(spec)).toThrow(/cannot serve; supported protocols are/)
  })

  it('leaves an unauthenticated route to its protocol rather than inventing a credential', async () => {
    const server = await mockServer([{ events: textEvents }])
    // Naming no credential is the deliberately unauthenticated posture — a
    // named reference that resolved to nothing would have failed with
    // MISSING_CREDENTIAL long before this point. The route resolves as
    // configured and the protocol decides: pi-ai's OpenAI-compatible
    // implementation wants a key or an Authorization header of its own, and
    // says so instead of the harness guessing a placeholder.
    const ctx = await harness({
      providers: {
        'local-llm': {
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          models: [{ id: 'qwen3', contextWindow: 32_768, maxTokens: 2048 }],
        },
      },
    })

    const result = await assemble(ctx, { provider: 'local-llm', model: 'qwen3', messages: [] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { message: 'No API key for provider: local-llm' },
    })
    expect(server.requests).toHaveLength(0)
  })

  it('authenticates an unauthenticated route through a configured header', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness({
      providers: {
        'local-llm': {
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          headers: { Authorization: 'Bearer local' },
          models: [{ id: 'qwen3', contextWindow: 32_768, maxTokens: 2048 }],
        },
      },
    })

    const result = await assemble(ctx, { provider: 'local-llm', model: 'qwen3', messages: [] })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.headers[0]?.authorization).toBe('Bearer local')
  })

  it('rejects a capacity that is not a positive integer', () => {
    const declare = (model: LlmPiAi.PiAiModelProfile): (() => unknown) =>
      () => resolveProfiles({ 'acme-gateway': { api: 'openai-completions', baseURL: 'https://acme.test', models: [model] } })

    expect(declare({ id: 'm', contextWindow: 0, maxTokens: 1 })).toThrow(/contextWindow must be a positive integer/)
    expect(declare({ id: 'm', contextWindow: 1.5, maxTokens: 1 })).toThrow(/contextWindow must be a positive integer/)
    expect(declare({ id: 'm', contextWindow: 1, maxTokens: 0 })).toThrow(/maxTokens must be a positive integer/)
    expect(declare({ id: 'm', contextWindow: 1, maxTokens: 1.5 })).toThrow(/maxTokens must be a positive integer/)
  })

  it('names the route key when no displayName is configured', () => {
    const resolved = resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm', contextWindow: 1, maxTokens: 1 }],
      },
    })
    expect(resolved.get('acme-gateway')?.displayName).toBe('acme-gateway')
    expect(() => resolveProfiles({ 'acme-gateway': { displayName: '' } })).toThrow(/empty displayName/)
  })
})

describe('catalog routes with per-model configuration', () => {
  it('serves the installed catalog untouched when the profile lists no models', async () => {
    const server = await mockServer([])
    const ctx = await harness({ providers: { deepseek: { apiKey: 'k', baseURL: server.url } } })

    const listed = await ctx.llm.listModels('deepseek')
    expect(listed.map(model => model.id).sort())
      .toEqual(getBuiltinModels('deepseek').map(model => model.id).sort())
  })

  it('overrides one catalog model field and defaults the rest from the catalog', async () => {
    const server = await mockServer([])
    const [catalogModel] = getBuiltinModels('deepseek')
    if (catalogModel === undefined) throw new Error('the installed catalog ships no deepseek model')
    const ctx = await harness({
      providers: {
        deepseek: {
          apiKey: 'k',
          baseURL: server.url,
          models: [{ id: catalogModel.id, contextWindow: 4096 }],
        },
      },
    })

    const info = await ctx.llm.resolveModelInfo('deepseek', catalogModel.id)
    // The configured field wins; name and output cap still come from the catalog.
    expect(info.context).toEqual({ contextWindow: 4096 })
    expect(info.name).toBe(catalogModel.name)
    expect(info.defaultMaxTokens).toBe(catalogModel.maxTokens)
    // An explicit list replaces the catalog rather than adding to it.
    expect((await ctx.llm.listModels('deepseek')).map(model => model.id)).toEqual([catalogModel.id])
  })

  it('adds a model the installed catalog does not describe to a catalog route', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness({
      providers: {
        deepseek: {
          apiKey: 'k',
          baseURL: `${server.url}/v1`,
          models: [{ id: 'deepseek-preview', contextWindow: 200_000, maxTokens: 8192 }],
        },
      },
    })

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-preview', messages: [] })
    expect(result.finish).toEqual({ kind: 'stop' })
    // The catalog route keeps its catalog protocol, so the new model reaches
    // the same endpoint shape the shipped models use.
    expect(server.paths).toEqual(['/v1/chat/completions'])
  })

  it('fails an unconfigured model id before any provider request', async () => {
    const server = await mockServer([])
    const ctx = await harness({
      providers: {
        deepseek: { apiKey: 'k', baseURL: server.url, models: [{ id: 'deepseek-preview', contextWindow: 1, maxTokens: 1 }] },
      },
    })

    await expect(assemble(ctx, { provider: 'deepseek', model: 'not-configured', messages: [] }))
      .rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    expect(server.requests).toHaveLength(0)
  })

  it('preserves catalog-only model metadata the profile cannot express', () => {
    // Some catalog models carry provider-required request headers; overriding a
    // capacity must not drop them, because configuration has no way to restate
    // them.
    const headered = (getBuiltinModels('nvidia') as { id: string; headers?: unknown }[])
      .find(model => model.headers !== undefined)
    if (headered === undefined) throw new Error('the installed catalog ships no nvidia model with headers')

    const resolved = resolveProfiles({
      nvidia: { models: [{ id: headered.id, contextWindow: 4096 }] },
    })
    const [model] = resolved.get('nvidia')?.piProvider.getModels() ?? []
    expect(model?.headers).toEqual(headered.headers)
    expect(model?.contextWindow).toBe(4096)
  })

  it('keeps each model its own endpoint when the catalog route declares none', () => {
    // `opencode` ships no provider-level endpoint: the address lives on every
    // catalog model, so the route resolves without any configured baseURL.
    const resolved = resolveProfiles({ opencode: {} })
    const models = resolved.get('opencode')?.piProvider.getModels() ?? []
    expect(models.length).toBeGreaterThan(0)
    expect(models.every(model => model.baseUrl.length > 0)).toBe(true)
    expect(resolved.get('opencode')?.piProvider.baseUrl).toBeUndefined()
  })

  it('repoints a catalog route at another wire protocol without restating its endpoint', () => {
    const resolved = resolveProfiles({ openai: { api: 'openai-completions' } })
    const models = resolved.get('openai')?.piProvider.getModels() ?? []
    // The protocol changes for the whole route; each model keeps the catalog
    // endpoint it already had.
    expect(models.every(model => model.api === 'openai-completions')).toBe(true)
    expect(models.every(model => model.baseUrl === 'https://api.openai.com/v1')).toBe(true)
  })

  it('repoints a catalog route at another wire protocol', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness({
      providers: {
        // openai's catalog models speak the Responses API; naming the protocol
        // explicitly moves the whole route onto Chat Completions.
        openai: {
          apiKey: 'k',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          models: [{ id: 'gpt-4.1', contextWindow: 100_000, maxTokens: 4096 }],
        },
      },
    })

    await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    expect(server.paths).toEqual(['/v1/chat/completions'])
  })
})
