import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { BashExecutor, setSandboxMode } from '@deepseek-ai/dsh-bash'
import type { BashExecRequest, BashExecSpec, BashProcess, BashProcessRead, BashRunResult } from '@deepseek-ai/dsh-bash'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

/**
 * Minimal concrete executor: canned foreground results, a hand-built process
 * handle. The seam is TASK-FREE (start returns a {@link BashProcess} handle;
 * task semantics live in `ctx.tasks`), so this stub is all an implementation
 * owes the abstract class.
 */
class StubExecutor extends BashExecutor {
  resolve(request: BashExecRequest): BashExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/stub',
      timeoutMs: request.timeoutMs ?? 1000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      ...request.signal ? { signal: request.signal } : {},
      sandboxMode: request.sandboxMode,
    }
  }

  async run(spec: BashExecSpec): Promise<BashRunResult> {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: 'ok', truncated: false },
      stderr: { text: '', truncated: false },
    }
  }

  start(): BashProcess {
    const proc: BashProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: Promise.resolve(),
      readOutput: (): BashProcessRead => ({ delta: '', lossy: false }),
      kill: (): boolean => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        return true
      },
    }
    return proc
  }
}

describe('BashExecutor service seam', () => {
  it('a concrete subclass registers as ctx.bash and serves the abstract API', async () => {
    const ctx = new Context()
    await ctx.plugin(StubExecutor)
    const spec = ctx.bash.resolve({ command: 'echo hi' })
    expect(spec).toEqual({ command: 'echo hi', workdir: '/stub', timeoutMs: 1000, stdoutMaxBytes: 64_000, sandboxMode: undefined })

    const result = await ctx.bash.run(spec)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('ok')

    const proc = ctx.bash.start(spec)
    expect(proc.status).toBe('running')
    expect(proc.readOutput()).toEqual({ delta: '', lossy: false })
    expect(proc.kill()).toBe(true)
    expect(proc.kill()).toBe(false) // already settled → no-op
    await proc.done
  })

  it('reports no default sandbox mode from the task-free base seam', async () => {
    const ctx = new Context()
    await ctx.plugin(StubExecutor)
    expect(ctx.bash.sandboxMode).toBeUndefined()
  })

  it('loading a second implementation throws (one bash service per context — cordis standard)', async () => {
    const ctx = new Context()
    await ctx.plugin(StubExecutor)
    class SecondExecutor extends StubExecutor {}
    await expect(ctx.plugin(SecondExecutor)).rejects.toThrow(/service "bash" has been registered/)
  })
})

/** A confining stub: the same executor with a configured default sandbox mode. */
class ConfiningStub extends StubExecutor {
  override get sandboxMode(): SandboxMode {
    return 'workspace-write'
  }
}

describe('resolveMode (the bash/resolve-mode seam)', () => {
  it('resolves undefined for a never-confining executor without consulting the waterfall', async () => {
    const ctx = new Context()
    await ctx.plugin(StubExecutor)
    const listener = vi.fn()
    ctx.on('bash/resolve-mode', listener)
    expect(await ctx.bash.resolveMode(new Session(SessionId('rm-none')))).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
  })

  it('resolves the executor default without a session and without an override', async () => {
    const ctx = new Context()
    await ctx.plugin(ConfiningStub)
    expect(await ctx.bash.resolveMode(undefined)).toBe('workspace-write')
    expect(await ctx.bash.resolveMode(new Session(SessionId('rm-default')))).toBe('workspace-write')
  })

  it('resolves the session override over the executor default', async () => {
    const ctx = new Context()
    await ctx.plugin(ConfiningStub)
    const session = new Session(SessionId('rm-override'))
    setSandboxMode(session, 'danger-full-access')
    expect(await ctx.bash.resolveMode(session)).toBe('danger-full-access')
  })

  it('a waterfall listener narrows the base per call and sees the session', async () => {
    const ctx = new Context()
    await ctx.plugin(ConfiningStub)
    const session = new Session(SessionId('rm-clamp'))
    setSandboxMode(session, 'danger-full-access')
    const seen: (Session | undefined)[] = []
    ctx.on('bash/resolve-mode', async (sess, next) => {
      seen.push(sess)
      await next()
      return 'read-only'
    })
    expect(await ctx.bash.resolveMode(session)).toBe('read-only')
    expect(seen).toEqual([session])
  })
})
