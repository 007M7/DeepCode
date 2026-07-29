import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmService from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CredentialsLocal } from '@deepseek-ai/dsh-credentials-local'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SettingsLocal } from '@deepseek-ai/dsh-settings-local'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const NS = settingsNamespace('llm-pi-ai')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-dynamic-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Real dynamic composition mirroring the deepseek twin's harness. */
async function boot(dir: string, config: LlmPiAi.Config): Promise<Context> {
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmService)
  await ctx.plugin(SettingsLocal, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(CredentialsLocal, { path: join(dir, '.env'), watch: false })
  await ctx.plugin(LlmPiAi, config)
  return ctx
}

describe('request-level dynamic profiles', () => {
  it('mounts bare and dormant, then registers routes the moment settings supply providers', async () => {
    vi.stubEnv('PI_DYNAMIC_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.env'), 'PI_DYNAMIC_KEY=pk-from-settings\n')
    const server = await mockServer([{ events: textEvents }])
    // The exact product posture: `- id: llm-pi-ai` with no config at all.
    const ctx = await boot(dir, {})

    expect(ctx.llm.listProviders()).toEqual([])
    await ctx.settings.update(NS, {
      providers: { deepseek: { apiKeyEnv: 'PI_DYNAMIC_KEY', baseURL: server.url } },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    await expect(ctx.llm.listModels('deepseek')).resolves.not.toHaveLength(0)

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer pk-from-settings')

    // Emptying the user layer returns the adapter to its dormant state.
    await ctx.settings.replace(NS, {})
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('adds a provider route from settings and drops it when the user layer resets', async () => {
    const dir = await home()
    const server = await mockServer([{ events: textEvents }])
    const ctx = await boot(dir, {
      providers: { openai: { apiKey: 'k', baseURL: 'http://127.0.0.1:1/v1' } },
    })

    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
    await ctx.settings.update(NS, {
      providers: { deepseek: { apiKey: 'live-key', baseURL: server.url } },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai', 'deepseek'])

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer live-key')

    // Reset the user layer: the settings-born route unregisters, the
    // composition route stays.
    await ctx.settings.replace(NS, {})
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
    await expect(assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] }))
      .rejects.toMatchObject({ code: 'NO_ADAPTER' })
  })

  it('rotates the per-request credential referenced by apiKeyEnv', async () => {
    vi.stubEnv('PI_DYNAMIC_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.env'), 'PI_DYNAMIC_KEY=pk-one\n')
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = await boot(dir, {
      providers: { deepseek: { apiKeyEnv: 'PI_DYNAMIC_KEY', baseURL: server.url } },
    })

    await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer pk-one')

    await ctx.credentials.set(credentialRef('PI_DYNAMIC_KEY'), 'pk-two')
    await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[1]?.authorization).toBe('Bearer pk-two')
  })

  it('re-registers routes in place when a captured retry policy changes', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {} } })

    await ctx.settings.update(NS, {
      providers: {
        openai: {
          retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
        },
      },
    })
    expect(ctx.llm.providerRetryPolicy('openai')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
  })

  it('keeps the last good profiles when a settings snapshot names an unknown provider', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {} } })

    // Schema-valid but catalog-invalid: the resolver rejects it and the
    // last good route set keeps serving.
    await ctx.settings.update(NS, { providers: { 'not-a-real-provider': {} } })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
  })
})
