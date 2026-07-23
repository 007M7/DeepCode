/**
 * Config hot-reload resilience of the booted include tree. `dsh-app-boot`
 * installs a fail-loud unhandled-rejection handler, so a `refresh()` that
 * rethrows a config-file parse error would kill a live app on one bad
 * `cordis.yml` edit (the HMR watcher awaits `refresh()` in an async event
 * callback nobody else catches). These tests pin the vendored
 * `@cordisjs/plugin-include` contract that boot relies on: an invalid file
 * keeps the last good tree, and a valid re-read re-applies overlay patches
 * exactly like the initial load.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import type { Include } from '@cordisjs/plugin-include'
import { boot } from '../src/index.ts'

const NAME = 'dsh-test-bin'

const NOOP_PLUGIN = 'export const name = "noop"\nexport function apply() {}\n'

interface TreeFixture {
  ctx: Context
  dir: string
  include: Include
}

async function bootTree(configBody: string): Promise<TreeFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-config-reload-'))
  writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
  writeFileSync(join(dir, 'cordis.yml'), configBody)
  const ctx = await boot(NAME, join(dir, 'cordis.yml'))
  const entry = [...ctx.loader.entries()].find(candidate => candidate.subtree !== undefined)
  if (entry?.subtree === undefined) throw new Error('booted tree has no include entry')
  return { ctx, dir, include: entry.subtree as Include }
}

function entryConfig(ctx: Context, id: string): unknown {
  return [...ctx.loader.entries()].find(entry => entry.options.id === id)?.options.config
}

describe('include refresh with an invalid file', () => {
  it('keeps the last good tree instead of throwing, then applies the next valid edit', async () => {
    const { ctx, dir, include } = await bootTree('- id: noop\n  name: ./noop.mjs\n  config:\n    value: 1\n')
    try {
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 1 })

      writeFileSync(join(dir, 'cordis.yml'), 'invalid: [unclosed\n')
      await expect(include.refresh()).resolves.toBeUndefined()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 1 })

      // An empty file parses to `undefined` without a YAML error; it must be
      // treated exactly like a parse failure, not crash the entry walk.
      writeFileSync(join(dir, 'cordis.yml'), '')
      await expect(include.refresh()).resolves.toBeUndefined()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 1 })

      writeFileSync(join(dir, 'cordis.yml'), '- id: noop\n  name: ./noop.mjs\n  config:\n    value: 2\n')
      await include.refresh()
      await ctx.loader.await()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 2 })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('include refresh with overlay patches', () => {
  it('re-applies entry patches and inserted entries on every re-read (parity with initial load)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-config-reload-overlay-'))
    writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
    writeFileSync(join(dir, 'base.yml'), '- id: noop\n  name: ./noop.mjs\n  config:\n    value: base\n')
    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: base',
      "  name: 'cordis:include'",
      '  config:',
      '    path: ./base.yml',
      '    patches:',
      '      - id: noop',
      '        name: ./noop.mjs',
      '        config:',
      '          value: patched',
      '      - insert:',
      '          - id: extra',
      '            name: ./noop.mjs',
      '',
    ].join('\n'))
    const ctx = await boot(NAME, join(dir, 'cordis.yml'))
    try {
      const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'base')
      if (entry?.subtree === undefined) throw new Error('overlay tree has no base include entry')
      const include = entry.subtree as Include
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'patched' })
      expect(entryConfig(ctx, 'extra')).toBeUndefined()
      expect([...ctx.loader.entries()].some(candidate => candidate.options.id === 'extra')).toBe(true)

      writeFileSync(join(dir, 'base.yml'), '- id: noop\n  name: ./noop.mjs\n  config:\n    value: edited\n')
      await include.refresh()
      await ctx.loader.await()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'patched' })
      expect([...ctx.loader.entries()].some(candidate => candidate.options.id === 'extra')).toBe(true)

      // Hot-update of the include entry's own config (the `internal/update`
      // path): the new patches must apply now AND stick for later re-reads —
      // the listener vetoes the fiber restart, so it must persist the new
      // config itself or the next refresh() re-applies the old overlay.
      await entry.update({ config: { path: './base.yml', patches: [{ id: 'noop', name: './noop.mjs', config: { value: 'patched-v2' } }] } })
      await ctx.loader.await()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'patched-v2' })
      expect([...ctx.loader.entries()].some(candidate => candidate.options.id === 'extra')).toBe(false)

      writeFileSync(join(dir, 'base.yml'), '- id: noop\n  name: ./noop.mjs\n  config:\n    value: edited-2\n')
      await include.refresh()
      await ctx.loader.await()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'patched-v2' })

      // Removing every patch must revert to the file's own values: patching
      // may not bake earlier patch results into the cached parse.
      await entry.update({ config: { path: './base.yml', patches: [] } })
      await ctx.loader.await()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'edited-2' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
