import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmService from '@deepseek-ai/dsh-llm'
import { CredentialsLocal } from '@deepseek-ai/dsh-credentials-local'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SettingsLocal } from '@deepseek-ai/dsh-settings-local'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const NS = settingsNamespace('llm-deepseek')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-dynamic-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

interface Harness {
  ctx: Context
  settingsFiber: { dispose(): Promise<void> }
}

/**
 * Real dynamic composition: llm + settings-local + credentials-local +
 * llm-deepseek over one temp harness home. Settings updates use their owning
 * write path; credentials are edited externally and read on demand.
 */
async function boot(dir: string, config: object): Promise<Harness> {
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmService)
  const settingsFiber = ctx.plugin(SettingsLocal, { path: join(dir, 'settings.yaml'), watch: false })
  await settingsFiber
  await ctx.plugin(CredentialsLocal, { path: join(dir, '.env') })
  await ctx.plugin(LlmDeepSeek, config)
  return { ctx, settingsFiber }
}

function prompt(ctx: Context) {
  return assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
}

describe('request-level dynamic configuration', () => {
  it('routes the next request with the freshly resolved base URL and credential', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.env'), 'DEEPSEEK_API_KEY=first-key\n')
    const serverA = await mockServer([{ kind: 'sse', events: textEvents }])
    const serverB = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx } = await boot(dir, { baseURL: serverA.url })

    await prompt(ctx)
    expect(serverA.headers[0]?.authorization).toBe('Bearer first-key')

    await ctx.settings.update(NS, { baseURL: serverB.url })
    await writeFile(join(dir, '.env'), 'DEEPSEEK_API_KEY=second-key\n')

    await prompt(ctx)
    // No restart, no re-registration: the next request resolved both facts.
    expect(serverA.requests).toHaveLength(1)
    expect(serverB.headers[0]?.authorization).toBe('Bearer second-key')
  })

  it('prefers a literal settings apiKey over the credential layers', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.env'), 'DEEPSEEK_API_KEY=file-key\n')
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx } = await boot(dir, { baseURL: server.url })

    await ctx.settings.update(NS, { apiKey: 'literal-key' })
    await prompt(ctx)
    expect(server.headers[0]?.authorization).toBe('Bearer literal-key')
  })

  it('starts keyless and serves the next request once the key arrives', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await home()
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx } = await boot(dir, { baseURL: server.url })

    await expect(prompt(ctx)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    await writeFile(join(dir, '.env'), 'DEEPSEEK_API_KEY=sk-arrived\n')
    await prompt(ctx)
    expect(server.headers[0]?.authorization).toBe('Bearer sk-arrived')
  })

  it('keeps the model catalog composition-fixed', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, { apiKey: 'k', baseURL: 'http://127.0.0.1:1' })

    await expect(ctx.llm.listModels('deepseek')).resolves.toHaveLength(2)
    await ctx.settings.update(NS, { models: [{ id: 'settings-model', name: 'From Settings' }] })
    await expect(ctx.llm.listModels('deepseek')).resolves.toHaveLength(2)
  })

  it('keeps the registration retry policy composition-fixed', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, {
      apiKey: 'k',
      baseURL: 'http://127.0.0.1:1',
      retryPolicy: {
        mode: 'always',
        backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 },
      },
    })

    await ctx.settings.update(NS, {
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    })
    expect(ctx.llm.providerRetryPolicy('deepseek')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek', name: 'DeepSeek' }])
  })

  it('rejects a settings generation that combines new composition and connection facts', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await home()
    const good = await mockServer([{ kind: 'sse', events: textEvents }])
    const rejected = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx } = await boot(dir, { apiKey: 'good-key', baseURL: good.url })

    // One schema-valid snapshot moves the endpoint and key while also trying
    // to replace the composition-owned catalog.
    await ctx.settings.update(NS, {
      apiKey: 'rejected-key',
      baseURL: rejected.url,
      models: [{ id: 'settings-model' }],
    })

    await prompt(ctx)
    // The rejected generation contributes nothing: not its endpoint, and — the
    // regression this pins — not its key either.
    expect(rejected.requests).toHaveLength(0)
    expect(good.requests).toHaveLength(1)
    expect(good.headers[0]?.authorization).toBe('Bearer good-key')
  })

  it('cannot mix earlier capability facts with a later settings connection', async () => {
    const dir = await home()
    const first = await mockServer([{ kind: 'sse', events: textEvents }])
    const second = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx } = await boot(dir, {
      apiKey: 'first-key',
      baseURL: first.url,
      thinking: 'disabled',
      reasoningEffort: 'off',
    })
    const resolveModel = vi.spyOn(LlmDeepSeek.DeepSeekAdapter.prototype, 'resolveModel')
    resolveModel.mockImplementation(async function (
      this: LlmDeepSeek.DeepSeekAdapter,
      provider,
      model,
      signal,
    ) {
      resolveModel.mockRestore()
      const resolved = await this.resolveModel(provider, model, signal)
      // Land a complete settings generation after capability resolution but
      // before stream dispatch. Its changed composition fact rejects it whole.
      await ctx.settings.update(NS, {
        apiKey: 'second-key',
        baseURL: second.url,
        thinking: 'enabled',
        reasoningEffort: 'max',
      })
      return resolved
    })

    await prompt(ctx)
    expect(second.requests).toHaveLength(0)
    expect(first.headers[0]?.authorization).toBe('Bearer first-key')
    expect(first.requests[0]).toMatchObject({ thinking: { type: 'disabled' } })
  })

  it('falls back to the composition entry when settings detach', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.env'), 'DEEPSEEK_API_KEY=steady-key\n')
    const serverA = await mockServer([{ kind: 'sse', events: textEvents }])
    const serverB = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx, settingsFiber } = await boot(dir, { baseURL: serverA.url })

    await ctx.settings.update(NS, { baseURL: serverB.url })
    await prompt(ctx)
    expect(serverB.requests).toHaveLength(1)

    await settingsFiber.dispose()
    await prompt(ctx)
    expect(serverA.requests).toHaveLength(1)
    expect(serverA.headers[0]?.authorization).toBe('Bearer steady-key')
  })
})
