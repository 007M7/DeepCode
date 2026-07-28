/** E2B process/worker implementation of the harness code-runtime seam. */

import { posix } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import type { Context } from 'cordis'
import z from 'schemastery'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type {
  CodeBindingNamespace,
  CodeJsonValue,
  CodeRunFailure,
  CodeRunRequest,
  CodeRunResult,
} from '@deepseek-ai/dsh-code-runtime'
import {
  E2BFrameDecoder,
  encodeBoundedE2BFrame,
  quoteE2BShellArg,
  resolveE2BExecutable,
} from '@deepseek-ai/dsh-e2b'
import {
  decodeWorkerJson,
  encodeWorkerJson,
  OutputLedger,
} from '@deepseek-ai/dsh-code-runtime-worker'
import type { WorkerJsonWire } from '@deepseek-ai/dsh-code-runtime-worker'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import E2BSubprocessService from '@deepseek-ai/dsh-subprocess-e2b'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { CODE_RUNNER_SOURCE } from './runner-source.ts'

/** Runtime configuration; every execution and bridge bound is deployment-tunable. */
export interface Config {
  /** Remote worker measured event-loop busy-time budget. */
  computeMs?: number
  /** Host-observed wall-clock ceiling. */
  maxWallMs?: number
  /** Combined serialized outer logs/value/diagnostic cap. */
  maxOutputBytes?: number
  /** Remote worker old-generation heap cap in MiB. */
  maxOldGenerationSizeMb?: number
  /** Largest decoded bridge frame, including binding traffic. */
  maxFrameBytes?: number
  /** Remote process-group TERM-to-KILL grace. */
  killGraceMs?: number
}

type ResolvedConfig = Required<Config>
type PreparedRuntime = { node: string; runner: string }

interface LiveRun {
  settle(failure: CodeRunFailure): void
  finished: Promise<void>
}

interface CallMessage {
  type: 'call'
  id: number
  global: string
  name: string
  args: WorkerJsonWire
}

interface LogMessage {
  type: 'log'
  text: string
}

interface DoneMessage {
  type: 'done'
  value?: WorkerJsonWire
  error?: CodeRunFailure
}

type RunnerMessage = CallMessage | LogMessage | DoneMessage | { type: 'output-limit' }

const STRIP_WRAP = { prefix: 'async function __dsh_program__() {\n', suffix: '\n}' } as const
const MIN_OUTPUT_BYTES = 4
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
/* jscpd:ignore-start -- Backends enforce the same injected-global vocabulary without coupling lifecycle implementations. */
const RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package',
  'private', 'protected', 'public', 'arguments', 'eval',
])
const RESERVED_ERROR_PROPERTIES = new Set(['name', 'message', 'stack'])
/* jscpd:ignore-end */
const FAILURE_KINDS = new Set<CodeRunFailure['kind']>([
  'exception', 'timeout', 'abort', 'worker-exit', 'invalid-output', 'output-limit',
])

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseRunnerMessage(raw: unknown): RunnerMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (record.type === 'output-limit') return { type: 'output-limit' }
  if (record.type === 'log') return typeof record.text === 'string' ? { type: 'log', text: record.text } : undefined
  if (record.type === 'call') {
    if (!Number.isSafeInteger(record.id) || (record.id as number) < 1 || typeof record.global !== 'string' || typeof record.name !== 'string' || !Array.isArray(record.args)) return undefined
    return { type: 'call', id: record.id as number, global: record.global, name: record.name, args: record.args as WorkerJsonWire }
  }
  if (record.type !== 'done') return undefined
  if (record.error === undefined) {
    return { type: 'done', ...record.value === undefined ? {} : { value: record.value as WorkerJsonWire } }
  }
  if (typeof record.error !== 'object' || record.error === null) return undefined
  const error = record.error as Record<string, unknown>
  if (typeof error.kind !== 'string' || !FAILURE_KINDS.has(error.kind as CodeRunFailure['kind']) || typeof error.message !== 'string') return undefined
  return { type: 'done', error: { kind: error.kind as CodeRunFailure['kind'], message: error.message } }
}

/** E2B-backed runtime: host-side type stripping, remote worker execution, host binding dispatch. */
export class E2BCodeRuntime extends CodeRuntime {
  static inject = ['e2b', 'subprocess']

  static Config: z<Config> = z.object({
    computeMs: z.number().default(60_000),
    maxWallMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(67_108_864),
    maxOldGenerationSizeMb: z.number().default(512),
    maxFrameBytes: z.number().default(268_435_456),
    killGraceMs: z.number().default(2_000),
  })

  readonly language = 'typescript'
  readonly isolation = 'container'

  private readonly config: ResolvedConfig
  private readonly ready: Promise<PreparedRuntime>
  private readonly live = new Set<LiveRun>()
  private readonly subprocess: E2BSubprocessService
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (!(ctx.subprocess instanceof E2BSubprocessService)) {
      throw new Error('code-runtime-e2b requires @deepseek-ai/dsh-subprocess-e2b as ctx.subprocess')
    }
    this.subprocess = ctx.subprocess
    this.config = config as ResolvedConfig
    for (const [key, value] of Object.entries(this.config)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`code-runtime-e2b: config.${key} must be a positive safe integer`)
      }
    }
    if (this.config.maxOutputBytes < MIN_OUTPUT_BYTES) {
      throw new Error(`code-runtime-e2b: config.maxOutputBytes must be at least ${MIN_OUTPUT_BYTES}`)
    }
    if (this.config.maxWallMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`code-runtime-e2b: config.maxWallMs must be at most ${MAX_TIMER_DELAY_MS}`)
    }
    if (this.config.maxFrameBytes < this.config.maxOutputBytes) {
      throw new Error('code-runtime-e2b: config.maxFrameBytes must be at least maxOutputBytes')
    }
    this.ready = this.prepare()
    void this.ready.catch(() => {})
    ctx.effect(() => () => this.teardown(), 'E2B code-runtime teardown')
  }

  /* jscpd:ignore-start -- Seam-level abort and type-strip results remain identical across execution substrates. */
  /** Execute one type-stripped program in a fresh E2B worker process. */
  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    if (this.disposed) throw new Error('code-runtime-e2b: run() after disposal')
    const bindings = this.validateBindings(request)
    if (request.signal?.aborted === true) {
      return this.failure({ kind: 'abort', message: String(request.signal.reason) })
    }
    let code: string
    try {
      const stripped = stripTypeScriptTypes(STRIP_WRAP.prefix + request.program + STRIP_WRAP.suffix)
      code = stripped.slice(STRIP_WRAP.prefix.length, stripped.length - STRIP_WRAP.suffix.length)
    } catch (error: unknown) {
      return this.failure({ kind: 'exception', message: messageOf(error) })
    }
    let runtime: PreparedRuntime | undefined
    try {
      runtime = await this.awaitPreparation(request.signal)
    } catch (error: unknown) {
      // Disposal can race the awaited setup despite the synchronous precheck.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (this.disposed) return this.failure({ kind: 'abort', message: 'runtime disposed' })
      return this.failure({ kind: 'worker-exit', message: `E2B runtime setup failed: ${messageOf(error)}` })
    }
    if (runtime === undefined) {
      return this.failure({ kind: 'abort', message: String(request.signal?.reason) })
    }
    // Disposal can race the awaited remote setup after the pre-await check.
    /* v8 ignore start -- requires disposal between promise resolution and its awaiting continuation. */
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this.disposed) return this.failure({ kind: 'abort', message: 'runtime disposed' })
    /* v8 ignore stop */
    return await this.execute(request, code, bindings, runtime)
  }
  /* jscpd:ignore-end */

  private async awaitPreparation(signal: AbortSignal | undefined): Promise<PreparedRuntime | undefined> {
    if (signal === undefined) return await this.ready
    const aborted = Promise.withResolvers<undefined>()
    const onAbort = (): void => { aborted.resolve(undefined) }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      signal.removeEventListener('abort', onAbort)
      return undefined
    }
    try {
      return await Promise.race([this.ready, aborted.promise])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private assertPreparationActive(): void {
    if (this.disposed) throw new Error('code-runtime-e2b: runtime disposed during setup')
  }

  private async prepare(): Promise<PreparedRuntime> {
    const sandbox = await this.ctx.e2b.getSandbox()
    this.assertPreparationActive()
    const runner = posix.join(this.ctx.e2b.runtimeRoot, 'code-runtime-runner.mjs')
    await sandbox.files.write([{ path: runner, data: CODE_RUNNER_SOURCE }])
    this.assertPreparationActive()
    await sandbox.commands.run(`chmod 600 -- ${quoteE2BShellArg(runner)}`)
    this.assertPreparationActive()
    const node = await resolveE2BExecutable(sandbox, 'node')
    this.assertPreparationActive()
    return { node, runner }
  }

  private failure(error: CodeRunFailure): CodeRunResult {
    return new OutputLedger(this.config.maxOutputBytes).failure([], error)
  }

  /* jscpd:ignore-start -- Binding names have one seam contract while dispatch and teardown remain backend-owned. */
  private validateBindings(request: CodeRunRequest): Map<string, CodeBindingNamespace> {
    const bindings = new Map<string, CodeBindingNamespace>()
    for (const namespace of request.bindings) {
      if (!IDENTIFIER.test(namespace.global) || RESERVED_WORDS.has(namespace.global)) {
        throw new Error(`code-runtime-e2b: binding global ${JSON.stringify(namespace.global)} is not a usable identifier`)
      }
      if (namespace.global === 'console' || bindings.has(namespace.global)) {
        throw new Error(`code-runtime-e2b: duplicate binding global ${JSON.stringify(namespace.global)}`)
      }
      bindings.set(namespace.global, namespace)
    }
    const errorClassNames = new Set<string>()
    for (const namespace of request.bindings) {
      const descriptor = namespace.errorClass
      if (descriptor === undefined) continue
      if (!IDENTIFIER.test(descriptor.name) || RESERVED_WORDS.has(descriptor.name)) {
        throw new Error(`code-runtime-e2b: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`)
      }
      if (descriptor.name === 'console' || bindings.has(descriptor.name) || errorClassNames.has(descriptor.name)) {
        throw new Error(`code-runtime-e2b: duplicate injected global ${JSON.stringify(descriptor.name)}`)
      }
      if (descriptor.memberNameProperty.length === 0 || RESERVED_ERROR_PROPERTIES.has(descriptor.memberNameProperty)) {
        throw new Error(`code-runtime-e2b: binding error member property ${JSON.stringify(descriptor.memberNameProperty)} is not usable`)
      }
      errorClassNames.add(descriptor.name)
    }
    return bindings
  }
  /* jscpd:ignore-end */

  private async execute(
    request: CodeRunRequest,
    code: string,
    bindings: Map<string, CodeBindingNamespace>,
    runtime: PreparedRuntime,
  ): Promise<CodeRunResult> {
    let handle: SubprocessHandle
    try {
      handle = this.subprocess.spawn({
        argv: [runtime.node, runtime.runner],
        cwd: this.ctx.e2b.cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: this.config.maxOutputBytes } },
        graceMs: this.config.killGraceMs,
        ...request.signal === undefined ? {} : { signal: request.signal },
        env: {},
      })
    } catch (error: unknown) {
      if (this.disposed) return this.failure({ kind: 'abort', message: 'runtime disposed' })
      if (request.signal?.aborted === true) {
        return this.failure({ kind: 'abort', message: String(request.signal.reason) })
      }
      return this.failure({ kind: 'worker-exit', message: `E2B runtime spawn failed: ${messageOf(error)}` })
    }
    if (handle.stdin === undefined || handle.stdout === undefined) {
      handle.terminate()
      await Promise.allSettled([handle.done])
      try {
        await handle.waitForExit()
      } catch (error: unknown) {
        return this.failure({ kind: 'worker-exit', message: `E2B runtime cleanup failed: ${messageOf(error)}` })
      }
      return this.failure({ kind: 'worker-exit', message: 'E2B subprocess dropped a piped runtime stream' })
    }
    const stdin = handle.stdin
    const stdout = handle.stdout

    return new Promise<CodeRunResult>((resolve) => {
      const output = new OutputLedger(this.config.maxOutputBytes)
      const logs: string[] = []
      const answered = new Set<number>()
      const decoder = new E2BFrameDecoder(this.config.maxFrameBytes)
      let settled = false
      let finishResolve!: () => void
      const finished = new Promise<void>((done) => { finishResolve = done })
      const wallTimer: { current: NodeJS.Timeout | undefined } = { current: undefined }
      const live: LiveRun = {
        finished,
        settle: (failure) => { finish(() => output.failure(logs, failure)) },
      }

      const finish = (result: CodeRunResult | (() => CodeRunResult)): void => {
        if (settled) return
        settled = true
        clearTimeout(wallTimer.current)
        request.signal?.removeEventListener('abort', onAbort)
        void new Promise<void>((resume) => { setImmediate(resume) }).then(async () => {
          handle.terminate()
          await handle.done.catch(() => {})
          let cleanupError: unknown
          try {
            await handle.waitForExit()
          } catch (error: unknown) {
            cleanupError = error
          }
          try {
            decoder.finish()
          } catch (error: unknown) {
            result = output.failure(logs, { kind: 'worker-exit', message: messageOf(error) })
          }
          if (cleanupError !== undefined) {
            result = output.failure(logs, { kind: 'worker-exit', message: `E2B runtime cleanup failed: ${messageOf(cleanupError)}` })
          }
          const final = typeof result === 'function' ? result() : result
          this.live.delete(live)
          finishResolve()
          resolve(final)
        })
      }

      const sendReply = (message: unknown): void => {
        if (settled) return
        let frame: string
        try {
          frame = encodeBoundedE2BFrame(message, this.config.maxFrameBytes)
        } catch (error: unknown) {
          finish(() => output.failure(logs, { kind: 'worker-exit', message: `E2B runtime bridge failed: ${messageOf(error)}` }))
          return
        }
        stdin.write(frame, (error?: Error | null) => {
          if (error !== undefined && error !== null) {
            finish(() => output.failure(logs, { kind: 'worker-exit', message: `E2B runtime bridge write failed: ${error.message}` }))
          }
        })
      }

      /* jscpd:ignore-start -- Host binding resolution mirrors worker semantics over a different transport. */
      const onCall = (message: CallMessage): void => {
        if (answered.has(message.id)) return
        answered.add(message.id)
        const functions = bindings.get(message.global)?.functions
        const fn = functions !== undefined && Object.hasOwn(functions, message.name) ? functions[message.name] : undefined
        if (typeof fn !== 'function') {
          sendReply({ type: 'reply', id: message.id, ok: false, message: `unknown binding ${JSON.stringify(`${message.global}.${message.name}`)}` })
          return
        }
        const args = decodeWorkerJson(message.args)
        if (args === undefined) {
          sendReply({ type: 'reply', id: message.id, ok: false, message: 'binding arguments must be lossless JSON' })
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
              sendReply({ type: 'reply', id: message.id, ok: false, message: 'binding resolution must be lossless JSON' })
            } else {
              sendReply({ type: 'reply', id: message.id, ok: true, value: encodeWorkerJson(value) })
            }
          } catch (error: unknown) {
            sendReply({ type: 'reply', id: message.id, ok: false, message: messageOf(error) })
          }
        })()
      }
      /* jscpd:ignore-end */

      const onMessage = (raw: unknown): void => {
        if (settled) return
        const message = parseRunnerMessage(raw)
        if (message === undefined) return
        if (message.type === 'log') {
          if (!output.admit(message.text, logs)) finish(output.limit([...logs, message.text]))
          return
        }
        if (message.type === 'output-limit') {
          finish(output.limit(logs))
          return
        }
        if (message.type === 'call') {
          onCall(message)
          return
        }
        if (message.error !== undefined) {
          finish(() => output.failure(logs, message.error as CodeRunFailure))
        } else if (message.value === undefined) {
          finish(() => output.success(logs))
        } else {
          const value = decodeWorkerJson(message.value)
          if (value === undefined) finish(() => output.failure(logs, { kind: 'invalid-output', message: 'program completion must be lossless JSON' }))
          else finish(() => output.success(logs, value))
        }
      }

      stdout.on('data', (chunk: Buffer) => {
        if (settled) return
        try {
          for (const frame of decoder.push(chunk.toString('utf8'))) onMessage(frame)
        } catch (error: unknown) {
          finish(() => output.failure(logs, { kind: 'worker-exit', message: `E2B runtime bridge failed: ${messageOf(error)}` }))
        }
      })
      stdout.on('error', (error: Error) => {
        finish(() => output.failure(logs, { kind: 'worker-exit', message: `E2B runtime stdout failed: ${error.message}` }))
      })
      stdin.on('error', (error: Error) => {
        finish(() => output.failure(logs, { kind: 'worker-exit', message: `E2B runtime stdin failed: ${error.message}` }))
      })
      void handle.done.then(
        () => {
          if (!settled) {
            const stderr = handle.collected.stderr?.readFrom(0).text.trim()
            finish(() => output.failure(logs, { kind: 'worker-exit', message: stderr === undefined || stderr === '' ? 'E2B runtime exited before completing' : `E2B runtime exited before completing: ${stderr}` }))
          }
        },
        (error: unknown) => {
          finish(() => output.failure(logs, { kind: 'worker-exit', message: `E2B runtime spawn failed: ${messageOf(error)}` }))
        },
      )

      const onAbort = (): void => {
        finish(() => output.failure(logs, { kind: 'abort', message: String(request.signal?.reason) }))
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      wallTimer.current = setTimeout(() => {
        finish(() => output.failure(logs, { kind: 'timeout', message: `wall-clock ceiling reached (${this.config.maxWallMs}ms)` }))
      }, this.config.maxWallMs)
      this.live.add(live)
      if (request.signal?.aborted === true) {
        onAbort()
        return
      }
      sendReply({
        type: 'boot',
        code,
        namespaces: [...bindings].map(([global, namespace]) => ({
          global,
          names: Object.keys(namespace.functions),
          ...namespace.errorClass === undefined ? {} : { errorClass: namespace.errorClass },
        })),
        computeMs: this.config.computeMs,
        maxOutputBytes: this.config.maxOutputBytes,
        maxOldGenerationSizeMb: this.config.maxOldGenerationSizeMb,
      })
    })
  }

  /* jscpd:ignore-start -- Code-runtime backends share the service lifecycle but own different child identities. */
  private async teardown(): Promise<void> {
    this.disposed = true
    const runs = [...this.live]
    for (const run of runs) run.settle({ kind: 'abort', message: 'runtime disposed' })
    await Promise.all([
      this.ready.then(() => {}, () => {}),
      ...runs.map(run => run.finished),
    ])
  }
  /* jscpd:ignore-end */
}

export default E2BCodeRuntime
