import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { ProcessManager } from '@deepseek-ai/dsh-process'
import type { ProcessHandle, ProcessOutputRead, ProcessSpawnSpec } from '@deepseek-ai/dsh-process'

/**
 * Minimal concrete manager: a hand-built handle. The seam is spawn-only —
 * defaulting, shell semantics, and deadlines belong to callers — so this stub
 * is all an implementation owes the abstract class.
 */
class StubProcessManager extends ProcessManager {
  spawn(spec: ProcessSpawnSpec): ProcessHandle {
    const read: ProcessOutputRead = { text: '', nextOffset: 0, lossy: false }
    let killed = false
    return {
      pid: spec.argv.length,
      stdout: { readFrom: () => read },
      stderr: { readFrom: () => read },
      done: Promise.resolve({
        exitCode: killed ? null : 0,
        signal: null,
        stdout: { text: 'ok', truncated: false },
        stderr: { text: '', truncated: false },
      }),
      kill: () => { killed = true },
    }
  }
}

describe('ProcessManager seam', () => {
  it('a concrete subclass registers as ctx.processes and serves the abstract API', async () => {
    const ctx = new Context()
    await ctx.plugin(StubProcessManager)
    const handle = ctx.processes.spawn({
      argv: ['true'],
      cwd: '/stub',
      stdoutMaxBytes: 1,
      stderrMaxBytes: 1,
      maxSpillBytes: 1,
      graceMs: 1,
    })
    expect(handle.pid).toBe(1)
    expect(handle.stdout.readFrom(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
    handle.kill()
    const outcome = await handle.done
    expect(outcome.stdout.text).toBe('ok')
  })

  it('loading a second implementation throws (one processes service per context — cordis standard)', async () => {
    const ctx = new Context()
    await ctx.plugin(StubProcessManager)
    class SecondManager extends StubProcessManager {}
    await expect(ctx.plugin(SecondManager)).rejects.toThrow(/service "processes" has been registered/)
  })
})
