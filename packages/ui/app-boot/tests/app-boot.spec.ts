import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  addHarnessSourceSection, assertEntriesActive, assertEntriesLoaded, boot, HARNESS_SOURCE_SECTION,
  installFailLoud, loadEnv, loadOverlayPatches, resolveConfigPath, type FailLoudProcess,
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

describe('loadOverlayPatches', () => {
  it('loads expressions and rejects missing, malformed, non-array, and non-mapping overlays', () => {
    const dir = tmp()
    const valid = join(dir, 'valid.yml')
    writeFileSync(valid, '- id: target\n  config:\n    value: !!js process.env.VALUE\n')
    expect(loadOverlayPatches(NAME, valid)).toEqual([{ id: 'target', config: { value: { __jsExpr: 'process.env.VALUE' } } }])
    expect(() => loadOverlayPatches(NAME, join(dir, 'missing.yml'))).toThrow(`${NAME}: failed to read overlay`)
    const malformed = join(dir, 'malformed.yml')
    writeFileSync(malformed, ': bad')
    expect(() => loadOverlayPatches(NAME, malformed)).toThrow(`${NAME}: failed to parse overlay`)
    const mapping = join(dir, 'mapping.yml')
    writeFileSync(mapping, 'id: target\n')
    expect(() => loadOverlayPatches(NAME, mapping)).toThrow('must be a top-level YAML array')
    const scalar = join(dir, 'scalar.yml')
    writeFileSync(scalar, '- scalar\n')
    expect(() => loadOverlayPatches(NAME, scalar)).toThrow('entry 1')
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

  it('runs host preparation before the Loader tree mounts', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'noop.mjs'), 'export const name = "noop"\nexport function apply() {}\n')
    writeFileSync(join(dir, 'cordis.yml'), '- id: noop\n  name: ./noop.mjs\n')
    const prepared: Context[] = []
    const ctx = await boot(NAME, join(dir, 'cordis.yml'), undefined, (hostCtx) => {
      expect(hostCtx.loader).toBeDefined()
      expect([...hostCtx.loader.entries()]).toEqual([])
      prepared.push(hostCtx)
    })
    try {
      expect(prepared).toEqual([ctx])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects (never exits 0 half-empty) when a config names a plugin that cannot be imported', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'cordis.yml'), '- id: ghost\n  name: ./missing.mjs\n')
    await expect(boot(NAME, join(dir, 'cordis.yml'))).rejects.toThrow(`${NAME}: plugin(s) failed to load: ./missing.mjs`)
  })

  it('rejects a settled tree with a pending inject and names every missing service', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'waiting.mjs'), "export const inject = ['alpha', 'beta']\nexport function apply() {}\n")
    writeFileSync(join(dir, 'cordis.yml'), '- id: waiting\n  name: ./waiting.mjs\n')
    await expect(boot(NAME, join(dir, 'cordis.yml'))).rejects.toThrow('./waiting.mjs: pending (waiting for services: alpha, beta)')
  })

  it('uses singular diagnostics for one missing pending dependency', () => {
    const ctx = {
      loader: { entries: () => [{ disabled: false, options: { name: 'waiting' }, fiber: { state: 0, inject: { alpha: {} } } }] },
      get: () => undefined,
    } as unknown as Context
    expect(() =>{  assertEntriesActive(ctx, NAME) }).toThrow('waiting: pending (waiting for service: alpha)')
  })

  it('reports unknown pending dependencies and unexpected fiber states', () => {
    const entries = [
      { disabled: false, options: { name: 'unknown' }, fiber: { state: 0, inject: {} } },
      { disabled: false, options: { name: 'failed' }, fiber: { state: 3, inject: {} } },
    ]
    const ctx = {
      loader: { entries: () => entries },
      get: () => undefined,
    } as unknown as Context
    expect(() =>{  assertEntriesActive(ctx, NAME) }).toThrow(`${NAME}: 2 entries did not activate\nunknown: pending (waiting for services: unknown)\nfailed: fiber state 3`)
  })
})

describe('addHarnessSourceSection', () => {
  const SOURCE_ROOT = `${sep}opt${sep}harness-src`
  const EXPECTED = `Your own source code is the checkout at ${SOURCE_ROOT}; you can read it there to learn how dsh works and how to extend it.`

  it('adds the source path between the harness identity and the deployment persona', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, { persona: 'You are a coding agent.' })
      const dispose = addHarnessSourceSection(ctx, SOURCE_ROOT)
      expect(dispose).toBeTypeOf('function')
      const systemPrompt = ctx.get('systemPrompt')!
      const rendered = renderPrompt(await systemPrompt.assemble())
      expect(rendered).toContain(EXPECTED)
      // Harness-owned opener (-100) → source (-99) → persona (0). The >= 0 guards
      // keep a drifted opener/persona string from a false pass through `-1 < n`.
      const identityAt = rendered.indexOf('You are an AI agent powered by the DeepSeek Harness SDK.')
      const sourceAt = rendered.indexOf(EXPECTED)
      const personaAt = rendered.indexOf('You are a coding agent.')
      expect(identityAt).toBeGreaterThanOrEqual(0)
      expect(personaAt).toBeGreaterThanOrEqual(0)
      expect(identityAt).toBeLessThan(sourceAt)
      expect(sourceAt).toBeLessThan(personaAt)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('is a no-op returning undefined when no systemPrompt service is mounted', async () => {
    const ctx = new Context()
    try {
      expect(addHarnessSourceSection(ctx, SOURCE_ROOT)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('disposes the section it added, so a systemPrompt reload leaves no residue', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, {})
      const systemPrompt = ctx.get('systemPrompt')!
      const dispose = addHarnessSourceSection(ctx, SOURCE_ROOT)!
      const present = await systemPrompt.assemble()
      expect(present.sections.some(section => section.name === HARNESS_SOURCE_SECTION)).toBe(true)
      dispose()
      const gone = await systemPrompt.assemble()
      expect(gone.sections.some(section => section.name === HARNESS_SOURCE_SECTION)).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
