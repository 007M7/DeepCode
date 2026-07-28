/** Local `node-pty` session: bounded output, readiness, signals, and teardown. */

import type { IDisposable, IPty } from 'node-pty'
import { PtyTerminalSanitizer, PtyTextBuffer, ptySignalName, ptyUtf8Tail } from '@deepseek-ai/dsh-pty'
import type {
  PtyBackendSession,
  PtyReadRequest,
  PtyReadResult,
  PtySendOperation,
  PtySendRead,
  PtySendRequest,
  PtySendResult,
  PtySessionStatus,
  PtySignal,
  PtySignalResult,
  PtyWaitReason,
} from '@deepseek-ai/dsh-pty'
import type { ResolvedConfig } from './config.ts'
import type { ProcessIdentity, ProcessInspector } from './process-inspector.ts'

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class LocalSendOperation implements PtySendOperation {
  private readonly output: PtyTextBuffer
  private readonly promise: PromiseWithResolvers<PtySendResult>
  private finished = false

  constructor(
    maxBytes: number,
    readonly startedAt: number,
    private readonly onCancel: () => void,
  ) {
    this.output = new PtyTextBuffer(maxBytes)
    this.promise = Promise.withResolvers<PtySendResult>()
  }

  get done(): Promise<PtySendResult> {
    return this.promise.promise
  }

  append(text: string): void {
    if (!this.finished) this.output.append(text)
  }

  settle(waitReason: PtyWaitReason, sessionStatus: PtySessionStatus, inheritedTruncation: boolean): void {
    if (this.finished) return
    this.finished = true
    const read = this.output.snapshot()
    this.promise.resolve({
      viewport: read.text,
      waitReason,
      sessionStatus,
      truncated: read.truncated || inheritedTruncation,
    })
  }

  fail(error: unknown): void {
    if (this.finished) return
    this.finished = true
    this.promise.reject(error)
  }

  readOutput(): PtySendRead {
    return this.output.consume()
  }

  cancel(): boolean {
    if (this.finished) return false
    this.onCancel()
    return true
  }
}

/** Backend session wrapping one `node-pty` process and its captured process tree. */
export class LocalPtySession implements PtyBackendSession {
  motd = ''
  readonly pid: number
  private readonly sanitizer: PtyTerminalSanitizer
  private readonly scrollback: PtyTextBuffer
  private readonly exitPromise: PromiseWithResolvers<void> = Promise.withResolvers<void>()
  private readonly dataDisposable: IDisposable
  private readonly exitDisposable: IDisposable
  private statusValue: PtySessionStatus = { kind: 'running' }
  private active: LocalSendOperation | undefined
  private activeTimer: NodeJS.Timeout | undefined
  private activeAbort: (() => void) | undefined
  private promptSeen = false
  private promptTextSeen = false
  private shellPgid: number | undefined
  private initializing = false
  private lastOutputAt = Date.now()
  private closing = false
  private closePromise: Promise<void> | undefined

  constructor(
    private readonly terminal: IPty,
    private readonly inspector: ProcessInspector,
    private readonly config: ResolvedConfig,
  ) {
    this.pid = terminal.pid
    this.sanitizer = new PtyTerminalSanitizer(config.maxReadBytes)
    this.scrollback = new PtyTextBuffer(config.scrollbackMaxBytes, config.scrollbackLines)
    this.dataDisposable = terminal.onData((data) => { this.onData(data) })
    this.exitDisposable = terminal.onExit(({ exitCode, signal }) => {
      const tail = this.sanitizer.flush()
      this.appendOutput(tail)
      this.statusValue = { kind: 'exited', exitCode, signal: ptySignalName(signal) }
      this.settleActive('session_exit')
      this.exitPromise.resolve()
    })
  }

  /**
   * Capture startup output through the same readiness contract as later sends.
   * @param signal - optional cancellation while the shell reaches its first prompt.
   * @returns Resolves after startup readiness; rejects on exit or readiness timeout.
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    this.initializing = true
    try {
      const operation = this.startSend({ text: '', submit: false, ...signal !== undefined ? { signal } : {} })
      const result = await operation.done
      if (result.waitReason === 'session_exit') throw new Error('PTY shell exited during startup')
      if (result.waitReason === 'timeout') throw new Error('PTY shell did not reach readiness before startup timeout')
      this.motd = result.viewport
    } catch (error: unknown) {
      signal?.throwIfAborted()
      throw error
    } finally {
      this.initializing = false
    }
  }

  startSend(request: PtySendRequest): PtySendOperation {
    if (this.closing) throw new Error('PTY session is closing')
    if (this.statusValue.kind === 'exited') throw new Error('PTY session has exited')
    if (this.active !== undefined) throw new Error('PTY session already has an active send')
    if (request.signal?.aborted === true) throw new Error('PTY send aborted before write')

    const operation = new LocalSendOperation(
      this.config.maxReadBytes,
      Date.now(),
      () => { this.interrupt(operation) },
    )
    this.active = operation
    this.lastOutputAt = Date.now()
    this.promptSeen = false
    this.promptTextSeen = false

    if (request.signal !== undefined) {
      const onAbort = (): void => { operation.cancel() }
      request.signal.addEventListener('abort', onAbort, { once: true })
      this.activeAbort = () => request.signal?.removeEventListener('abort', onAbort)
    }

    try {
      if (request.text.length > 0) this.terminal.write(request.text)
      if (request.submit) this.terminal.write('\r')
    } catch (error: unknown) {
      this.clearActive()
      operation.fail(error)
      return operation
    }

    this.activeTimer = setInterval(() => { this.pollReadiness(operation) }, this.config.pollIntervalMs)
    return operation
  }

  read(request: PtyReadRequest): PtyReadResult {
    const snapshot = this.scrollback.snapshot()
    const lines = snapshot.text.split('\n')
    const totalLines = snapshot.text.length === 0 ? 0 : lines.length
    const offset = request.offset ?? 0
    const count = request.count ?? 500
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('PTY read offset must be a non-negative safe integer')
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('PTY read count must be a positive safe integer')
    if (offset >= totalLines) {
      return { text: '', totalLines, lineBegin: offset, lineEnd: offset, truncated: snapshot.truncated }
    }
    const end = totalLines - offset
    const start = Math.max(0, end - count)
    const requested = lines.slice(start, end).join('\n')
    const bounded = ptyUtf8Tail(requested, this.config.maxReadBytes)
    const returnedLines = bounded.text.length === 0 ? 0 : bounded.text.split('\n').length
    return {
      text: bounded.text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + returnedLines,
      truncated: snapshot.truncated || bounded.truncated,
    }
  }

  signal(signal: PtySignal): Promise<PtySignalResult> {
    return Promise.resolve().then(() => {
      const pgid = this.inspector.foregroundPgid(this.pid)
      if (pgid === undefined) throw new Error(`cannot resolve foreground process group for PTY ${this.pid}`)
      if (signal === 'SIGKILL' && pgid === this.pid) {
        throw new Error('refusing to SIGKILL the PTY shell; use terminal_close')
      }
      this.inspector.signalGroup(pgid, signal)
      return { delivered: true, targetPgid: pgid }
    })
  }

  status(): PtySessionStatus {
    return this.statusValue
  }

  close(reason: string): Promise<void> {
    this.closing = true
    if (this.closePromise !== undefined) return this.closePromise
    const closing = this.closeOnce(reason).catch((error: unknown) => {
      this.closePromise = undefined
      this.failActive(error)
      throw error
    })
    this.closePromise = closing
    return closing
  }

  private onData(data: string): void {
    const sanitized = this.sanitizer.push(data)
    this.appendOutput(sanitized.text)
    if (sanitized.prompt) {
      const foregroundPgid = this.inspector.foregroundPgid(this.pid)
      if (this.shellPgid === undefined) this.shellPgid = foregroundPgid
      // Bash can print PROMPT_COMMAND before the kernel publishes its return
      // to the foreground process group. Retain the marker; polling below is
      // the authority that accepts it only after bash owns the foreground.
      this.promptSeen = true
      this.promptTextSeen = sanitized.promptText === true
      this.lastOutputAt = Date.now()
    } else if (this.promptSeen && sanitized.promptText === true) {
      this.promptTextSeen = true
    }
  }

  private appendOutput(text: string): void {
    if (text.length === 0) return
    this.lastOutputAt = Date.now()
    this.scrollback.append(text)
    this.active?.append(text)
  }

  private pollReadiness(operation: LocalSendOperation): void {
    if (this.active !== operation) return
    if (this.statusValue.kind === 'exited') {
      this.settleActive('session_exit')
      return
    }
    if (this.promptSeen && this.promptTextSeen && Date.now() - this.lastOutputAt >= this.config.pollIntervalMs) {
      const pgid = this.inspector.foregroundPgid(this.pid)
      if (this.shellPgid !== undefined && pgid === this.shellPgid) {
        this.settleActive('stdin_read')
        return
      }
    }
    const elapsed = Date.now() - operation.startedAt
    const startupHasOutput = !this.initializing || this.scrollback.snapshot().text.length > 0
    if (startupHasOutput && elapsed >= this.config.exactProbeAfterMs) {
      const pgid = this.inspector.foregroundPgid(this.pid)
      if (pgid !== undefined && this.inspector.isStdinWaiting(pgid)) {
        this.settleActive('stdin_read')
        return
      }
    }
    // A prompt candidate can race bash's foreground handoff, but an interactive
    // child also inherits PROMPT_COMMAND. Silence therefore remains the bound
    // on waiting for shell ownership instead of letting a child marker suppress
    // readiness until the absolute timeout. When a prompt marker was seen, the
    // configured grace holds the fallback past the silence bound so polls in
    // that window can observe the foreground handoff and settle as stdin_read.
    const idleFor = Date.now() - this.lastOutputAt
    const handoffGrace = this.promptSeen ? this.config.handoffGraceMs : 0
    if (startupHasOutput && idleFor >= this.config.idleSilenceMs + handoffGrace) {
      this.settleActive('inferred_idle')
      return
    }
    if (elapsed >= this.config.timeoutMs) this.settleActive('timeout')
  }

  private settleActive(waitReason: PtyWaitReason): void {
    const operation = this.active
    if (operation === undefined) return
    const scrollbackTruncated = this.scrollback.snapshot().truncated
    this.clearActive()
    operation.settle(waitReason, this.statusValue, scrollbackTruncated)
  }

  private stopPolling(): void {
    if (this.activeTimer !== undefined) clearInterval(this.activeTimer)
    this.activeTimer = undefined
  }

  private clearActive(): void {
    this.stopPolling()
    this.activeAbort?.()
    this.activeAbort = undefined
    this.active = undefined
  }

  private failActive(error: unknown): void {
    const operation = this.active
    if (operation === undefined) return
    this.clearActive()
    operation.fail(error)
  }

  private interrupt(operation: LocalSendOperation): void {
    if (this.active !== operation) return
    try {
      const pgid = this.inspector.foregroundPgid(this.pid)
      if (pgid === undefined) throw new Error(`cannot resolve foreground process group for PTY ${this.pid}`)
      this.inspector.signalGroup(pgid, 'SIGINT')
    } catch (error: unknown) {
      this.failActive(error)
    }
  }

  private survivors(members: ProcessIdentity[]): ProcessIdentity[] {
    return members.filter(member => this.inspector.isAlive(member))
  }

  private descendants(): ProcessIdentity[] {
    return this.inspector.processTree(this.pid).filter(member => member.pid !== this.pid)
  }

  private async waitForExit(members: ProcessIdentity[]): Promise<ProcessIdentity[]> {
    const deadline = Date.now() + this.config.disposeGraceMs
    let survivors = this.survivors(members)
    while (survivors.length > 0 && Date.now() < deadline) {
      await delay(Math.min(25, Math.max(1, deadline - Date.now())))
      survivors = this.survivors(members)
    }
    return survivors
  }

  private signalMembers(members: ProcessIdentity[], signal: 'SIGTERM' | 'SIGKILL'): void {
    for (const member of members) {
      try {
        this.inspector.signalProcess(member, signal)
      } catch (_alreadyExitedDuringSignal) {
        // Identity is rechecked by the inspector; a same-tick exit is success.
      }
    }
  }

  private unionMembers(...groups: ProcessIdentity[][]): ProcessIdentity[] {
    const members: ProcessIdentity[] = []
    const seen = new Set<string>()
    for (const group of groups) {
      for (const member of group) {
        const key = JSON.stringify([member.pid, member.started])
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
    const capturedSurvivors = await this.waitForExit(captured)
    // A TERM-handling descendant may have forked while winding down. Rescan
    // while the shell can still reap every member, then kill both the fresh
    // tree and captured survivors that were reparented out of that tree.
    const members = this.unionMembers(capturedSurvivors, this.descendants())
    this.signalMembers(members, 'SIGKILL')
    const survivors = await this.waitForExit(members)
    return this.survivors(this.unionMembers(survivors, this.descendants()))
  }

  private async stopShell(): Promise<void> {
    try {
      this.terminal.kill('SIGTERM')
    } catch (_topLevelAlreadyExitedDuringTerm) {
      // The exit notification remains authoritative.
    }
    if (this.statusValue.kind === 'running') {
      await Promise.race([this.exitPromise.promise, delay(this.config.disposeGraceMs)])
    }
    if (this.statusValue.kind === 'running') {
      try {
        this.terminal.kill('SIGKILL')
      } catch (_topLevelAlreadyExitedDuringKill) {
        // The exit notification remains authoritative.
      }
      await Promise.race([this.exitPromise.promise, delay(this.config.disposeGraceMs)])
    }
    if (this.statusValue.kind === 'running') {
      throw new Error(`PTY cleanup failed; surviving pids: ${this.pid}`)
    }
  }

  private async closeOnce(reason: string): Promise<void> {
    this.dataDisposable.dispose()
    // Stop readiness polling but retain the active operation: teardown settles
    // it as session_exit below, so an in-flight send is never mis-settled as
    // stdin_read/inferred_idle/timeout during the grace period.
    this.stopPolling()
    const survivors = await this.stopDescendants()
    if (survivors.length > 0) {
      throw new Error(`PTY cleanup failed (${reason}); surviving pids: ${survivors.map(member => member.pid).join(', ')}`)
    }
    await this.stopShell()
    this.settleActive('session_exit')
    this.exitDisposable.dispose()
  }
}
