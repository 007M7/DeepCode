import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandExitError,
  type CommandHandle,
  type CommandResult,
  type Sandbox,
} from '@deepseek-ai/dsh-e2b'
import type { PtySendOperation, PtySessionStatus } from '@deepseek-ai/dsh-pty'
import { E2BPtySession } from '@deepseek-ai/dsh-pty-e2b'
import type { ResolvedConfig } from '@deepseek-ai/dsh-pty-e2b/src/config.ts'

function commandError(exitCode: number): CommandExitError {
  return new CommandExitError({ exitCode, stdout: '', stderr: '', error: `exit ${exitCode}` })
}

class FakePtyHandle {
  pid = 123
  readonly result = Promise.withResolvers<CommandResult>()
  disconnects = 0
  kills = 0
  disconnectError: unknown
  private settled = false

  wait(): Promise<CommandResult> {
    return this.result.promise
  }

  async disconnect(): Promise<void> {
    this.disconnects += 1
    if (this.disconnectError !== undefined) throw this.disconnectError
  }

  async kill(): Promise<boolean> {
    this.kills += 1
    return true
  }

  exit(exitCode = 0): void {
    if (this.settled) return
    this.settled = true
    this.result.resolve({ exitCode, stdout: '', stderr: '' })
  }

  failExit(exitCode: number): void {
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

class FakeSandbox {
  readonly sent: Array<{ pid: number; data: Buffer }> = []
  readonly commands: string[] = []
  readonly killed: number[] = []
  pgid = '456\n'
  sessionGroups = [123]
  sendError: unknown
  signalError: unknown
  killError: unknown
  onTerm: (() => void) | undefined
  onGroupKill: (() => void) | undefined
  onKill: (() => void) | undefined

  readonly sandbox = {
    pty: {
      sendInput: async (pid: number, data: Uint8Array): Promise<void> => {
        this.sent.push({ pid, data: Buffer.from(data) })
        if (this.sendError !== undefined) throw this.sendError
      },
      kill: async (pid: number): Promise<boolean> => {
        this.killed.push(pid)
        if (this.killError !== undefined) throw this.killError
        this.onKill?.()
        return true
      },
    },
    commands: {
      run: async (command: string): Promise<CommandResult> => {
        this.commands.push(command)
        if (command.startsWith('ps -o tpgid')) return { exitCode: 0, stdout: this.pgid, stderr: '' }
        if (command.startsWith('ps -eo sid=')) {
          return { exitCode: 0, stdout: this.sessionGroups.map(value => `${value}\n`).join(''), stderr: '' }
        }
        if (command.startsWith('kill -')) {
          if (this.signalError !== undefined) {
            const error = this.signalError
            this.signalError = undefined
            throw error
          }
          if (command.startsWith('kill -TERM')) this.onTerm?.()
          if (command.startsWith('kill -KILL')) this.onGroupKill?.()
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  } as unknown as Sandbox
}

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    backendType: 'shell', rows: 24, cols: 80,
    scrollbackLines: 10, scrollbackMaxBytes: 128, maxReadBytes: 64,
    pollIntervalMs: 10, idleSilenceMs: 40, timeoutMs: 100, disposeGraceMs: 20,
    ...overrides,
  }
}

async function initialize(session: E2BPtySession): Promise<void> {
  const pending = session.initialize()
  session.onData(Buffer.from('\x1b]133;D;0\x07dsh> '))
  await vi.advanceTimersByTimeAsync(10)
  await pending
}

afterEach(() => { vi.useRealTimers() })

describe('E2BPtySession readiness, output, and signals', () => {
  it('initializes, sends UTF-8 input, settles at a prompt, and reads bounded scrollback', async () => {
    vi.useFakeTimers()
    const fake = new FakeSandbox()
    const handle = new FakePtyHandle()
    const session = new E2BPtySession(fake.sandbox, handle.asHandle(), 123, config({ maxReadBytes: 12 }))
    expect(session.read({})).toMatchObject({ text: '', totalLines: 0 })
    await initialize(session)
    expect(session.motd).toBe('dsh> ')

    const operation = session.startSend({ text: 'printf 你好', submit: true })
    expect(fake.sent).toEqual([{ pid: 123, data: Buffer.from('printf 你好\r') }])
    session.onData(Buffer.from('一\n二\n三\x1b]133;D;0\x07dsh> '))
    const bounded = operation.readOutput()
    expect(bounded.delta).toContain('三')
    expect(bounded.truncated).toBe(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(await operation.done).toMatchObject({ waitReason: 'stdin_read', sessionStatus: { kind: 'running' } })
    expect(operation.cancel()).toBe(false)
    expect(session.read({ count: 2 }).text).toContain('dsh>')
    expect(session.read({ offset: 99 })).toMatchObject({ text: '', lineBegin: 99, lineEnd: 99 })
    expect(() => session.read({ offset: -1 })).toThrow('non-negative safe integer')
    expect(() => session.read({ offset: 1.5 })).toThrow('non-negative safe integer')
    expect(() => session.read({ count: 0 })).toThrow('positive safe integer')
    expect(() => session.read({ count: 1.5 })).toThrow('positive safe integer')

    await expect(session.signal('SIGTERM')).resolves.toEqual({ delivered: true, targetPgid: 456 })
    expect(fake.commands).toContain('kill -TERM -- -456')
    expect(session.status()).toEqual({ kind: 'running' })
  })

  it('distinguishes inferred idle, timeout, session exit, and no-output startup timeout', async () => {
    vi.useFakeTimers()
    const fake = new FakeSandbox()
    const handle = new FakePtyHandle()
    const session = new E2BPtySession(fake.sandbox, handle.asHandle(), 123, config())
    await initialize(session)

    const inferred = session.startSend({ text: '', submit: false })
    await vi.advanceTimersByTimeAsync(40)
    expect((await inferred.done).waitReason).toBe('inferred_idle')

    const timeout = session.startSend({ text: '', submit: false })
    for (let index = 0; index < 3; index += 1) {
      await vi.advanceTimersByTimeAsync(30)
      session.onData(Buffer.from('.'))
    }
    await vi.advanceTimersByTimeAsync(10)
    expect((await timeout.done).waitReason).toBe('timeout')

    const exiting = session.startSend({ text: '', submit: false })
    handle.failExit(143)
    expect(await exiting.done).toMatchObject({
      waitReason: 'session_exit',
      sessionStatus: { kind: 'exited', exitCode: null, signal: 'SIGTERM' },
    })
    expect(() => session.startSend({ text: '', submit: false })).toThrow('has exited')

    const startupHandle = new FakePtyHandle()
    const startup = new E2BPtySession(fake.sandbox, startupHandle.asHandle(), 123, config())
    const timedOut = expect(startup.initialize()).rejects.toThrow('startup timeout')
    await vi.advanceTimersByTimeAsync(100)
    await timedOut
  })

  it('handles split prompt text, stale operations, and explicit cancellation', async () => {
    vi.useFakeTimers()
    const fake = new FakeSandbox()
    const handle = new FakePtyHandle()
    const session = new E2BPtySession(fake.sandbox, handle.asHandle(), 123, config())
    const initializing = session.initialize()
    session.onData(Buffer.from('\x1b]133;D;0\x07'))
    await vi.advanceTimersByTimeAsync(20)
    session.onData(Buffer.from('dsh> '))
    await vi.advanceTimersByTimeAsync(10)
    await initializing

    const operation = session.startSend({ text: 'sleep', submit: true })
    const internal = session as unknown as {
      pollReadiness(operation: PtySendOperation): void
      interrupt(operation: PtySendOperation): void
      settleActive(reason: 'timeout'): void
      failActive(error: unknown): void
      appendOutput(text: string): void
      statusValue: PtySessionStatus
    }
    internal.pollReadiness({} as PtySendOperation)
    internal.interrupt({} as PtySendOperation)
    internal.appendOutput('')
    fake.pgid = '789\n'
    expect(operation.cancel()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.commands).toContain('kill -INT -- -789')
    session.onData(Buffer.from('\x1b]133;D;130\x07dsh> '))
    await vi.advanceTimersByTimeAsync(10)
    await operation.done

    internal.settleActive('timeout')
    internal.failActive(new Error('ignored'))
    const operationInternal = operation as unknown as {
      append(text: string): void
      settle(reason: 'timeout', status: PtySessionStatus, inherited: boolean): void
      fail(error: unknown): void
    }
    operationInternal.append('ignored')
    operationInternal.settle('timeout', { kind: 'running' }, false)
    operationInternal.fail(new Error('ignored'))
  })

  it('observes AbortSignal and contains send or foreground lookup failures', async () => {
    vi.useFakeTimers()
    const fake = new FakeSandbox()
    const handle = new FakePtyHandle()
    const session = new E2BPtySession(fake.sandbox, handle.asHandle(), 123, config())
    await initialize(session)

    const controller = new AbortController()
    const aborting = session.startSend({ text: '', submit: false, signal: controller.signal })
    expect(() => session.startSend({ text: '', submit: false })).toThrow('active send')
    fake.pgid = 'not-a-pgid\n'
    controller.abort()
    await expect(aborting.done).rejects.toThrow('cannot resolve foreground process group')

    const already = new AbortController()
    already.abort()
    expect(() => session.startSend({ text: '', submit: false, signal: already.signal })).toThrow('aborted before write')

    fake.sendError = new Error('send failed')
    const failed = session.startSend({ text: 'x', submit: false })
    await expect(failed.done).rejects.toThrow('send failed')

    fake.pgid = '123\n'
    await expect(session.signal('SIGKILL')).rejects.toThrow('refusing to SIGKILL')
    fake.pgid = '0\n'
    await expect(session.signal('SIGINT')).rejects.toThrow('cannot resolve')

    const deferred = Promise.withResolvers<undefined>()
    fake.sendError = undefined
    const sendInput = vi.spyOn(fake.sandbox.pty, 'sendInput').mockReturnValueOnce(deferred.promise)
    const late = session.startSend({ text: 'late', submit: false })
    session.onData(Buffer.from('\x1b]133;D;0\x07dsh> '))
    await vi.advanceTimersByTimeAsync(10)
    await late.done
    deferred.reject(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(0)
    expect(sendInput).toHaveBeenCalled()
  })

  it('preserves startup abort reasons and classifies invalid UTF-8 transport failures', async () => {
    const fake = new FakeSandbox()
    const abortHandle = new FakePtyHandle()
    const abortSession = new E2BPtySession(fake.sandbox, abortHandle.asHandle(), 123, config())
    const controller = new AbortController()
    const reason = new Error('startup cancelled')
    const initializing = abortSession.initialize(controller.signal)
    const rejected = expect(initializing).rejects.toBe(reason)
    controller.abort(reason)
    await rejected

    const invalidHandle = new FakePtyHandle()
    const invalid = new E2BPtySession(fake.sandbox, invalidHandle.asHandle(), 123, config())
    const pending = invalid.startSend({ text: '', submit: false })
    invalid.onData(Uint8Array.from([0xff]))
    await expect(pending.done).rejects.toThrow('invalid UTF-8')
    expect(invalid.status()).toEqual({ kind: 'exited', exitCode: null, signal: null })

    const crashHandle = new FakePtyHandle()
    const crashed = new E2BPtySession(fake.sandbox, crashHandle.asHandle(), 123, config())
    const active = crashed.startSend({ text: '', submit: false })
    crashHandle.crash('transport gone')
    await expect(active.done).rejects.toEqual(new Error('transport gone'))

    const startupExitHandle = new FakePtyHandle()
    const startupExit = new E2BPtySession(fake.sandbox, startupExitHandle.asHandle(), 123, config())
    const exitedDuringStartup = expect(startupExit.initialize()).rejects.toThrow('exited during startup')
    startupExitHandle.exit(7)
    await exitedDuringStartup
  })

  it('covers empty bounded reads and polling an exited active session', async () => {
    vi.useFakeTimers()
    const fake = new FakeSandbox()
    const tinyHandle = new FakePtyHandle()
    const tiny = new E2BPtySession(fake.sandbox, tinyHandle.asHandle(), 123, config({ maxReadBytes: 1 }))
    tiny.onData(Buffer.from('你'))
    expect(tiny.read({ count: 1 })).toMatchObject({ text: '', lineEnd: 0 })

    const handle = new FakePtyHandle()
    const session = new E2BPtySession(fake.sandbox, handle.asHandle(), 123, config())
    const operation = session.startSend({ text: '', submit: false })
    const internal = session as unknown as {
      pollReadiness(operation: PtySendOperation): void
      clearActive(): void
      statusValue: PtySessionStatus
    }
    internal.statusValue = { kind: 'exited', exitCode: 7, signal: null }
    internal.pollReadiness(operation)
    expect((await operation.done).waitReason).toBe('session_exit')
    internal.clearActive()
  })
})

describe('E2BPtySession teardown', () => {
  it('terminates the process group once, awaits exit, and disconnects', async () => {
    vi.useFakeTimers()
    const fake = new FakeSandbox()
    const handle = new FakePtyHandle()
    fake.onTerm = () => { fake.sessionGroups = []; handle.failExit(143) }
    const session = new E2BPtySession(fake.sandbox, handle.asHandle(), 123, config())
    const first = session.close('done')
    expect(session.close('again')).toBe(first)
    await first
    expect(session.status()).toEqual({ kind: 'exited', exitCode: null, signal: 'SIGTERM' })
    expect(handle.disconnects).toBe(1)
    expect(() => session.startSend({ text: '', submit: false })).toThrow('closing')
  })

  it('escalates every job-control group that survives shell exit', async () => {
    vi.useFakeTimers()
    const fake = new FakeSandbox()
    fake.sessionGroups = [123, 456]
    const handle = new FakePtyHandle()
    fake.onTerm = () => { fake.sessionGroups = [456]; handle.failExit(143) }
    fake.onGroupKill = () => { fake.sessionGroups = [] }
    const session = new E2BPtySession(fake.sandbox, handle.asHandle(), 123, config())

    const closing = session.close('tree cleanup')
    await vi.advanceTimersByTimeAsync(100)
    await closing

    expect(fake.commands).toContain('kill -TERM -- -123 -456')
    expect(fake.commands).toContain('kill -KILL -- -456')
  })

  it('contains an already-gone TERM, escalates to KILL, and reports a survivor', async () => {
    vi.useFakeTimers()
    const gone = new FakeSandbox()
    const goneHandle = new FakePtyHandle()
    gone.signalError = commandError(1)
    gone.onGroupKill = () => { gone.sessionGroups = [] }
    gone.onKill = () => { goneHandle.failExit(137) }
    const goneSession = new E2BPtySession(gone.sandbox, goneHandle.asHandle(), 123, config())
    const closingGone = goneSession.close('gone')
    await vi.advanceTimersByTimeAsync(100)
    await closingGone
    expect(gone.killed).toEqual([123])
    expect(goneSession.status()).toEqual({ kind: 'exited', exitCode: null, signal: 'SIGKILL' })

    const survivor = new FakeSandbox()
    const survivorHandle = new FakePtyHandle()
    const survivorSession = new E2BPtySession(survivor.sandbox, survivorHandle.asHandle(), 123, config())
    const failed = expect(survivorSession.close('still alive')).rejects.toThrow('surviving process groups: 123')
    await vi.advanceTimersByTimeAsync(100)
    await failed
    survivorHandle.exit()
    survivor.sessionGroups = []
    await expect(survivorSession.close('retry')).resolves.toBeUndefined()
  })

  it('propagates cleanup transport failures and lets close retry', async () => {
    const fake = new FakeSandbox()
    const handle = new FakePtyHandle()
    fake.signalError = new Error('TERM transport failed')
    const session = new E2BPtySession(fake.sandbox, handle.asHandle(), 123, config())
    await expect(session.close('failure')).rejects.toThrow('TERM transport failed')
    handle.exit()
    fake.sessionGroups = []
    await expect(session.close('retry')).resolves.toBeUndefined()

    const invalidTailHandle = new FakePtyHandle()
    const invalidTail = new E2BPtySession(fake.sandbox, invalidTailHandle.asHandle(), 123, config())
    invalidTail.onData(Uint8Array.from([0xe2]))
    invalidTailHandle.exit()
    await expect(invalidTail.close('invalid tail')).rejects.toThrow('invalid UTF-8')

    const normalHandle = new FakePtyHandle()
    normalHandle.disconnectError = new Error('disconnect raced')
    const normal = new E2BPtySession(fake.sandbox, normalHandle.asHandle(), 123, config())
    normalHandle.exit(7)
    await Promise.resolve()
    expect(normal.status()).toEqual({ kind: 'exited', exitCode: 7, signal: null })
    await expect(normal.close('already exited')).resolves.toBeUndefined()
  })

  it('rejects invalid session groups and a shell handle that survives SDK kill', async () => {
    const invalid = new FakeSandbox()
    invalid.sessionGroups = [1]
    const invalidSession = new E2BPtySession(invalid.sandbox, new FakePtyHandle().asHandle(), 123, config())
    await expect(invalidSession.close('invalid group')).rejects.toThrow('invalid process group')

    vi.useFakeTimers()
    const survivor = new FakeSandbox()
    survivor.sessionGroups = []
    const survivorHandle = new FakePtyHandle()
    const survivorSession = new E2BPtySession(survivor.sandbox, survivorHandle.asHandle(), 123, config())
    const failed = expect(survivorSession.close('shell survived')).rejects.toThrow('surviving pid: 123')
    await vi.advanceTimersByTimeAsync(100)
    await failed
    expect(survivor.killed).toEqual([123])
  })

  it('kills a remotely live PTY after its host transport fails', async () => {
    const fake = new FakeSandbox()
    const handle = new FakePtyHandle()
    const session = new E2BPtySession(fake.sandbox, handle.asHandle(), 123, config())
    const active = session.startSend({ text: '', submit: false })
    session.onData(Uint8Array.from([0xff]))
    await expect(active.done).rejects.toThrow('invalid UTF-8')
    expect(session.status()).toEqual({ kind: 'exited', exitCode: null, signal: null })

    fake.onTerm = () => { fake.sessionGroups = []; handle.failExit(143) }
    await expect(session.close('transport failed')).rejects.toThrow('invalid UTF-8')
    expect(fake.commands).toContain('kill -TERM -- -123')
    expect(handle.disconnects).toBe(1)
  })
})
