import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from 'cordis'
import {
  assertEntriesLoaded, boot, installFailLoud, loadEnv, resolveConfigPath,
  type FailLoudProcess,
} from '../src/index.ts'

const NAME = 'dsh-test-bin'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-app-boot-'))

describe('resolveConfigPath', () => {
  it('resolves relative to the given cwd outside replay mode', () => {
    expect(resolveConfigPath('./cordis.yml', undefined, `${sep}base`)).toBe(resolve(`${sep}base`, 'cordis.yml'))
    expect(resolveConfigPath('conf/app.yaml', 'record', `${sep}base`)).toBe(resolve(`${sep}base`, 'conf/app.yaml'))
  })

  it('swaps a cordis.yml/.yaml basename for cordis.snapshot.yml in replay mode', () => {
    expect(resolveConfigPath('./cordis.yml', 'replay', `${sep}base`)).toBe(resolve(`${sep}base`, 'cordis.snapshot.yml'))
    expect(resolveConfigPath('deep/cordis.yaml', 'replay', `${sep}base`)).toBe(resolve(`${sep}base`, 'deep/cordis.snapshot.yml'))
  })

  it('leaves a non-cordis basename alone in replay mode and defaults cwd to the process cwd', () => {
    expect(resolveConfigPath('custom.yml', 'replay', `${sep}base`)).toBe(resolve(`${sep}base`, 'custom.yml'))
    expect(resolveConfigPath('./x.yml', undefined)).toBe(resolve(process.cwd(), 'x.yml'))
  })
})

describe('loadEnv', () => {
  it('loads variables from .env in the given dir', () => {
    const dir = tmp()
    writeFileSync(join(dir, '.env'), 'DSH_APP_BOOT_SPEC_VAR=loaded\n')
    const warn = vi.fn()
    loadEnv(NAME, dir, warn)
    expect(process.env['DSH_APP_BOOT_SPEC_VAR']).toBe('loaded')
    expect(warn).not.toHaveBeenCalled()
    delete process.env['DSH_APP_BOOT_SPEC_VAR']
  })

  it('stays silent when no .env exists (ambient environment wins)', () => {
    const warn = vi.fn()
    loadEnv(NAME, tmp(), warn)
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns (labelled, single line) when .env exists but cannot be loaded', () => {
    const dir = tmp()
    mkdirSync(join(dir, '.env')) // a directory named .env: present, unreadable as a file
    const warn = vi.fn()
    loadEnv(NAME, dir, warn)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(new RegExp(`^${NAME}: failed to load \\.env: `))
  })

  it('defaults dir to the process cwd and warn to a stderr write', () => {
    const dir = tmp()
    writeFileSync(join(dir, '.env'), 'DSH_APP_BOOT_SPEC_DEFAULTS=yes\n')
    const previous = process.cwd()
    process.chdir(dir)
    try {
      loadEnv(NAME) // happy path: the default warn sink is never invoked
    } finally {
      process.chdir(previous)
    }
    expect(process.env['DSH_APP_BOOT_SPEC_DEFAULTS']).toBe('yes')
    delete process.env['DSH_APP_BOOT_SPEC_DEFAULTS']
    // The default warn sink itself: point it at a broken .env with stderr
    // spied, so the arrow body runs without polluting the test output.
    const broken = tmp()
    mkdirSync(join(broken, '.env'))
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    let written: string[]
    try {
      loadEnv(NAME, broken)
      written = write.mock.calls.map(call => String(call[0]))
    } finally {
      write.mockRestore()
    }
    expect(written).toHaveLength(1)
    expect(written[0]).toContain(`${NAME}: failed to load .env: `)
  })
})

describe('installFailLoud', () => {
  function fakeProc(): FailLoudProcess & { handlers: Array<(err: unknown) => void>; written: string[]; exits: number[] } {
    const handlers: Array<(err: unknown) => void> = []
    const written: string[] = []
    const exits: number[] = []
    return {
      handlers, written, exits,
      on: (_event, handler) => { handlers.push(handler) },
      off: (_event, handler) => { handlers.splice(handlers.indexOf(handler), 1) },
      stderr: { write: (chunk: string) => { written.push(chunk) } },
      exit: (code: number) => { exits.push(code) },
    }
  }

  it('writes one labelled line with the stack and exits 1 on an Error rejection', () => {
    const proc = fakeProc()
    installFailLoud(NAME, proc)
    const error = new Error('boom')
    proc.handlers[0]!(error)
    expect(proc.written[0]).toContain(`${NAME}: fatal load failure: `)
    expect(proc.written[0]).toContain(error.stack)
    expect(proc.exits).toEqual([1])
  })

  it('stringifies a non-Error rejection and an Error without a stack falls back to its message', () => {
    const proc = fakeProc()
    installFailLoud(NAME, proc)
    proc.handlers[0]!('plain failure')
    expect(proc.written[0]).toContain('plain failure')
    const stackless = new Error('no stack')
    delete (stackless as { stack?: string }).stack
    proc.handlers[0]!(stackless)
    expect(proc.written[1]).toContain('no stack')
    expect(proc.exits).toEqual([1, 1])
  })

  it('returns an uninstaller that removes the handler (and defaults to the real process)', () => {
    const proc = fakeProc()
    const uninstall = installFailLoud(NAME, proc)
    expect(proc.handlers).toHaveLength(1)
    uninstall()
    expect(proc.handlers).toHaveLength(0)
    // Default-proc arm: install on the real process, then immediately uninstall
    // so the suite leaks no handler and can never exit the runner.
    const before = process.listenerCount('unhandledRejection')
    const uninstallReal = installFailLoud(NAME)
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1)
    uninstallReal()
    expect(process.listenerCount('unhandledRejection')).toBe(before)
  })
})

describe('assertEntriesLoaded', () => {
  const ctxWith = (entries: Array<{ fiber?: unknown; disabled?: boolean; options: { name?: string } }>): Context =>
    ({ loader: { entries: () => entries } }) as unknown as Context

  it('passes when every enabled entry has a fiber', () => {
    expect(() => { assertEntriesLoaded(ctxWith([
      { fiber: {}, options: { name: 'a' } },
      { disabled: true, options: { name: 'off' } },
    ]), NAME) }).not.toThrow()
  })

  it('throws naming every enabled fiber-less entry', () => {
    expect(() => { assertEntriesLoaded(ctxWith([
      { fiber: {}, options: { name: 'ok' } },
      { options: { name: 'broken-a' } },
      { options: { name: 'broken-b' } },
    ]), NAME) }).toThrow(`${NAME}: plugin(s) failed to load: broken-a, broken-b`)
  })
})

describe('boot', () => {
  it('boots a leaf config through the real Loader and settles the tree', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'noop.mjs'), 'export const name = "noop"\nexport function apply() {}\n')
    writeFileSync(join(dir, 'cordis.yml'), '- id: noop\n  name: ./noop.mjs\n')
    const ctx = await boot(NAME, join(dir, 'cordis.yml'))
    try {
      const entries = [...ctx.loader.entries()]
      expect(entries.some(entry => entry.options.name === './noop.mjs' && entry.fiber !== undefined)).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects (never exits 0 half-empty) when a config names a plugin that cannot be imported', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'cordis.yml'), '- id: ghost\n  name: ./missing.mjs\n')
    await expect(boot(NAME, join(dir, 'cordis.yml'))).rejects.toThrow(`${NAME}: plugin(s) failed to load: ./missing.mjs`)
  })
})
