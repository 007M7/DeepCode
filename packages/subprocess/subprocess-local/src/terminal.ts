/** Local node-pty terminal-process implementation for the subprocess seam. */

import { Buffer } from 'node:buffer'
import { constants } from 'node:os'
import { PassThrough } from 'node:stream'
import type { IDisposable, IPty } from 'node-pty'
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
} from '@deepseek-ai/dsh-subprocess'
import type { ProcessIdentity, ProcessInspector } from './process-inspector.ts'

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function signalName(number: number | undefined): NodeJS.Signals | null {
  if (number === undefined || number === 0) return null
  for (const [name, value] of Object.entries(constants.signals)) {
    if (value === number) return name as NodeJS.Signals
  }
  return null
}

/** A local terminal whose process-session ownership stays below the PTY backend. */
export class LocalTerminalHandle implements SubprocessTerminalHandle {
  readonly pid: number
  readonly output = new PassThrough()
  readonly done: Promise<SubprocessOutcome>

  private readonly outcome = Promise.withResolvers<SubprocessOutcome>()
  private readonly dataDisposable: IDisposable
  private readonly exitDisposable: IDisposable
  private exited = false
  private termination: Promise<void> | undefined
  private removeAbort: (() => void) | undefined
  private trackedDescendants: ProcessIdentity[] = []

  /**
   * @param terminal - allocated node-pty process.
   * @param inspector - platform process/session operations.
   * @param graceMs - TERM-to-KILL and exit-wait grace.
   * @param signal - optional lifetime cancellation.
   */
  constructor(
    private readonly terminal: IPty,
    private readonly inspector: ProcessInspector,
    private readonly graceMs: number,
    signal?: AbortSignal,
  ) {
    this.pid = terminal.pid
    this.done = this.outcome.promise
    this.dataDisposable = terminal.onData((data) => { this.output.write(Buffer.from(data, 'utf8')) })
    this.exitDisposable = terminal.onExit(({ exitCode, signal: exitSignal }) => {
      if (this.exited) return
      this.exited = true
      this.output.end()
      this.outcome.resolve({
        exitCode: exitSignal === undefined || exitSignal === 0 ? exitCode : null,
        signal: signalName(exitSignal),
      })
      this.terminate()
    })
    if (signal !== undefined) {
      const onAbort = (): void => { this.terminate() }
      signal.addEventListener('abort', onAbort, { once: true })
      this.removeAbort = () => { signal.removeEventListener('abort', onAbort) }
      if (signal.aborted) this.terminate()
    }
  }

  // node-pty writes synchronously; the seam returns a promise for remote transports.
  // eslint-disable-next-line @typescript-eslint/require-await
  async write(data: Uint8Array): Promise<void> {
    if (this.exited) throw new Error('terminal process has exited')
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    } catch (error: unknown) {
      throw new Error('terminal input must be valid UTF-8', { cause: error })
    }
    this.terminal.write(text)
  }

  // Local inspection is synchronous; the seam returns a promise for remote transports.
  // eslint-disable-next-line @typescript-eslint/require-await
  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    this.descendants()
    const processGroupId = this.inspector.foregroundPgid(this.pid)
    if (processGroupId === undefined) return undefined
    return {
      processGroupId,
      inputWaiting: this.inspector.isStdinWaiting(processGroupId),
    }
  }

  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    const foreground = await this.inspectForeground()
    if (foreground === undefined) {
      throw new Error(`cannot resolve foreground process group for terminal ${this.pid}`)
    }
    if (signal === 'SIGKILL' && foreground.processGroupId === this.pid) {
      throw new Error('refusing to SIGKILL the terminal shell; terminate the terminal session instead')
    }
    this.inspector.signalGroup(foreground.processGroupId, signal)
    return foreground.processGroupId
  }

  terminate(): void {
    this.termination ??= this.closeOnce().catch((error: unknown) => {
      this.termination = undefined
      throw error
    })
    void this.termination.catch(() => {})
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    // A caller may begin waiting before the top-level process exits. The exit
    // callback starts descendant cleanup in the same turn, so resolve that
    // eventual transaction after `done` instead of snapshotting only `done`.
    const quiescence = this.termination ?? this.done.then(() => this.termination)
    if (signal === undefined) {
      await quiescence
      return true
    }
    if (signal.aborted) return false
    return await new Promise<boolean>((resolve, reject) => {
      const onAbort = (): void => { cleanup(); resolve(false) }
      const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
      signal.addEventListener('abort', onAbort, { once: true })
      void quiescence.then(
        () => { cleanup(); resolve(true) },
        (error: unknown) => {
          cleanup()
          // The owned cleanup transaction only throws Error diagnostics.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error)
        },
      )
    })
  }

  private survivors(members: ProcessIdentity[]): ProcessIdentity[] {
    return members.filter(member => this.inspector.isAlive(member))
  }

  private descendants(): ProcessIdentity[] {
    this.trackedDescendants = this.survivors(this.unionMembers(
      this.trackedDescendants,
      this.inspector.processTree(this.pid),
      this.inspector.processSession(this.pid),
    ).filter(member => member.pid !== this.pid))
    return this.trackedDescendants
  }

  private async waitForMembers(members: ProcessIdentity[]): Promise<ProcessIdentity[]> {
    const until = Date.now() + this.graceMs
    let survivors = this.survivors(members)
    while (survivors.length > 0 && Date.now() < until) {
      await delay(Math.min(25, Math.max(1, until - Date.now())))
      survivors = this.survivors(members)
    }
    return survivors
  }

  private signalMembers(members: ProcessIdentity[], signal: 'SIGTERM' | 'SIGKILL'): void {
    for (const member of members) {
      try {
        this.inspector.signalProcess(member, signal)
      } catch (_alreadyExitedDuringSignal) {
        // The exact process identity is rechecked; a same-tick exit is success.
      }
    }
  }

  private unionMembers(...groups: ProcessIdentity[][]): ProcessIdentity[] {
    const members: ProcessIdentity[] = []
    const seen = new Set<string>()
    for (const group of groups) {
      for (const member of group) {
        const key = `${member.pid}:${member.started}`
        if (seen.has(key)) continue
        seen.add(key)
        members.push(member)
      }
    }
    return members
  }

  private async stopDescendants(): Promise<ProcessIdentity[]> {
    const captured = this.descendants()
    this.signalMembers(captured, 'SIGTERM')
    const capturedSurvivors = await this.waitForMembers(captured)
    const members = this.unionMembers(capturedSurvivors, this.descendants())
    this.signalMembers(members, 'SIGKILL')
    const survivors = await this.waitForMembers(members)
    return this.survivors(this.unionMembers(survivors, this.descendants()))
  }

  private async stopShell(): Promise<void> {
    if (!this.exited) {
      try {
        this.terminal.kill('SIGTERM')
      } catch (_topLevelAlreadyExitedDuringTerm) {
        // The exit callback is authoritative.
      }
      await Promise.race([this.done.then(() => undefined), delay(this.graceMs)])
    }
    if (!this.exited) {
      try {
        this.terminal.kill('SIGKILL')
      } catch (_topLevelAlreadyExitedDuringKill) {
        // The exit callback is authoritative.
      }
      await Promise.race([this.done.then(() => undefined), delay(this.graceMs)])
    }
    if (!this.exited) throw new Error(`terminal cleanup failed; surviving pid: ${this.pid}`)
  }

  private async closeOnce(): Promise<void> {
    const survivors = await this.stopDescendants()
    if (survivors.length > 0) {
      throw new Error(`terminal cleanup failed; surviving pids: ${survivors.map(member => member.pid).join(', ')}`)
    }
    await this.stopShell()
    this.removeAbort?.()
    this.removeAbort = undefined
    this.dataDisposable.dispose()
    this.exitDisposable.dispose()
  }
}
