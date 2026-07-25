import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LocalProcessManager from '@deepseek-ai/dsh-process-local'
import type { ProcessSpawnSpec } from '@deepseek-ai/dsh-process'

function spec(command: string, overrides: Partial<ProcessSpawnSpec> = {}): ProcessSpawnSpec {
  return {
    argv: ['bash', '-c', command],
    cwd: process.cwd(),
    stdoutMaxBytes: 64_000,
    stderrMaxBytes: 64_000,
    maxSpillBytes: 64 * 1024 * 1024,
    graceMs: 200,
    ...overrides,
  }
}

describe('LocalProcessManager', () => {
  it('registers as ctx.processes and spawns managed handles', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalProcessManager)
    const result = await ctx.processes.spawn(spec('echo managed')).done
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('managed\n')
    await fiber.dispose()
  })

  it('disposal kills still-running processes and awaits their exit', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalProcessManager)
    const handle = ctx.processes.spawn(spec('sleep 60'))
    await fiber.dispose()
    const outcome = await handle.done
    expect(outcome.signal).toBe('SIGTERM')
  })

  it('a settled process leaves the live set (disposal does not re-kill it)', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalProcessManager)
    const handle = ctx.processes.spawn(spec('true'))
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
    await fiber.dispose()
  })

  it('disposal tolerates a handle whose spawn already failed', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalProcessManager)
    const handle = ctx.processes.spawn(spec('true', { cwd: '/nonexistent-dir-dsh-manager-test' }))
    await expect(handle.done).rejects.toThrow()
    await fiber.dispose()
  })

  it('disposal contains a spawn-failure rejection that races teardown', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalProcessManager)
    // Dispose before the rejection continuation removes the handle from the
    // live set, so teardown itself must swallow the rejected done.
    const handle = ctx.processes.spawn(spec('true', { cwd: '/nonexistent-dir-dsh-manager-test' }))
    await fiber.dispose()
    await expect(handle.done).rejects.toThrow()
  })

  it('loading a second implementation throws (one processes service per context — cordis standard)', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalProcessManager)
    class SecondManager extends LocalProcessManager {}
    await expect(ctx.plugin(SecondManager)).rejects.toThrow(/service "processes" has been registered/)
  })
})
