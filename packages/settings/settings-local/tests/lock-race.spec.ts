// Writer-lock races that cannot be timed from outside: a contender whose lock
// vanishes after the failed exclusive create and a temp-file write failing
// mid-cycle.
// The fs/promises seam is partially mocked to inject exactly one failure at a
// chosen path suffix; everything else passes through to the real filesystem.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import z from 'schemastery'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SettingsLocal } from '../src/index.ts'

const state = vi.hoisted(() => ({
  /** One-shot failure injections keyed by operation, matched on a path suffix. */
  failures: [] as Array<{ suffix: string; code: string }>,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const inject = (path: unknown): void => {
    const index = state.failures.findIndex(f => String(path).endsWith(f.suffix))
    if (index === -1) return
    const [failure] = state.failures.splice(index, 1)
    throw Object.assign(new Error(`${failure!.code}: injected writeFile failure`), { code: failure!.code })
  }
  return {
    ...actual,
    writeFile: (async (path: unknown, ...rest: never[]) => {
      inject(path)
      return (actual.writeFile as (path: unknown, ...args: never[]) => Promise<void>)(path, ...rest)
    }) as typeof actual.writeFile,
  }
})

const AlphaSchema: z<{ value: number }> = z.object({ value: z.number().default(0) })

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  state.failures.length = 0
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-settings-lockrace-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: ConstructorParameters<typeof SettingsLocal>[1]): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(SettingsLocal, config)
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

describe('writer-lock races', () => {
  it('retries when the contending lock vanished after the failed create', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('alpha'), AlphaSchema)
    // The exclusive create loses once, but no lock remains by the retry.
    state.failures.push({ suffix: '.lock', code: 'EEXIST' })
    await scope.update({ value: 3 })
    expect(await readFile(path, 'utf8')).toContain('value: 3')
  })

  it('cleans up the temp file and releases the lock when the write fails mid-cycle', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    await writeFile(path, 'alpha:\n  value: 1\n')
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('alpha'), AlphaSchema)
    state.failures.push({ suffix: '.tmp', code: 'ENOSPC' })
    await expect(scope.update({ value: 9 })).rejects.toThrow(/ENOSPC/)
    // The document is untouched and the writer lock was released on the way out.
    expect(await readFile(path, 'utf8')).toContain('value: 1')
    await expect(access(`${path}.lock`)).rejects.toThrow()
  })
})
