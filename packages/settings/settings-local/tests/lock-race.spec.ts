// A temp-file write failure cannot be timed from outside. The fs/promises seam
// injects it once so the test can prove that the writer lock still releases.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import z from 'schemastery'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SettingsLocal } from '../src/index.ts'

const state = vi.hoisted(() => ({
  failTempWrite: false,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: (async (path: unknown, ...rest: never[]) => {
      if (state.failTempWrite && String(path).endsWith('.tmp')) {
        state.failTempWrite = false
        throw Object.assign(new Error('ENOSPC: injected writeFile failure'), { code: 'ENOSPC' })
      }
      return (actual.writeFile as (path: unknown, ...args: never[]) => Promise<void>)(path, ...rest)
    }) as typeof actual.writeFile,
  }
})

const AlphaSchema: z<{ value: number }> = z.object({ value: z.number().default(0) })

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  state.failTempWrite = false
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

describe('writer-lock failure cleanup', () => {
  it('cleans up the temp file and releases the lock when the write fails mid-cycle', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    await writeFile(path, 'alpha:\n  value: 1\n')
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('alpha'), AlphaSchema)
    state.failTempWrite = true
    await expect(scope.update({ value: 9 })).rejects.toThrow(/ENOSPC/)
    // The document is untouched and the writer lock was released on the way out.
    expect(await readFile(path, 'utf8')).toContain('value: 1')
    await expect(access(`${path}.lock`)).rejects.toThrow()
  })
})
