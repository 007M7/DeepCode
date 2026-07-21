/**
 * Worker-thread code runtime: a fresh worker runs each host-type-stripped TypeScript program
 * and bridges bindings over its message port. This is containment, not a security boundary:
 * model code has bash-equivalent trust despite an empty environment, a heap cap, measured
 * event-loop busy-time and wall-time budgets, and termination that also stops synchronous loops.
 * @module @deepseek-ai/dsh-code-runtime-worker
 */

import { Worker } from 'node:worker_threads'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import z from 'schemastery'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeBindingFunction, CodeJsonValue, CodeRunFailure, CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { ReplyMessage, WorkerBootData, WorkerToHost } from './protocol.ts'
import { truncateJsonStringBytes } from './output-json.ts'

/** Plugin config: every execution cap, changeable from `cordis.yml` (no hardcoded tunables). */
export interface Config {
  /**
   * Busy-time budget in milliseconds: the run fails with kind `'timeout'`
   * once the worker's MEASURED event-loop active time
   * (`worker.performance.eventLoopUtilization()`) exceeds this. Metering
   * measured busy time — not wall time, not host-side pending-call
   * bookkeeping — is what makes the budget both fair (a program awaiting a
   * slow tool accrues nothing) and ungameable (a hot loop accrues whether
   * or not a decoy dispatch is in flight).
   */
  computeMs?: number
  /**
   * Wall-clock ceiling in milliseconds; never pauses for anything. The
   * backstop for what busy-time cannot see (a program awaiting a promise
   * nobody will resolve).
   */
  maxWallMs?: number
  /** Hard cap for the combined serialized outer logs, completion value, and failure diagnostic. */
  maxOutputBytes?: number
  /** The worker's max old-generation heap in MiB (`resourceLimits`); overflow kills the worker, surfacing as kind `'worker-exit'`. */
  maxOldGenerationSizeMb?: number
}

/** {@link Config} after schemastery fills the defaults (every field present). */
type ResolvedConfig = Required<Config>

/**
 * How often the host samples the worker's event-loop utilization for the
 * `computeMs` budget. An internal cadence, not config: the only effect of
 * the interval is budget-expiry granularity (a run can overshoot by up to
 * one interval), and nothing a deployment could tune here improves that
 * without burning host CPU.
 */
const ELU_POLL_INTERVAL_MS = 25

/** Smallest cap that can represent the empty logs array plus an empty JSON failure diagnostic. */
const MIN_OUTPUT_BYTES = 4

/** ECMAScript reserved words that cannot be async-function parameter names — rejected as binding globals. */
const RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package',
  'private', 'protected', 'public', 'arguments', 'eval',
])

/** Valid async-function parameter name (the binding global becomes one). */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * The shell a program is wrapped in for the type-strip, matching the
 * grammatical context it will execute in (an async function body, where
 * top-level `return` and `await` are legal — a bare module parse would
 * reject the `return`). Strip mode is position-preserving (removed syntax
 * becomes whitespace, nothing shifts), so the wrapper survives the strip
 * byte-identical and the body slices back out with the model's own
 * line/column positions intact.
 */
const STRIP_WRAP = { prefix: 'async function __dsh_program__() {\n', suffix: '\n}' } as const

/** One in-flight run's host-side state, tracked for disposal. */
interface LiveRun {
  worker: Worker
  settle(failure: CodeRunFailure): void
  finished: Promise<void>
}

/**
 * The worker entry path. Source runs unbuilt (`src/worker.ts`, loadable
 * directly on this repo's Node range via native type stripping — the file
 * is erasable-only with type-only relative imports); the built package
 * ships it as a sibling CommonJS bundle (`lib/worker.cjs`, its own tsdown
 * entry) because pkg's VFS Worker hook compiles string-path entries as
 * CommonJS.
 * The URL *pathname*'s extension says which world this module is in —
 * pathname, because dev-time module runners (vitest) may suffix
 * `import.meta.url` with a query string; relative resolution drops it. Worker
 * receives a filesystem string so pkg's VFS Worker hook can resolve it.
 */
/* v8 ignore next -- the './worker.cjs' arm is the built-lib world, unreachable unbuilt by construction; the built-lib e2e pins it. */
const WORKER_PATH = fileURLToPath(new URL(new URL(import.meta.url).pathname.endsWith('.ts') ? './worker.ts' : './worker.cjs', import.meta.url))

/** Render an unknown thrown value as a message, `Error` or not. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Runtime shape gate for inbound port traffic. The peer runs MODEL CODE and
 * can post anything — `null`, primitives, objects with poisoned fields — so
 * the compile-time `WorkerToHost` type means nothing here: everything is
 * re-validated and REBUILT field by field (a forged extra field never rides
 * along; a non-number call id can never be echoed into a reply). Junk returns
 * `undefined` and is dropped — a throw in the host's `message` listener would
 * crash the host process.
 */
function parseWorkerMessage(raw: unknown): WorkerToHost | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const m = raw as Record<string, unknown>
  switch (m.type) {
    case 'call': {
      if (typeof m.id !== 'number' || typeof m.global !== 'string' || typeof m.name !== 'string') return undefined
      return { type: 'call', id: m.id, global: m.global, name: m.name, args: m.args }
    }
    case 'log': {
      if (typeof m.text !== 'string') return undefined
      return { type: 'log', text: m.text }
    }
    case 'output-limit': return { type: 'output-limit' }
    case 'done': {
      if (m.error === undefined) return { type: 'done', ...m.value !== undefined ? { value: m.value } : {} }
      const error = m.error
      if (typeof error !== 'object' || error === null) return undefined
      const { kind, message } = error as Record<string, unknown>
      if ((kind !== 'exception' && kind !== 'invalid-output' && kind !== 'output-limit') || typeof message !== 'string') return undefined
      return { type: 'done', error: { kind, message } }
    }
    default: return undefined
  }
}


/** Serialized byte size of one lossless JSON value. */
function jsonBytes(value: CodeJsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** One run's combined outer-output ledger; binding values never enter it. */
class OutputLedger {
  private bytes = 2 // JSON serialization of the empty logs array: []
  private entries = 0

  constructor(private readonly maxBytes: number) {}

  /** Admit one exact log entry, or report that the hard cap was crossed. */
  admit(text: string, sink: string[]): boolean {
    const cost = Buffer.byteLength(JSON.stringify(text), 'utf8') + (this.entries > 0 ? 1 : 0)
    if (this.bytes + cost > this.maxBytes) return false
    this.bytes += cost
    this.entries += 1
    sink.push(text)
    return true
  }

  /** Finalize a successful absent-or-JSON completion against the combined cap. */
  success(logs: string[], value?: CodeJsonValue): CodeRunResult {
    if (value !== undefined && this.bytes + jsonBytes(value) > this.maxBytes) return this.limit(logs)
    return { logs, ...value !== undefined ? { value } : {} }
  }

  /** Finalize a failure diagnostic, with output-limit taking precedence when combined bytes exceed the cap. */
  failure(logs: string[], error: CodeRunFailure): CodeRunResult {
    if (this.bytes + Buffer.byteLength(JSON.stringify(error.message), 'utf8') > this.maxBytes) return this.limit(logs)
    return { logs, error }
  }

  /** Build the explicit output-limit failure while retaining a fitting prefix of the final log. */
  limit(logs: string[]): CodeRunResult {
    const fullMessage = `outer output exceeded ${this.maxBytes} bytes`
    const messageBytes = Buffer.byteLength(JSON.stringify(fullMessage), 'utf8')
    const retained = [...logs]
    let retainedBytes = jsonBytes(retained)
    const logBudget = this.maxBytes - messageBytes
    while (retained.length > 0 && retainedBytes > logBudget) {
      const removed = retained.pop()
      /* v8 ignore next -- the while guard proves pop cannot return undefined. */
      if (removed === undefined) throw new Error('output ledger lost its final log entry')
      const separatorBytes = retained.length > 0 ? 1 : 0
      retainedBytes -= Buffer.byteLength(JSON.stringify(removed), 'utf8') + separatorBytes
      const prefix = truncateJsonStringBytes(removed, logBudget - retainedBytes - separatorBytes)
      if (prefix.length > 0) {
        retained.push(prefix)
        retainedBytes += Buffer.byteLength(JSON.stringify(prefix), 'utf8') + separatorBytes
        break
      }
    }
    if (logBudget < 2) {
      retained.length = 0
      retainedBytes = 2
    }
    const availableMessageBytes = this.maxBytes - retainedBytes
    // This fixed diagnostic is ASCII with no JSON escapes, so two bytes are
    // the surrounding quotes and every retained character costs one byte.
    const message = messageBytes <= availableMessageBytes
      ? fullMessage
      : fullMessage.slice(0, availableMessageBytes - 2)
    return { logs: retained, error: { kind: 'output-limit', message } }
  }
}

/**
 * The shipped {@link CodeRuntime} backend (`ctx.codeRuntime`). Registers as
 * the `codeRuntime` service; every cap comes from validated config. See the
 * module doc for the containment model and the class JSDoc on the seam for
 * the contract this implements (error-as-field, hostile-peer port,
 * no cross-run state, dispose to quiescence).
 */
export class WorkerCodeRuntime extends CodeRuntime {
  static Config: z<Config> = z.object({
    computeMs: z.number().default(60_000),
    maxWallMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(67_108_864),
    maxOldGenerationSizeMb: z.number().default(512),
  })

  readonly language = 'typescript'
  readonly isolation = 'worker-thread'

  private readonly config: ResolvedConfig
  private readonly live = new Set<LiveRun>()
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery filled the defaults; the cast records that. Positivity is a
    // semantic check the schema's plain number type does not carry.
    this.config = config as ResolvedConfig
    for (const [key, value] of Object.entries(this.config)) {
      if (!(Number.isFinite(value) && value > 0)) throw new Error(`dsh-code-runtime-worker: config.${key} must be a positive number, got ${String(value)}`)
    }
    if (!Number.isSafeInteger(this.config.maxOutputBytes) || this.config.maxOutputBytes < MIN_OUTPUT_BYTES) {
      throw new Error(`dsh-code-runtime-worker: config.maxOutputBytes must be a safe integer of at least ${MIN_OUTPUT_BYTES}, got ${String(this.config.maxOutputBytes)}`)
    }
    ctx.effect(() => () => this.teardown(), 'worker code-runtime teardown')
  }

  /**
   * Dispose to quiescence: mark the service unusable, fail every in-flight
   * run as aborted, and AWAIT each worker's exit so no worker outlives the
   * fiber.
   */
  private async teardown(): Promise<void> {
    this.disposed = true
    const runs = [...this.live]
    for (const run of runs) run.settle({ kind: 'abort', message: 'runtime disposed' })
    await Promise.all(runs.map(run => run.finished))
  }

  /**
   * Execute one program in a fresh worker. Program outcomes — including a
   * type-strip syntax error, which never spawns a worker — resolve with
   * `result.error`; the method rejects only for seam misuse (a disposed
   * runtime, an invalid binding namespace).
   * @param request - the program, its bindings, and the abort signal.
   * @returns the run's outcome per the seam contract.
   */
  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    if (this.disposed) throw new Error('dsh-code-runtime-worker: run() after disposal')
    const bindings = this.validateBindings(request)
    if (request.signal?.aborted) {
      return this.failureBeforeWorker({ kind: 'abort', message: String(request.signal.reason) })
    }

    let code: string
    try {
      const stripped = stripTypeScriptTypes(STRIP_WRAP.prefix + request.program + STRIP_WRAP.suffix)
      code = stripped.slice(STRIP_WRAP.prefix.length, stripped.length - STRIP_WRAP.suffix.length)
    } catch (error: unknown) {
      // A program that does not survive the type-strip (syntax error,
      // non-erasable syntax like `enum`) is a program failure, reported the
      // same way a thrown exception would be — and no worker ever spawns.
      return this.failureBeforeWorker({ kind: 'exception', message: messageOf(error) })
    }

    return await this.execute(request, code, bindings)
  }

  /** Apply the outer-output ledger to failures that occur before a worker owns one. */
  private failureBeforeWorker(error: CodeRunFailure): CodeRunResult {
    return new OutputLedger(this.config.maxOutputBytes).failure([], error)
  }

  /** Reject (seam misuse) malformed binding namespaces: non-identifier or reserved globals, duplicates, and the `console` collision. */
  private validateBindings(request: CodeRunRequest): Map<string, Record<string, CodeBindingFunction>> {
    const bindings = new Map<string, Record<string, CodeBindingFunction>>()
    for (const namespace of request.bindings) {
      if (!IDENTIFIER.test(namespace.global) || RESERVED_WORDS.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-worker: binding global ${JSON.stringify(namespace.global)} is not a usable identifier`)
      }
      if (namespace.global === 'console' || namespace.global === 'ToolCallError' || bindings.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-worker: duplicate binding global ${JSON.stringify(namespace.global)}`)
      }
      bindings.set(namespace.global, namespace.functions)
    }
    return bindings
  }

  /** Spawn the worker for one validated, type-stripped run and drive it to settlement. */
  private execute(
    request: CodeRunRequest,
    code: string,
    bindings: Map<string, Record<string, CodeBindingFunction>>,
  ): Promise<CodeRunResult> {
    const bootData: WorkerBootData = {
      code,
      namespaces: [...bindings].map(([global, functions]) => ({ global, names: Object.keys(functions) })),
      maxOutputBytes: this.config.maxOutputBytes,
    }
    const worker = new Worker(WORKER_PATH, {
      workerData: bootData,
      // Model code gets NO ambient environment — stronger than the scrubbed
      // env the defensive-patterns rule requires for spawned commands.
      env: {},
      // Hermetic flags too: without this the worker inherits the host process's execArgv (a
      // test runner's or tsx's loader hooks), which a bare isolate with an empty environment
      // cannot satisfy.
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: this.config.maxOldGenerationSizeMb },
      // Backstop capture: the bootstrap patches JS-level writes into its own
      // ordered buffer, so these pipes normally stay silent; anything that
      // still arrives (native-level writes) is appended after the done logs.
      stdout: true,
      stderr: true,
    })

    return new Promise<CodeRunResult>((resolve) => {
      let settled = false
      const answered = new Set<number>()
      const logs: string[] = []
      const strayLogs: string[] = []
      const output = new OutputLedger(this.config.maxOutputBytes)

      // No settled guard: `finish` snapshots the arrays when it resolves, so
      // a chunk flushing after settlement mutates only the discarded buffers,
      // and the ledger bounds that growth until the pipes close.
      const captureStray = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        if (!settled && !output.admit(text, strayLogs)) finish(output.limit([...logs, ...strayLogs, text]))
      }
      worker.stdout.on('data', captureStray)
      worker.stderr.on('data', captureStray)

      // Exactly one outcome wins. Every path cleans up, terminates, and awaits the worker;
      // logs captured before timeout, abort, or failure remain in the result.
      let finishResolve!: () => void
      const finished = new Promise<void>((done) => { finishResolve = done })
      const finish = (result: CodeRunResult): void => {
        if (settled) return
        settled = true
        clearInterval(eluTimer)
        clearTimeout(wallTimer)
        request.signal?.removeEventListener('abort', onAbort)
        this.live.delete(live)
        void worker.terminate().then(() => {
          finishResolve()
          resolve(result)
        })
      }

      const onDone = (message: WorkerToHost): void => {
        if (message.type !== 'done') return
        const captured = [...logs, ...strayLogs]
        if (message.error) {
          finish(output.failure(captured, message.error))
          return
        }
        if (message.value === undefined) {
          finish(output.success(captured))
          return
        }
        // The worker-thread boundary has already structured-cloned this
        // hostile value, so accessors and proxies cannot survive to throw
        // during the lossless-JSON snapshot.
        const value = snapshotJsonValue(message.value) as CodeJsonValue | undefined
        finish(value === undefined
          ? output.failure(captured, { kind: 'invalid-output', message: 'program completion must be lossless JSON' })
          : output.success(captured, value))
      }

      const onCall = (message: WorkerToHost): void => {
        if (message.type !== 'call' || settled) return
        // Hostile-peer rules: a duplicate id is ignored, an unknown name is
        // answered with a failure, and a binding throw/reject becomes the
        // program-side rejection — contained here, never a host crash.
        if (answered.has(message.id)) return
        answered.add(message.id)
        const reply = (payload: ReplyMessage): void => {
          if (settled) return
          // Canonical resolutions were snapshotted as lossless JSON before
          // this point, so this payload is structured-cloneable by contract.
          worker.postMessage(payload)
        }
        const record = bindings.get(message.global)
        // Own-property lookup only: a forged name like 'constructor' or
        // 'hasOwnProperty' must not walk the record's prototype chain and
        // reach a callable the consumer never declared.
        const fn = record && Object.hasOwn(record, message.name) ? record[message.name] : undefined
        if (typeof fn !== 'function') {
          reply({ type: 'reply', id: message.id, ok: false, message: `unknown binding ${JSON.stringify(`${message.global}.${message.name}`)}` })
          return
        }
        let args: CodeJsonValue | undefined
        try {
          args = snapshotJsonValue(message.args) as CodeJsonValue | undefined
        } catch {
          args = undefined
        }
        if (args === undefined) {
          reply({ type: 'reply', id: message.id, ok: false, message: 'binding arguments must be lossless JSON' })
          return
        }
        void (async () => {
          try {
            const resolved = await fn(args)
            let value: CodeJsonValue | undefined
            try {
              value = snapshotJsonValue(resolved)
            } catch {
              value = undefined
            }
            if (value === undefined) {
              reply({ type: 'reply', id: message.id, ok: false, message: 'binding resolution must be lossless JSON' })
            } else {
              reply({ type: 'reply', id: message.id, ok: true, value })
            }
          } catch (error: unknown) {
            reply({ type: 'reply', id: message.id, ok: false, message: messageOf(error) })
          }
        })()
      }

      worker.on('message', (raw: unknown) => {
        // Parse before touching: the peer can post ANY shape, and a throw in
        // this listener would crash the host process. Junk drops silently.
        const message = parseWorkerMessage(raw)
        if (!message) return
        if (message.type === 'log' && !settled && !output.admit(message.text, logs)) {
          finish(output.limit([...logs, ...strayLogs, message.text]))
          return
        }
        if (message.type === 'output-limit' && !settled) {
          finish(output.limit([...logs, ...strayLogs]))
          return
        }
        onCall(message)
        onDone(message)
      })
      worker.on('error', (error: Error) => {
        finish(output.failure([...logs, ...strayLogs], { kind: 'worker-exit', message: `worker error: ${error.message}` }))
      })
      worker.on('exit', (exitCode: number) => {
        finish(output.failure([...logs, ...strayLogs], { kind: 'worker-exit', message: `worker exited with code ${exitCode} before completing` }))
      })

      // The compute budget reads the worker's own measured busy time, so a
      // hot loop expires it no matter what dispatches are in flight, while a
      // program idling on a slow binding accrues nothing.
      const eluTimer = setInterval(() => {
        const elu = worker.performance.eventLoopUtilization()
        if (elu.active > this.config.computeMs) {
          finish(output.failure([...logs, ...strayLogs], { kind: 'timeout', message: `compute budget exhausted (${this.config.computeMs}ms busy)` }))
        }
      }, ELU_POLL_INTERVAL_MS)
      const wallTimer = setTimeout(() => {
        finish(output.failure([...logs, ...strayLogs], { kind: 'timeout', message: `wall-clock ceiling reached (${this.config.maxWallMs}ms)` }))
      }, this.config.maxWallMs)
      const onAbort = (): void => {
        finish(output.failure([...logs, ...strayLogs], { kind: 'abort', message: String(request.signal?.reason) }))
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })

      const live: LiveRun = {
        worker,
        finished,
        settle: (failure: CodeRunFailure) => { finish(output.failure([...logs, ...strayLogs], failure)) },
      }
      this.live.add(live)
    })
  }
}

export default WorkerCodeRuntime
