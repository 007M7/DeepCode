import { once } from 'node:events'
import { Context } from 'cordis'
import {
  CommandExitError,
  type CommandHandle,
  type CommandResult,
  type Sandbox,
} from '@deepseek-ai/dsh-e2b'
import type E2BSandboxService from '@deepseek-ai/dsh-e2b'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import E2BSubprocessService from '@deepseek-ai/dsh-subprocess-e2b'
import * as E2BSubprocessInvariant from '../src/invariant.ts'
import { E2BOutputReader } from '../src/output.ts'
import { E2BSubprocessHandle } from '../src/process.ts'
import InvariantService from '@deepseek-ai/dsh-invariants'
import { describe, expect, it, vi } from 'vitest'

function commandError(exitCode: number): CommandExitError {
  return new CommandExitError({ exitCode, stdout: '', stderr: '', error: `exit ${exitCode}` })
}

interface StartOptions {
  background: true
  cwd: string
  stdin: boolean
  timeoutMs: number
  signal?: AbortSignal
  envs?: Record<string, string>
  onStdout?: (data: string) => void | Promise<void>
  onStderr?: (data: string) => void | Promise<void>
}

class FakeCommandHandle {
  pid = 4242
  readonly sent: Array<string | Uint8Array> = []
  closes = 0
  kills = 0
  killError: unknown
  private readonly result = Promise.withResolvers<CommandResult>()
  private settled = false

  wait(): Promise<CommandResult> {
    return this.result.promise
  }

  async sendStdin(data: string | Uint8Array): Promise<void> {
    this.sent.push(data)
  }

  async closeStdin(): Promise<void> {
    this.closes += 1
  }

  async kill(): Promise<boolean> {
    this.kills += 1
    if (this.killError !== undefined) throw this.killError
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
}

class FakeSandbox {
  readonly handle = new FakeCommandHandle()
  readonly commandsSeen: string[] = []
  readonly writtenFiles: string[][] = []
  readonly writtenFileData = new Map<string, string>()
  readonly removed: string[] = []
  readonly directories: string[] = []
  startOptions: StartOptions | undefined
  backgroundError: unknown
  nextRemoveError: unknown
  probeError: unknown
  signalError: unknown
  trapsTerm = false
  alive = true
  processGroupId = '4242\n'
  readonly processGroupReads: string[] = []
  beforeProbe: (() => void) | undefined
  afterProbe: (() => void) | undefined
  private startGate: Promise<void> | undefined
  private openStart: (() => void) | undefined

  deferStart(): void {
    const gate = Promise.withResolvers<undefined>()
    this.startGate = gate.promise
    this.openStart = () => { gate.resolve(undefined) }
  }

  releaseStart(): void {
    this.openStart?.()
  }

  finish(exitCode = 0): void {
    this.alive = false
    if (exitCode === 0) this.handle.succeed(0)
    else this.handle.fail(exitCode)
  }

  async stdout(data: string): Promise<void> {
    await this.startOptions?.onStdout?.(data)
  }

  async stderr(data: string): Promise<void> {
    await this.startOptions?.onStderr?.(data)
  }

  readonly sandbox = {
    sandboxId: 'fake',
    files: {
      makeDir: async (path: string): Promise<boolean> => {
        this.directories.push(path)
        return true
      },
      write: async (files: Array<{ path: string; data: string }>): Promise<object[]> => {
        this.writtenFiles.push(files.map(file => file.path))
        for (const file of files) this.writtenFileData.set(file.path, file.data)
        return files.map(() => ({}))
      },
      read: async (): Promise<string> => this.processGroupReads.shift() ?? this.processGroupId,
      remove: async (path: string): Promise<void> => {
        this.removed.push(path)
        if (this.nextRemoveError !== undefined) {
          const error = this.nextRemoveError
          this.nextRemoveError = undefined
          throw error
        }
      },
    },
    commands: {
      run: async (command: string, options?: StartOptions | { signal?: AbortSignal }): Promise<CommandHandle | CommandResult> => {
        this.commandsSeen.push(command)
        if (command.startsWith('kill -0 ')) {
          this.beforeProbe?.()
          if (options?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
          if (this.probeError !== undefined) {
            const error = this.probeError
            this.probeError = undefined
            throw error
          }
          if (!this.alive) throw commandError(1)
          this.afterProbe?.()
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (command.startsWith('kill -TERM ')) {
          if (this.signalError !== undefined) {
            const error = this.signalError
            this.signalError = undefined
            throw error
          }
          if (!this.trapsTerm) {
            this.alive = false
            this.handle.fail(143)
          }
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (command.startsWith('kill -KILL ')) {
          if (this.signalError !== undefined) {
            const error = this.signalError
            this.signalError = undefined
            throw error
          }
          this.alive = false
          this.handle.fail(137)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if ((options as StartOptions | undefined)?.background === true) {
          this.startOptions = options as StartOptions
          await this.startGate
          if (this.backgroundError !== undefined) throw this.backgroundError
          return this.handle as unknown as CommandHandle
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  } as unknown as Sandbox
}

function spec(overrides: Partial<SubprocessSpawnSpec> = {}): SubprocessSpawnSpec {
  return {
    argv: ['bash', '-c', 'printf ok'],
    cwd: '/workspace',
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 4, spill: { maxBytes: 16 } },
      stderr: { maxBytes: 4 },
    },
    graceMs: 5,
    ...overrides,
  }
}

function runtime(fake: FakeSandbox, getSandbox: () => Promise<Sandbox> = async () => fake.sandbox): E2BSandboxService {
  return {
    cwd: '/workspace',
    runtimeRoot: '/workspace/.dsh-e2b',
    disposeMode: 'kill',
    getSandbox,
  } as unknown as E2BSandboxService
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('E2BOutputReader', () => {
  it('keeps a byte-exact tail with independent whole-stream cursors', () => {
    const reader = new E2BOutputReader(4, 10, '/remote/spill')
    reader.push('')
    reader.push('ab')
    reader.push('cdef')
    expect(reader.size).toBe(6)
    expect(reader.readFrom(0)).toEqual({ text: 'cdef', nextOffset: 6, lossy: true, spillPath: '/remote/spill' })
    expect(reader.readFrom(2)).toEqual({ text: 'cdef', nextOffset: 6, lossy: false })
    expect(reader.readFrom(5)).toEqual({ text: 'f', nextOffset: 6, lossy: false })
    expect(reader.readFrom(99)).toEqual({ text: '', nextOffset: 6, lossy: false })
  })

  it('drops whole head chunks and withholds absent or over-cap spills', () => {
    const withoutSpill = new E2BOutputReader(2, undefined, '/unused')
    withoutSpill.push('ab')
    withoutSpill.push('cd')
    expect(withoutSpill.readFrom(0)).toEqual({ text: 'cd', nextOffset: 4, lossy: true })
    const overCap = new E2BOutputReader(2, 3, '/too-small')
    overCap.push('abcd')
    expect(overCap.readFrom(0)).toEqual({ text: 'cd', nextOffset: 4, lossy: true })
    expect(() => overCap.readFrom(-1)).toThrow(/non-negative safe integer/)
    expect(() => overCap.readFrom(1.5)).toThrow(/non-negative safe integer/)
  })
})

describe('E2BSubprocessHandle', () => {
  it('starts asynchronously, keeps secrets out of the command, and supports deferred piped stdin/output', async () => {
    const fake = new FakeSandbox()
    fake.processGroupId = '4343\n'
    fake.deferStart()
    const handle = new E2BSubprocessHandle(runtime(fake), spec({
      argv: ['tool', 'argument with spaces'],
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 8, spill: { maxBytes: 32 } } },
      env: { PATH: '/bin', 'FOO-BAR': 'hyphen-value', DEEPSEEK_API_KEY: 'explicit-secret', DSH_MODE: 'test' },
    }), '/workspace/.dsh-e2b/processes/one')
    expect(handle.pid).toBe(-1)
    handle.stdin!.write('hello')
    handle.stdin!.end()
    fake.releaseStart()
    await flush()
    expect(handle.pid).toBe(4343)
    expect(fake.handle.sent.map(value => String(value))).toEqual(['hello'])
    expect(fake.handle.closes).toBe(1)
    expect(fake.startOptions?.envs).toBeUndefined()
    const command = fake.commandsSeen.find(value => value.startsWith('exec setsid'))!
    expect(command).toContain('exec setsid --wait -- bash -c')
    expect(command).not.toContain('DEEPSEEK_API_KEY')
    expect(command).not.toContain('DSH_MODE')
    expect(command).not.toContain('FOO-BAR')
    expect(command).not.toContain('explicit-secret')
    expect(command).not.toContain('hyphen-value')
    expect(command).not.toContain('${!dsh_e2b_name}')
    expect(command).toContain('env -0')
    expect(command).toContain('mapfile -d')
    expect(fake.writtenFiles[0]).toEqual([
      '/workspace/.dsh-e2b/processes/one/pid',
      '/workspace/.dsh-e2b/processes/one/exit-code',
      '/workspace/.dsh-e2b/processes/one/environment',
      '/workspace/.dsh-e2b/processes/one/stderr.log',
    ])
    expect(fake.writtenFileData.get('/workspace/.dsh-e2b/processes/one/environment')).toBe(
      'PATH=/bin\0FOO-BAR=hyphen-value\0DEEPSEEK_API_KEY=explicit-secret\0DSH_MODE=test\0',
    )

    let piped = ''
    handle.stdout!.on('data', (chunk) => { piped += String(chunk) })
    await fake.stdout('pipe-data')
    await fake.stderr('err')
    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(piped).toBe('pipe-data')
    expect(handle.collected.stderr!.readFrom(0)).toMatchObject({ text: 'err', lossy: false })
    expect(fake.removed).toContain('/workspace/.dsh-e2b/processes/one/stderr.log')
    await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it('surfaces deferred piped-stdin write and close failures as stream errors', async () => {
    const writeFake = new FakeSandbox()
    writeFake.deferStart()
    vi.spyOn(writeFake.handle, 'sendStdin').mockRejectedValueOnce('stdin rejected')
    const writeHandle = new E2BSubprocessHandle(runtime(writeFake), spec({
      stdio: { stdin: 'pipe', stdout: { maxBytes: 4 }, stderr: { maxBytes: 4 } },
    }), '/runtime/stdin-write-error')
    const writeError = once(writeHandle.stdin!, 'error')
    writeHandle.stdin!.write('input')
    writeFake.releaseStart()
    await expect(writeError).resolves.toMatchObject([{ message: 'stdin rejected' }])
    writeFake.finish()
    await writeHandle.done

    const closeFake = new FakeSandbox()
    vi.spyOn(closeFake.handle, 'closeStdin').mockRejectedValueOnce(new Error('close rejected'))
    const closeHandle = new E2BSubprocessHandle(runtime(closeFake), spec({
      stdio: { stdin: 'pipe', stdout: { maxBytes: 4 }, stderr: { maxBytes: 4 } },
    }), '/runtime/stdin-close-error')
    await flush()
    const closeError = once(closeHandle.stdin!, 'error')
    closeHandle.stdin!.end()
    await expect(closeError).resolves.toMatchObject([{ message: 'close rejected' }])
    closeFake.finish()
    await closeHandle.done
  })

  it('collects bounded tails, retains valid spills, and maps natural nonzero exits', async () => {
    const fake = new FakeSandbox()
    const handle = new E2BSubprocessHandle(runtime(fake), spec({
      stdio: {
        stdin: { data: 'batch' },
        stdout: { maxBytes: 4, spill: { maxBytes: 16 } },
        stderr: { maxBytes: 3 },
      },
    }), '/runtime/two')
    await flush()
    await fake.stdout('abcdef')
    await fake.stderr('12345')
    fake.finish(7)
    await expect(handle.done).resolves.toEqual({ exitCode: 7, signal: null })
    expect(fake.handle.sent).toEqual(['batch'])
    expect(fake.handle.closes).toBe(1)
    expect(handle.collected.stdout!.readFrom(0)).toEqual({
      text: 'cdef',
      nextOffset: 6,
      lossy: true,
      spillPath: '/runtime/two/stdout.log',
    })
    expect(handle.collected.stderr!.readFrom(0)).toEqual({ text: '345', nextOffset: 5, lossy: true })
    expect(fake.removed).not.toContain('/runtime/two/stdout.log')
  })

  it('removes a spill once the complete stream exceeds its cap', async () => {
    const fake = new FakeSandbox()
    const handle = new E2BSubprocessHandle(runtime(fake), spec({
      stdio: { stdin: 'ignore', stdout: { maxBytes: 2, spill: { maxBytes: 3 } }, stderr: 'inherit' },
    }), '/runtime/oversize')
    await flush()
    await fake.stdout('abcd')
    await fake.stderr('')
    fake.finish()
    await handle.done
    expect(handle.collected.stdout!.readFrom(0)).toEqual({ text: 'cd', nextOffset: 4, lossy: true })
    expect(fake.removed).toContain('/runtime/oversize/stdout.log')
    const command = fake.commandsSeen.find(value => value.startsWith('exec setsid'))!
    expect(command).toContain('head -c 3')
    expect(command).toContain('/runtime/oversize/stdout.log')
    expect(command).toContain('tee --output-error=warn-nopipe')
    expect(command).not.toContain('tee -a')
  })

  it('contains remote spill-removal failures and routes empty inherited output', async () => {
    const fake = new FakeSandbox()
    fake.nextRemoveError = new Error('already removed')
    const handle = new E2BSubprocessHandle(runtime(fake), spec({
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: { maxBytes: 4, spill: { maxBytes: 8 } } },
    }), '/runtime/remove-error')
    await flush()
    await fake.stdout('')
    await fake.stderr('')
    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(fake.removed).toContain('/runtime/remove-error/stderr.log')
  })

  it('terminates a process group with TERM and reports the signal outcome', async () => {
    const fake = new FakeSandbox()
    const handle = new E2BSubprocessHandle(runtime(fake), spec(), '/runtime/term')
    await flush()
    handle.terminate()
    handle.terminate()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(fake.commandsSeen).toContain('kill -TERM -- -4242')
    expect(fake.commandsSeen).not.toContain('kill -KILL -- -4242')
  })

  it('escalates a TERM-trapping process group to KILL and uses the SDK kill as fallback', async () => {
    const fake = new FakeSandbox()
    fake.trapsTerm = true
    fake.handle.killError = new Error('already gone')
    const handle = new E2BSubprocessHandle(runtime(fake), spec({ graceMs: 1 }), '/runtime/kill')
    await flush()
    handle.terminate()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(fake.commandsSeen).toContain('kill -KILL -- -4242')
    expect(fake.handle.kills).toBe(1)
  })

  it('honors termination requested before asynchronous startup finishes', async () => {
    const fake = new FakeSandbox()
    fake.deferStart()
    const handle = new E2BSubprocessHandle(runtime(fake), spec(), '/runtime/deferred-kill')
    handle.terminate()
    fake.releaseStart()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
  })

  it('honors an already-aborted signal when constructing the asynchronous handle directly', async () => {
    const fake = new FakeSandbox()
    const handle = new E2BSubprocessHandle(runtime(fake), spec({ signal: AbortSignal.abort('stop') }), '/runtime/pre-aborted')
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
  })

  it('reacts to a signal that aborts after the remote command has started', async () => {
    const fake = new FakeSandbox()
    const controller = new AbortController()
    const handle = new E2BSubprocessHandle(runtime(fake), spec({ signal: controller.signal }), '/runtime/live-abort')
    await flush()
    controller.abort('stop')
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
  })

  it('can terminate a surviving process group after the command leader settles', async () => {
    const fake = new FakeSandbox()
    const handle = new E2BSubprocessHandle(runtime(fake), spec(), '/runtime/surviving-group')
    await flush()
    fake.handle.succeed(0)
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(fake.alive).toBe(true)

    handle.terminate()
    await flush()
    const signaled = fake.commandsSeen.includes('kill -TERM -- -4242')
    if (!signaled) fake.finish()
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(signaled).toBe(true)
  })

  it('bounds waitForExit while startup or a live group is pending', async () => {
    const fake = new FakeSandbox()
    fake.deferStart()
    const handle = new E2BSubprocessHandle(runtime(fake), spec(), '/runtime/wait')
    const beforeStart = new AbortController()
    const pending = handle.waitForExit(beforeStart.signal)
    beforeStart.abort()
    await expect(pending).resolves.toBe(false)
    await expect(handle.waitForExit(AbortSignal.abort())).resolves.toBe(false)
    fake.releaseStart()
    await flush()
    const live = new AbortController()
    const liveWait = handle.waitForExit(live.signal)
    live.abort()
    await expect(liveWait).resolves.toBe(false)
    fake.finish()
    await handle.done
  })

  it('bounds both sides of the liveness-poll abort race', async () => {
    const fake = new FakeSandbox()
    const handle = new E2BSubprocessHandle(runtime(fake), spec(), '/runtime/poll-abort')
    await flush()

    const beforeTick = new AbortController()
    fake.afterProbe = () => { beforeTick.abort(); fake.afterProbe = undefined }
    await expect(handle.waitForExit(beforeTick.signal)).resolves.toBe(false)

    const duringTick = new AbortController()
    fake.afterProbe = () => {
      fake.afterProbe = undefined
      setTimeout(() => { duringTick.abort() }, 0)
    }
    await expect(handle.waitForExit(duringTick.signal)).resolves.toBe(false)

    const duringProbe = new AbortController()
    fake.beforeProbe = () => { duringProbe.abort(); fake.beforeProbe = undefined }
    await expect(handle.waitForExit(duringProbe.signal)).resolves.toBe(false)
    fake.finish()
    await handle.done
  })

  it('observes a live group across one successful bounded poll', async () => {
    const fake = new FakeSandbox()
    const handle = new E2BSubprocessHandle(runtime(fake), spec(), '/runtime/poll-success')
    await flush()
    setTimeout(() => { fake.finish() }, 1)
    await expect(handle.waitForExit(new AbortController().signal)).resolves.toBe(true)
    await handle.done
  })

  it('treats startup failure as no live tree and contains readiness rejection', async () => {
    const fake = new FakeSandbox()
    fake.backgroundError = new Error('start failed')
    const handle = new E2BSubprocessHandle(runtime(fake), spec(), '/runtime/fail')
    await expect(handle.done).rejects.toThrow('start failed')
    expect(handle.pid).toBe(-1)
    await expect(handle.waitForExit()).resolves.toBe(true)
    handle.terminate()
  })

  it('bounds a readiness rejection with a still-live caller signal', async () => {
    const fake = new FakeSandbox()
    fake.deferStart()
    fake.backgroundError = new Error('start failed')
    const handle = new E2BSubprocessHandle(runtime(fake), spec(), '/runtime/fail-with-signal')
    const waiting = handle.waitForExit(new AbortController().signal)
    fake.releaseStart()
    await expect(handle.done).rejects.toThrow('start failed')
    await expect(waiting).resolves.toBe(true)
  })

  it('propagates an unavailable sandbox unless the caller aborts the wait', async () => {
    const fake = new FakeSandbox()
    let calls = 0
    const unavailable = runtime(fake, async () => {
      calls += 1
      if (calls === 1) return fake.sandbox
      throw new Error('connection unavailable')
    })
    const handle = new E2BSubprocessHandle(unavailable, spec(), '/runtime/unavailable')
    await flush()
    await expect(handle.waitForExit()).rejects.toThrow('connection unavailable')
    fake.finish()
    await handle.done
  })

  it('returns false when the caller aborts while reconnecting for liveness', async () => {
    const fake = new FakeSandbox()
    const reconnect = Promise.withResolvers<Sandbox>()
    let calls = 0
    const unavailable = runtime(fake, async () => {
      calls += 1
      return calls === 1 ? fake.sandbox : await reconnect.promise
    })
    const handle = new E2BSubprocessHandle(unavailable, spec(), '/runtime/reconnect-abort')
    await flush()
    const controller = new AbortController()
    const waiting = handle.waitForExit(controller.signal)
    await flush()
    controller.abort()
    reconnect.reject(new Error('connection unavailable'))
    await expect(waiting).resolves.toBe(false)
    fake.finish()
    await handle.done
  })

  it('returns false when a liveness request itself is aborted and surfaces other probe failures', async () => {
    const fake = new FakeSandbox()
    const handle = new E2BSubprocessHandle(runtime(fake), spec(), '/runtime/probe')
    await flush()
    const controller = new AbortController()
    controller.abort()
    await expect(handle.waitForExit(controller.signal)).resolves.toBe(false)
    fake.probeError = new Error('probe failed')
    await expect(handle.waitForExit()).rejects.toThrow('probe failed')
    fake.finish()
    await handle.done
  })

  it('makes batch stdin close failures best-effort', async () => {
    const fake = new FakeSandbox()
    vi.spyOn(fake.handle, 'sendStdin').mockRejectedValueOnce(new Error('closed'))
    const handle = new E2BSubprocessHandle(runtime(fake), spec({
      stdio: { stdin: { data: 'ignored' }, stdout: { maxBytes: 4 }, stderr: { maxBytes: 4 } },
    }), '/runtime/stdin-closed')
    await flush()
    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('rejects malformed SDK process ids and non-command settlement failures', async () => {
    const invalidPid = new FakeSandbox()
    invalidPid.handle.pid = 0
    const invalid = new E2BSubprocessHandle(runtime(invalidPid), spec(), '/runtime/invalid-pid')
    await expect(invalid.done).rejects.toThrow(/invalid command pid 0/)
    await expect(invalid.waitForExit()).resolves.toBe(true)

    const crashedFake = new FakeSandbox()
    const crashed = new E2BSubprocessHandle(runtime(crashedFake), spec(), '/runtime/crashed')
    await flush()
    crashedFake.alive = false
    crashedFake.handle.crash(new Error('command transport failed'))
    await expect(crashed.done).rejects.toThrow('command transport failed')
  })

  it('rejects invalid or absent process-group publication', async () => {
    const invalidGroup = new FakeSandbox()
    invalidGroup.processGroupId = 'not-a-pid\n'
    vi.spyOn(invalidGroup.handle, 'kill').mockImplementation(async () => {
      invalidGroup.handle.kills += 1
      invalidGroup.finish()
      return true
    })
    const invalid = new E2BSubprocessHandle(runtime(invalidGroup), spec(), '/runtime/invalid-group')
    await expect(invalid.done).rejects.toThrow(/invalid process-group id/)
    expect(invalidGroup.handle.kills).toBe(1)

    const absentGroup = new FakeSandbox()
    absentGroup.processGroupId = ''
    const absent = new E2BSubprocessHandle(runtime(absentGroup), spec(), '/runtime/absent-group')
    await flush()
    absentGroup.finish()
    await expect(absent.done).rejects.toThrow(/exited before publishing/)
    expect(absentGroup.handle.kills).toBe(1)
  })

  it('waits for delayed process-group publication', async () => {
    const fake = new FakeSandbox()
    fake.processGroupReads.push('', '4242\n')
    const handle = new E2BSubprocessHandle(runtime(fake), spec(), '/runtime/delayed-group')
    await vi.waitFor(() => { expect(handle.pid).toBe(4242) })
    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('handles output backpressure and contains a stderr sink failure', async () => {
    const fake = new FakeSandbox()
    const handle = new E2BSubprocessHandle(runtime(fake), spec({
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    }), '/runtime/backpressure')
    await flush()

    handle.stdout!.on('error', () => {})
    const stdoutWrite = vi.spyOn(handle.stdout!, 'write').mockReturnValueOnce(false)
    const stdoutPending = fake.stdout('blocked')
    queueMicrotask(() => { handle.stdout!.emit('drain') })
    await stdoutPending
    stdoutWrite.mockRestore()

    handle.stderr!.on('error', () => {})
    const stderrWrite = vi.spyOn(handle.stderr!, 'write').mockReturnValueOnce(false)
    const stderrPending = fake.stderr('broken')
    queueMicrotask(() => { handle.stderr!.emit('error', new Error('sink failed')) })
    await stderrPending
    stderrWrite.mockRestore()

    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('contains a pipe callback failure instead of rejecting command settlement', async () => {
    const fake = new FakeSandbox()
    const handle = new E2BSubprocessHandle(runtime(fake), spec({
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 4 } },
    }), '/runtime/pipe-error')
    await flush()
    const emitted = once(handle.stdout!, 'error')
    handle.stdout!.destroy(new Error('consumer failed'))
    await emitted
    await fake.stdout('late output')
    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('contains an already-gone group signal and observes non-command signal failures', async () => {
    const gone = new FakeSandbox()
    gone.trapsTerm = true
    gone.signalError = commandError(1)
    const goneHandle = new E2BSubprocessHandle(runtime(gone), spec({ graceMs: 1 }), '/runtime/gone-signal')
    await flush()
    goneHandle.terminate()
    await expect(goneHandle.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })

    const failed = new FakeSandbox()
    failed.signalError = new Error('signal transport failed')
    const failedHandle = new E2BSubprocessHandle(runtime(failed), spec(), '/runtime/failed-signal')
    await flush()
    failedHandle.terminate()
    await flush()
    failed.finish()
    await expect(failedHandle.done).resolves.toEqual({ exitCode: 0, signal: null })
  })
})

describe('E2BSubprocessService', () => {
  async function service(
    fake = new FakeSandbox(),
    providedRuntime: E2BSandboxService = runtime(fake),
  ): Promise<{ ctx: Context; fiber: Awaited<ReturnType<Context['plugin']>> }> {
    const ctx = new Context()
    ctx.provide('e2b', providedRuntime)
    const fiber = await ctx.plugin(E2BSubprocessService)
    return { ctx, fiber }
  }

  it('registers handles and disposal terminates and joins live remote groups regardless of sandbox policy', async () => {
    const fake = new FakeSandbox()
    fake.trapsTerm = true
    const { ctx, fiber } = await service(fake)
    const handle = ctx.subprocess.spawn(spec({ graceMs: 1 }))
    await flush()
    await fiber.dispose()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
    expect(fake.alive).toBe(false)
  })

  it('releases naturally settled handles before later service disposal', async () => {
    const fake = new FakeSandbox()
    const { ctx, fiber } = await service(fake)
    const handle = ctx.subprocess.spawn(spec())
    await flush()
    fake.finish()
    await handle.done
    await flush()
    const signalsBefore = fake.commandsSeen.filter(command => command.startsWith('kill -')).length
    await fiber.dispose()
    expect(fake.commandsSeen.filter(command => command.startsWith('kill -')).length).toBe(signalsBefore)
  })

  it('contains a release liveness failure and retries quiescence during disposal', async () => {
    const fake = new FakeSandbox()
    let calls = 0
    const reconnecting = runtime(fake, async () => {
      calls += 1
      if (calls === 2) throw new Error('transient liveness failure')
      return fake.sandbox
    })
    const { ctx, fiber } = await service(fake, reconnecting)
    const handle = ctx.subprocess.spawn(spec())
    await flush()
    fake.finish()
    await handle.done
    await flush()
    await fiber.dispose()
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  it('contains spawn rejection while disposal is joining the pending handle', async () => {
    const fake = new FakeSandbox()
    fake.deferStart()
    fake.backgroundError = new Error('start failed during disposal')
    const { ctx, fiber } = await service(fake)
    const handle = ctx.subprocess.spawn(spec())
    const disposing = fiber.dispose()
    fake.releaseStart()
    await expect(disposing).resolves.toBeUndefined()
    await expect(handle.done).rejects.toThrow('start failed during disposal')
  })

  it('validates synchronous spawn preconditions', async () => {
    const { ctx } = await service()
    expect(() => ctx.subprocess.spawn(spec({ argv: [] }))).toThrow(/non-empty program/)
    expect(() => ctx.subprocess.spawn(spec({ graceMs: 0 }))).toThrow(/positive finite/)
    expect(() => ctx.subprocess.spawn(spec({ signal: AbortSignal.abort('stop') }))).toThrow(/aborted before spawn/)
    expect(() => ctx.subprocess.spawn(spec({ signal: { aborted: true, reason: undefined } as AbortSignal }))).toThrow(/aborted$/)
  })

  it('registers the package-owned empty invariant installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService, { enabled: true })
    const fiber = await ctx.plugin(E2BSubprocessInvariant).await()
    await fiber.dispose()
  })
})
