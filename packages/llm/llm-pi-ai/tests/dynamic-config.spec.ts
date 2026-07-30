import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmService from '@deepseek-ai/dsh-llm'
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
  vi.restoreAllMocks()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-dynamic-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Real dynamic composition mirroring the DeepSeek twin's harness. */
async function boot(dir: string, config: LlmPiAi.Config): Promise<Context> {
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LlmService)
  await ctx.plugin(SettingsLocal, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(CredentialsLocal, { path: join(dir, '.env') })
  await ctx.plugin(LlmPiAi, config)
  return ctx
}

describe('request-level dynamic profiles', () => {
  it('uses the next endpoint and credential while keeping the route fixed', async () => {
    vi.stubEnv('PI_DYNAMIC_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.env'), 'PI_DYNAMIC_KEY=pk-one\n')
    const serverA = await mockServer([{ events: textEvents }])
    const serverB = await mockServer([{ events: textEvents }])
    const ctx = await boot(dir, {
      providers: { deepseek: { apiKeyEnv: 'PI_DYNAMIC_KEY', baseURL: serverA.url } },
    })

    await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(serverA.headers[0]?.authorization).toBe('Bearer pk-one')

    await ctx.settings.update(NS, { providers: { deepseek: { baseURL: serverB.url } } })
    await writeFile(join(dir, '.env'), 'PI_DYNAMIC_KEY=pk-two\n')
    await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(serverA.requests).toHaveLength(1)
    expect(serverB.headers[0]?.authorization).toBe('Bearer pk-two')
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
  })

  it('rejects settings-born routes and keeps the composition profile serving', async () => {
    const dir = await home()
    const server = await mockServer([{ events: textEvents }])
    const ctx = await boot(dir, {
      providers: { openai: { apiKey: 'pk', baseURL: `${server.url}/v1` } },
    })

    await ctx.settings.update(NS, {
      providers: { anthropic: { apiKey: 'other' } },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
    await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    expect(server.paths).toEqual(['/v1/responses'])
  })

  it('keeps the registration retry policy composition-fixed', async () => {
    const dir = await home()
    const ctx = await boot(dir, {
      providers: {
        openai: {
          retryPolicy: {
            mode: 'always',
            backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 },
          },
        },
      },
    })

    await ctx.settings.update(NS, {
      providers: { openai: { retryPolicy: { mode: 'normal', maxRetries: 0 } } },
    })
    expect(ctx.llm.providerRetryPolicy('openai')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
  })

  it('cannot mix earlier capability facts with a later settings connection', async () => {
    const dir = await home()
    const first = await mockServer([{ events: textEvents }])
    const second = await mockServer([{ events: textEvents }])
    const ctx = await boot(dir, {
      providers: {
        deepseek: {
          apiKey: 'first-key',
          baseURL: first.url,
          reasoning: 'off',
        },
      },
    })
    const resolveModel = vi.spyOn(LlmPiAi.PiAiAdapter.prototype, 'resolveModel')
    resolveModel.mockImplementation(async function (
      this: LlmPiAi.PiAiAdapter,
      provider,
      model,
      signal,
    ) {
      resolveModel.mockRestore()
      const resolved = await this.resolveModel(provider, model, signal)
      // Land a complete settings generation after capability resolution but
      // before stream dispatch. Its changed reasoning default rejects it whole.
      await ctx.settings.update(NS, {
        providers: {
          deepseek: {
            apiKey: 'second-key',
            baseURL: second.url,
            reasoning: 'max',
          },
        },
      })
      return resolved
    })

    await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(second.requests).toHaveLength(0)
    expect(first.headers[0]?.authorization).toBe('Bearer first-key')
  })
})
