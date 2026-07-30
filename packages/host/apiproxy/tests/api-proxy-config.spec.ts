/**
 * Settings/credentials/llm RPC domains and their host-stream frames over
 * createApiProxy: layered redacted describe, write-path rejection mapping,
 * value-free credential views, the directory/live-route merge, and the three
 * invalidation frames (settings/credentials/models changed).
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import z from 'schemastery'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import LlmService, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Settings, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { Credentials } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type { HostFrame } from '../src/api/index.ts'
import type { RpcRequest, RpcResponse } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const DEFAULTS = { provider: 'p', model: 'm', cwd: '/tmp', workspaceRoot: '/tmp' }

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`req-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function expectErr<T>(response: RpcResponse<T>): { code: string; message: string; details: unknown } {
  expect(response.result.ok).toBe(false)
  if (response.result.ok) throw new Error('unreachable')
  return response.result.error
}

/** In-memory settings provider: the seam base class owns all tested behavior. */
class MemorySettings extends Settings {
  doc: Record<string, unknown>

  constructor(ctx: ConstructorParameters<typeof Settings>[0], options?: { doc?: Record<string, unknown>; readOnly?: boolean }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? {})
    this.readOnly = options?.readOnly ?? false
  }

  private readonly readOnly: boolean

  get writable(): boolean {
    return !this.readOnly
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

/** In-memory credential provider with an env-shadow double for the rejection path. */
class MemoryCredentials extends Credentials {
  private readonly values = new Map<string, string>()

  constructor(ctx: ConstructorParameters<typeof Credentials>[0], options?: { shadowed?: string[] }) {
    super(ctx)
    this.shadowed = new Set(options?.shadowed ?? [])
  }

  private readonly shadowed: Set<string>

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    if (this.shadowed.has(ref)) return Promise.resolve({ value: 'from-env', source: 'env' })
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'file' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (this.shadowed.has(ref)) return Promise.resolve({ configured: true, source: 'env', writable: false })
    const configured = this.values.has(ref)
    return Promise.resolve({ configured, ...configured ? { source: 'file' } : {}, writable: true })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    if (this.shadowed.has(ref)) {
      return Promise.reject(new Error(`credentials: ${ref} is shadowed by the read-only environment`))
    }
    this.values.set(ref, value)
    this.ctx.emit('credentials/updated', ref)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    if (this.shadowed.has(ref)) {
      return Promise.reject(new Error(`credentials: ${ref} is shadowed by the read-only environment`))
    }
    this.values.delete(ref)
    this.ctx.emit('credentials/updated', ref)
    return Promise.resolve()
  }
}

/** Catalog-serving adapter stub for the llm.models path. */
class CatalogAdapter extends LlmAdapter {
  constructor(private readonly name: string, private readonly models: readonly string[]) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.name }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models.map(id => ({ provider, id, name: id })))
  }


  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('not exercised')
  }
}

class BrokenCatalogAdapter extends CatalogAdapter {
  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.reject(new Error('catalog backend down'))
  }
}

const NS = settingsNamespace('llm-deepseek')

const AdapterConfig = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().default('DEEPSEEK_API_KEY'),
  baseURL: z.string(),
})

async function harness(options?: {
  settings?: false | { doc?: Record<string, unknown>; readOnly?: boolean }
  credentials?: false | { shadowed?: string[] }
  /** Skip the directory registration to exercise a namespace the proxy does not expose. */
  configurableProviders?: false
}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(UserInteractionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmService)
  if (options?.settings !== false) await ctx.plugin(MemorySettings, options?.settings)
  if (options?.credentials !== false) await ctx.plugin(MemoryCredentials, options?.credentials)
  // The proxy serves only namespaces a configurable provider addresses, which
  // is what the real LLM plugins declare at load; the tests mirror that.
  if (options?.configurableProviders !== false) {
    ctx.llm.registerConfigurableProviders([
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
    ])
  }
  // Host-stream opener reads the committed-workspace baseline; the stub
  // suffices — the real workspace composition is api-proxy-workspace.spec's.
  ctx.provide('workspace', { list: () => [] } as never)
  return ctx
}

/** Drain `count` host frames matching `types`, then abort the stream. */
async function collectHost(
  api: ReturnType<typeof createApiProxy>,
  types: string[],
  count: number,
  run: () => Promise<void>,
): Promise<HostFrame[]> {
  const abort = new AbortController()
  const frames: HostFrame[] = []
  const stream = api.events.host(request({}), abort.signal)
  const consume = (async () => {
    for await (const frame of stream) {
      if (!types.includes(frame.payload.type)) continue
      frames.push(frame.payload)
      if (frames.length >= count) abort.abort()
    }
  })()
  await run()
  await consume
  return frames
}

describe('settings domain', () => {
  it('reports an actionable error when no settings provider is mounted', async () => {
    const ctx = await harness({ settings: false })
    const api = createApiProxy(ctx, DEFAULTS)
    const error = expectErr(await api.settings.describe(request({})))
    expect(error.code).toBe('internal')
    expect(error.message).toContain('dsh-settings-local')
  })

  it('describes layered redacted namespaces with their secret slots', async () => {
    const ctx = await harness({ settings: { doc: { 'llm-deepseek': { apiKey: 'user-secret', baseURL: 'https://user' } } } })
    ctx.settings.register(NS, AdapterConfig, { base: { baseURL: 'https://base' } })
    const api = createApiProxy(ctx, DEFAULTS)
    const value = expectOk(await api.settings.describe(request({})))
    expect(value.writable).toBe(true)
    expect(value.namespaces).toHaveLength(1)
    const view = value.namespaces[0]!
    expect(view.ns).toBe('llm-deepseek')
    expect(view.applies).toBe('live')
    expect((view.schema as { refs?: unknown }).refs).toBeDefined()
    expect(view.value).toEqual({ apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://user' })
    expect(view.base).toEqual({ baseURL: 'https://base' })
    expect(view.user).toEqual({ baseURL: 'https://user' })
    expect(view.secrets).toEqual([{ path: ['apiKey'], set: true }])
    expect(JSON.stringify(value)).not.toContain('user-secret')
  })

  it('serves only namespaces a registered model provider addresses', async () => {
    // The settings seam is general: any plugin may register a namespace for
    // its own configuration. The Web configuration plane is not — it is the
    // model-provider surface, and a namespace nothing in the provider
    // directory addresses must be invisible and unwritable here, so a future
    // plugin cannot become remotely configurable just by registering.
    const ctx = await harness()
    ctx.settings.register(NS, AdapterConfig)
    ctx.settings.register(settingsNamespace('some-other-plugin'), z.object({ secretPath: z.string() }))
    const api = createApiProxy(ctx, DEFAULTS)

    const value = expectOk(await api.settings.describe(request({})))
    expect(value.namespaces.map(view => view.ns)).toEqual(['llm-deepseek'])

    for (const response of [
      await api.settings.update(request({ ns: 'some-other-plugin', patch: { secretPath: '/etc/shadow' } })),
      await api.settings.replace(request({ ns: 'some-other-plugin', section: {} })),
    ]) {
      const error = expectErr(response)
      expect(error.code).toBe('settings-not-exposed')
      expect(error.details).toEqual({ ns: 'some-other-plugin' })
    }
    // The write never reached the seam.
    expect(ctx.settings.describe().find(d => String(d.ns) === 'some-other-plugin')?.value).toEqual({})
  })

  it('refuses even a model-provider namespace once its directory entry is gone', async () => {
    const ctx = await harness({ configurableProviders: false })
    ctx.settings.register(NS, AdapterConfig)
    const api = createApiProxy(ctx, DEFAULTS)
    expect(expectOk(await api.settings.describe(request({}))).namespaces).toEqual([])
    expect(expectErr(await api.settings.update(request({ ns: 'llm-deepseek', patch: { baseURL: 'https://x' } }))).code)
      .toBe('settings-not-exposed')
  })

  it('invalidates the model catalog when a provider namespace changes, and broadcasts a raw-only change', async () => {
    // Editing `models` changes no route, so llm/adapters-updated never fires
    // and an open model picker kept serving the old catalog. And storing an
    // override equal to the resolved value emits nothing on settings/updated,
    // so another tab never learned the field became overridden.
    const ctx = await harness()
    ctx.settings.register(NS, AdapterConfig, { base: { baseURL: 'https://base' } })
    const api = createApiProxy(ctx, DEFAULTS)
    const frames = await collectHost(api, ['host/settings-changed', 'host/models-changed'], 2, async () => {
      await api.settings.update(request({ ns: 'llm-deepseek', patch: { baseURL: 'https://base' } }))
    })
    expect(frames).toEqual([
      { type: 'host/settings-changed', ns: 'llm-deepseek' },
      { type: 'host/models-changed' },
    ])
    // The resolved value never moved: base already said https://base.
    expect(expectOk(await api.settings.describe(request({}))).namespaces[0]!.value)
      .toEqual({ apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://base' })
  })

  it('maps a stale expectedRevision to settings-conflict carrying both revisions', async () => {
    const ctx = await harness()
    ctx.settings.register(NS, AdapterConfig)
    const api = createApiProxy(ctx, DEFAULTS)
    const opened = expectOk(await api.settings.describe(request({}))).namespaces[0]!.revision
    expect(expectOk(await api.settings.update(request({ ns: 'llm-deepseek', patch: { baseURL: 'https://first' }, expectedRevision: opened })))
      .revision).toBe(opened + 1)
    const error = expectErr(await api.settings.update(request({ ns: 'llm-deepseek', patch: { baseURL: 'https://second' }, expectedRevision: opened })))
    expect(error.code).toBe('settings-conflict')
    expect(error.details).toEqual({ ns: 'llm-deepseek', expected: opened, actual: opened + 1 })
    // The refused write changed nothing.
    expect(expectOk(await api.settings.describe(request({}))).namespaces[0]!.user).toEqual({ baseURL: 'https://first' })
  })

  it('updates the user layer, answers with the new redacted view, and broadcasts the frame', async () => {
    const ctx = await harness()
    ctx.settings.register(NS, AdapterConfig, { base: { baseURL: 'https://base' } })
    const api = createApiProxy(ctx, DEFAULTS)
    const frames = await collectHost(api, ['host/settings-changed'], 1, async () => {
      const view = expectOk(await api.settings.update(request({ ns: 'llm-deepseek', patch: { apiKey: 'sk-new', baseURL: 'https://next' } })))
      expect(view.value).toEqual({ apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://next' })
      expect(view.user).toEqual({ baseURL: 'https://next' })
      expect(view.secrets).toEqual([{ path: ['apiKey'], set: true }])
      expect(JSON.stringify(view)).not.toContain('sk-new')
    })
    expect(frames).toEqual([{ type: 'host/settings-changed', ns: 'llm-deepseek' }])
  })

  it('replace resets the user layer wholesale', async () => {
    const ctx = await harness({ settings: { doc: { 'llm-deepseek': { baseURL: 'https://user' } } } })
    ctx.settings.register(NS, AdapterConfig)
    const api = createApiProxy(ctx, DEFAULTS)
    const view = expectOk(await api.settings.replace(request({ ns: 'llm-deepseek', section: {} })))
    expect(view.value).toEqual({ apiKeyEnv: 'DEEPSEEK_API_KEY' })
    expect(view.user).toEqual({})
  })

  it.each([
    ['an invalid namespace name', 'Not A Namespace', {}],
    ['a schema-invalid patch', 'llm-deepseek', { baseURL: 42 }],
  ])('rejects %s as settings-rejected', async (_case, ns, patch) => {
    const ctx = await harness()
    ctx.settings.register(NS, AdapterConfig)
    const api = createApiProxy(ctx, DEFAULTS)
    const error = expectErr(await api.settings.update(request({ ns, patch })))
    expect(error.code).toBe('settings-rejected')
    expect(error.details).toEqual({ ns })
  })

  it('answers an unregistered namespace exactly like an unexposed one', async () => {
    // Deliberately indistinguishable: separating "does not exist" from
    // "exists but is not yours to configure" would let a caller enumerate the
    // registered namespaces one probe at a time.
    const ctx = await harness()
    ctx.settings.register(NS, AdapterConfig)
    ctx.settings.register(settingsNamespace('some-other-plugin'), z.object({ secretPath: z.string() }))
    const api = createApiProxy(ctx, DEFAULTS)
    const unknown = expectErr(await api.settings.update(request({ ns: 'unknown-ns', patch: {} })))
    const unexposed = expectErr(await api.settings.update(request({ ns: 'some-other-plugin', patch: {} })))
    expect(unknown.code).toBe('settings-not-exposed')
    expect(unexposed.code).toBe(unknown.code)
    expect(unexposed.message.replace('some-other-plugin', 'unknown-ns')).toBe(unknown.message)
  })

  it('maps a read-only provider refusal onto the same rejection', async () => {
    const ctx = await harness({ settings: { readOnly: true } })
    ctx.settings.register(NS, AdapterConfig)
    const api = createApiProxy(ctx, DEFAULTS)
    const value = expectOk(await api.settings.describe(request({})))
    expect(value.writable).toBe(false)
    const error = expectErr(await api.settings.update(request({ ns: 'llm-deepseek', patch: {} })))
    expect(error.code).toBe('settings-rejected')
    expect(error.message).toContain('read-only')
  })
})

describe('credentials domain', () => {
  it('reports an actionable error when no credential provider is mounted', async () => {
    const ctx = await harness({ credentials: false })
    const api = createApiProxy(ctx, DEFAULTS)
    const error = expectErr(await api.credentials.describe(request({ refs: ['A'] })))
    expect(error.code).toBe('internal')
    expect(error.message).toContain('dsh-credentials-local')
  })

  it('describes value-free views and flips state through set/unset with frames', async () => {
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    const before = expectOk(await api.credentials.describe(request({ refs: ['OPENAI_API_KEY'] })))
    expect(before.credentials).toEqual({ OPENAI_API_KEY: { configured: false, writable: true } })
    const frames = await collectHost(api, ['host/credentials-changed'], 2, async () => {
      expectOk(await api.credentials.set(request({ ref: 'OPENAI_API_KEY', value: 'sk-secret' })))
      const after = expectOk(await api.credentials.describe(request({ refs: ['OPENAI_API_KEY'] })))
      expect(after.credentials).toEqual({ OPENAI_API_KEY: { configured: true, source: 'file', writable: true } })
      expect(JSON.stringify(after)).not.toContain('sk-secret')
      expectOk(await api.credentials.unset(request({ ref: 'OPENAI_API_KEY' })))
    })
    expect(frames).toEqual([
      { type: 'host/credentials-changed', ref: 'OPENAI_API_KEY' },
      { type: 'host/credentials-changed', ref: 'OPENAI_API_KEY' },
    ])
  })

  it('maps a shadowed write onto credential-rejected for set and unset alike', async () => {
    const ctx = await harness({ credentials: { shadowed: ['DEEPSEEK_API_KEY'] } })
    const api = createApiProxy(ctx, DEFAULTS)
    const described = expectOk(await api.credentials.describe(request({ refs: ['DEEPSEEK_API_KEY'] })))
    expect(described.credentials['DEEPSEEK_API_KEY']).toEqual({ configured: true, source: 'env', writable: false })
    const setError = expectErr(await api.credentials.set(request({ ref: 'DEEPSEEK_API_KEY', value: 'x' })))
    expect(setError.code).toBe('credential-rejected')
    expect(setError.details).toEqual({ ref: 'DEEPSEEK_API_KEY' })
    const unsetError = expectErr(await api.credentials.unset(request({ ref: 'DEEPSEEK_API_KEY' })))
    expect(unsetError.code).toBe('credential-rejected')
  })
})

describe('llm domain', () => {
  it('merges the configurable directory with live routes and appends undeclared ones', async () => {
    const ctx = await harness({ configurableProviders: false })
    ctx.llm.registerConfigurableProviders([
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
    ])
    ctx.llm.registerAdapter(['deepseek-official'], new CatalogAdapter('DeepSeek', ['deepseek-v4-flash']))
    ctx.llm.registerAdapter(['undeclared'], new CatalogAdapter('Undeclared', ['u-1']))
    const api = createApiProxy(ctx, DEFAULTS)
    const value = expectOk(await api.llm.providers(request({})))
    expect(value.providers).toEqual([
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
      { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: false },
      { provider: 'undeclared', displayName: 'Undeclared', settingsNs: '', settingsPath: [], active: true },
    ])
  })

  it('serves the host-scoped catalog with per-provider failures contained', async () => {
    const ctx = await harness()
    ctx.llm.registerAdapter(['deepseek-official'], new CatalogAdapter('DeepSeek', ['deepseek-v4-flash', 'deepseek-v4-pro']))
    ctx.llm.registerAdapter(['broken'], new BrokenCatalogAdapter('Broken', []))
    const api = createApiProxy(ctx, DEFAULTS)
    const value = expectOk(await api.llm.models(request({})))
    expect(value.groups).toEqual([{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
        { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' },
      ],
    }])
    expect(value.failures).toEqual([{ id: 'broken', name: 'Broken', message: 'catalog backend down' }])
  })

  it('broadcasts host/models-changed at every topology commit point', async () => {
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    const frames = await collectHost(api, ['host/models-changed'], 2, async () => {
      const dispose = ctx.llm.registerAdapter(['deepseek-official'], new CatalogAdapter('DeepSeek', []))
      dispose()
      return Promise.resolve()
    })
    expect(frames).toEqual([{ type: 'host/models-changed' }, { type: 'host/models-changed' }])
  })
})
