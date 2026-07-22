/** Local `node-pty` session: bounded output, readiness, signals, and teardown. */

import { constants } from 'node:os'
import { Buffer } from 'node:buffer'
import type { IDisposable, IPty } from 'node-pty'
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
import type { ProcessInspector } from './process-inspector.ts'
import { TerminalSanitizer } from './sanitize.ts'

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function utf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  const chars = Array.from(text)
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const next = Buffer.byteLength(chars[start - 1] as string)
    if (bytes + next > maxBytes) break
    bytes += next
    start -= 1
  }
  return { text: chars.slice(start).join(''), truncated: true }
}

class BoundedTextBuffer {
  private value = ''
  private dropped = false

  constructor(
    private readonly maxBytes: number,
    private readonly maxLines?: number,
  ) {}

  append(text: string): void {
    if (text.length === 0) return
    this.value += text
    if (this.maxLines !== undefined) {
      const lines = this.value.split('\n')
      if (lines.length > this.maxLines) {
        this.value = lines.slice(lines.length - this.maxLines).join('\n')
        this.dropped = true
      }
    }
    const tail = utf8Tail(this.value, this.maxBytes)
    this.value = tail.text
    this.dropped ||= tail.truncated
  }

  consume(): PtySendRead {
    const delta = this.value
    const truncated = this.dropped
    this.value = ''
    this.dropped = false
    return { delta, truncated }
  }

  snapshot(): { text: string; truncated: boolean } {
    return { text: this.value, truncated: this.dropped }
  }
}

class LocalSendOperation implements PtySendOperation {
  private readonly output: BoundedTextBuffer
  private readonly promise: PromiseWithResolvers<PtySendResult>
  private finished = false

  constructor(
    maxBytes: number,
    readonly startedAt: number,
    private readonly onCancel: () => void,
  ) {
    this.output = new BoundedTextBuffer(maxBytes)
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

function signalName(number: number | undefined): NodeJS.Signals | null {
  if (number === undefined || number === 0) return null
  for (const [name, value] of Object.entries(constants.signals)) {
    if (value === number) return name as NodeJS.Signals
  }
  return null
}

/** Backend session wrapping one `node-pty` process and its captured process tree. */
export class LocalPtySession implements PtyBackendSession {
  motd = ''
  readonly pid: number
  private readonly sanitizer: TerminalSanitizer
  private readonly scrollback: BoundedTextBuffer
  private readonly exitPromise: PromiseWithResolvers<void> = Promise.withResolvers<void>()
  private readonly dataDisposable: IDisposable
  private readonly exitDisposable: IDisposable
  private statusValue: PtySessionStatus = { kind: 'running' }
  private active: LocalSendOperation | undefined
  private activeTimer: NodeJS.Timeout | undefined
  private activeAbort: (() => void) | undefined
  private promptSeen = false
  private shellPgid: number | undefined
  private initializing = false
  private lastOutputAt = Date.now()
  private closePromise: Promise<void> | undefined

  constructor(
    private readonly terminal: IPty,
    private readonly inspector: ProcessInspector,
    private readonly config: ResolvedConfig,
  ) {
    this.pid = terminal.pid
    this.sanitizer = new TerminalSanitizer(config.maxReadBytes)
    this.scrollback = new BoundedTextBuffer(config.scrollbackMaxBytes, config.scrollbackLines)
    this.dataDisposable = terminal.onData((data) => { this.onData(data) })
    this.exitDisposable = terminal.onExit(({ exitCode, signal }) => {
      const tail = this.sanitizer.flush()
      this.appendOutput(tail)
      this.statusValue = { kind: 'exited', exitCode, signal: signalName(signal) }
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
    } finally {
      this.initializing = false
    }
  }

  startSend(request: PtySendRequest): PtySendOperation {
    if (this.closePromise !== undefined) throw new Error('PTY session is closing')
    if (this.statusValue.kind === 'exited') throw new Error('PTY session has exited')
    if (this.active !== undefined) throw new Error('PTY session already has an active send')
    if (request.signal?.aborted === true) throw new Error('PTY send aborted before write')

    const operation = new LocalSendOperation(this.config.maxReadBytes, Date.now(), () => {
      try {
        this.terminal.write('\x03')
      } catch (error: unknown) {
        operation.fail(error)
      }
    })
    this.active = operation
    this.lastOutputAt = Date.now()
    this.promptSeen = false

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
    const bounded = utf8Tail(requested, this.config.maxReadBytes)
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
    this.closePromise ??= this.closeOnce(reason)
    return this.closePromise
  }

  private onData(data: string): void {
    const sanitized = this.sanitizer.push(data)
    this.appendOutput(sanitized.text)
    if (sanitized.prompt) {
      const foregroundPgid = this.inspector.foregroundPgid(this.pid)
      if (this.shellPgid === undefined) this.shellPgid = foregroundPgid
      if (foregroundPgid !== undefined && foregroundPgid === this.shellPgid) {
        this.promptSeen = true
        this.lastOutputAt = Date.now()
      }
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
    if (this.promptSeen && Date.now() - this.lastOutputAt >= this.config.pollIntervalMs) {
      this.settleActive('stdin_read')
      return
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
    if (startupHasOutput && Date.now() - this.lastOutputAt >= this.config.idleSilenceMs) {
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

  private async closeOnce(reason: string): Promise<void> {
    this.dataDisposable.dispose()
    // Stop readiness polling but retain the active operation: teardown settles
    // it as session_exit below, so an in-flight send is never mis-settled as
    // stdin_read/inferred_idle/timeout during the grace period.
    this.stopPolling()
    const members = this.inspector.processTree(this.pid)
    for (const member of members) {
      try {
        this.inspector.signalProcess(member, 'SIGTERM')
      } catch (_alreadyExitedDuringTerm) {
        // Identity is rechecked by the inspector; a same-tick exit is success.
      }
    }
    try {
      this.terminal.kill('SIGTERM')
    } catch (_topLevelAlreadyExited) {
      // onExit or identity checks below remain authoritative.
    }

    const deadline = Date.now() + this.config.disposeGraceMs
    let survivors = members.filter(member => this.inspector.isAlive(member))
    while (survivors.length > 0 && Date.now() < deadline) {
      await delay(Math.min(25, this.config.disposeGraceMs))
      survivors = members.filter(member => this.inspector.isAlive(member))
    }
    for (const survivor of survivors) {
      try {
        this.inspector.signalProcess(survivor, 'SIGKILL')
      } catch (_alreadyExitedDuringKill) {
        // Final identity check below decides success.
      }
    }
    try {
      this.terminal.kill('SIGKILL')
    } catch (_topLevelAlreadyKilled) {
      // The root may already have delivered onExit.
    }

    const killDeadline = Date.now() + this.config.disposeGraceMs
    survivors = members.filter(member => this.inspector.isAlive(member))
    while (survivors.length > 0 && Date.now() < killDeadline) {
      await delay(Math.min(25, this.config.disposeGraceMs))
      survivors = members.filter(member => this.inspector.isAlive(member))
    }
    const exitWaitMs = Math.max(0, killDeadline - Date.now())
    await Promise.race([this.exitPromise.promise, delay(exitWaitMs)])
    survivors = members.filter(member => this.inspector.isAlive(member))
    this.settleActive('session_exit')
    this.exitDisposable.dispose()
    if (survivors.length > 0) {
      throw new Error(`PTY cleanup failed (${reason}); surviving pids: ${survivors.map(member => member.pid).join(', ')}`)
    }
  }
}
