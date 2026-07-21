/**
 * Worker-side execution logic, written as plain functions over an injected port so the unit
 * suite can run every line IN-PROCESS against a fake port (a real worker thread is a separate
 * V8 isolate the coverage provider cannot observe).
 * @module @deepseek-ai/dsh-code-runtime-worker/src/bootstrap
 */

import { inspect } from 'node:util'
import type { DoneMessage, ReplyMessage, WorkerBootData, WorkerToHost } from './protocol.ts'
import { jsonValueBytesUpTo } from './output-json.ts'
import { snapshotCodeJsonValue } from './worker-json.ts'

/** The port surface the bootstrap needs — satisfied by `parentPort` and by the tests' fake. */
export interface BootstrapPort {
  postMessage(message: WorkerToHost): void
  on(event: 'message', listener: (message: ReplyMessage) => void): void
}

/**
 * A writable stream's `write` slot, as the bootstrap patches it (see
 * {@link captureStreamWrites}). Method-typed so the real
 * `process.stdout`/`process.stderr` (narrower chunk parameters) remain
 * assignable.
 */
export interface PatchableStream {
  write(chunk: unknown, ...rest: unknown[]): boolean
}

/**
 * Ordered text capture under one shared byte budget, delivered to a sink as
 * each item lands (the real sink streams text over the port eagerly, so
 * captured output survives a mid-run termination). Once the budget is
 * exhausted it emits the fitting prefix and reports the limit once; the host
 * turns that condition into an explicit `output-limit` run failure.
 */
export class LogBuffer {
  private remaining: number
  private truncated = false
  // Explicit fields, not constructor parameter properties: this module loads
  // under Node's native strip-only mode, which rejects non-erasable syntax —
  // and parameter properties are non-erasable.
  private readonly sink: (text: string) => void
  private readonly onLimit: () => void

  constructor(maxBytes: number, sink: (text: string) => void, onLimit: () => void = () => {}) {
    this.sink = sink
    this.onLimit = onLimit
    this.remaining = maxBytes
  }

  /**
   * Emit text to the sink, charging it against the budget (drops + marks once exhausted).
   * @param text - the captured text to deliver.
   */
  push(text: string): void {
    if (this.truncated) return
    const cost = Buffer.byteLength(text, 'utf8')
    if (cost > this.remaining) {
      this.truncated = true
      const prefix = truncateUtf8Bytes(text, this.remaining)
      if (prefix.length > 0) this.sink(prefix)
      this.remaining = 0
      this.onLimit()
      return
    }
    this.remaining -= cost
    this.sink(text)
  }
}

/** The five console methods the shim captures, in the seam's level vocabulary. */
const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const

/**
 * A `console` replacement whose five leveled methods render their arguments
 * `util.inspect`-style (matching real console formatting closely enough for
 * a model to recognize its own output) into the buffer. Only these five
 * exist — the program gets a deliberately small console, not Node's full
 * surface.
 * @param logs - the buffer every rendered line is pushed into.
 * @returns the five-method console object handed to the program.
 */
export function makeConsoleShim(logs: LogBuffer): Record<(typeof CONSOLE_LEVELS)[number], (...args: unknown[]) => void> {
  const render = (args: unknown[]): string =>
    args.map(arg => typeof arg === 'string' ? arg : inspect(arg, INSPECT_OPTIONS)).join(' ')
  const shim = Object.create(null) as Record<(typeof CONSOLE_LEVELS)[number], (...args: unknown[]) => void>
  for (const level of CONSOLE_LEVELS) {
    shim[level] = (...args: unknown[]) => { logs.push(render(args)) }
  }
  return shim
}

/**
 * Redirect a stream's `write` into the log buffer (the program-visible
 * `process.stdout`/`process.stderr` in the real worker), so raw writes land in emission order
 * alongside console output instead of racing down a pipe. It preserves Node's optional callback
 * contract: the callback runs asynchronously after admission, even when the log budget drops
 * the write.
 *
 * @param logs - the buffer captured writes are pushed into.
 * @param stream - the stream whose `write` slot is patched.
 * @returns the restore function (the in-process tests un-patch; the real
 *   worker never needs to).
 */
export function captureStreamWrites(logs: LogBuffer, stream: PatchableStream): () => void {
  // The slot's VALUE is stored for restore and reassigned — never invoked
  // detached, so the unbound-method concern does not apply.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = stream.write
  stream.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    logs.push(typeof chunk === 'string' ? chunk : String(chunk))
    // Node's optional-encoding shape: the callback is whichever of the next
    // two positions holds a function (a non-function there is the encoding).
    const callback = [rest[0], rest[1]].find(
      (arg): arg is (error?: Error | null) => void => typeof arg === 'function',
    )
    if (callback) queueMicrotask(() => { callback(null) })
    return true
  }
  return () => { stream.write = original }
}

/** Bounded inspect options: deep enough to be useful, bounded so a pathological value cannot explode the rendering. */
const INSPECT_OPTIONS = { depth: 4, maxArrayLength: 100, maxStringLength: 10_000 } as const

/**
 * The longest prefix of `text` whose UTF-8 encoding fits `maxBytes`, cut at
 * a code-point boundary (never mid-surrogate-pair). The byte caps are BYTE
 * caps — `String.prototype.slice` counts UTF-16 code units, up to 3× smaller
 * than what a multibyte string actually costs across the boundary.
 * @param text - the string to bound.
 * @param maxBytes - the UTF-8 byte budget the prefix must fit.
 * @returns the prefix (all of `text` when it already fits).
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let bytes = 0
  let end = 0
  for (const char of text) {
    const cost = Buffer.byteLength(char, 'utf8')
    if (bytes + cost > maxBytes) break
    bytes += cost
    end += char.length
  }
  return text.slice(0, end)
}

/**
 * Prepare the program's completion value for the done message. Only lossless
 * JSON crosses, and an individually oversized value reports `output-limit`;
 * the host revalidates both and accounts for the combined outer envelope.
 *
 * @param value - the program's completion value.
 * @param maxOutputBytes - the byte cap for the outer result.
 * @returns the done-message fragment: `{}` for `undefined`, else `{ value }`.
 */
export function prepareCompletion(value: unknown, maxOutputBytes: number): Omit<DoneMessage, 'type'> {
  if (value === undefined) return {}
  let snapshot: ReturnType<typeof snapshotCodeJsonValue>
  try {
    snapshot = snapshotCodeJsonValue(value)
  } catch {
    snapshot = undefined
  }
  if (snapshot === undefined) {
    return { error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } }
  }
  if (jsonValueBytesUpTo(snapshot, maxOutputBytes) === undefined) {
    return { error: { kind: 'output-limit', message: `outer output exceeded ${maxOutputBytes} bytes` } }
  }
  return { value: snapshot }
}

/** One awaited binding call's settlement handles, keyed by call id in the pending map. */
export interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
}

/** Program-visible typed rejection for a failed member of the `tools` namespace. */
export class ToolCallError extends Error {
  override readonly name = 'ToolCallError'
  readonly toolName: string

  constructor(toolName: string, message: string) {
    super(message)
    this.toolName = toolName
  }
}

/** Create the namespace-specific rejection for one lossy binding argument. */
function bindingArgumentFailure(global: string, name: string): Error {
  const message = 'binding arguments must be lossless JSON'
  return global === 'tools' ? new ToolCallError(name, message) : new Error(message)
}

/**
 * Route host replies into the pending-call map: each reply settles its call
 * at most once, and a reply for an unknown id (stray, or a duplicate answer
 * to an id already settled) is ignored. Shared wiring between
 * {@link runWorkerMain} and the tests that exercise {@link makeNamespaces}
 * standalone.
 * @param port - the port whose `message` events carry the replies.
 * @param pending - the id-keyed map of unsettled binding calls.
 */
export function wireReplies(port: BootstrapPort, pending: Map<number, PendingCall>): void {
  port.on('message', (message: ReplyMessage) => {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.ok) entry.resolve(message.value)
    else entry.reject(new Error(message.message))
  })
}

/**
 * Build the binding namespace objects the program sees: one null-prototype global per
 * namespace, each declared name an own enumerable async function that bridges over the port
 * (`__proto__`/`constructor`/`toString` are ordinary keys, never prototype collisions).
 * Lossy arguments reject before posting; clone failures and host failure
 * replies reject only the corresponding call.
 *
 * @param data - the boot payload's namespace declarations (globals + names).
 * @param port - the port binding calls are posted to.
 * @param pending - the id-keyed map each posted call parks its handles in.
 * @param nextId - the shared mutable id counter (worker-issued correlation ids).
 * @returns one namespace object per declaration, in declaration order.
 */
export function makeNamespaces(
  data: Pick<WorkerBootData, 'namespaces'>,
  port: BootstrapPort,
  pending: Map<number, PendingCall>,
  nextId: { value: number },
): Record<string, unknown>[] {
  return data.namespaces.map(({ global, names }) => {
    const namespace = Object.create(null) as Record<string, unknown>
    for (const name of names) {
      Object.defineProperty(namespace, name, {
        enumerable: true,
        value: (args: unknown): Promise<unknown> => {
          let detached: unknown
          try {
            detached = snapshotCodeJsonValue(args)
          } catch {
            detached = undefined
          }
          if (detached === undefined) return Promise.reject(bindingArgumentFailure(global, name))
          return new Promise((resolve, reject) => {
            const id = nextId.value++
            pending.set(id, {
              resolve,
              reject: (error) => {
                reject(global === 'tools' ? new ToolCallError(name, error.message) : error)
              },
            })
            try {
              port.postMessage({ type: 'call', id, global, name, args: detached })
            } catch (error: unknown) {
              pending.delete(id)
              const message = `binding arguments must be structured-cloneable: ${error instanceof Error ? error.message : String(error)}`
              reject(global === 'tools' ? new ToolCallError(name, message) : new Error(message))
            }
          })
        },
      })
    }
    return namespace
  })
}

/**
 * Run one strict async-function body, allowing top-level `await` and `return`, and post exactly
 * one terminal {@link DoneMessage}; a thrown program error becomes its `error` field.
 * @param port - host message port or test double.
 * @param data - the boot payload the host sent.
 * @param streams - stdout/stderr objects captured as program logs.
 * @returns after posting the done message.
 */
export async function runWorkerMain(
  port: BootstrapPort,
  data: WorkerBootData,
  streams: { stdout: PatchableStream; stderr: PatchableStream },
): Promise<void> {
  const logs = new LogBuffer(
    data.maxOutputBytes,
    (text) => { port.postMessage({ type: 'log', text }) },
    () => { port.postMessage({ type: 'output-limit' }) },
  )
  captureStreamWrites(logs, streams.stdout)
  captureStreamWrites(logs, streams.stderr)

  const pending = new Map<number, PendingCall>()
  wireReplies(port, pending)

  const nextId = { value: 1 }
  const namespaces = makeNamespaces(data, port, pending, nextId)
  const consoleShim = makeConsoleShim(logs)

  let done: DoneMessage
  try {
    // The async function constructor, reached through an instance because
    // `AsyncFunction` is not a global. The program body is strict-mode.
    /* v8 ignore next -- the arrow exists only to reach the AsyncFunction constructor; it is never invoked. */
    const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>
    const fn = new AsyncFunction(...data.namespaces.map(namespace => namespace.global), 'ToolCallError', 'console', `'use strict';\n${data.code}`)
    const value = await fn(...namespaces, ToolCallError, consoleShim)
    done = { type: 'done', ...prepareCompletion(value, data.maxOutputBytes) }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    done = { type: 'done', error: { kind: 'exception', message } }
  }
  port.postMessage(done)
}
