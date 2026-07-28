/** One byte-oriented E2B PTY session projected onto the harness PTY seam. */

import { Buffer } from 'node:buffer'
import type { CommandHandle, Sandbox } from '@deepseek-ai/dsh-e2b'
import { CommandExitError } from '@deepseek-ai/dsh-e2b'
import {
  PtyTerminalSanitizer,
  PtyTextBuffer,
  ptySignalName,
  ptyUtf8Tail,
} from '@deepseek-ai/dsh-pty'
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/* jscpd:ignore-start -- Operation state stays backend-local because process readiness and cleanup identities diverge. */
class E2BSendOperation implements PtySendOperation {
  private readonly output: PtyTextBuffer
  private readonly result = Promise.withResolvers<PtySendResult>()
  private finished = false

  constructor(
    maxBytes: number,
    readonly startedAt: number,
    private readonly onCancel: () => void,
  ) {
    this.output = new PtyTextBuffer(maxBytes)
  }

  get done(): Promise<PtySendResult> {
    return this.result.promise
  }

  append(text: string): void {
    if (!this.finished) this.output.append(text)
  }

  settle(waitReason: PtyWaitReason, sessionStatus: PtySessionStatus, inheritedTruncation: boolean): void {
    if (this.finished) return
    this.finished = true
    const read = this.output.snapshot()
    this.result.resolve({
      viewport: read.text,
      waitReason,
      sessionStatus,
      truncated: read.truncated || inheritedTruncation,
    })
  }

  fail(error: unknown): void {
    if (this.finished) return
    this.finished = true
    this.result.reject(error)
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
/* jscpd:ignore-end */

/** Live session around one E2B SDK PTY handle. */
export class E2BPtySession implements PtyBackendSession {
  motd = ''
  readonly pid: number
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly sanitizer: PtyTerminalSanitizer
  private readonly scrollback: PtyTextBuffer
  private readonly exited = Promise.withResolvers<void>()
  private statusValue: PtySessionStatus = { kind: 'running' }
  private active: E2BSendOperation | undefined
  private activeTimer: NodeJS.Timeout | undefined
  private activeAbort: (() => void) | undefined
  private promptSeen = false
  private promptTextSeen = false
  private initializing = false
  private lastOutputAt = Date.now()
  private closing = false
  private closePromise: Promise<void> | undefined
  private closeSignal: NodeJS.Signals | null = null
  private transportFailure: Error | undefined
  private remoteExited = false

  constructor(
    private readonly sandbox: Sandbox,
    private readonly handle: CommandHandle,
    private readonly terminalSessionId: number,
    private readonly config: ResolvedConfig,
  ) {
    this.pid = handle.pid
    this.sanitizer = new PtyTerminalSanitizer(config.maxReadBytes)
    this.scrollback = new PtyTextBuffer(config.scrollbackMaxBytes, config.scrollbackLines)
    const completion = handle.wait()
    void completion.then(
      (result) => { this.onExit(result.exitCode) },
      (error: unknown) => {
        if (error instanceof CommandExitError) this.onExit(error.exitCode)
        else this.onTransportFailure(error)
      },
    )
  }

  /**
   * Consume bytes received by the SDK's PTY callback.
   * @param data - Exact callback bytes in delivery order.
   */
  onData(data: Uint8Array): void {
    let decoded: string
    try {
      decoded = this.decoder.decode(data, { stream: true })
    } catch (error: unknown) {
      this.onTransportFailure(new Error('pty-e2b: PTY emitted invalid UTF-8', { cause: error }))
      return
    }
    const sanitized = this.sanitizer.push(decoded)
    this.appendOutput(sanitized.text)
    if (sanitized.prompt) {
      this.promptSeen = true
      this.promptTextSeen = sanitized.promptText === true
      this.lastOutputAt = Date.now()
    } else if (this.promptSeen && sanitized.promptText === true) {
      this.promptTextSeen = true
    }
  }

  /**
   * Await the first prompt or bounded startup fallback.
   * @param signal - Optional startup cancellation signal.
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    this.initializing = true
    try {
      const operation = this.startSend({ text: '', submit: false, ...signal === undefined ? {} : { signal } })
      const result = await operation.done
      if (result.waitReason === 'session_exit') throw new Error('E2B PTY shell exited during startup')
      if (result.waitReason === 'timeout') throw new Error('E2B PTY shell did not reach readiness before startup timeout')
      this.motd = result.viewport
    } catch (error: unknown) {
      signal?.throwIfAborted()
      throw error
    } finally {
      this.initializing = false
    }
  }

  /* jscpd:ignore-start -- PTY backends share request admission while owning distinct input and readiness transports. */
  startSend(request: PtySendRequest): PtySendOperation {
    if (this.closing) throw new Error('E2B PTY session is closing')
    if (this.statusValue.kind === 'exited') throw new Error('E2B PTY session has exited')
    if (this.active !== undefined) throw new Error('E2B PTY session already has an active send')
    if (request.signal?.aborted === true) throw new Error('E2B PTY send aborted before write')

    const operation = new E2BSendOperation(
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

    const input = `${request.text}${request.submit ? '\r' : ''}`
    if (input.length > 0) {
      void this.sandbox.pty.sendInput(this.pid, Buffer.from(input)).catch((error: unknown) => {
        if (this.active === operation) this.failActive(error)
      })
    }
    this.activeTimer = setInterval(() => { this.pollReadiness(operation) }, this.config.pollIntervalMs)
    return operation
  }
  /* jscpd:ignore-end */

  /* jscpd:ignore-start -- The seam requires identical bounded-read coordinates across backend buffers. */
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
    const bounded = ptyUtf8Tail(lines.slice(start, end).join('\n'), this.config.maxReadBytes)
    const returnedLines = bounded.text.length === 0 ? 0 : bounded.text.split('\n').length
    return {
      text: bounded.text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + returnedLines,
      truncated: snapshot.truncated || bounded.truncated,
    }
  }
  /* jscpd:ignore-end */

  /* jscpd:ignore-start -- Signal, status, and close methods preserve the seam shape around remote identities. */
  async signal(signal: PtySignal): Promise<PtySignalResult> {
    const pgid = await this.foregroundPgid()
    if (signal === 'SIGKILL' && pgid === this.pid) {
      throw new Error('refusing to SIGKILL the E2B PTY shell; use terminal_close')
    }
    await this.sandbox.commands.run(`kill -${signal.slice(3)} -- -${pgid}`)
    return { delivered: true, targetPgid: pgid }
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
  /* jscpd:ignore-end */

  private appendOutput(text: string): void {
    if (text.length === 0) return
    this.lastOutputAt = Date.now()
    this.scrollback.append(text)
    this.active?.append(text)
  }

  private pollReadiness(operation: E2BSendOperation): void {
    if (this.active !== operation) return
    if (this.statusValue.kind === 'exited') {
      this.settleActive('session_exit')
      return
    }
    const elapsed = Date.now() - operation.startedAt
    const idleFor = Date.now() - this.lastOutputAt
    if (this.promptSeen && this.promptTextSeen && idleFor >= this.config.pollIntervalMs) {
      this.settleActive('stdin_read')
      return
    }
    const startupHasOutput = !this.initializing || this.scrollback.snapshot().text.length > 0
    if (startupHasOutput && idleFor >= this.config.idleSilenceMs) {
      this.settleActive('inferred_idle')
      return
    }
    if (elapsed >= this.config.timeoutMs) this.settleActive('timeout')
  }

  private settleActive(waitReason: PtyWaitReason): void {
    const operation = this.active
    if (operation === undefined) return
    const inherited = this.scrollback.snapshot().truncated
    this.clearActive()
    operation.settle(waitReason, this.statusValue, inherited)
  }

  private clearActive(): void {
    if (this.activeTimer !== undefined) clearInterval(this.activeTimer)
    this.activeTimer = undefined
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

  private interrupt(operation: E2BSendOperation): void {
    if (this.active !== operation) return
    void this.signal('SIGINT').catch((error: unknown) => { this.failActive(error) })
  }

  private async foregroundPgid(): Promise<number> {
    const result = await this.sandbox.commands.run(`ps -o tpgid= -p ${this.pid}`)
    const raw = result.stdout.trim()
    const pgid = Number(raw)
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(pgid)) {
      throw new Error(`cannot resolve foreground process group for E2B PTY ${this.pid}`)
    }
    return pgid
  }

  private async sessionProcessGroups(): Promise<number[]> {
    const result = await this.sandbox.commands.run(
      `ps -eo sid=,pgid= | awk '$1 == ${this.terminalSessionId} { print $2 }'`,
    )
    const groups = new Set<number>()
    for (const raw of result.stdout.trim().split(/\s+/)) {
      if (raw.length === 0) continue
      const pgid = Number(raw)
      if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(pgid) || pgid <= 1) {
        throw new Error(`pty-e2b: invalid process group ${JSON.stringify(raw)} in terminal session ${this.terminalSessionId}`)
      }
      groups.add(pgid)
    }
    return [...groups]
  }

  private async signalProcessGroups(groups: number[], signal: 'TERM' | 'KILL'): Promise<void> {
    try {
      await this.sandbox.commands.run(`kill -${signal} -- ${groups.map(pgid => `-${pgid}`).join(' ')}`)
    } catch (error: unknown) {
      if (!(error instanceof CommandExitError)) throw error
    }
  }

  private async awaitSessionEmpty(timeoutMs: number, signal?: 'KILL'): Promise<number[]> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const groups = await this.sessionProcessGroups()
      if (groups.length === 0 || Date.now() >= deadline) return groups
      if (signal !== undefined) await this.signalProcessGroups(groups, signal)
      await delay(Math.min(this.config.pollIntervalMs, deadline - Date.now()))
    }
  }

  private onExit(exitCode: number): void {
    this.remoteExited = true
    let tail = ''
    try {
      tail = this.decoder.decode()
    } catch (error: unknown) {
      this.transportFailure ??= new Error('pty-e2b: PTY ended with invalid UTF-8', { cause: error })
    }
    this.appendOutput(this.sanitizer.push(tail).text)
    this.appendOutput(this.sanitizer.flush())
    const inferredSignal = this.closeSignal ?? (exitCode > 128 ? ptySignalName(exitCode - 128) : null)
    this.statusValue = {
      kind: 'exited',
      exitCode: inferredSignal === null ? exitCode : null,
      signal: inferredSignal,
    }
    if (this.transportFailure === undefined) this.settleActive('session_exit')
    else this.failActive(this.transportFailure)
    this.exited.resolve()
  }

  private onTransportFailure(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error))
    this.transportFailure ??= failure
    this.statusValue = { kind: 'exited', exitCode: null, signal: null }
    this.failActive(failure)
  }

  private async closeOnce(reason: string): Promise<void> {
    let survivingGroups = await this.sessionProcessGroups()
    if (survivingGroups.length > 0) {
      this.closeSignal = 'SIGTERM'
      await this.signalProcessGroups(survivingGroups, 'TERM')
      survivingGroups = await this.awaitSessionEmpty(this.config.disposeGraceMs)
    }
    if (survivingGroups.length > 0 || !this.remoteExited) {
      this.closeSignal = 'SIGKILL'
      if (!this.remoteExited) await this.sandbox.pty.kill(this.pid)
      survivingGroups = await this.awaitSessionEmpty(this.config.disposeGraceMs, 'KILL')
      if (!this.remoteExited) await Promise.race([this.exited.promise, delay(this.config.disposeGraceMs)])
    }
    if (survivingGroups.length > 0) {
      throw new Error(`E2B PTY cleanup failed (${reason}); surviving process groups: ${survivingGroups.join(', ')}`)
    }
    if (!this.remoteExited) {
      throw new Error(`E2B PTY cleanup failed (${reason}); surviving pid: ${this.pid}`)
    }
    this.settleActive('session_exit')
    await this.handle.disconnect().catch(() => {})
    if (this.transportFailure !== undefined) throw this.transportFailure
  }
}
