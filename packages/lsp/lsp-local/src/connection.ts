/**
 * A JSON-RPC endpoint over one spawned language server's stdio. Owns id correlation, outbound
 * requests/notifications, and inbound server→client requests: it answers `workspace/configuration`
 * from static config, and rejects `workspace/applyEdit` (this host never applies edits or runs
 * commands). It caps stderr, surfaces framing/decoder failures as a fatal close, and exposes the
 * child handle so the instance owns process-signal teardown.
 * @module @deepseek-ai/dsh-lsp-local/connection
 */

import type { ChildProcessByStdio } from 'node:child_process'
import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { encodeMessage, MessageDecoder } from './framing.ts'

/** How to launch the server and answer its config requests. */
export interface ConnectionSpec {
  /** The resolved absolute executable path (no shell). */
  readonly command: string
  /** Arguments passed to the executable. */
  readonly args: readonly string[]
  /** The child's working directory (the canonical workspace). */
  readonly cwd: string
  /** The child's environment (credential-scrubbed, with overrides applied). */
  readonly env: Record<string, string>
  /** Largest single framed message accepted from the server. */
  readonly maxMessageBytes: number
  /** Largest stderr tail retained for diagnostics. */
  readonly maxStderrBytes: number
  /** Static answer to every `workspace/configuration` item. */
  readonly configuration: unknown
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** A live JSON-RPC endpoint bound to one child process. */
export class LspConnection {
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>
  private readonly decoder: MessageDecoder
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private stderr = Buffer.alloc(0)
  private closeReason: Error | undefined
  /** Set once the process has fully exited; the instance awaits it during teardown. */
  readonly closed: Promise<void>

  /**
   * @param spec - how to launch the server and answer its config requests.
   * @param onServerRequest - answers a server→client request; rejects to send an error response.
   */
  constructor(
    private readonly spec: ConnectionSpec,
    private readonly onServerRequest: (method: string, params: unknown) => Promise<unknown>,
  ) {
    this.decoder = new MessageDecoder(spec.maxMessageBytes)
    // `detached` puts the server in its own process group so teardown can signal the WHOLE group
    // (via `process.kill(-pid)`), reaching helper processes a language server spawns (e.g. tsserver).
    this.child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    this.closed = new Promise<void>((resolve) => {
      this.child.on('close', () => {
        const reason = this.closeReason ?? new Error(this.exitMessage())
        // Record the reason so any request issued AFTER close rejects immediately instead of hanging
        // (a closed process sends no further responses).
        this.closeReason = reason
        this.failAll(reason)
        resolve()
      })
    })
    this.child.on('error', (error) => { this.fail(error) })
    // A write to the child's stdin after it exits emits an async 'error'; swallow it so an EPIPE
    // during teardown does not crash the process. Pending requests fail via the 'close' handler.
    /* v8 ignore next -- the handler only fires on an async stdin write error during teardown. */
    this.child.stdin.on('error', () => { /* swallow */ })
    this.child.stdout.on('data', (chunk: Buffer) => { this.onStdout(chunk) })
    this.child.stderr.on('data', (chunk: Buffer) => { this.onStderr(chunk) })
  }

  /** The child's pid, or `-1` when the spawn produced no pid (so signalling is a no-op). */
  get pid(): number {
    /* v8 ignore next -- the `-1` fallback only applies to a spawn that produced no pid; defensive. */
    return this.child.pid ?? -1
  }

  /** The retained stderr tail, for diagnostics on a failed server. */
  get stderrTail(): string {
    return this.stderr.toString('utf8')
  }

  /**
   * Send a request and await its result.
   * @param method - the JSON-RPC method.
   * @param params - the request params.
   * @returns the response result; rejects on an error response, write failure, or close.
   */
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      if (this.closeReason !== undefined) {
        reject(this.closeReason)
        return
      }
      this.pending.set(id, { resolve, reject })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        /* v8 ignore start -- a stdin write failure surfaces asynchronously via the swallowed
           'error' listener, so this synchronous catch is a defensive guard. */
        this.pending.delete(id)
        reject(asError(error))
        /* v8 ignore stop */
      }
    })
    // A caller that stops awaiting (e.g. an aborted query) can leave this promise to reject later
    // when the process closes; a benign no-op handler keeps that from surfacing as an unhandled
    // rejection. The returned promise still delivers the rejection to the caller's own await/catch.
    promise.catch(() => {})
    return promise
  }

  /**
   * Send a notification (no id, no response).
   * @param method - the JSON-RPC method.
   * @param params - the notification params.
   */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  /**
   * Send a `$/cancelRequest` for an in-flight request id (best-effort; ignores write failure).
   * @param requestId - the numeric id of the request to cancel.
   */
  cancel(requestId: number): void {
    try {
      this.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: requestId } })
    } catch {
      // The server is already gone or unwritable; the pending request will fail on close.
    }
  }

  /**
   * The id the NEXT `request()` will use, so the instance can pre-arm a cancel.
   * @returns the numeric id the next request will be assigned.
   */
  peekNextId(): number {
    return this.nextId
  }

  /** Send SIGTERM to the server's process group (idempotent-safe; a dead group ignores it). */
  terminate(): void {
    this.signalGroup('SIGTERM')
  }

  /** Send SIGKILL to the server's process group. */
  kill(): void {
    this.signalGroup('SIGKILL')
  }

  /**
   * Signal the whole process group (negative pid) so helper processes are reached; fall back to the
   * direct child if the group send fails. Never throws — teardown races process exit.
   */
  private signalGroup(sig: NodeJS.Signals): void {
    const pid = this.child.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, sig)
    } catch {
      // The group is gone (already exited) or could not be signalled; try the direct child.
      try {
        this.child.kill(sig)
      } catch {
        // Already dead; nothing to signal.
      }
    }
  }

  private onStdout(chunk: Buffer): void {
    let messages: unknown[]
    try {
      messages = this.decoder.push(chunk)
    } catch (error) {
      // A framing/JSON failure corrupts the stream position irrecoverably: fail the instance and
      // SIGKILL the whole group so helper processes don't outlive the leader.
      this.fail(asError(error))
      this.signalGroup('SIGKILL')
      return
    }
    for (const message of messages) this.dispatch(message)
  }

  private onStderr(chunk: Buffer): void {
    // Retain the TAIL, not the prefix: a language server's fatal diagnostic usually appears just
    // before it exits, so the final bounded segment is the useful one.
    const cap = this.spec.maxStderrBytes
    if (chunk.length >= cap) {
      // Copy the bounded suffix so retaining it does not pin an arbitrarily large incoming buffer.
      this.stderr = Buffer.from(chunk.subarray(chunk.length - cap))
      return
    }
    const retainedBytes = Math.min(this.stderr.length, cap - chunk.length)
    this.stderr = Buffer.concat([
      this.stderr.subarray(this.stderr.length - retainedBytes),
      chunk,
    ], retainedBytes + chunk.length)
  }

  private dispatch(message: unknown): void {
    if (message === null || typeof message !== 'object') return
    const frame = message as Record<string, unknown>
    const id = frame.id
    const method = frame.method
    if (typeof method === 'string' && (typeof id === 'number' || typeof id === 'string')) {
      void this.handleServerRequest(id, method, frame.params)
      return
    }
    if (typeof method === 'string') {
      // A server→client notification (e.g. diagnostics, logs): ignored by this MVP host.
      return
    }
    if (typeof id === 'number') this.handleResponse(id, frame)
  }

  private async handleServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.onServerRequest(method, params)
      this.write({ jsonrpc: '2.0', id, result })
    } catch (error) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: asError(error).message } })
    }
  }

  private handleResponse(id: number, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    const error = frame.error
    if (error !== null && typeof error === 'object') {
      const record = error as Record<string, unknown>
      pending.reject(new Error(typeof record.message === 'string' ? record.message : 'LSP error response'))
      return
    }
    pending.resolve(frame.result)
  }

  private write(message: unknown): void {
    this.child.stdin.write(encodeMessage(message))
  }

  /** The exit-close error message, appending the retained stderr tail when the server wrote any. */
  private exitMessage(): string {
    const tail = this.stderrTail.trim()
    return tail === '' ? 'language server exited' : `language server exited; stderr: ${tail}`
  }

  private fail(error: Error): void {
    /* v8 ignore next -- the second arm (closeReason already set) needs two fail() calls before close; defensive. */
    if (this.closeReason === undefined) this.closeReason = error
    this.failAll(error)
  }

  private failAll(error: Error): void {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const pending of waiting) pending.reject(error)
  }
}

/** Coerce an unknown thrown value to an `Error`. */
function asError(value: unknown): Error {
  /* v8 ignore next -- the non-Error branch guards against a non-Error throw, which our paths never produce. */
  return value instanceof Error ? value : new Error(String(value))
}
