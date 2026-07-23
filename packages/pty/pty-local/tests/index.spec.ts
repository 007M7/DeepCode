import { describe, expect, it, vi } from 'vitest'
import type { IPty, IPtyForkOptions } from 'node-pty'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import PtyService, { PtySessionId } from '@deepseek-ai/dsh-pty'
import { LocalPtyBackend } from '@deepseek-ai/dsh-pty-local'
import * as ptyLocal from '@deepseek-ai/dsh-pty-local'
import type { ResolvedConfig } from '@deepseek-ai/dsh-pty-local/src/config.ts'
import type { ProcessInspector } from '@deepseek-ai/dsh-pty-local/src/process-inspector.ts'
import type { LocalPtySession } from '@deepseek-ai/dsh-pty-local/src/session.ts'

class EmptySandbox extends SandboxProvider {
  confine(_argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return { argv: [], enforcement: 'full', denialSignatures: [], runnerFailureSignatures: [] }
  }
}

class RecordingSandbox extends SandboxProvider {
  calls: { argv: readonly string[]; policy: SandboxPolicy }[] = []

  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    this.calls.push({ argv, policy })
    return { argv: ['/sandbox', '--', ...argv], enforcement: 'full', denialSignatures: [], runnerFailureSignatures: [] }
  }
}

function config(): ResolvedConfig {
  return {
    backendType: 'shell', shellPath: '/bin/bash', shellArgs: [], rows: 24, cols: 80,
    scrollbackLines: 10, scrollbackMaxBytes: 100, maxReadBytes: 50,
    pollIntervalMs: 10, exactProbeAfterMs: 20, idleSilenceMs: 50, timeoutMs: 100,
    disposeGraceMs: 10,
  }
}

function agent(ctx: Context): Agent {
  const id = SessionId('agent')
  return {
    id, options: {}, session: new Session(id), status: 'idle', ctx,
    send() {}, steer() {}, inject() {}, cancel() {}, whenIdle: () => Promise.resolve(),
  }
}

const inspector = {
  foregroundPgid: () => undefined,
  isStdinWaiting: () => false,
  processTree: () => [],
  isAlive: () => false,
  signalGroup() {},
  signalProcess() {},
} satisfies ProcessInspector

function spec(owner: Agent, signal?: AbortSignal) {
  return {
    sessionId: PtySessionId('pty-1'), owner, type: 'shell',
    ...signal !== undefined ? { signal } : {},
  }
}

describe('LocalPtyBackend startup rollback', () => {
  it('rejects pre-aborted setup and empty sandbox argv', async () => {
    const ctx = new Context()
    await ctx.plugin(EmptySandbox)
    await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: '/tmp' })
    const backend = new LocalPtyBackend(ctx, config(), inspector)
    const controller = new AbortController()
    controller.abort()
    await expect(backend.spawn(spec(agent(ctx), controller.signal))).rejects.toThrow('spawn aborted')
    await expect(backend.spawn(spec(agent(ctx)))).rejects.toThrow('empty argv')
  })

  it('closes failed startup and aggregates cleanup failure', async () => {
    const ctx = new Context()
    await ctx.plugin(EmptySandbox)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/tmp' })
    const spawnTerminal = (() => ({} as IPty)) as never

    const closed = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const failed = { initialize: () => Promise.reject(new Error('startup failed')), close: closed } as unknown as LocalPtySession
    const backend = new LocalPtyBackend(ctx, config(), inspector, spawnTerminal, () => failed)
    await expect(backend.spawn(spec(agent(ctx)))).rejects.toThrow('startup failed')
    expect(closed).toHaveBeenCalledWith('PTY startup failed')

    const doublyFailed = {
      initialize: () => Promise.reject(new Error('startup failed')),
      close: () => Promise.reject(new Error('cleanup failed')),
    } as unknown as LocalPtySession
    const aggregate = new LocalPtyBackend(ctx, config(), inspector, spawnTerminal, () => doublyFailed)
    await expect(aggregate.spawn(spec(agent(ctx)))).rejects.toThrow('startup and cleanup both failed')
  })

  it('wraps confined argv, scrubs the environment, and returns initialized sessions', async () => {
    const ctx = new Context()
    await ctx.plugin(RecordingSandbox)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/workspace' })
    const terminal = {} as IPty
    let spawned: { file: string; args: string[]; options: IPtyForkOptions } | undefined
    const spawnTerminal = ((file: string, args: string[], options: IPtyForkOptions) => {
      spawned = { file, args, options }
      return terminal
    }) as never
    const initialized = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const session = { initialize: initialized } as unknown as LocalPtySession
    const backend = new LocalPtyBackend(
      ctx,
      { ...config(), shellArgs: ['-i'] },
      inspector,
      spawnTerminal,
      () => session,
    )
    const previous = process.env.PTY_TEST_SECRET
    process.env.PTY_TEST_SECRET = 'must-not-leak'
    try {
      expect(await backend.spawn({ ...spec(agent(ctx)), cwd: '/work' })).toBe(session)
    } finally {
      if (previous === undefined) delete process.env.PTY_TEST_SECRET
      else process.env.PTY_TEST_SECRET = previous
    }

    expect(spawned).toMatchObject({
      file: '/sandbox',
      args: ['--', '/bin/bash', '-i'],
      options: {
        name: 'dumb', cols: 80, rows: 24, cwd: '/work',
        env: {
          TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', PS1: 'dsh> ', BASH_SILENCE_DEPRECATION_WARNING: '1',
          DSH_SHELL: '1', DSH_SESSION_ID: 'agent', DSH_PTY_SESSION_ID: 'pty-1',
        },
      },
    })
    expect(spawned?.options.env?.PTY_TEST_SECRET).toBeUndefined()
    expect(initialized).toHaveBeenCalledWith(undefined)
  })

  it('composes the default local session around a spawned terminal', async () => {
    const ctx = new Context()
    await ctx.plugin(EmptySandbox)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/workspace' })
    let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined
    const terminal = {
      pid: 123, cols: 80, rows: 24, process: 'bash', handleFlowControl: false,
      onData(listener: (data: string) => void) {
        queueMicrotask(() => { listener('\x1b]133;D;0\x07dsh> ') })
        return { dispose() {} }
      },
      onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
        exitListener = listener
        return { dispose() {} }
      },
      write() {},
      kill() { exitListener?.({ exitCode: 0, signal: 15 }) },
      resize() {}, clear() {}, pause() {}, resume() {},
    } as IPty
    const backend = new LocalPtyBackend(ctx, config(), inspector, () => terminal)
    const session = await backend.spawn(spec(agent(ctx)))
    expect(session.motd).toBe('dsh> ')
    await session.close('test complete')
  })
})

describe('pty-local plugin shape', () => {
  it('keeps name, inject, and Config through Loader unwrapExports', () => {
    expect('default' in ptyLocal).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(ptyLocal) as Record<string, unknown>
    expect(unwrapped.name).toBe('pty-local')
    expect(unwrapped.inject).toEqual(['pty', 'sandbox', 'sandboxPolicy'])
    expect(unwrapped.Config).toBeDefined()
  })

  it('validates config and registers the configured backend', async () => {
    const ctx = new Context()
    await ctx.plugin(PtyService)
    await ctx.plugin(EmptySandbox)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/tmp' })
    const fiber = await ctx.plugin(ptyLocal, config())
    expect(ctx.pty.listBackends()).toEqual(['shell'])
    await fiber.dispose()
    expect(ctx.pty.listBackends()).toEqual([])
  })
})
