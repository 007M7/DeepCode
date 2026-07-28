import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import type { CommandHandle, Sandbox } from '@deepseek-ai/dsh-e2b'
import type E2BSandboxService from '@deepseek-ai/dsh-e2b'
import PtyService, { PtyBackendCleanupError, PtySessionId } from '@deepseek-ai/dsh-pty'
import { E2BPtyBackend, apply } from '@deepseek-ai/dsh-pty-e2b'
import { validateConfig } from '@deepseek-ai/dsh-pty-e2b/src/config.ts'
import * as E2BPtyInvariant from '../src/invariant.ts'
import InvariantService from '@deepseek-ai/dsh-invariants'
import { AgentMessageId, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

function config() {
  return {
    backendType: 'shell', rows: 24, cols: 80,
    scrollbackLines: 10, scrollbackMaxBytes: 128, maxReadBytes: 64,
    pollIntervalMs: 1, idleSilenceMs: 2, timeoutMs: 5, disposeGraceMs: 1,
  }
}

function owner(ctx: Context): Agent {
  const id = SessionId('owner')
  return {
    id, options: {}, session: new Session(id), status: 'idle', acceptsNextStep: false, ctx,
    followup: () => AgentMessageId('unused'), steer: () => AgentMessageId('unused'),
    inject: () => AgentMessageId('unused'), send: () => AgentMessageId('unused'),
    cancel() {}, whenIdle: () => Promise.resolve(),
  }
}

function handle(pid = 123, kill = vi.fn().mockResolvedValue(true)): CommandHandle {
  const result = Promise.withResolvers<{ exitCode: number; stdout: string; stderr: string }>()
  return {
    pid,
    wait: () => result.promise,
    kill,
    disconnect: vi.fn().mockResolvedValue(undefined),
  } as unknown as CommandHandle
}

describe('E2BPtyBackend and plugin', () => {
  it('creates a remote PTY with isolated environment and initializes the session', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    const sandbox = {} as Sandbox
    ctx.provide('e2b', {
      cwd: '/workspace',
      getSandbox: async () => sandbox,
    } as E2BSandboxService)
    const created = handle()
    let options: Parameters<Sandbox['pty']['create']>[0] | undefined
    const backend = new E2BPtyBackend(ctx, config(), async (_sandbox, received) => {
      options = received
      void received.onData(Buffer.from('banner\n'))
      void received.onData(Buffer.from('\x1b]133;D;0\x07dsh> '))
      return created
    })
    const pending = backend.spawn({
      sessionId: PtySessionId('pty-1'), owner: owner(ctx), type: 'shell', cwd: 'project',
      signal: new AbortController().signal,
    })
    await vi.advanceTimersByTimeAsync(2)
    const session = await pending

    expect(session.motd).toBe('banner\ndsh> ')
    expect(options).toMatchObject({ rows: 24, cols: 80, cwd: '/workspace/project', timeoutMs: 0 })
    expect(options?.envs).toMatchObject({
      TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', PS1: 'dsh> ',
      DSH_SHELL: '1', DSH_SESSION_ID: 'owner', DSH_PTY_SESSION_ID: 'pty-1',
    })
    vi.useRealTimers()
  })

  it('uses the SDK PTY create method and the shared cwd by default', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    const created = handle()
    const create = vi.fn(async (received: Parameters<Sandbox['pty']['create']>[0]) => {
      setTimeout(() => { void received.onData(Buffer.from('\x1b]133;D;0\x07dsh> ')) }, 0)
      return created
    })
    const sandbox = { pty: { create } } as unknown as Sandbox
    ctx.provide('e2b', { cwd: '/workspace', getSandbox: async () => sandbox } as unknown as E2BSandboxService)
    const backend = new E2BPtyBackend(ctx, config())
    const pending = backend.spawn({ sessionId: PtySessionId('default'), owner: owner(ctx), type: 'shell' })
    await vi.advanceTimersByTimeAsync(2)
    await pending
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/workspace' }))
    vi.useRealTimers()
  })

  it('rejects aborts and invalid pids, killing a malformed SDK handle', async () => {
    const ctx = new Context()
    const sandbox = {} as Sandbox
    ctx.provide('e2b', { cwd: '/workspace', getSandbox: async () => sandbox } as E2BSandboxService)
    const create = vi.fn().mockResolvedValue(handle(0))
    const backend = new E2BPtyBackend(ctx, config(), create)
    const aborted = AbortSignal.abort(new Error('stop'))
    await expect(backend.spawn({ sessionId: PtySessionId('one'), owner: owner(ctx), type: 'shell', signal: aborted })).rejects.toThrow('stop')
    expect(create).not.toHaveBeenCalled()

    const malformedKill = vi.fn().mockResolvedValue(true)
    const malformed = handle(0, malformedKill)
    const invalid = new E2BPtyBackend(ctx, config(), async () => malformed)
    await expect(invalid.spawn({ sessionId: PtySessionId('two'), owner: owner(ctx), type: 'shell' })).rejects.toThrow('invalid PTY pid')
    expect(malformedKill).toHaveBeenCalledOnce()

    const killFailureKill = vi.fn().mockRejectedValue(new Error('already gone'))
    const killFailure = handle(0, killFailureKill)
    const raced = new E2BPtyBackend(ctx, config(), async () => killFailure)
    await expect(raced.spawn({ sessionId: PtySessionId('three'), owner: owner(ctx), type: 'shell' })).rejects.toThrow('invalid PTY pid')
  })

  it('cleans failed startup and aggregates a cleanup failure', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    const sandbox = {
      commands: { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }) },
      pty: { kill: vi.fn().mockRejectedValue(new Error('cleanup failed')) },
    } as unknown as Sandbox
    ctx.provide('e2b', { cwd: '/workspace', getSandbox: async () => sandbox } as E2BSandboxService)
    const failedHandle = handle()
    const backend = new E2BPtyBackend(ctx, config(), async () => failedHandle)
    const pending = backend.spawn({ sessionId: PtySessionId('failed'), owner: owner(ctx), type: 'shell' })
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'PtyBackendCleanupError',
      cleanupError: expect.objectContaining({ message: 'cleanup failed' }),
    } satisfies Partial<PtyBackendCleanupError>)
    await vi.advanceTimersByTimeAsync(6)
    await vi.advanceTimersByTimeAsync(2)
    await rejected
    vi.useRealTimers()
  })

  it('preserves startup failure when cleanup succeeds', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    const completion = Promise.withResolvers<{ exitCode: number; stdout: string; stderr: string }>()
    const created = {
      pid: 123,
      wait: () => completion.promise,
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as CommandHandle
    const sandbox = {
      commands: {
        run: vi.fn(async (command: string) => {
          if (command.startsWith('kill -TERM')) completion.resolve({ exitCode: 143, stdout: '', stderr: '' })
          return { exitCode: 0, stdout: '', stderr: '' }
        }),
      },
      pty: { kill: vi.fn().mockResolvedValue(true) },
    } as unknown as Sandbox
    ctx.provide('e2b', { cwd: '/workspace', getSandbox: async () => sandbox } as unknown as E2BSandboxService)
    const backend = new E2BPtyBackend(ctx, config(), async () => created)
    const rejected = expect(backend.spawn({ sessionId: PtySessionId('failed-clean'), owner: owner(ctx), type: 'shell' }))
      .rejects.toThrow('startup timeout')
    await vi.advanceTimersByTimeAsync(6)
    await rejected
    vi.useRealTimers()
  })

  it('validates configuration and registers the selected backend type', async () => {
    const valid = config()
    expect(() => { validateConfig(valid) }).not.toThrow()
    for (const invalid of [
      { ...valid, backendType: '' },
      { ...valid, rows: 0 },
      { ...valid, rows: 1.5 },
      { ...valid, maxReadBytes: 129 },
    ]) {
      expect(() => { validateConfig(invalid) }).toThrow()
    }

    const registerBackend = vi.fn()
    apply({ pty: { registerBackend } } as unknown as Context, valid)
    expect(registerBackend).toHaveBeenCalledWith(expect.objectContaining({ type: 'shell' }))

    const ctx = new Context()
    await ctx.plugin(PtyService)
    ctx.provide('e2b', { cwd: '/workspace', getSandbox: async () => ({}) } as never)
    const fiber = await ctx.plugin({
      inject: ['pty', 'e2b'],
      apply: (pluginCtx: Context) => { apply(pluginCtx, valid) },
    })
    expect(ctx.pty.listBackends()).toEqual(['shell'])
    await fiber.dispose()
  })

  it('registers the package-owned invariant companion', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService, { enabled: true })
    const fiber = await ctx.plugin(E2BPtyInvariant).await()
    await fiber.dispose()
  })
})
