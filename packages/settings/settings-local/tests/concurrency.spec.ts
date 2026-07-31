// Cross-instance and writer-lock behavior: two providers on one document are
// the in-process equivalent of two dsh processes sharing a harness home —
// neither knows the other's cache, so only the read-modify-write cycle under
// the `<file>.lock` sibling keeps both namespaces alive on disk.
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import z from 'schemastery'
import { chmod, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SettingsLocal } from '../src/index.ts'

const AlphaSchema: z<{ value: number }> = z.object({ value: z.number().default(0) })
const BetaSchema: z<{ value: number }> = z.object({ value: z.number().default(0) })

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-settings-lock-'))
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

describe('cross-instance writes', () => {
  it('keeps both namespaces when two providers write the same document concurrently', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    const first = await boot({ path, watch: false })
    const second = await boot({ path, watch: false })
    const alpha = first.settings.register(settingsNamespace('alpha'), AlphaSchema)
    const beta = second.settings.register(settingsNamespace('beta'), BetaSchema)
    const rounds = [1, 2, 3, 4, 5]
    await Promise.all([
      (async () => { for (const value of rounds) await alpha.update({ value }) })(),
      (async () => { for (const value of rounds) await beta.update({ value }) })(),
    ])
    const text = await readFile(path, 'utf8')
    expect(text).toContain('alpha:')
    expect(text).toContain('beta:')
    // A third instance resolves both final values from the shared document.
    const third = await boot({ path, watch: false })
    expect(third.settings.register(settingsNamespace('alpha'), AlphaSchema).get()).toEqual({ value: 5 })
    expect(third.settings.register(settingsNamespace('beta'), BetaSchema).get()).toEqual({ value: 5 })
  })
})

describe('writer lock', () => {
  it('waits for a busy writer lock instead of failing', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('alpha'), AlphaSchema)
    await writeFile(`${path}.lock`, 'holder\n')
    const release = setTimeout(() => { void rm(`${path}.lock`, { force: true }) }, 120)
    cleanups.push(async () => { clearTimeout(release) })
    await scope.update({ value: 7 })
    expect(await readFile(path, 'utf8')).toContain('value: 7')
  })

  it('breaks a stale writer lock with a warning and writes through', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('alpha'), AlphaSchema)
    await writeFile(`${path}.lock`, 'crashed-holder\n')
    const past = (Date.now() - 60_000) / 1000
    await utimes(`${path}.lock`, past, past)
    await scope.update({ value: 9 })
    expect(await readFile(path, 'utf8')).toContain('value: 9')
  })

  it('times out on a lock a live holder never releases', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('alpha'), AlphaSchema)
    await writeFile(`${path}.lock`, 'busy-holder\n')
    await expect(scope.update({ value: 1 })).rejects.toThrow(/timed out waiting for the writer lock/)
  }, 10_000)

  it('surfaces a non-contention lock failure as the write error', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('alpha'), AlphaSchema)
    await chmod(dir, 0o500)
    cleanups.push(() => chmod(dir, 0o700))
    await expect(scope.update({ value: 1 })).rejects.toThrow(/EACCES|permission/)
  })
})
