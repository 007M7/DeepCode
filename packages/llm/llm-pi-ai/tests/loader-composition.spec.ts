/**
 * Real-composition guard for a configured pi-ai route through Loader + Include.
 * Settings may change request facts, while the route stays composition-owned.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'
import LlmService from '@deepseek-ai/dsh-llm'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import SettingsLocal from '@deepseek-ai/dsh-settings-local'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

let root: string | undefined
let context: Context | undefined
const NS = settingsNamespace('llm-pi-ai')

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function loadComposition(baseURL: string): Promise<{ ctx: Context; settingsPath: string; envPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-composition-'))
  const settingsPath = join(root, 'settings.yaml')
  const envPath = join(root, '.env')
  await writeFile(settingsPath, '# personal settings\n')
  await writeFile(envPath, 'PI_COMPOSITION_KEY=key-from-store\n')

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: settings',
    "  name: '@deepseek-ai/dsh-settings-local'",
    '  config:',
    `    path: ${JSON.stringify(settingsPath)}`,
    '    debounceMs: 10',
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(envPath)}`,
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      deepseek:',
    '        apiKeyEnv: PI_COMPOSITION_KEY',
    `        baseURL: ${baseURL}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmService],
    ['@deepseek-ai/dsh-settings-local', SettingsLocal],
    ['@deepseek-ai/dsh-credentials-local', CredentialsLocal],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, settingsPath, envPath }
}

describe('llm-pi-ai real composition', () => {
  it('keeps its route while external settings and credential edits reach the next request', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const serverA = await mockServer([{ events: textEvents }])
    const serverB = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath, envPath } = await loadComposition(serverA.url)

    await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(serverA.headers[0]?.authorization).toBe('Bearer key-from-store')

    await writeFile(settingsPath, [
      'llm-pi-ai:',
      '  providers:',
      '    deepseek:',
      `      baseURL: ${serverB.url}`,
      '',
    ].join('\n'))
    await writeFile(envPath, 'PI_COMPOSITION_KEY=rotated-key\n')
    await vi.waitFor(() => {
      expect((ctx.get('settings')!.get(NS) as { providers?: { deepseek?: { baseURL?: string } } })
        .providers?.deepseek?.baseURL).toBe(serverB.url)
    }, { timeout: 5000 })

    await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    expect(serverB.headers[0]?.authorization).toBe('Bearer rotated-key')
  })
})
