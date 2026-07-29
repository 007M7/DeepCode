/** Typed source for the dependency-free execution-world runner bundle. */

import { Buffer } from 'node:buffer'
import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { inspect } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import {
  decodeWorkerJson,
  encodeWorkerJson,
  jsonStringBytesUpTo,
  runWorkerMain,
  waitForRuntimePipeDrain,
} from '@deepseek-ai/dsh-code-runtime-worker/runtime-host'
import type { WorkerJsonWire } from '@deepseek-ai/dsh-code-runtime-worker/runtime-host'

type WorkerBootData = Parameters<typeof runWorkerMain>[1]
type Controller = ChildProcess & { stdout: Readable; stderr: Readable }
type FailureKind = 'exception' | 'timeout' | 'abort' | 'worker-exit' | 'invalid-output' | 'output-limit'

interface RuntimeBootData extends WorkerBootData {
  type: 'boot'
  maxFrameBytes: number
  maxOldGenerationSizeMb: number
  computeMs: number
}

interface RuntimeFailure {
  kind: FailureKind
  message: string
}

interface RuntimeCall {
  type: 'call'
  id: number
  global: string
  name: string
  args: WorkerJsonWire | null
}

type RuntimeReply =
  | { type: 'reply'; id: number; ok: true; value: unknown }
  | { type: 'reply'; id: number; ok: false; message: string }

type RuntimeMessage = RuntimeCall
  | { type: 'log'; text: string }
  | { type: 'output-limit' }
  | { type: 'done'; value?: WorkerJsonWire | null; error?: RuntimeFailure }

const failureKinds = new Set<FailureKind>([
  'exception', 'timeout', 'abort', 'worker-exit', 'invalid-output', 'output-limit',
])

let maxFrameBytes = 0

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function encodeJsonBounded(value: unknown, maxBytes: number): string | undefined {
  try {
    const json: unknown = JSON.stringify(value)
    return typeof json === 'string' && Buffer.byteLength(json) <= maxBytes ? json : undefined
  } catch {
    return undefined
  }
}

function emitJson(json: string): void {
  process.stdout.write(json)
  process.stdout.write('\n')
}

function emitFrame(message: RuntimeMessage): boolean {
  const json = encodeJsonBounded(message, maxFrameBytes)
  if (json === undefined) return false
  emitJson(json)
  return true
}

function validFailure(value: unknown): value is RuntimeFailure {
  const record = recordOf(value)
  return record !== undefined
    && typeof record.kind === 'string'
    && failureKinds.has(record.kind as FailureKind)
    && typeof record.message === 'string'
}

function validWorkerFailure(value: unknown): value is RuntimeFailure {
  return validFailure(value)
    && (value.kind === 'exception' || value.kind === 'invalid-output' || value.kind === 'output-limit')
}

function doneMessage(
  message: Record<string, unknown>,
  acceptsFailure: (value: unknown) => value is RuntimeFailure,
): RuntimeMessage | undefined {
  if (message.error !== undefined) {
    return acceptsFailure(message.error) ? { type: 'done', error: message.error } : undefined
  }
  return { type: 'done', ...message.value === undefined ? {} : { value: transportWireOrNull(message.value) } }
}

function runtimeBoot(value: unknown): RuntimeBootData | undefined {
  const record = recordOf(value)
  if (record === undefined
    || record.type !== 'boot'
    || typeof record.code !== 'string'
    || !Array.isArray(record.namespaces)
    || !Number.isSafeInteger(record.maxOutputBytes)
    || (record.maxOutputBytes as number) < 4
    || !Number.isSafeInteger(record.maxFrameBytes)
    || (record.maxFrameBytes as number) < (record.maxOutputBytes as number)
    || typeof record.computeMs !== 'number'
    || !Number.isFinite(record.computeMs)
    || (record.computeMs) <= 0
    || typeof record.maxOldGenerationSizeMb !== 'number'
    || !Number.isFinite(record.maxOldGenerationSizeMb)
    || (record.maxOldGenerationSizeMb) <= 0) return undefined
  return record as unknown as RuntimeBootData
}

function runtimeReply(value: unknown): RuntimeReply | undefined {
  const record = recordOf(value)
  if (record === undefined || record.type !== 'reply' || typeof record.id !== 'number' || typeof record.ok !== 'boolean') return undefined
  return record.ok
    ? { type: 'reply', id: record.id, ok: true, value: record.value }
    : { type: 'reply', id: record.id, ok: false, message: String(record.message) }
}

function transportWireOrNull(input: unknown): WorkerJsonWire | null {
  const value = decodeWorkerJson(input)
  return value === undefined ? null : encodeWorkerJson(value)
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => { child.once('exit', () => { resolve() }) })
}

function frameLimitFailure(): RuntimeMessage {
  return {
    type: 'done',
    error: { kind: 'worker-exit', message: 'code runtime bridge frame exceeded maxFrameBytes' },
  }
}

function runLauncher(): void {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let controller: Controller | undefined
  let maxOutputBytes = 0
  let logBytes = 2
  let logEntries = 0
  let settling = false

  const finish = (message: RuntimeMessage): void => {
    if (settling) return
    const encoded = encodeJsonBounded(message, maxFrameBytes)
      ?? encodeJsonBounded(frameLimitFailure(), maxFrameBytes)
    settling = true
    if (encoded !== undefined) emitJson(encoded)
    const current = controller
    controller = undefined
    const drain = current === undefined
      ? Promise.resolve()
      : new Promise<void>((resolve) => { setImmediate(resolve) }).then(async () => {
        const stdoutDrained = waitForRuntimePipeDrain(current.stdout)
        const stderrDrained = waitForRuntimePipeDrain(current.stderr)
        const exited = waitForChildExit(current)
        current.kill('SIGKILL')
        await Promise.all([exited, stdoutDrained, stderrDrained])
      })
    void drain.catch((error: unknown) => {
      process.stderr.write(`dsh-code-runtime-subprocess controller cleanup error: ${String(error)}\n`)
    }).then(() => {
      input.close()
      process.stdin.destroy()
    })
  }

  const forwardLog = (text: string): void => {
    if (settling) return
    const separator = logEntries > 0 ? 1 : 0
    const cost = jsonStringBytesUpTo(text, maxOutputBytes - logBytes - separator)
    if (cost === undefined) {
      finish({ type: 'output-limit' })
      return
    }
    logBytes += cost + separator
    logEntries += 1
    if (!emitFrame({ type: 'log', text })) finish(frameLimitFailure())
  }

  const startController = (boot: RuntimeBootData): void => {
    maxOutputBytes = boot.maxOutputBytes
    maxFrameBytes = boot.maxFrameBytes
    controller = fork(fileURLToPath(import.meta.url), [], {
      env: { DSH_CODE_RUNTIME_CONTROLLER: '1' },
      detached: false,
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }) as Controller
    const current = controller
    current.stdout.on('data', (data: Buffer) => { forwardLog(data.toString('utf8')) })
    current.stderr.on('data', (data: Buffer) => { forwardLog(data.toString('utf8')) })
    current.on('message', (raw: unknown) => {
      const message = recordOf(raw)
      if (message === undefined) return
      if (message.type === 'log' && typeof message.text === 'string') {
        forwardLog(message.text)
        return
      }
      if (settling) return
      if (message.type === 'call'
        && typeof message.id === 'number'
        && typeof message.global === 'string'
        && typeof message.name === 'string') {
        if (!emitFrame({
          type: 'call', id: message.id, global: message.global, name: message.name, args: transportWireOrNull(message.args),
        })) finish(frameLimitFailure())
      } else if (message.type === 'output-limit') {
        finish({ type: 'output-limit' })
      } else if (message.type === 'done') {
        const done = doneMessage(message, validFailure)
        if (done !== undefined) finish(done)
      }
    })
    current.on('error', (error: Error) => {
      finish({ type: 'done', error: { kind: 'worker-exit', message: `remote controller error: ${error.message}` } })
    })
    current.on('exit', (code: number | null) => {
      if (!settling) {
        finish({ type: 'done', error: { kind: 'worker-exit', message: `remote controller exited with code ${code} before completing` } })
      }
    })
    current.send(boot, (error: Error | null) => {
      if (error !== null) {
        finish({ type: 'done', error: { kind: 'worker-exit', message: `remote controller boot failed: ${error.message}` } })
      }
    })
  }

  input.on('line', (line: string) => {
    let raw: unknown
    try {
      raw = JSON.parse(line) as unknown
    } catch (error: unknown) {
      process.stderr.write(`dsh-code-runtime-subprocess frame error: ${String(error)}\n`)
      finish({ type: 'done', error: { kind: 'worker-exit', message: 'remote runner received a malformed frame' } })
      return
    }
    if (controller === undefined) {
      const boot = runtimeBoot(raw)
      if (boot === undefined) {
        finish({ type: 'done', error: { kind: 'worker-exit', message: 'remote runner received an invalid boot frame' } })
        return
      }
      startController(boot)
      return
    }
    const reply = runtimeReply(raw)
    if (reply !== undefined) {
      controller.send(reply, (error: Error | null) => {
        if (error !== null) {
          finish({ type: 'done', error: { kind: 'worker-exit', message: `remote controller reply failed: ${error.message}` } })
        }
      })
    }
  })
  input.on('close', () => {
    if (controller !== undefined && !settling) {
      finish({ type: 'done', error: { kind: 'abort', message: 'remote runner input closed' } })
    }
  })
}

function runController(): void {
  let worker: Worker | undefined
  let finished = false
  let computeTimer: NodeJS.Timeout | undefined
  let controllerMaxFrameBytes = 0

  const send = (message: RuntimeMessage): boolean => {
    if (process.send === undefined) return false
    if (controllerMaxFrameBytes > 0 && encodeJsonBounded(message, controllerMaxFrameBytes) === undefined) return false
    process.send(message)
    return true
  }

  const finish = (message: RuntimeMessage): void => {
    if (finished) return
    finished = true
    clearInterval(computeTimer)
    const bounded = controllerMaxFrameBytes > 0 && encodeJsonBounded(message, controllerMaxFrameBytes) === undefined
      ? frameLimitFailure()
      : message
    const current = worker
    worker = undefined
    const drain = current === undefined
      ? Promise.resolve()
      : new Promise<void>((resolve) => { setImmediate(resolve) }).then(async () => {
        const stdoutDrained = waitForRuntimePipeDrain(current.stdout)
        const stderrDrained = waitForRuntimePipeDrain(current.stderr)
        await Promise.all([current.terminate(), stdoutDrained, stderrDrained])
      })
    void drain.catch((error: unknown) => {
      send({ type: 'log', text: `dsh-code-runtime-subprocess worker cleanup error: ${String(error)}\n` })
    }).then(() => {
      if (process.send === undefined) {
        process.exitCode = 1
        return
      }
      process.send(bounded, () => { if (process.connected) process.disconnect() })
    })
  }

  process.on('message', (raw: unknown) => {
    if (worker === undefined) {
      const boot = runtimeBoot(raw)
      if (boot === undefined) {
        finish({ type: 'done', error: { kind: 'worker-exit', message: 'remote controller received an invalid boot frame' } })
        return
      }
      controllerMaxFrameBytes = boot.maxFrameBytes
      worker = new Worker(new URL(import.meta.url), {
        workerData: boot,
        env: {},
        execArgv: [],
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: boot.maxOldGenerationSizeMb },
      })
      const current = worker
      current.stdout.on('data', (data: Buffer) => {
        if (!send({ type: 'log', text: data.toString('utf8') })) finish(frameLimitFailure())
      })
      current.stderr.on('data', (data: Buffer) => {
        if (!send({ type: 'log', text: data.toString('utf8') })) finish(frameLimitFailure())
      })
      current.on('message', (messageRaw: unknown) => {
        const message = recordOf(messageRaw)
        if (message === undefined) return
        if (message.type === 'call'
          && typeof message.id === 'number'
          && typeof message.global === 'string'
          && typeof message.name === 'string') {
          if (!send({
            type: 'call', id: message.id, global: message.global, name: message.name, args: transportWireOrNull(message.args),
          })) finish(frameLimitFailure())
        } else if (message.type === 'log' && typeof message.text === 'string') {
          if (!send({ type: 'log', text: message.text })) finish(frameLimitFailure())
        } else if (message.type === 'output-limit') {
          finish({ type: 'output-limit' })
        } else if (message.type === 'done') {
          const done = doneMessage(message, validWorkerFailure)
          if (done !== undefined) finish(done)
        }
      })
      current.on('error', (error: Error) => {
        finish({
          type: 'done',
          error: { kind: 'worker-exit', message: `worker error: ${error.stack || error.message || inspect(error)}` },
        })
      })
      current.on('exit', (code: number) => {
        if (!finished) {
          finish({ type: 'done', error: { kind: 'worker-exit', message: `worker exited with code ${code} before completing` } })
        }
      })
      computeTimer = setInterval(() => {
        if (worker !== undefined && worker.performance.eventLoopUtilization().active > boot.computeMs) {
          finish({ type: 'done', error: { kind: 'timeout', message: `compute budget exhausted (${boot.computeMs}ms busy)` } })
        }
      }, 25)
      return
    }
    const reply = runtimeReply(raw)
    if (reply !== undefined) worker.postMessage(reply)
  })
  process.on('disconnect', () => { if (worker !== undefined && !finished) void worker.terminate() })
}

if (!isMainThread) {
  if (parentPort === null) throw new Error('remote worker requires parentPort')
  const boot = workerData as RuntimeBootData
  void runWorkerMain(parentPort, boot, { stdout: process.stdout, stderr: process.stderr }, boot.maxFrameBytes)
} else if (process.env.DSH_CODE_RUNTIME_CONTROLLER === '1') {
  runController()
} else {
  runLauncher()
}
