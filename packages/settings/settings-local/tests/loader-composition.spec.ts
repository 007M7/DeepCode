/**
 * Real-composition guard: the provider and a consumer plugin boot from a
 * test-only cordis.yml through the actual Loader + Include path, and an
 * external edit of settings.yaml hot-publishes into the consumer's scope.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'
import z from 'schemastery'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import SettingsLocal from '../src/index.ts'

interface ThemeConfig {
  theme: 'dark' | 'light'
  fontSize: number
}

const ThemeSchema: z<ThemeConfig> = z.object({
  theme: z.union(['dark', 'light']).default('dark'),
  fontSize: z.number().default(14),
})

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

interface ConsumerState {
  scope: SettingsScope<ThemeConfig> | undefined
  seen: ThemeConfig[]
}

async function loadComposition(): Promise<{ ctx: Context; state: ConsumerState; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-settings-composition-'))
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, 'ui-theme:\n  theme: light\n')

  const state: ConsumerState = { scope: undefined, seen: [] }
  const consumer = {
    name: 'settings-consumer',
    inject: ['settings'],
    apply: (ctx: Context) => {
      const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema, {
        base: { fontSize: 16 },
      })
      state.scope = scope
      scope.watch((next) => { state.seen.push(next) })
    },
  }

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: settings',
    "  name: '@deepseek-ai/dsh-settings-local'",
    '  config:',
    `    path: ${JSON.stringify(settingsPath)}`,
    '    debounceMs: 10',
    '- id: consumer',
    '  name: test-settings-consumer',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-settings-local', SettingsLocal],
    ['test-settings-consumer', consumer],
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
  return { ctx, state, settingsPath }
}

describe('settings-local real composition', () => {
  it('boots from cordis.yml and hot-publishes an external settings edit', async () => {
    const { ctx, state, settingsPath } = await loadComposition()

    // Composition resolution: user layer over the consumer's composition base.
    expect(state.scope!.get()).toEqual({ theme: 'light', fontSize: 16 })
    expect(ctx.get('settings')!.describe().map(entry => entry.ns)).toEqual(['ui-theme'])

    await writeFile(settingsPath, 'ui-theme:\n  theme: dark\n  fontSize: 20\n')
    await vi.waitFor(() => {
      expect(state.scope!.get()).toEqual({ theme: 'dark', fontSize: 20 })
    }, { timeout: 5000 })
    expect(state.seen.at(-1)).toEqual({ theme: 'dark', fontSize: 20 })
  })
})
