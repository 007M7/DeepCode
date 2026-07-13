import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { BashExecutor, BashTaskId, OwnerToken } from '@deepseek-ai/dsh-bash'
import type { BashExecRequest, BashExecSpec, BashRunResult, BashTask, BashTaskRead } from '@deepseek-ai/dsh-bash'

/** Minimal concrete executor: records calls, lets tests drive completions. */
class StubExecutor extends BashExecutor {
  tasks = new Map<BashTaskId, BashTask>()
  private owners = new Map<BashTaskId, OwnerToken | undefined>()

  resolve(request: BashExecRequest): BashExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/stub',
      timeoutMs: request.timeoutMs ?? 1000,
      ...request.signal ? { signal: request.signal } : {},
      owner: request.owner,
      sandboxMode: request.sandboxMode,
    }
  }

  async run(_spec: BashExecSpec): Promise<BashRunResult> {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 1000,
      stdout: { text: 'ok', truncated: false },
      stderr: { text: '', truncated: false },
    }
  }

  start(spec: BashExecSpec): BashTask {
    const task: BashTask = {
      id: BashTaskId(`stub-${this.tasks.size + 1}`),
      command: spec.command,
      status: 'running',
      exitCode: null,
      signal: null,
      done: Promise.resolve(),
    }
    this.tasks.set(task.id, task)
    this.owners.set(task.id, spec.owner)
    return task
  }

  get(id: BashTaskId): BashTask | undefined {
    return this.tasks.get(id)
  }

  ownerOf(id: BashTaskId): OwnerToken | undefined {
    return this.owners.get(id)
  }

  list(): BashTask[] {
    return [...this.tasks.values()]
  }

  readOutput(id: BashTaskId): BashTaskRead {
    const task = this.tasks.get(id)
    if (!task) throw new Error(`unknown bash task "${id}"`)
    return { task, delta: '', lossy: false }
  }

  kill(id: BashTaskId): boolean {
    const task = this.tasks.get(id)
    if (!task) throw new Error(`unknown bash task "${id}"`)
    if (task.status !== 'running') return false
    task.status = 'killed'
    return true
  }

  /** Expose the protected notifier for tests. */
  fire(task: BashTask): void {
    this.notifyTaskDone(task)
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(StubExecutor)
  // ctx.bash resolves to the registered implementation.
  const bash = ctx.bash as StubExecutor
  return { ctx, bash }
}

describe('BashExecutor service seam', () => {
  it('registers as ctx.bash and serves the abstract API', async () => {
    const { bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'sleep 1' }))
    expect(bash.get(task.id)).toBe(task)
    expect(bash.list()).toEqual([task])
    expect(bash.kill(task.id)).toBe(true)
    expect(bash.kill(task.id)).toBe(false)
    const result = await bash.run(bash.resolve({ command: 'true' }))
    expect(result.exitCode).toBe(0)
  })

  it('reports no default sandbox mode (composition truth: the base never confines)', async () => {
    const { bash } = await setup()
    expect(bash.sandboxMode).toBeUndefined()
  })

  it('onTaskDone delivers completions to registered listeners', async () => {
    const { bash } = await setup()
    const seen: string[] = []
    bash.onTaskDone(task => void seen.push(task.id))
    const task = bash.start(bash.resolve({ command: 'x' }))
    bash.fire(task)
    expect(seen).toEqual([task.id])
  })

  it('onTaskDone disposer unsubscribes the listener', async () => {
    const { bash } = await setup()
    const listener = vi.fn()
    const dispose = bash.onTaskDone(listener)
    dispose()
    bash.fire(bash.start(bash.resolve({ command: 'x' })))
    expect(listener).not.toHaveBeenCalled()
  })

  it('listeners registered from a fiber are removed on dispose (HMR safety)', async () => {
    const { ctx, bash } = await setup()
    const listener = vi.fn()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.bash.onTaskDone(listener)
    }, { inject: ['bash'] }))
    bash.fire(bash.start(bash.resolve({ command: 'one' })))
    expect(listener).toHaveBeenCalledTimes(1)

    await fiber.dispose()
    bash.fire(bash.start(bash.resolve({ command: 'two' })))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('silences listeners once the service fiber is disposed', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(Object.assign(async (inner: Context) => {
      await inner.plugin(StubExecutor)
    }, {}))
    const bash = ctx.bash as StubExecutor
    const listener = vi.fn()
    bash.onTaskDone(listener)
    const task = bash.start(bash.resolve({ command: 'x' }))

    await fiber.dispose()
    bash.fire(task)
    expect(listener).not.toHaveBeenCalled()
  })
})
