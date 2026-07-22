/**
 * Personal-config behavior of `dsh-app-boot`: the Harness home (`~/.dsh`)
 * `config.yaml` overlay loader and `boot()` applying the personal overlay over
 * a real Loader tree.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import {
  boot,
  loadPersonalPatches,
  PERSONAL_CONFIG_FILENAME,
} from '../src/index.ts'

const NAME = 'dsh-test-bin'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-personal-config-'))

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
    writeFileSync(join(dir, 'noop.mjs'), 'export const name = "noop"\nexport function apply() {}\n')
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
})
