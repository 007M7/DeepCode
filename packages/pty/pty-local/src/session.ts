/** Persistent PTY session over the subprocess seam's terminal primitive. */

import { Buffer } from 'node:buffer'
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
} from '@deepseek-ai/dsh-subprocess'
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
import { CONTROLLED_PROMPT, TerminalSanitizer } from './sanitize.ts'

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
  private cancellationRequested = false
  private initialForegroundLeftWait: boolean
  private initialForegroundPgid: number | undefined

  constructor(
    maxBytes: number,
    readonly startedAt: number,
    private readonly onCancel: () => void,
  ) {
    this.output = new BoundedTextBuffer(maxBytes)
    this.promise = Promise.withResolvers<PtySendResult>()
    this.initialForegroundLeftWait = true
  }

  get done(): Promise<PtySendResult> {
    return this.promise.promise
  }

  get settled(): boolean {
    return this.finished
  }

  get cancelRequested(): boolean {
    return this.cancellationRequested
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

  setInitialForeground(foreground: SubprocessTerminalForeground | undefined): void {
    this.initialForegroundPgid = foreground?.processGroupId
    this.initialForegroundLeftWait = foreground?.inputWaiting !== true
  }

  acceptsStdinWait(pgid: number, waiting: boolean): boolean {
    // The same group may still expose the wait that existed before terminal.write.
    // Observe every poll so a departure before the exact-settlement threshold
    // still makes a later return to that wait post-write evidence.
    if (pgid !== this.initialForegroundPgid) return waiting
    if (!waiting) this.initialForegroundLeftWait = true
    return waiting && this.initialForegroundLeftWait
  }

  cancel(): boolean {
    if (this.finished) return false
    this.cancellationRequested = true
    this.onCancel()
    return true
  }
}

/** Backend session wrapping one provider-owned terminal process. */
export class LocalPtySession implements PtyBackendSession {
  motd = ''
  readonly pid: number
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly sanitizer: TerminalSanitizer
  private readonly scrollback: BoundedTextBuffer
  private readonly outputEnded = Promise.withResolvers<void>()
  private readonly completion: Promise<void>
  private statusValue: PtySessionStatus = { kind: 'running' }
  private active: LocalSendOperation | undefined
  private activeTimer: NodeJS.Timeout | undefined
  private activeDeadlineTimer: NodeJS.Timeout | undefined
  private activeAbort: (() => void) | undefined
  private writing: LocalSendOperation | undefined
  private pollingReady: LocalSendOperation | undefined
  private polling = false
  private promptSeen = false
  private promptTextSeen = false
  private promptTail = ''
  private shellPgid: number | undefined
  private initializing = false
  private lastOutputAt = Date.now()
  private closing = false
  private closePromise: Promise<void> | undefined
  private transportFailure: Error | undefined

  constructor(
    private readonly terminal: SubprocessTerminalHandle,
    private readonly config: ResolvedConfig,
  ) {
    this.pid = terminal.pid
    this.sanitizer = new TerminalSanitizer(config.maxReadBytes)
    this.scrollback = new BoundedTextBuffer(config.scrollbackMaxBytes, config.scrollbackLines)
    terminal.output.on('data', this.onTerminalData)
    terminal.output.once('end', this.onTerminalEnd)
    terminal.output.once('error', this.onTerminalError)
    this.completion = terminal.done.then(
      outcome => this.onExit(outcome),
      (error: unknown) => { this.onTransportFailure(error) },
    )
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
    this.promptTail = ''

    if (request.signal !== undefined) {
      const onAbort = (): void => { operation.cancel() }
      request.signal.addEventListener('abort', onAbort, { once: true })
      this.activeAbort = () => request.signal?.removeEventListener('abort', onAbort)
    }
    this.activeDeadlineTimer = setTimeout(() => {
      if (this.active === operation) this.settleActive('timeout', this.writing === operation)
    }, this.config.timeoutMs)
    void this.beginSend(operation, request)
    return operation
  }

  private async beginSend(operation: LocalSendOperation, request: PtySendRequest): Promise<void> {
    try {
      const foreground = await this.terminal.inspectForeground()
      if (this.active !== operation || this.closing) return
      operation.setInitialForeground(foreground)
      const input = `${request.text}${request.submit ? '\r' : ''}`
      if (input.length > 0 && !operation.cancelRequested) {
        this.writing = operation
        try {
          await this.terminal.write(Buffer.from(input, 'utf8'))
        } finally {
          this.writing = undefined
        }
      }
      if (this.active === operation && operation.settled) {
        this.clearActive()
        return
      }
      // Closing can race the awaited provider write even though static analysis sees only local assignments.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (this.active === operation && !this.closing) {
        this.pollingReady = operation
        this.schedulePoll(operation)
      }
    } catch (error: unknown) {
      if (this.active === operation) {
        if (operation.settled) this.clearActive()
        else this.failActive(error)
      }
    }
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

  async signal(signal: PtySignal): Promise<PtySignalResult> {
    const targetPgid = await this.terminal.signalForeground(signal)
    return { delivered: true, targetPgid }
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

  private readonly onTerminalData = (chunk: Buffer | Uint8Array | string): void => {
    try {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      this.onData(this.decoder.decode(bytes, { stream: true }))
    } catch (error: unknown) {
      this.onTransportFailure(new Error('PTY emitted invalid UTF-8', { cause: error }))
    }
  }

  private readonly onTerminalEnd = (): void => {
    try {
      this.onData(this.decoder.decode())
      this.appendOutput(this.sanitizer.flush())
    } catch (error: unknown) {
      this.onTransportFailure(new Error('PTY ended with invalid UTF-8', { cause: error }))
    } finally {
      this.outputEnded.resolve()
    }
  }

  private readonly onTerminalError = (error: Error): void => {
    this.onTransportFailure(error)
    this.outputEnded.resolve()
  }

  private onData(data: string): void {
    const sanitized = this.sanitizer.push(data)
    this.appendOutput(sanitized.text)
    if (sanitized.prompt) {
      // Bash can print PROMPT_COMMAND before the kernel publishes its return
      // to the foreground process group. Retain the marker; polling below is
      // the authority that accepts it only after bash owns the foreground.
      this.promptSeen = true
      this.promptTail = ''
      this.lastOutputAt = Date.now()
    }
    if (this.promptSeen && sanitized.promptTail !== undefined) {
      const remaining = Math.max(0, CONTROLLED_PROMPT.length + 1 - this.promptTail.length)
      this.promptTail += sanitized.promptTail.slice(0, remaining)
      if (sanitized.promptTail.length > remaining) this.promptTail = `${CONTROLLED_PROMPT}\0`
      this.promptTextSeen = this.promptTail === CONTROLLED_PROMPT
    }
  }

  private async onExit(outcome: SubprocessOutcome): Promise<void> {
    await this.outputEnded.promise
    if (this.transportFailure !== undefined) return
    this.statusValue = { kind: 'exited', exitCode: outcome.exitCode, signal: outcome.signal }
    this.settleActive('session_exit')
  }

  private onTransportFailure(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error))
    this.transportFailure ??= failure
    this.statusValue = { kind: 'exited', exitCode: null, signal: null }
    this.failActive(failure)
    this.terminal.terminate()
  }

  private appendOutput(text: string): void {
    if (text.length === 0) return
    this.lastOutputAt = Date.now()
    this.scrollback.append(text)
    this.active?.append(text)
  }

  private schedulePoll(operation: LocalSendOperation, delayMs = this.config.pollIntervalMs): void {
    if (this.active !== operation || this.polling) return
    if (this.activeTimer !== undefined) clearTimeout(this.activeTimer)
    this.activeTimer = setTimeout(() => {
      this.activeTimer = undefined
      void this.pollReadiness(operation)
    }, delayMs)
  }

  private async pollReadiness(operation: LocalSendOperation): Promise<void> {
    if (this.active !== operation || this.polling) return
    this.polling = true
    try {
      if (this.statusValue.kind === 'exited') {
        this.settleActive('session_exit')
        return
      }
      const foreground = await this.terminal.inspectForeground()
      if (this.active !== operation) return
      const idleFor = Date.now() - this.lastOutputAt
      if (this.promptSeen && foreground !== undefined && this.shellPgid === undefined) {
        this.shellPgid = foreground.processGroupId
      }
      if (this.promptSeen && this.promptTextSeen && idleFor >= this.config.pollIntervalMs
        && foreground?.processGroupId === this.shellPgid) {
        this.settleActive('stdin_read')
        return
      }
      const elapsed = Date.now() - operation.startedAt
      const startupHasOutput = !this.initializing || this.scrollback.snapshot().text.length > 0
      const acceptsStdinWait = startupHasOutput && foreground !== undefined
        && operation.acceptsStdinWait(foreground.processGroupId, foreground.inputWaiting)
      if (elapsed >= this.config.exactProbeAfterMs && acceptsStdinWait) {
        this.settleActive('stdin_read')
        return
      }
      // A prompt candidate can race bash's foreground handoff, but an interactive
      // child also inherits PROMPT_COMMAND. Silence therefore remains the bound
      // on waiting for shell ownership instead of letting a child marker suppress
      // readiness until the absolute timeout.
      const handoffGrace = this.promptSeen ? this.config.handoffGraceMs : 0
      if (startupHasOutput && idleFor >= this.config.idleSilenceMs + handoffGrace) {
        this.settleActive('inferred_idle')
      }
    } catch (error: unknown) {
      if (this.active === operation) this.failActive(error)
    } finally {
      this.polling = false
      const active = this.active
      // Awaited provider inspection can clear or replace the active send despite static analysis.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (active !== undefined && this.pollingReady === active) this.schedulePoll(active)
    }
  }

  private settleActive(waitReason: PtyWaitReason, retainOwnership = false): void {
    const operation = this.active
    if (operation === undefined) return
    const scrollbackTruncated = this.scrollback.snapshot().truncated
    if (retainOwnership) {
      this.stopPolling()
      this.activeAbort?.()
      this.activeAbort = undefined
    } else {
      this.clearActive()
    }
    operation.settle(waitReason, this.statusValue, scrollbackTruncated)
  }

  private stopPolling(): void {
    if (this.activeTimer !== undefined) clearTimeout(this.activeTimer)
    this.activeTimer = undefined
    if (this.activeDeadlineTimer !== undefined) clearTimeout(this.activeDeadlineTimer)
    this.activeDeadlineTimer = undefined
  }

  private clearActive(): void {
    this.stopPolling()
    this.activeAbort?.()
    this.activeAbort = undefined
    this.writing = undefined
    this.pollingReady = undefined
    this.active = undefined
  }

  private failActive(error: unknown, retainOwnership = false): void {
    const operation = this.active
    if (operation === undefined) return
    if (retainOwnership) {
      this.stopPolling()
      this.activeAbort?.()
      this.activeAbort = undefined
    } else {
      this.clearActive()
    }
    operation.fail(error)
  }

  private interrupt(operation: LocalSendOperation): void {
    if (this.active !== operation) return
    void this.terminal.signalForeground('SIGINT').catch((error: unknown) => {
      if (this.active === operation) this.failActive(error, this.writing === operation)
    })
  }

  private async closeOnce(reason: string): Promise<void> {
    // Stop readiness polling but retain the active operation: teardown settles
    // it as session_exit below, so an in-flight send is never mis-settled as
    // stdin_read/inferred_idle/timeout during the grace period.
    this.stopPolling()
    this.terminal.terminate()
    const quiescent = await this.terminal.waitForExit()
    if (!quiescent) {
      throw new Error(`PTY cleanup failed (${reason}); terminal session did not reach quiescence`)
    }
    // Whole-session cleanup can fail before the top-level process exits. Wait
    // for it first so that failure is reported instead of blocking forever on
    // `done`; successful quiescence guarantees `done` can now settle status and
    // drain the terminal output.
    await this.completion
    this.settleActive('session_exit')
    this.terminal.output.off('data', this.onTerminalData)
    this.terminal.output.off('end', this.onTerminalEnd)
    this.terminal.output.off('error', this.onTerminalError)
    if (this.transportFailure !== undefined) throw this.transportFailure
  }
}
