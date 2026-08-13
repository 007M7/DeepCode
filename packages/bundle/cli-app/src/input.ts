/**
 * Single owner of the process's one `readline/promises` interface. The REPL,
 * the approval answerer, and the user-questions provider all prompt through this
 * object, so exactly one line editor is ever attached to stdin; none of them may
 * create their own readline interface.
 *
 * This module is deliberately free of Cordis imports: it is a plain object
 * wrapping Node's readline, injected into the runner and handed to the answerer
 * and question provider unchanged.
 * @module @deepseek-ai/dsh-cli-app/input
 */

import { createInterface, type Interface } from 'node:readline'

interface PendingLine {
  readonly resolve: (line: string) => void
  readonly reject: (error: Error) => void
  readonly signal?: AbortSignal
  readonly abort?: () => void
}

/** Constructor inputs; each falls back to the matching process stream when omitted. */
export interface CliInputOptions {
  /** The stream to read lines from; defaults to `process.stdin`. */
  input?: NodeJS.ReadableStream
  /** The stream to write prompts and echoes to; defaults to `process.stdout`. */
  output?: NodeJS.WritableStream
  /** Force terminal (line-editing) mode; defaults to readline's `isTTY` inference. */
  terminal?: boolean
}

/**
 * Sole holder of the `readline/promises` interface backing the interactive CLI.
 *
 * Responsibilities:
 * - `ask` serialises prompts: at most one question is pending at a time, and an
 *   `AbortSignal` cancels the pending read without leaving a second editor open.
 * - `closed` resolves once, when the input reaches EOF or `close()` is called.
 * - `onSigint` accepts the one runner-owned Ctrl+C handler and forwards readline's
 *   `SIGINT` event (emitted only in terminal mode) to it.
 * - `close` is idempotent and releases the interface and its listeners.
 */
export class CliInput {
  private readonly rl: Interface
  private readonly output: NodeJS.WritableStream
  private readonly closePromise: Promise<void>
  private resolveClose!: () => void
  private closedFlag = false
  private readonly queuedLines: string[] = []
  private pending: PendingLine | undefined
  private sigintHandler: (() => void) | undefined

  constructor(options: CliInputOptions = {}) {
    this.output = options.output ?? process.stdout
    this.rl = createInterface({
      input: options.input ?? process.stdin,
      output: this.output,
      terminal: options.terminal,
    })
    this.closePromise = new Promise<void>((resolve) => {
      this.resolveClose = resolve
    })
    this.rl.on('line', (line) => {
      const pending = this.pending
      if (pending === undefined) {
        this.queuedLines.push(line)
        return
      }
      this.pending = undefined
      if (pending.signal !== undefined && pending.abort !== undefined) {
        pending.signal.removeEventListener('abort', pending.abort)
      }
      pending.resolve(line)
    })
    this.rl.once('close', () => {
      this.closedFlag = true
      const pending = this.pending
      this.pending = undefined
      if (pending !== undefined) {
        if (pending.signal !== undefined && pending.abort !== undefined) {
          pending.signal.removeEventListener('abort', pending.abort)
        }
        pending.reject(new Error('CliInput.ask: the input closed before an answer arrived'))
      }
      this.resolveClose()
    })
    // Forward readline's terminal-mode Ctrl+C to the single runner handler.
    this.rl.on('SIGINT', () => {
      this.sigintHandler?.()
    })
  }

  /**
   * Read one line after writing `prompt`. Only one `ask` may be in flight at a
   * time; a concurrent call throws rather than opening a second editor.
   *
   * @param prompt - text written to the output stream before reading.
   * @param signal - when aborted, the pending read is cancelled and the returned
   *   promise rejects with the signal's reason.
   * @returns the line typed by the user, without the trailing newline.
   * @throws when the interface closes before a line arrives or the supplied
   *   signal aborts the pending question.
   */
  ask(prompt: string, signal?: AbortSignal): Promise<string> {
    if (this.pending !== undefined) return Promise.reject(new Error('CliInput.ask: a question is already pending'))
    signal?.throwIfAborted()
    this.output.write(prompt)
    const queued = this.queuedLines.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.closedFlag) return Promise.reject(new Error('CliInput.ask: the input is closed'))
    return new Promise<string>((resolve, reject) => {
      const pending: PendingLine = { resolve, reject, ...signal === undefined ? {} : { signal } }
      if (signal !== undefined) {
        const abort = (): void => {
          if (this.pending !== pending) return
          this.pending = undefined
          reject(signal.reason instanceof Error ? signal.reason : new Error('CliInput.ask: aborted'))
        }
        signal.addEventListener('abort', abort, { once: true })
        Object.assign(pending, { abort })
      }
      this.pending = pending
    })
  }

  /**
   * Resolves once when the input reaches EOF or `close()` is called, whichever
   * comes first. Awaited by the runner to detect an idle exit condition.
   */
  get closed(): Promise<void> {
    return this.closePromise
  }

  /** Whether EOF or `close()` has already terminated the interface. */
  get isClosed(): boolean {
    return this.closedFlag && this.queuedLines.length === 0
  }

  /**
   * Register the runner's single Ctrl+C handler. Readline emits `SIGINT` only in
   * terminal mode; when it fires, `handler` is invoked synchronously. May be
   * called at most once — the REPL owns Ctrl+C, so a second registration is a
   * programming error.
   *
   * @param handler - the callback to run on Ctrl+C.
   */
  onSigint(handler: () => void): void {
    if (this.sigintHandler !== undefined) {
      throw new Error('CliInput.onSigint: a SIGINT handler is already registered')
    }
    this.sigintHandler = handler
  }

  /**
   * Close the interface and release its listeners. Idempotent: repeated calls
   * are no-ops, and a close already caused by EOF does not error. The owned
   * close promise rejects any pending `ask`; Node's readline question does not
   * settle on interface close by itself.
   */
  close(): void {
    if (this.closedFlag) return
    this.closedFlag = true
    this.queuedLines.length = 0
    const pending = this.pending
    this.pending = undefined
    if (pending !== undefined) {
      if (pending.signal !== undefined && pending.abort !== undefined) {
        pending.signal.removeEventListener('abort', pending.abort)
      }
      pending.reject(new Error('CliInput.ask: the input closed before an answer arrived'))
    }
    this.resolveClose()
    this.rl.removeAllListeners('SIGINT')
    this.rl.close()
  }
}
