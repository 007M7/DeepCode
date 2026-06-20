import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type {} from '@deepseek-ai/dsh-bash'

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-bash-exec-spec-'))

async function setup(config: ConstructorParameters<typeof LocalBashExecutor>[1] = {}) {
  const ctx = new Context()
  await ctx.plugin(LocalBashExecutor, config)
  const bash = ctx.bash as LocalBashExecutor
  bash.internals = { spillDir, graceMs: 200 }
  return { ctx, bash }
}

/** Poll until a pid no longer exists. */
async function waitGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`)
}

describe('LocalBashExecutor.run', () => {
  it('resolves with output and the effective timeout', async () => {
    const { bash } = await setup({ timeoutMs: 5_000 })
    const result = await bash.run(bash.resolve({ command: 'echo hi' }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('hi\n')
    expect(result.timeoutMs).toBe(5_000)
  })

  it('uses config cwd, overridable per call', async () => {
    const { bash } = await setup({ cwd: '/tmp' })
    const fromConfig = await bash.run(bash.resolve({ command: 'pwd' }))
    expect(fromConfig.stdout.text.trim()).toMatch(/\/tmp$/)
    const fromCall = await bash.run(bash.resolve({ command: 'pwd', workdir: '/' }))
    expect(fromCall.stdout.text.trim()).toBe('/')
  })

  it('defaults cwd to process.cwd()', async () => {
    const { bash } = await setup()
    const result = await bash.run(bash.resolve({ command: 'pwd' }))
    expect(result.stdout.text.trim()).toBe(process.cwd())
  })

  it('caps per-call timeouts at maxTimeoutMs', async () => {
    const { bash } = await setup({ timeoutMs: 1_000, maxTimeoutMs: 2_000 })
    const result = await bash.run(bash.resolve({ command: 'true', timeoutMs: 99_999 }))
    expect(result.timeoutMs).toBe(2_000)
  })

  it('rejects invalid numeric config and timeout overrides', async () => {
    await expect(setup({ timeoutMs: Number.NaN })).rejects.toThrow(/timeoutMs/)
    await expect(setup({ maxTimeoutMs: 0 })).rejects.toThrow(/maxTimeoutMs/)
    await expect(setup({ maxOutputBytes: -1 })).rejects.toThrow(/maxOutputBytes/)

    const { bash } = await setup()
    expect(() => bash.resolve({ command: 'true', timeoutMs: Number.NaN })).toThrow(/request\.timeoutMs/)
    expect(() => bash.resolve({ command: 'true', timeoutMs: -1 })).toThrow(/request\.timeoutMs/)
  })

  it('per-call timeout takes precedence under the cap and kills on expiry', async () => {
    const { bash } = await setup({ timeoutMs: 60_000 })
    const result = await bash.run(bash.resolve({ command: 'sleep 60', timeoutMs: 100 }))
    expect(result.timedOut).toBe(true)
    expect(result.timeoutMs).toBe(100)
  })

  it('propagates abort signals', async () => {
    const { bash } = await setup()
    const controller = new AbortController()
    const pending = bash.run(bash.resolve({ command: 'sleep 60', signal: controller.signal }))
    setTimeout(() => { controller.abort() }, 50)
    const result = await pending
    expect(result.aborted).toBe(true)
  })

  it('rejects on spawn failure (bad workdir)', async () => {
    const { bash } = await setup()
    await expect(bash.run(bash.resolve({ command: 'true', workdir: '/nonexistent-dsh' }))).rejects.toThrow(/ENOENT/)
  })
})

describe('LocalBashExecutor background tasks', () => {
  it('start returns immediately with a registered running task', async () => {
    const { bash } = await setup()
    const before = Date.now()
    const task = bash.start(bash.resolve({ command: 'sleep 0.2; echo done' }))
    expect(Date.now() - before).toBeLessThan(150)
    expect(task.status).toBe('running')
    expect(bash.get(task.id)).toBe(task)
    expect(bash.list()).toContain(task)
    await task.done
    expect(task.status).toBe('completed')
    expect(task.exitCode).toBe(0)
  })

  it('assigns sequential ids', async () => {
    const { bash } = await setup()
    const first = bash.start(bash.resolve({ command: 'true' }))
    const second = bash.start(bash.resolve({ command: 'true' }))
    expect(first.id).toBe('bash-1')
    expect(second.id).toBe('bash-2')
    await Promise.all([first.done, second.done])
  })

  it('readOutput returns increments without re-delivery', async () => {
    const { bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'echo first; sleep 0.3; echo second' }))
    await new Promise(resolve => setTimeout(resolve, 150))
    const first = bash.readOutput(task.id)
    expect(first.delta).toBe('first\n')
    expect(first.lossy).toBe(false)
    await task.done
    const second = bash.readOutput(task.id)
    expect(second.delta).toBe('second\n')
    const third = bash.readOutput(task.id)
    expect(third.delta).toBe('')
  })

  it('readOutput marks stderr sections', async () => {
    const { bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'echo out; echo err >&2' }))
    await task.done
    const read = bash.readOutput(task.id)
    expect(read.delta).toBe('out\n[stderr]\nerr\n')
  })

  it('readOutput reports stderr-only deltas without a leading newline', async () => {
    const { bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'echo err >&2' }))
    await task.done
    expect(bash.readOutput(task.id).delta).toBe('[stderr]\nerr\n')
  })

  it('readOutput flags lossy reads and reports spill paths', async () => {
    const { bash } = await setup({ maxOutputBytes: 100 })
    const task = bash.start(bash.resolve({ command: 'for i in $(seq 1 100); do printf "line-%04d\\n" $i; done' }))
    await task.done
    const read = bash.readOutput(task.id)
    // Window slid past offset 0 → lossy, spill path points at the full stream.
    expect(read.lossy).toBe(true)
    expect(read.stdoutSpillPath).toBeDefined()
  })

  it('readOutput throws for unknown ids', async () => {
    const { bash } = await setup()
    expect(() => bash.readOutput('nope')).toThrow(/unknown bash task "nope"/)
  })

  it('kill terminates the process group and reports status killed', async () => {
    const { bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'sleep 60' }))
    expect(bash.kill(task.id)).toBe(true)
    await task.done
    expect(task.status).toBe('killed')
    expect(task.signal).toBe('SIGTERM')
  })

  it('kill returns false for finished tasks and throws for unknown ids', async () => {
    const { bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'true' }))
    await task.done
    expect(bash.kill(task.id)).toBe(false)
    expect(() => bash.kill('nope')).toThrow(/unknown bash task "nope"/)
  })

  it('notifies onTaskDone listeners on completion', async () => {
    const { bash } = await setup()
    const seen: [string, string][] = []
    bash.onTaskDone(task => void seen.push([task.id, task.status]))
    const task = bash.start(bash.resolve({ command: 'true' }))
    await task.done
    expect(seen).toEqual([[task.id, 'completed']])
  })

  it('notifies onTaskDone for killed tasks too', async () => {
    const { bash } = await setup()
    const listener = vi.fn()
    bash.onTaskDone(listener)
    const task = bash.start(bash.resolve({ command: 'sleep 60' }))
    bash.kill(task.id)
    await task.done
    expect(listener).toHaveBeenCalledWith(task)
    expect(task.status).toBe('killed')
  })

  it('marks tasks killed when the background spawn itself fails', async () => {
    const { bash } = await setup()
    const listener = vi.fn()
    bash.onTaskDone(listener)
    const task = bash.start(bash.resolve({ command: 'true', workdir: '/nonexistent-dsh' }))
    await task.done
    expect(task.status).toBe('killed')
    expect(listener).toHaveBeenCalledWith(task)
    expect(bash.readOutput(task.id).delta).toContain('spawn failed')
  })

  it('readOutput adds a separator only when stdout lacks a trailing newline', async () => {
    const { bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'printf out; echo err >&2' }))
    await task.done
    expect(bash.readOutput(task.id).delta).toBe('out\n[stderr]\nerr\n')
  })

  it('readOutput reports stderr spill paths', async () => {
    const { bash } = await setup({ maxOutputBytes: 100 })
    const task = bash.start(bash.resolve({ command: 'for i in $(seq 1 100); do printf "line-%04d\\n" $i >&2; done' }))
    await task.done
    const read = bash.readOutput(task.id)
    expect(read.lossy).toBe(true)
    expect(read.stderrSpillPath).toBeDefined()
    expect(read.delta).toContain('[stderr]')
  })

  it('disposing with already-finished tasks only kills the running ones', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalBashExecutor, {})
    const bash = ctx.bash as LocalBashExecutor
    bash.internals = { spillDir, graceMs: 200 }

    const finished = bash.start(bash.resolve({ command: 'true' }))
    await finished.done
    const running = bash.start(bash.resolve({ command: 'sleep 60' }))

    await fiber.dispose()
    await running.done
    expect(finished.status).toBe('completed')
    expect(running.signal).toBe('SIGTERM')
    expect(bash.list()).toEqual([])
  })

  it('disposing the executor fiber kills running tasks (no orphans)', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalBashExecutor, {})
    const bash = ctx.bash as LocalBashExecutor
    bash.internals = { spillDir, graceMs: 200 }
    const listener = vi.fn()
    bash.onTaskDone(listener)

    const task = bash.start(bash.resolve({ command: 'sleep 60' }))
    const running = bash.get(task.id)!
    await new Promise(resolve => setTimeout(resolve, 50))

    // Grab the pid before dispose clears the registry.
    const pid = (running as unknown as { running: { pid: number } }).running.pid
    await fiber.dispose()
    await waitGone(pid)
    expect(bash.list()).toEqual([])
    // Listener silenced by base-class teardown — no late notifications.
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('review fixes: lifecycle hardening', () => {
  it('start honors a pre-aborted or later-aborted AbortSignal', async () => {
    const { bash } = await setup()
    const controller = new AbortController()
    const task = bash.start(bash.resolve({ command: 'sleep 60', signal: controller.signal }))
    controller.abort()
    await task.done
    expect(task.status).toBe('killed')
    expect(task.signal).toBe('SIGTERM')
  })

  it('a throwing onTaskDone listener does not reject task.done or starve later listeners', async () => {
    const { bash } = await setup()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const second = vi.fn()
    try {
      bash.onTaskDone(() => { throw new Error('listener bug') })
      bash.onTaskDone(second)
      const task = bash.start(bash.resolve({ command: 'true' }))
      await expect(task.done).resolves.toBeUndefined()
      expect(second).toHaveBeenCalledWith(task)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('dispose AWAITS a TERM-trapping process (SIGKILL escalation included)', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalBashExecutor, {})
    const bash = ctx.bash as LocalBashExecutor
    bash.internals = { spillDir, graceMs: 200 }

    const task = bash.start(bash.resolve({ command: 'trap \'\' TERM; sleep 60' }))
    await new Promise(resolve => setTimeout(resolve, 100))
    const pid = (task as unknown as { running: { pid: number } }).running.pid

    await fiber.dispose()
    // Disposal itself waited: the pid must already be gone, no grace left.
    expect(() => process.kill(pid, 0)).toThrow()
    expect(task.status).toBe('killed')
  })
})
