import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import {
  CommandExitError,
  FileNotFoundError,
  type CommandHandle,
  type CommandResult,
  type Sandbox,
} from '@deepseek-ai/dsh-e2b'
import type E2BSandboxService from '@deepseek-ai/dsh-e2b'
import type { SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import E2BSubprocessService from '@deepseek-ai/dsh-subprocess-e2b'
import { E2BTerminalHandle, spawnE2BTerminal } from '../src/terminal.ts'

function commandError(exitCode: number): CommandExitError {
  return new CommandExitError({ exitCode, stdout: '', stderr: '', error: `exit ${exitCode}` })
}

interface CommandOptions {
  signal?: AbortSignal
  cwd?: string
}

class FakeTerminalCommandHandle {
  pid = 123
  disconnects = 0
  sdkKills = 0
  disconnectError: unknown
  sdkKillError: unknown
  private readonly result = Promise.withResolvers<CommandResult>()
  private settled = false

  wait(): Promise<CommandResult> {
    return this.result.promise
  }

  async disconnect(): Promise<void> {
    this.disconnects += 1
    if (this.disconnectError !== undefined) throw this.disconnectError
  }

  async kill(): Promise<boolean> {
    this.sdkKills += 1
    if (this.sdkKillError !== undefined) {
      const error = this.sdkKillError
      this.fail(137)
      throw error
    }
    this.fail(137)
    return true
  }

  succeed(exitCode = 0): void {
    if (this.settled) return
    this.settled = true
    this.result.resolve({ exitCode, stdout: '', stderr: '' })
  }

  fail(exitCode: number): void {
    if (this.settled) return
    this.settled = true
    this.result.reject(commandError(exitCode))
  }

  crash(error: unknown): void {
    if (this.settled) return
    this.settled = true
    this.result.reject(error)
  }

  asHandle(): CommandHandle {
    return this as unknown as CommandHandle
  }
}

class FakeTerminalSandbox {
  readonly handle = new FakeTerminalCommandHandle()
  readonly commands: string[] = []
  readonly commandOptions: CommandOptions[] = []
  readonly inputs: Array<{ pid: number; data: Buffer }> = []
  readonly removed: string[] = []
  readonly directories: string[] = []
  readonly writes = new Map<string, string>()
  createOptions: Parameters<Sandbox['pty']['create']>[0] | undefined
  ambient = 'KEEP=visible\0NPM_TOKEN=secret\0DSH_STALE=old\0BROKEN\0=bad\0'
  ready: string | Error = 'ready\n'
  readyMisses = 0
  sessionId = '123\n'
  foreground = '456\n'
  groups = [123]
  createError: unknown
  sendError: unknown
  commandFailure: unknown
  foregroundFailure: unknown
  termFailure: unknown
  removeError: unknown
  clearOnTerm = true
  clearOnKill = true
  settleOnPtyKill = true
  ptyKills = 0
  resolvedExecutable = '/usr/bin/node\n'

  readonly sandbox = {
    files: {
      makeDir: async (path: string): Promise<boolean> => {
        this.directories.push(path)
        return true
      },
      write: async (files: Array<{ path: string; data: string }>): Promise<object[]> => {
        for (const file of files) this.writes.set(file.path, file.data)
        return files.map(() => ({}))
      },
      read: async (): Promise<string> => {
        if (this.readyMisses > 0) {
          this.readyMisses -= 1
          throw new FileNotFoundError('not ready')
        }
        if (this.ready instanceof Error) throw this.ready
        return this.ready
      },
      remove: async (path: string): Promise<void> => {
        this.removed.push(path)
        if (this.removeError !== undefined) throw this.removeError
      },
    },
    commands: {
      run: async (command: string, options?: CommandOptions): Promise<CommandResult> => {
        this.commands.push(command)
        if (options !== undefined) this.commandOptions.push(options)
        options?.signal?.throwIfAborted()
        if (this.commandFailure !== undefined) {
          const error = this.commandFailure
          this.commandFailure = undefined
          throw error
        }
        if (command === 'env -0') return { exitCode: 0, stdout: this.ambient, stderr: '' }
        if (command.includes('command -v -- ')) {
          return { exitCode: 0, stdout: this.resolvedExecutable, stderr: '' }
        }
        if (command.startsWith('ps -o sid=')) return { exitCode: 0, stdout: this.sessionId, stderr: '' }
        if (command.startsWith('ps -o tpgid=')) {
          if (this.foregroundFailure !== undefined) throw this.foregroundFailure
          return { exitCode: 0, stdout: this.foreground, stderr: '' }
        }
        if (command.startsWith('ps -eo sid=')) {
          return { exitCode: 0, stdout: this.groups.map(group => `${group}\n`).join(''), stderr: '' }
        }
        if (command.startsWith('kill -TERM -- ')) {
          if (this.termFailure !== undefined) throw this.termFailure
          if (this.clearOnTerm) {
            this.groups = []
            this.handle.fail(143)
          }
        }
        if (command.startsWith('kill -KILL -- ') && this.clearOnKill) this.groups = []
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    pty: {
      create: async (options: Parameters<Sandbox['pty']['create']>[0]): Promise<CommandHandle> => {
        this.createOptions = options
        if (this.createError !== undefined) throw this.createError
        await options.onData(Buffer.from('buffered banner\n'))
        return this.handle.asHandle()
      },
      sendInput: async (pid: number, data: Uint8Array, options?: { signal?: AbortSignal }): Promise<void> => {
        options?.signal?.throwIfAborted()
        this.inputs.push({ pid, data: Buffer.from(data) })
        if (this.sendError !== undefined) throw this.sendError
      },
      kill: async (pid: number): Promise<boolean> => {
        this.ptyKills += 1
        if (this.settleOnPtyKill) this.handle.fail(137)
        return pid === this.handle.pid
      },
    },
  } as unknown as Sandbox
}

function runtime(fake: FakeTerminalSandbox): E2BSandboxService {
  return {
    cwd: '/workspace',
    runtimeRoot: '/workspace/.dsh-e2b',
    disposeMode: 'kill',
    getSandbox: async () => fake.sandbox,
  } as unknown as E2BSandboxService
}

function spec(overrides: Partial<SubprocessTerminalSpawnSpec> = {}): SubprocessTerminalSpawnSpec {
  return {
    argv: ['/bin/bash', '--noprofile', '--norc'],
    cwd: '/workspace',
    rows: 24,
    cols: 80,
    graceMs: 5,
    env: { TERM: 'dumb', DSH_SESSION_ID: 'owner', TOKEN_EXPLICIT: 'kept' },
    ...overrides,
  }
}

describe('E2B terminal allocation', () => {
  it('boots the requested argv through a private runner and preserves buffered bytes', async () => {
    const fake = new FakeTerminalSandbox()
    fake.readyMisses = 1
    const terminal = await spawnE2BTerminal(runtime(fake), spec(), '/runtime/terminal-one')
    let output = ''
    terminal.output.on('data', (chunk) => { output += String(chunk) })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(output).toBe('buffered banner\n')
    expect(fake.createOptions).toMatchObject({ rows: 24, cols: 80, cwd: '/workspace', timeoutMs: 0, envs: { TERM: 'dumb' } })
    expect(fake.inputs[0]?.data.toString()).toContain("exec /bin/bash '/runtime/terminal-one/runner.bash'")
    expect(fake.writes.get('/runtime/terminal-one/environment')).toContain('KEEP=visible\0')
    expect(fake.writes.get('/runtime/terminal-one/environment')).toContain('TOKEN_EXPLICIT=kept\0')
    expect(fake.writes.get('/runtime/terminal-one/environment')).not.toContain('secret')
    expect(fake.writes.get('/runtime/terminal-one/environment')).not.toContain('DSH_STALE')
    expect(fake.writes.get('/runtime/terminal-one/argv')).toBe('/bin/bash\0--noprofile\0--norc\0')
    const runner = fake.writes.get('/runtime/terminal-one/runner.bash') ?? ''
    expect(runner).toContain('if (( ${#dsh_argv[@]} == 0 )); then')
    expect(runner).toContain('exec env -i "${dsh_env[@]}" "${dsh_argv[@]}"')
    expect(runner).not.toContain('\u007f')

    await terminal.write(Buffer.from('echo ok\r'))
    expect(fake.inputs.at(-1)?.data.toString()).toBe('echo ok\r')
    await expect(terminal.inspectForeground()).resolves.toEqual({ processGroupId: 456, inputWaiting: false })
    await expect(terminal.signalForeground('SIGINT')).resolves.toBe(456)
    expect(fake.commands).toContain('kill -INT -- -456')

    terminal.terminate()
    await expect(terminal.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    await expect(terminal.waitForExit()).resolves.toBe(true)
    expect(fake.handle.disconnects).toBe(1)
    expect(fake.removed).toContain('/runtime/terminal-one')
  })

  it('inherits only safe ambient values and binds live abort to terminal cleanup', async () => {
    const fake = new FakeTerminalSandbox()
    const controller = new AbortController()
    const terminal = await spawnE2BTerminal(
      runtime(fake),
      spec({ env: undefined, signal: controller.signal }),
      '/runtime/abort-live',
    )
    const environment = fake.writes.get('/runtime/abort-live/environment') ?? ''
    expect(environment).toContain('KEEP=visible\0')
    expect(environment).not.toContain('secret')
    expect(environment).not.toContain('DSH_STALE')

    controller.abort(new Error('stop'))
    await expect(terminal.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    await expect(terminal.waitForExit(controller.signal)).resolves.toBe(false)
    await expect(terminal.waitForExit()).resolves.toBe(true)
  })

  it('rejects malformed environment and argv values before PTY allocation', async () => {
    const invalidName = new FakeTerminalSandbox()
    await expect(spawnE2BTerminal(runtime(invalidName), spec({ env: { 'BAD=NAME': 'x' } }), '/runtime/name'))
      .rejects.toThrow('environment entries')
    expect(invalidName.createOptions).toBeUndefined()

    const invalidValue = new FakeTerminalSandbox()
    await expect(spawnE2BTerminal(runtime(invalidValue), spec({ env: { BAD: 'x\0y' } }), '/runtime/value'))
      .rejects.toThrow('environment entries')

    const invalidArg = new FakeTerminalSandbox()
    await expect(spawnE2BTerminal(runtime(invalidArg), spec({ argv: ['/bin/bash', 'x\0y'] }), '/runtime/argv'))
      .rejects.toThrow('argv must not contain NUL')
  })

  it('cleans malformed handles, bootstrap failures, and readiness failures', async () => {
    const invalidPid = new FakeTerminalSandbox()
    invalidPid.handle.pid = 0
    await expect(spawnE2BTerminal(runtime(invalidPid), spec(), '/runtime/invalid-pid'))
      .rejects.toThrow('invalid terminal pid 0')
    expect(invalidPid.handle.sdkKills).toBe(1)
    expect(invalidPid.removed).toContain('/runtime/invalid-pid')

    const failedInput = new FakeTerminalSandbox()
    failedInput.sendError = new Error('bootstrap failed')
    await expect(spawnE2BTerminal(runtime(failedInput), spec(), '/runtime/input'))
      .rejects.toThrow('bootstrap failed')
    expect(failedInput.handle.sdkKills).toBe(1)

    const exited = new FakeTerminalSandbox()
    exited.ready = new FileNotFoundError('not ready')
    queueMicrotask(() => { exited.handle.succeed(0) })
    await expect(spawnE2BTerminal(runtime(exited), spec(), '/runtime/exited'))
      .rejects.toThrow('exited before publishing readiness')

    const invalidSession = new FakeTerminalSandbox()
    invalidSession.sessionId = 'not-a-session\n'
    await expect(spawnE2BTerminal(runtime(invalidSession), spec(), '/runtime/session'))
      .rejects.toThrow('cannot resolve process session')
    expect(invalidSession.handle.sdkKills).toBe(1)
    const lateData = invalidSession.createOptions?.onData
    if (lateData === undefined) throw new Error('missing captured terminal callback')
    expect(lateData(Buffer.from('late bytes'))).toBeUndefined()

    const cleanupFailed = new FakeTerminalSandbox()
    cleanupFailed.handle.pid = 0
    cleanupFailed.handle.sdkKillError = new Error('kill transport failed')
    cleanupFailed.removeError = new Error('remove transport failed')
    await expect(spawnE2BTerminal(runtime(cleanupFailed), spec(), '/runtime/cleanup-failed'))
      .rejects.toThrow('invalid terminal pid 0')
  })

  it('propagates setup cancellation and provider failures', async () => {
    const aborted = new FakeTerminalSandbox()
    await expect(spawnE2BTerminal(runtime(aborted), spec({ signal: AbortSignal.abort(new Error('stop')) }), '/runtime/abort'))
      .rejects.toThrow('stop')

    const createFailed = new FakeTerminalSandbox()
    createFailed.createError = new Error('create failed')
    await expect(spawnE2BTerminal(runtime(createFailed), spec(), '/runtime/create'))
      .rejects.toThrow('create failed')

    const readFailed = new FakeTerminalSandbox()
    readFailed.ready = new Error('ready transport failed')
    await expect(spawnE2BTerminal(runtime(readFailed), spec(), '/runtime/read'))
      .rejects.toThrow('ready transport failed')
  })
})

describe('E2B terminal lifecycle', () => {
  it('maps ordinary exits, closes output, and reports an absent foreground after exit', async () => {
    const fake = new FakeTerminalSandbox()
    fake.groups = []
    const terminal = await spawnE2BTerminal(runtime(fake), spec(), '/runtime/natural')
    terminal.output.resume()
    const ended = once(terminal.output, 'end')
    fake.handle.succeed(7)
    await expect(terminal.done).resolves.toEqual({ exitCode: 7, signal: null })
    await ended
    await expect(terminal.waitForExit()).resolves.toBe(true)
    await expect(terminal.write(Buffer.from('late'))).rejects.toThrow('exited')
    fake.foregroundFailure = commandError(1)
    await expect(terminal.inspectForeground()).resolves.toBeUndefined()
    await expect(terminal.signalForeground('SIGINT')).rejects.toThrow('cannot resolve foreground process group')
  })

  it('starts cleanup when the lifetime signal is already aborted at handle publication', async () => {
    const fake = new FakeTerminalSandbox()
    const controller = new AbortController()
    controller.abort(new Error('publication cancelled'))
    const terminal = new E2BTerminalHandle(
      fake.sandbox,
      fake.handle.asHandle(),
      new PassThrough(),
      fake.handle.wait(),
      123,
      '/runtime/pre-aborted',
      1,
      controller.signal,
    )

    await expect(terminal.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    await expect(terminal.waitForExit()).resolves.toBe(true)
  })

  it.each([
    [7, { exitCode: 7, signal: null }],
    [143, { exitCode: null, signal: 'SIGTERM' }],
    [255, { exitCode: 255, signal: null }],
  ] as const)('classifies an unrequested command exit %i', async (exitCode, expected) => {
    const fake = new FakeTerminalSandbox()
    fake.groups = []
    const terminal = await spawnE2BTerminal(runtime(fake), spec(), `/runtime/exit-${exitCode}`)
    fake.handle.fail(exitCode)
    await expect(terminal.done).resolves.toEqual(expected)
    await expect(terminal.waitForExit(new AbortController().signal)).resolves.toBe(true)
  })

  it('lets an early quiescence observer follow a transport rejection', async () => {
    const fake = new FakeTerminalSandbox()
    fake.groups = []
    const terminal = await spawnE2BTerminal(runtime(fake), spec(), '/runtime/early-observer')
    terminal.output.on('error', () => {})
    const quiescence = terminal.waitForExit()
    fake.handle.crash(new Error('transport failed'))
    await expect(terminal.done).rejects.toThrow('transport failed')
    await expect(quiescence).resolves.toBe(true)
  })

  it('rejects killing the terminal shell and propagates live foreground failures', async () => {
    const fake = new FakeTerminalSandbox()
    fake.foreground = '123\n'
    const terminal = await spawnE2BTerminal(runtime(fake), spec(), '/runtime/signal')
    await expect(terminal.signalForeground('SIGKILL')).rejects.toThrow('refusing to SIGKILL')
    fake.foreground = 'invalid\n'
    await expect(terminal.inspectForeground()).rejects.toThrow('cannot resolve foreground')
    fake.foregroundFailure = commandError(1)
    await expect(terminal.inspectForeground()).rejects.toBeInstanceOf(CommandExitError)
    fake.clearOnTerm = true
    terminal.terminate()
    await terminal.waitForExit()
  })

  it('escalates surviving process groups and bounds an observing wait', async () => {
    const fake = new FakeTerminalSandbox()
    fake.groups = [123, 456]
    fake.clearOnTerm = false
    const terminal = await spawnE2BTerminal(runtime(fake), spec({ graceMs: 1 }), '/runtime/escalate')
    const controller = new AbortController()
    const observing = terminal.waitForExit(controller.signal)
    controller.abort()
    await expect(observing).resolves.toBe(false)

    terminal.terminate()
    await expect(terminal.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
    await expect(terminal.waitForExit()).resolves.toBe(true)
    expect(fake.commands).toContain('kill -TERM -- -123 -456')
    expect(fake.commands).toContain('kill -KILL -- -123 -456')
  })

  it('surfaces cleanup failures and allows a later retry', async () => {
    const fake = new FakeTerminalSandbox()
    fake.groups = [1]
    const terminal = await spawnE2BTerminal(runtime(fake), spec({ graceMs: 1 }), '/runtime/retry')
    terminal.terminate()
    await expect(terminal.waitForExit(new AbortController().signal)).rejects.toThrow('unsafe process group 1')

    fake.groups = []
    fake.handle.succeed(0)
    await terminal.done
    terminal.terminate()
    await expect(terminal.waitForExit()).resolves.toBe(true)
  })

  it('propagates a process-group signalling transport failure before retry', async () => {
    const fake = new FakeTerminalSandbox()
    fake.termFailure = new Error('signal transport failed')
    const terminal = await spawnE2BTerminal(runtime(fake), spec({ graceMs: 1 }), '/runtime/signal-failure')
    terminal.terminate()
    await expect(terminal.waitForExit()).rejects.toThrow('signal transport failed')

    fake.groups = []
    fake.handle.succeed(0)
    await terminal.done
    terminal.terminate()
    await expect(terminal.waitForExit()).resolves.toBe(true)

    const alreadyExited = new FakeTerminalSandbox()
    alreadyExited.termFailure = commandError(1)
    const tolerant = await spawnE2BTerminal(runtime(alreadyExited), spec({ graceMs: 1 }), '/runtime/group-exited')
    tolerant.terminate()
    await expect(tolerant.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
    await expect(tolerant.waitForExit()).resolves.toBe(true)
  })

  it('normalizes a non-Error cleanup rejection for an observing wait', async () => {
    const fake = new FakeTerminalSandbox()
    const terminal = await spawnE2BTerminal(runtime(fake), spec(), '/runtime/non-error-cleanup')
    fake.commandFailure = 'cleanup transport gone'
    terminal.terminate()
    await expect(terminal.waitForExit(new AbortController().signal)).rejects.toThrow('cleanup transport gone')

    fake.groups = []
    fake.handle.succeed(0)
    await terminal.done
    terminal.terminate()
    await expect(terminal.waitForExit()).resolves.toBe(true)
  })

  it('keeps command rejection authoritative while cleanup is already waiting', async () => {
    const fake = new FakeTerminalSandbox()
    fake.groups = []
    fake.removeError = new Error('private state already gone')
    const terminal = await spawnE2BTerminal(runtime(fake), spec(), '/runtime/reject-during-cleanup')
    terminal.output.on('error', () => {})
    terminal.terminate()
    await Promise.resolve()
    fake.handle.crash(new Error('command transport failed'))
    await expect(terminal.done).rejects.toThrow('command transport failed')
    await expect(terminal.waitForExit()).resolves.toBe(true)
  })

  it('keeps a late command rejection authoritative after PTY kill', async () => {
    const fake = new FakeTerminalSandbox()
    fake.groups = []
    fake.settleOnPtyKill = false
    const terminal = await spawnE2BTerminal(runtime(fake), spec({ graceMs: 1 }), '/runtime/reject-after-kill')
    terminal.output.on('error', () => {})
    terminal.terminate()
    while (fake.ptyKills === 0) await new Promise(resolve => setTimeout(resolve, 0))
    await Promise.resolve()
    fake.handle.crash(new Error('late command transport failed'))
    await expect(terminal.done).rejects.toThrow('late command transport failed')
    await expect(terminal.waitForExit()).resolves.toBe(true)
  })

  it('reports surviving groups, a surviving top-level pid, and transport failure', async () => {
    const survivor = new FakeTerminalSandbox()
    survivor.clearOnTerm = false
    survivor.clearOnKill = false
    const terminal = await spawnE2BTerminal(runtime(survivor), spec({ graceMs: 1 }), '/runtime/survivor')
    terminal.terminate()
    await expect(terminal.waitForExit()).rejects.toThrow('surviving process groups: 123')

    const livePid = new FakeTerminalSandbox()
    livePid.groups = []
    livePid.settleOnPtyKill = false
    const live = await spawnE2BTerminal(runtime(livePid), spec({ graceMs: 1 }), '/runtime/live-pid')
    live.terminate()
    await expect(live.waitForExit()).rejects.toThrow('surviving pid: 123')
    livePid.handle.succeed(0)
    await live.done

    const crashed = new FakeTerminalSandbox()
    crashed.groups = []
    const failed = await spawnE2BTerminal(runtime(crashed), spec(), '/runtime/crashed')
    const outputError = once(failed.output, 'error')
    crashed.handle.crash('transport gone')
    await expect(failed.done).rejects.toEqual('transport gone')
    await expect(outputError).resolves.toMatchObject([{ message: 'transport gone' }])
    await expect(failed.waitForExit()).resolves.toBe(true)
  })
})

describe('E2B subprocess terminal service', () => {
  async function service(fake = new FakeTerminalSandbox()): Promise<{
    ctx: Context
    fiber: Awaited<ReturnType<Context['plugin']>>
    fake: FakeTerminalSandbox
  }> {
    const ctx = new Context()
    ctx.provide('e2b', runtime(fake))
    const fiber = await ctx.plugin(E2BSubprocessService)
    return { ctx, fiber, fake }
  }

  it('publishes execution-world coordinates and resolves remote executables', async () => {
    const { ctx, fake } = await service()
    expect(ctx.subprocess.cwd).toBe('/workspace')
    expect(ctx.subprocess.runtimeRoot).toBe('/workspace/.dsh-e2b')
    await expect(ctx.subprocess.resolveExecutable('/bin/bash')).resolves.toBe('/bin/bash')
    await expect(ctx.subprocess.resolveExecutable('node', { PATH: '/custom/bin' }, new AbortController().signal))
      .resolves.toBe('/usr/bin/node')
    fake.resolvedExecutable = 'tools/bin/node\n'
    await expect(ctx.subprocess.resolveExecutable('node', { PATH: 'tools/bin' }))
      .resolves.toBe('/workspace/tools/bin/node')
    expect(fake.commandOptions.at(-1)).toMatchObject({ cwd: '/workspace' })
    expect((ctx.e2b)).toBeDefined()
  })

  it('rejects invalid executable lookup inputs and results', async () => {
    const { ctx, fake } = await service()
    await expect(ctx.subprocess.resolveExecutable('')).rejects.toThrow('non-empty')
    await expect(ctx.subprocess.resolveExecutable('node', undefined, AbortSignal.abort(new Error('stop'))))
      .rejects.toThrow('stop')
    fake.resolvedExecutable = 'node\n'
    await expect(ctx.subprocess.resolveExecutable('node')).rejects.toThrow('did not resolve')
    fake.resolvedExecutable = '/one\n/two\n'
    await expect(ctx.subprocess.resolveExecutable('node')).rejects.toThrow('did not resolve')
  })

  it('owns live terminals through service disposal', async () => {
    const { ctx, fiber, fake } = await service()
    const terminal = await ctx.subprocess.spawnTerminal(spec())
    await fiber.dispose()
    await expect(terminal.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    expect(fake.handle.disconnects).toBe(1)
  })

  it('releases naturally settled terminals and validates terminal requests', async () => {
    const { ctx, fiber, fake } = await service()
    for (const request of [
      spec({ argv: [] }),
      spec({ rows: 0 }),
      spec({ cols: 1.5 }),
      spec({ graceMs: 0 }),
      spec({ signal: AbortSignal.abort(new Error('cancelled')) }),
    ]) {
      await expect(ctx.subprocess.spawnTerminal(request)).rejects.toThrow()
    }

    fake.groups = []
    const terminal = await ctx.subprocess.spawnTerminal(spec())
    fake.handle.succeed(0)
    await terminal.done
    await terminal.waitForExit()
    const signals = fake.commands.filter(command => command.startsWith('kill -')).length
    await fiber.dispose()
    expect(fake.commands.filter(command => command.startsWith('kill -'))).toHaveLength(signals)
  })

  it('contains a failed automatic terminal release until service disposal retries it', async () => {
    const { fiber, fake } = await service()
    fake.clearOnTerm = false
    fake.clearOnKill = false
    const terminal = await (fiber.ctx).subprocess.spawnTerminal(spec({ graceMs: 1 }))
    fake.handle.succeed(0)
    await terminal.done
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fake.commands).toContain('kill -KILL -- -123')

    fake.groups = []
    await fiber.dispose()
    await expect(terminal.waitForExit()).resolves.toBe(true)
  })
})
