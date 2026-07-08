/**
 * Worker-side execution logic, written as plain functions over an injected
 * port so the unit suite can run every line IN-PROCESS against a fake port
 * (a real worker thread is a separate V8 isolate the coverage provider
 * cannot observe). The real worker entry (`worker.ts`) is a thin
 * self-executing glue file over {@link runWorkerMain}, excluded from
 * coverage the same way `bin.ts` entrypoints are, and exercised end-to-end
 * by the integration tests that spawn real workers.
 *
 * @module @deepseek-ai/dsh-code-runtime-worker/src/bootstrap
 */

import { inspect } from 'node:util'
import { serialize } from 'node:v8'
import type { CodeLogEntry } from '@deepseek-ai/dsh-code-runtime'
import { logTruncationMarker } from './protocol.ts'
import type { DoneMessage, ReplyMessage, WorkerBootData, WorkerToHost } from './protocol.ts'

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
 * Ordered log capture under one shared byte budget, delivered to a sink as
 * each entry lands (the real sink streams entries over the port eagerly, so
 * captured output survives a mid-run termination). Once the budget is
 * exhausted it emits exactly one in-band marker entry (on the `stderr`
 * diagnostics channel) and silently drops everything after — the cap is a
 * blast-radius bound, so "how much was lost" intentionally stays unmeasured.
 */
export class LogBuffer {
  private remaining: number
  private truncated = false
  // Explicit fields, not constructor parameter properties: this module loads
  // under Node's native strip-only mode, which rejects non-erasable syntax —
  // and parameter properties are non-erasable.
  private readonly maxBytes: number
  private readonly sink: (entry: CodeLogEntry) => void

  constructor(maxBytes: number, sink: (entry: CodeLogEntry) => void) {
    this.maxBytes = maxBytes
    this.sink = sink
    this.remaining = maxBytes
  }

  /**
   * Emit one entry to the sink, charging its text against the budget (drops + marks once exhausted).
   * @param entry - the log entry to deliver.
   */
  push(entry: CodeLogEntry): void {
    if (this.truncated) return
    const cost = Buffer.byteLength(entry.text, 'utf8')
    if (cost > this.remaining) {
      this.truncated = true
      this.sink({ source: 'stderr', text: logTruncationMarker(this.maxBytes) })
      return
    }
    this.remaining -= cost
    this.sink(entry)
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
    shim[level] = (...args: unknown[]) => { logs.push({ source: 'console', level, text: render(args) }) }
  }
  return shim
}

/**
 * Redirect a stream's `write` into the log buffer (the program-visible
 * `process.stdout`/`process.stderr` in the real worker), so raw writes land
 * in emission order alongside console output instead of racing down a pipe.
 * The shim keeps Node's `write(chunk[, encoding][, callback])` contract: the
 * callback fires asynchronously once the chunk is admitted (a program
 * awaiting flush completion must complete, not sit until the wall timeout),
 * even for writes the exhausted budget drops.
 * @param logs - the buffer captured writes are pushed into.
 * @param stream - the stream whose `write` slot is patched.
 * @param source - the log source the captured writes are attributed to.
 * @returns the restore function (the in-process tests un-patch; the real
 *   worker never needs to).
 */
export function captureStreamWrites(logs: LogBuffer, stream: PatchableStream, source: 'stdout' | 'stderr'): () => void {
  // The slot's VALUE is stored for restore and reassigned — never invoked
  // detached, so the unbound-method concern does not apply.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = stream.write
  stream.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    logs.push({ source, text: typeof chunk === 'string' ? chunk : String(chunk) })
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
 * Prepare the program's completion value for the done message: a value whose
 * MEASURED cross-boundary size fits `maxValueBytes` crosses raw — exact
 * bytes for a string, the structured-clone wire size (`v8.serialize`) for
 * everything else, so a huge container whose BOUNDED inspect rendering
 * happens to be small cannot smuggle itself past the cap. Anything else
 * (non-cloneable, or oversized) is REPLACED by its bounded `util.inspect`
 * rendering, byte-truncated ({@link truncateUtf8Bytes}) with an in-band
 * marker — the seam contract's "a non-transferable value is replaced by a
 * string rendering", extended to oversized ones so a huge return cannot
 * flood the host.
 * @param value - the program's completion value.
 * @param maxValueBytes - the byte cap for the value.
 * @returns the done-message fragment: `{}` for `undefined`, else `{ value }`.
 */
export function prepareValue(value: unknown, maxValueBytes: number): { value?: unknown } {
  if (value === undefined) return {}
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') <= maxValueBytes) return { value }
  } else {
    let size: number | undefined
    try {
      size = serialize(value).byteLength
    } catch {
      // Only the verdict matters: the value has parts the structured-clone
      // algorithm rejects (functions, classes, …) and must cross as its
      // rendering instead.
      size = undefined
    }
    if (size !== undefined && size <= maxValueBytes) return { value }
  }
  const rendered = typeof value === 'string' ? value : inspect(value, INSPECT_OPTIONS)
  const capped = Buffer.byteLength(rendered, 'utf8') > maxValueBytes
    ? `${truncateUtf8Bytes(rendered, maxValueBytes)}… [truncated]`
    : rendered
  return { value: capped }
}

/** One awaited binding call's settlement handles, keyed by call id in the pending map. */
export interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
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
 * Build the binding namespace objects the program sees: one null-prototype
 * global per namespace, each declared name an own enumerable async function
 * that bridges over the port (`__proto__`/`constructor`/`toString` are
 * ordinary keys, never prototype collisions). A non-cloneable argument
 * rejects that one call with a descriptive error; the host's reply (`ok`
 * false) rejects it likewise, so a failed tool call surfaces in the program
 * as an ordinary promise rejection.
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
        value: (args: unknown): Promise<unknown> => new Promise((resolve, reject) => {
          const id = nextId.value++
          pending.set(id, { resolve, reject })
          try {
            port.postMessage({ type: 'call', id, global, name, args })
          } catch (error: unknown) {
            pending.delete(id)
            reject(new Error(`binding arguments must be structured-cloneable: ${error instanceof Error ? error.message : String(error)}`))
          }
        }),
      })
    }
    return namespace
  })
}

/**
 * Run one program to settlement and post the {@link DoneMessage}: wires the
 * reply handler, materializes the namespaces and console shim, compiles the
 * type-stripped body as an async function (top-level `await`/`return`
 * work), and reports a thrown program error as the done message's `error`
 * field. Exactly one done message is ever posted.
 * @param port - the message port to the host (the real `parentPort`, or the tests' fake).
 * @param data - the boot payload the host sent.
 * @param streams - the stream objects whose `write` is captured (the real
 *   `process.stdout`/`process.stderr` in the worker; fakes in tests).
 * @returns resolves after the done message is posted (the tests await it;
 *   the real entry lets the worker exit naturally).
 */
export async function runWorkerMain(
  port: BootstrapPort,
  data: WorkerBootData,
  streams: { stdout: PatchableStream; stderr: PatchableStream },
): Promise<void> {
  const logs = new LogBuffer(data.maxLogBytes, (entry) => { port.postMessage({ type: 'log', entry }) })
  captureStreamWrites(logs, streams.stdout, 'stdout')
  captureStreamWrites(logs, streams.stderr, 'stderr')

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
    const fn = new AsyncFunction(...data.namespaces.map(namespace => namespace.global), 'console', `'use strict';\n${data.code}`)
    const value = await fn(...namespaces, consoleShim)
    done = { type: 'done', ...prepareValue(value, data.maxValueBytes) }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    done = { type: 'done', error: { message } }
  }
  port.postMessage(done)
}
