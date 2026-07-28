import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IDisposable, IPty } from 'node-pty'
import { LocalTerminalHandle } from '@deepseek-ai/dsh-subprocess-local/src/terminal.ts'
import type {
  ProcessIdentity,
  ProcessInspector,
} from '@deepseek-ai/dsh-subprocess-local/src/process-inspector.ts'
import type { SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess'

class FakePty {
  pid = 123
  readonly writes: string[] = []
  readonly kills: string[] = []
  autoExitOnKill = true
  throwKill = false
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()

  readonly onData = (listener: (data: string) => void): IDisposable => {
    this.dataListeners.add(listener)
    return { dispose: () => { this.dataListeners.delete(listener) } }
  }

  readonly onExit = (listener: (event: { exitCode: number; signal?: number }) => void): IDisposable => {
    this.exitListeners.add(listener)
    return { dispose: () => { this.exitListeners.delete(listener) } }
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data)
  }

  emitExit(exitCode = 0, signal?: number): void {
    for (const listener of this.exitListeners) listener({ exitCode, ...signal === undefined ? {} : { signal } })
  }

  write(data: string): void { this.writes.push(data) }

  kill(signal?: string): void {
    if (this.throwKill) throw new Error('process raced')
    this.kills.push(signal ?? 'SIGHUP')
    if (this.autoExitOnKill) this.emitExit(0, signal === 'SIGKILL' ? 9 : 15)
  }

  asPty(): IPty {
    return this as unknown as IPty
  }
}

class FakeInspector implements ProcessInspector {
  pgid: number | undefined = 456
  waiting = false
  members: ProcessIdentity[] = []
  readonly alive = new Set<number>()
  readonly groups: Array<[number, SubprocessTerminalSignal]> = []
  readonly processes: Array<[number, 'SIGTERM' | 'SIGKILL']> = []
  throwGroup = false
  throwProcess = false
  removeOnSignal = true

  foregroundPgid() { return this.pgid }
  isStdinWaiting() { return this.waiting }
  processTree() { return this.members }
  isAlive(identity: ProcessIdentity) { return this.alive.has(identity.pid) }
  signalGroup(pgid: number, signal: SubprocessTerminalSignal) {
    if (this.throwGroup) throw new Error('group failed')
    this.groups.push([pgid, signal])
  }
  signalProcess(identity: ProcessIdentity, signal: 'SIGTERM' | 'SIGKILL') {
    if (this.throwProcess) throw new Error('process raced')
    this.processes.push([identity.pid, signal])
    if (this.removeOnSignal) this.alive.delete(identity.pid)
  }
}

afterEach(() => { vi.useRealTimers() })

describe('LocalTerminalHandle', () => {
  it('bridges terminal bytes, foreground control, and signalled exit facts', async () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    inspector.waiting = true
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10)
    const chunks: Buffer[] = []
    handle.output.on('data', (chunk: Buffer) => { chunks.push(chunk) })

    pty.emitData('hello €')
    await handle.write(Buffer.from('input\r'))
    expect(pty.writes).toEqual(['input\r'])
    expect(await handle.inspectForeground()).toEqual({ processGroupId: 456, inputWaiting: true })
    expect(await handle.signalForeground('SIGINT')).toBe(456)
    expect(inspector.groups).toEqual([[456, 'SIGINT']])

    pty.emitExit(7, 9)
    pty.emitExit(0)
    expect(await handle.done).toEqual({ exitCode: null, signal: 'SIGKILL' })
    expect(await handle.waitForExit()).toBe(true)
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello €')
  })

  it('rejects invalid input and unsafe foreground signals', async () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10)
    await expect(handle.write(Uint8Array.from([0xff]))).rejects.toThrow('valid UTF-8')

    inspector.pgid = handle.pid
    await expect(handle.signalForeground('SIGKILL')).rejects.toThrow('terminate the terminal session')
    inspector.pgid = undefined
    expect(await handle.inspectForeground()).toBeUndefined()
    await expect(handle.signalForeground('SIGTERM')).rejects.toThrow('cannot resolve')

    pty.emitExit(3)
    expect(await handle.done).toEqual({ exitCode: 3, signal: null })
    await handle.waitForExit()
    await expect(handle.write(Buffer.from('late'))).rejects.toThrow('has exited')
  })

  it('keeps the shell alive until forced descendants leave', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    const inspector = new FakeInspector()
    inspector.members = [{ pid: 124, started: 'child' }]
    inspector.alive.add(124)
    inspector.removeOnSignal = false
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 20)

    handle.terminate()
    const quiescent = handle.waitForExit()
    await vi.advanceTimersByTimeAsync(20)
    expect(inspector.processes).toContainEqual([124, 'SIGKILL'])
    expect(pty.kills).toEqual([])

    inspector.alive.delete(124)
    await vi.advanceTimersByTimeAsync(20)
    expect(await quiescent).toBe(true)
    expect(pty.kills).toEqual(['SIGTERM'])
  })

  it('keeps an early exit wait pending through descendant cleanup', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    const inspector = new FakeInspector()
    inspector.members = [{ pid: 124, started: 'child' }]
    inspector.alive.add(124)
    inspector.removeOnSignal = false
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 20)
    const waiting = handle.waitForExit()
    let settled = false
    void waiting.then(() => { settled = true })

    pty.emitExit()
    await vi.advanceTimersByTimeAsync(10)
    expect(settled).toBe(false)

    inspector.alive.delete(124)
    await vi.advanceTimersByTimeAsync(20)
    expect(await waiting).toBe(true)
  })

  it('rescans for descendants forked during TERM', async () => {
    const pty = new FakePty()
    const inspector = new FakeInspector()
    let reads = 0
    inspector.processTree = () => {
      reads += 1
      if (reads === 1) {
        inspector.alive.add(124)
        return [{ pid: 124, started: 'first' }]
      }
      if (reads === 2) {
        inspector.alive.add(125)
        return [{ pid: 125, started: 'late' }]
      }
      return []
    }
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10)
    handle.terminate()
    await handle.waitForExit()
    expect(inspector.processes).toEqual([[124, 'SIGTERM'], [125, 'SIGKILL']])
    expect(pty.kills).toEqual(['SIGTERM'])
  })

  it('retains captured descendants after reparenting', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    const inspector = new FakeInspector()
    const captured = { pid: 124, started: 'captured' }
    let reads = 0
    inspector.alive.add(captured.pid)
    inspector.processTree = () => reads++ === 0 ? [captured] : []
    inspector.signalProcess = (identity, signal) => {
      inspector.processes.push([identity.pid, signal])
      if (signal === 'SIGKILL') inspector.alive.delete(identity.pid)
    }
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 20)
    handle.terminate()
    const quiescent = handle.waitForExit()
    await vi.advanceTimersByTimeAsync(25)
    expect(await quiescent).toBe(true)
    expect(inspector.processes).toEqual([[124, 'SIGTERM'], [124, 'SIGKILL']])
  })

  it('allows cleanup to retry after a surviving descendant leaves', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    const inspector = new FakeInspector()
    inspector.members = [{ pid: 124, started: 'child' }]
    inspector.alive.add(124)
    inspector.removeOnSignal = false
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 10)

    handle.terminate()
    const first = expect(handle.waitForExit(new AbortController().signal)).rejects.toThrow('surviving pids: 124')
    await vi.advanceTimersByTimeAsync(25)
    await first

    inspector.alive.delete(124)
    handle.terminate()
    expect(await handle.waitForExit()).toBe(true)
    expect(pty.kills).toEqual(['SIGTERM'])
  })

  it('bounds waits and reports a top-level process that ignores escalation', async () => {
    vi.useFakeTimers()
    const pty = new FakePty()
    pty.autoExitOnKill = false
    const handle = new LocalTerminalHandle(pty.asPty(), new FakeInspector(), 10)
    expect(await handle.waitForExit(AbortSignal.abort())).toBe(false)
    const controller = new AbortController()
    const bounded = handle.waitForExit(controller.signal)
    controller.abort()
    expect(await bounded).toBe(false)

    handle.terminate()
    const failed = expect(handle.waitForExit()).rejects.toThrow('surviving pid: 123')
    await vi.advanceTimersByTimeAsync(25)
    await failed
    expect(pty.kills).toEqual(['SIGTERM', 'SIGKILL'])

    pty.emitExit(0, 999)
    expect(await handle.done).toEqual({ exitCode: null, signal: null })
    handle.terminate()
    expect(await handle.waitForExit()).toBe(true)
  })

  it('contains process races and reacts to lifetime cancellation', async () => {
    const pty = new FakePty()
    pty.throwKill = true
    const inspector = new FakeInspector()
    inspector.members = [{ pid: 124, started: 'child' }]
    inspector.alive.add(124)
    inspector.throwProcess = true
    const controller = new AbortController()
    const handle = new LocalTerminalHandle(pty.asPty(), inspector, 1, controller.signal)
    controller.abort()
    const failed = expect(handle.waitForExit()).rejects.toThrow('surviving pids: 124')
    await failed

    inspector.alive.delete(124)
    pty.throwKill = false
    handle.terminate()
    await handle.waitForExit()

    const preAbortedPty = new FakePty()
    const preAborted = new LocalTerminalHandle(
      preAbortedPty.asPty(),
      new FakeInspector(),
      1,
      AbortSignal.abort('stop'),
    )
    await preAborted.waitForExit()
    expect(preAbortedPty.kills).toEqual(['SIGTERM'])
  })
})
