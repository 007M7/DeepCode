/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver row plus the adaptive chooser, and the
 * assertions observe the durable outcome — which backend entry the chooser
 * mounted into the Loader store, the capability the seam then serves, and
 * that disposing the chooser removes the mounted entry again (HMR safety).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import type { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'
import BrowseDirectoryPicker from '@deepseek-ai/dsh-host-directory-picker-browse'
import NativeDirectoryPicker from '@deepseek-ai/dsh-host-directory-picker-native'
import * as DirectoryPickerAuto from '../src/index.ts'

const AUTO = '@deepseek-ai/dsh-host-directory-picker-auto'
const NATIVE = '@deepseek-ai/dsh-host-directory-picker-native'
const BROWSE = '@deepseek-ai/dsh-host-directory-picker-browse'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a dist fixture and a two-row cordis.yml (webserver + chooser), then boot it through the real Loader. */
async function loadComposition(bindHost: '127.0.0.1' | '0.0.0.0'): Promise<{ ctx: Context; configPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-directory-picker-auto-'))
  const dist = join(root, 'dist')
  await mkdir(dist)
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<head></head><body>shell</body>')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    `    host: '${bindHost}'`,
    '    port: 0',
    `    distIndex: '${distIndex}'`,
    `- name: '${AUTO}'`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    [AUTO, DirectoryPickerAuto],
    [NATIVE, NativeDirectoryPicker],
    [BROWSE, BrowseDirectoryPicker],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return { ctx: context, configPath }
}

/** Entry names currently present in the loader store (root tree plus subtrees). */
function entryNames(ctx: Context): string[] {
  return [...ctx.loader.entries()].map(entry => entry.options.name)
}

/** Force every signal of an attended host: no SSH launch, a display on any platform. */
function stubAttendedHost(): void {
  vi.stubEnv('SSH_CONNECTION', '')
  vi.stubEnv('SSH_TTY', '')
  vi.stubEnv('DISPLAY', ':0')
}

describe('real Loader composition', () => {
  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution after the host/client program split is slow enough
  // to trip the default 5s budget on cold caches.
  it('mounts the native backend for an attended loopback host and unmounts it on disposal', { timeout: 60_000 }, async () => {
    stubAttendedHost()
    const { ctx, configPath } = await loadComposition('127.0.0.1')

    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(entryNames(ctx)).toContain(NATIVE)
    expect(entryNames(ctx)).not.toContain(BROWSE)
    const picker = ctx.get('directoryPicker') as DirectoryPicker
    expect(picker.capability().kind).toBe('native')
    // The mounted row lives in the Loader's in-memory root tree only — the
    // booted config file must never gain the resolved backend row.
    expect(await readFile(configPath, 'utf8')).not.toContain(NATIVE)

    // HMR safety: disposing the chooser's fiber removes the entry it created.
    const autoEntry = [...ctx.loader.entries()].find(entry => entry.options.name === AUTO)!
    await autoEntry.fiber!.dispose()
    await ctx.loader.await()
    expect(entryNames(ctx)).not.toContain(NATIVE)
    expect(ctx.get('directoryPicker')).toBeUndefined()
  })

  it('mounts the browse backend under an SSH launch', { timeout: 60_000 }, async () => {
    stubAttendedHost()
    vi.stubEnv('SSH_CONNECTION', '10.0.0.2 55 10.0.0.9 22')
    const { ctx } = await loadComposition('127.0.0.1')

    expect(entryNames(ctx)).toContain(BROWSE)
    expect(entryNames(ctx)).not.toContain(NATIVE)
    const picker = ctx.get('directoryPicker') as DirectoryPicker
    expect(picker.capability().kind).toBe('browse')
  })

  it('mounts the browse backend for an all-interfaces bind even on an attended host', { timeout: 60_000 }, async () => {
    stubAttendedHost()
    const { ctx } = await loadComposition('0.0.0.0')

    expect(entryNames(ctx)).toContain(BROWSE)
    expect(entryNames(ctx)).not.toContain(NATIVE)
  })
})
