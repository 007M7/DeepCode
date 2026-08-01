/**
 * Personal-config behavior of `dsh-app-boot`: the Harness home (`~/.dsh`)
 * `config.yaml` overlay loader and `boot()` applying the personal overlay over
 * a real Loader tree.
 */

import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Hmr from '@cordisjs/plugin-hmr'
import Loader from '@cordisjs/plugin-loader'
import Timer from '@cordisjs/plugin-timer'
import {
  boot,
  loadPersonalPatches,
  PERSONAL_CONFIG_FILENAME,
  watchPersonalPatches,
} from '../src/index.ts'

const NAME = 'dsh-test-bin'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-personal-config-'))

async function eventually(test: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!test()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const settleChokidarChangeThrottle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 75))

describe('loadPersonalPatches', () => {
  afterEach(() => {
    delete process.env.DSH_HOME
  })

  it('returns undefined when no personal patches file exists', () => {
    expect(loadPersonalPatches(NAME, tmp())).toBeUndefined()
  })

  it('parses a patch list and preserves !!js expressions as loader expression nodes', () => {
    const dir = tmp()
    writeFileSync(join(dir, PERSONAL_CONFIG_FILENAME), [
      '- id: tui-agent',
      "  name: '@deepseek-ai/dsh-tui-demo'",
      '  config:',
      '    model: !!js process.env.DSH_SPEC_MODEL',
      '- insert:',
      '    - id: llm',
      "      name: '@deepseek-ai/dsh-llm-pi-ai'",
      '',
    ].join('\n'))
    const patches = loadPersonalPatches(NAME, dir)
    expect(patches).toHaveLength(2)
    expect(patches?.[0]).toMatchObject({
      id: 'tui-agent',
      config: { model: { __jsExpr: 'process.env.DSH_SPEC_MODEL' } },
    })
    expect(patches?.[1]?.insert).toHaveLength(1)
  })

  it('defaults its directory to the Harness home ($DSH_HOME)', () => {
    const dir = tmp()
    writeFileSync(join(dir, PERSONAL_CONFIG_FILENAME), '- id: x\n  config:\n    a: 1\n')
    process.env.DSH_HOME = dir
    expect(loadPersonalPatches(NAME)).toHaveLength(1)
  })

  it('fails loud on an unreadable file (a present personal config is never skipped)', () => {
    const dir = tmp()
    mkdirSync(join(dir, PERSONAL_CONFIG_FILENAME)) // a directory: present, unreadable as a file
    expect(() => loadPersonalPatches(NAME, dir))
      .toThrow(new RegExp(`^${NAME}: failed to read personal patches `))
  })

  it('fails loud on unparsable YAML and on a !!js tag with no expression body', () => {
    const dir = tmp()
    writeFileSync(join(dir, PERSONAL_CONFIG_FILENAME), 'invalid: [unclosed\n')
    expect(() => loadPersonalPatches(NAME, dir))
      .toThrow(new RegExp(`^${NAME}: failed to parse personal patches `))
    writeFileSync(join(dir, PERSONAL_CONFIG_FILENAME), '- id: x\n  config:\n    a: !!js\n')
    expect(() => loadPersonalPatches(NAME, dir))
      .toThrow(new RegExp(`^${NAME}: failed to parse personal patches `))
  })

  it('fails loud when the file is not a top-level array or an entry is not an object', () => {
    const dir = tmp()
    writeFileSync(join(dir, PERSONAL_CONFIG_FILENAME), 'id: not-a-list\n')
    expect(() => loadPersonalPatches(NAME, dir))
      .toThrow('must be a top-level YAML array of loader patch entries')
    writeFileSync(join(dir, PERSONAL_CONFIG_FILENAME), '- just-a-string\n')
    expect(() => loadPersonalPatches(NAME, dir))
      .toThrow(`${NAME}: personal patches entry 1 in`)
  })
})

describe('boot with personal patches', () => {
  function writeTree(dir: string): string {
    writeFileSync(join(dir, 'noop.mjs'), [
      'export const name = "noop"',
      'export function apply(_ctx, config = {}) {',
      '  if (config.fail) throw new Error("candidate config failed")',
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'cordis.yml'), '- id: noop\n  name: ./noop.mjs\n  config:\n    value: base\n')
    return join(dir, 'cordis.yml')
  }

  function entryConfig(ctx: Context, id: string): unknown {
    return [...ctx.loader.entries()].find(entry => entry.options.id === id)?.options.config
  }

  it('applies id-targeted overrides, inserts, and interpolates !!js from the environment', async () => {
    const dir = tmp()
    const personal = tmp()
    writeFileSync(join(personal, PERSONAL_CONFIG_FILENAME), [
      '- id: noop',
      '  name: ./noop.mjs',
      '  config:',
      '    value: !!js process.env.DSH_APP_BOOT_PERSONAL_SPEC',
      '- insert:',
      '    - id: personal-extra',
      '      name: ./noop.mjs',
      '',
    ].join('\n'))
    process.env['DSH_APP_BOOT_PERSONAL_SPEC'] = 'personal-value'
    const ctx = await boot(NAME, writeTree(dir), loadPersonalPatches(NAME, personal))
    try {
      const noop = [...ctx.loader.entries()].find(entry => entry.options.id === 'noop')
      // The mounted plugin received the interpolated environment value.
      expect(noop?.fiber?.config).toEqual({ value: 'personal-value' })
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'personal-extra')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      delete process.env['DSH_APP_BOOT_PERSONAL_SPEC']
    }
  })

  it('mounts no patch layer for an absent or empty personal overlay', async () => {
    const dir = tmp()
    const ctx = await boot(NAME, writeTree(dir), loadPersonalPatches(NAME, tmp()))
    try {
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'base' })
    } finally {
      await ctx.fiber.dispose()
    }
    const empty = tmp()
    writeFileSync(join(empty, PERSONAL_CONFIG_FILENAME), '[]\n')
    const ctxEmpty = await boot(NAME, writeTree(tmp()), loadPersonalPatches(NAME, empty))
    try {
      expect(entryConfig(ctxEmpty, 'noop')).toEqual({ value: 'base' })
    } finally {
      await ctxEmpty.fiber.dispose()
    }
  })

  it('watches add, failure, recovery, and removal through transactional HMR', { timeout: 20_000 }, async () => {
    const dir = tmp()
    const personal = tmp()
    const filename = join(personal, PERSONAL_CONFIG_FILENAME)
    const basePatches = [{ id: 'noop', config: { value: 'generated' } }]
    const ctx = await boot(NAME, writeTree(dir), basePatches)
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    const failures: Array<{ filename: string; error: Error }> = []
    ctx.on('hmr/config-update-failed', (failedFilename, error) => {
      failures.push({ filename: failedFilename, error })
    })
    const dispose = await watchPersonalPatches(ctx, {
      binName: NAME,
      dir: personal,
      compose: personalPatches => [...basePatches, ...personalPatches],
    })
    try {
      writeFileSync(filename, '- id: noop\n  config:\n    value: live\n')
      await eventually(() => (entryConfig(ctx, 'noop') as { value?: string }).value === 'live', 'personal config addition was not applied')

      writeFileSync(filename, '- id: noop\n  config:\n    fail: true\n')
      await eventually(() => failures.length === 1, 'failed candidate was not broadcast')
      expect(failures[0]).toMatchObject({ filename })
      expect(failures[0]?.error).toBeInstanceOf(Error)
      expect((entryConfig(ctx, 'noop') as { value?: string }).value).toBe('live')
      await settleChokidarChangeThrottle()

      writeFileSync(filename, 'invalid: [unclosed\n')
      await eventually(() => failures.length === 2, 'parse failure was not broadcast')
      expect(failures[1]?.error).toBeInstanceOf(Error)
      expect((entryConfig(ctx, 'noop') as { value?: string }).value).toBe('live')
      await settleChokidarChangeThrottle()

      writeFileSync(filename, '- id: noop\n  config:\n    value: recovered\n')
      await eventually(() => (entryConfig(ctx, 'noop') as { value?: string }).value === 'recovered', 'valid recovery was not applied')
      await settleChokidarChangeThrottle()

      unlinkSync(filename)
      await eventually(() => (entryConfig(ctx, 'noop') as { value?: string }).value === 'generated', 'personal config removal did not restore the app-owned patch')
      expect(failures).toHaveLength(2)
      await settleChokidarChangeThrottle()

      // Default compose: the personal overlay IS the whole patch list, so a
      // fresh generation replaces the app-owned layer instead of stacking on it.
      await dispose()
      const disposeDefault = await watchPersonalPatches(ctx, { binName: NAME, dir: personal })
      try {
        writeFileSync(filename, '- id: noop\n  config:\n    value: identity\n')
        await eventually(() => (entryConfig(ctx, 'noop') as { value?: string }).value === 'identity', 'default-compose personal patch was not applied')
      } finally {
        await disposeDefault()
      }
    } finally {
      await dispose()
      await ctx.fiber.dispose()
    }
  })

  it('fails loud when the exact watcher lacks HMR or a root Include', async () => {
    const dir = tmp()
    const withoutHmr = await boot(NAME, writeTree(dir))
    await expect(watchPersonalPatches(withoutHmr, { binName: NAME, dir: tmp() })).rejects.toThrow('requires the Cordis HMR service')
    await withoutHmr.fiber.dispose()

    const withoutInclude = new Context()
    withoutInclude.baseUrl = pathToFileURL(`${tmp()}/`).href
    await withoutInclude.plugin(Loader)
    await withoutInclude.plugin(Timer)
    await withoutInclude.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    await expect(watchPersonalPatches(withoutInclude, { binName: NAME, dir: tmp() })).rejects.toThrow('requires the root Include entry')
    await withoutInclude.fiber.dispose()
  })

  it('returns a no-op disposer when the tree is disposed while the watcher opens', async () => {
    // A TUI `/exit` typed during startup disposes the whole tree while
    // registerConfig's effect registration is still in flight (the HMR effect
    // then fails with INACTIVE_EFFECT); the app is exiting exactly as asked,
    // so the watcher must not crash the process. The stub makes the race
    // deterministic — the live-teardown ordering itself is not stageable.
    const dir = tmp()
    const ctx = await boot(NAME, writeTree(dir))
    try {
      const teardown = Object.assign(new Error('cannot create effect on inactive context'), { code: 'INACTIVE_EFFECT' })
      ctx.provide('hmr', { registerConfig: () => Promise.reject(teardown) })
      const dispose = await watchPersonalPatches(ctx, { binName: NAME, dir: tmp() })
      await expect(dispose()).resolves.toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('propagates registration failures other than mid-teardown', async () => {
    const dir = tmp()
    const personal = tmp()
    const ctx = await boot(NAME, writeTree(dir))
    try {
      await ctx.plugin(Timer)
      await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
      const dispose = await watchPersonalPatches(ctx, { binName: NAME, dir: personal })
      // Same personal path registered twice: HMR refuses; not a teardown race.
      await expect(watchPersonalPatches(ctx, { binName: NAME, dir: personal })).rejects.toThrow('already registered')
      await dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
