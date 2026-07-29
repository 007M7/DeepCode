/** Shared host mechanics for local and subprocess-hosted TypeScript worker runtimes. */

import { stripTypeScriptTypes } from 'node:module'
import type {
  CodeBindingNamespace,
  CodeJsonValue,
  CodeRunFailure,
  CodeRunRequest,
  CodeRunResult,
} from '@deepseek-ai/dsh-code-runtime'
import { jsonStringBytesUpTo, jsonValueBytesUpTo, truncateJsonStringBytes } from './output-json.ts'
import { decodeWorkerJson, encodeWorkerJson, snapshotCodeJsonValue } from './worker-json.ts'
import type { WorkerJsonWire } from './worker-json.ts'

/** Smallest cap that can represent an empty log array and failure message. */
export const MIN_RUNTIME_OUTPUT_BYTES = 4

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package',
  'private', 'protected', 'public', 'arguments', 'eval',
])
const RESERVED_ERROR_PROPERTIES = new Set(['name', 'message', 'stack'])
const STRIP_WRAP = { prefix: 'async function __dsh_program__() {\n', suffix: '\n}' } as const

/** One validated binding call received from an isolated worker. */
export interface RuntimeBindingCall {
  /** Correlation id supplied by the isolated worker. */
  readonly id: number
  /** Injected namespace global. */
  readonly global: string
  /** Declared namespace function. */
  readonly name: string
  /** Untrusted lossless-JSON wire payload. */
  readonly args: unknown
}

/** One host reply to an isolated worker binding call. */
export type RuntimeBindingReply =
  | { readonly type: 'reply'; readonly id: number; readonly ok: true; readonly value: WorkerJsonWire }
  | { readonly type: 'reply'; readonly id: number; readonly ok: false; readonly message: string }

/**
 * Render an unknown thrown value without assuming it is an Error.
 * @param error - thrown or rejected value.
 * @returns the caller-facing diagnostic text.
 */
export function runtimeErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'binding rejected with an unrenderable value'
  }
}

/**
 * Strip erasable TypeScript while preserving the program's body coordinates.
 * @param program - model-written async-function body.
 * @returns JavaScript source with the wrapper removed.
 */
export function stripRuntimeProgram(program: string): string {
  const stripped = stripTypeScriptTypes(STRIP_WRAP.prefix + program + STRIP_WRAP.suffix)
  return stripped.slice(STRIP_WRAP.prefix.length, stripped.length - STRIP_WRAP.suffix.length)
}

/**
 * Validate binding globals and typed-error declarations shared by worker runtimes.
 * @param request - code-runtime request carrying the namespaces.
 * @param implementationName - package name used in seam-misuse diagnostics.
 * @returns namespaces indexed by their injected global.
 */
export function validateRuntimeBindings(
  request: CodeRunRequest,
  implementationName: string,
): Map<string, CodeBindingNamespace> {
  const bindings = new Map<string, CodeBindingNamespace>()
  for (const namespace of request.bindings) {
    if (!IDENTIFIER.test(namespace.global) || RESERVED_WORDS.has(namespace.global)) {
      throw new Error(`${implementationName}: binding global ${JSON.stringify(namespace.global)} is not a usable identifier`)
    }
    if (namespace.global === 'console' || bindings.has(namespace.global)) {
      throw new Error(`${implementationName}: duplicate binding global ${JSON.stringify(namespace.global)}`)
    }
    bindings.set(namespace.global, namespace)
  }

  const errorClassNames = new Set<string>()
  for (const namespace of request.bindings) {
    const descriptor = namespace.errorClass
    if (descriptor === undefined) continue
    if (!IDENTIFIER.test(descriptor.name) || RESERVED_WORDS.has(descriptor.name)) {
      throw new Error(`${implementationName}: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`)
    }
    if (descriptor.name === 'console' || bindings.has(descriptor.name) || errorClassNames.has(descriptor.name)) {
      throw new Error(`${implementationName}: duplicate injected global ${JSON.stringify(descriptor.name)}`)
    }
    if (descriptor.memberNameProperty.length === 0 || RESERVED_ERROR_PROPERTIES.has(descriptor.memberNameProperty)) {
      throw new Error(`${implementationName}: binding error member property ${JSON.stringify(descriptor.memberNameProperty)} is not usable`)
    }
    errorClassNames.add(descriptor.name)
  }
  return bindings
}

/**
 * Resolve one untrusted worker call through a declared host binding.
 * @param call - parsed call envelope from the isolated worker.
 * @param bindings - namespaces returned by {@link validateRuntimeBindings}.
 * @returns a lossless-JSON success or stable rejection reply.
 */
export async function invokeRuntimeBinding(
  call: RuntimeBindingCall,
  bindings: ReadonlyMap<string, CodeBindingNamespace>,
): Promise<RuntimeBindingReply> {
  const functions = bindings.get(call.global)?.functions
  const fn = functions !== undefined && Object.hasOwn(functions, call.name) ? functions[call.name] : undefined
  if (typeof fn !== 'function') {
    return { type: 'reply', id: call.id, ok: false, message: `unknown binding ${JSON.stringify(`${call.global}.${call.name}`)}` }
  }
  const args = decodeWorkerJson(call.args)
  if (args === undefined) {
    return { type: 'reply', id: call.id, ok: false, message: 'binding arguments must be lossless JSON' }
  }
  try {
    const resolved = await fn(args)
    let value: CodeJsonValue | undefined
    try {
      value = snapshotCodeJsonValue(resolved)
    } catch {
      value = undefined
    }
    if (value === undefined) {
      return { type: 'reply', id: call.id, ok: false, message: 'binding resolution must be lossless JSON' }
    }
    return { type: 'reply', id: call.id, ok: true, value: encodeWorkerJson(value) }
  } catch (error: unknown) {
    return { type: 'reply', id: call.id, ok: false, message: runtimeErrorMessage(error) }
  }
}

/** One run's combined outer-output ledger; binding values never enter it. */
export class RuntimeOutputLedger {
  private bytes = 2
  private entries = 0

  /** @param maxBytes - hard cap for logs plus completion or failure payload. */
  constructor(private readonly maxBytes: number) {}

  /**
   * Admit one exact log entry.
   * @param text - candidate log entry.
   * @param sink - ordered retained log list.
   * @returns false when the hard cap was crossed.
   */
  admit(text: string, sink: string[]): boolean {
    const separatorBytes = this.entries > 0 ? 1 : 0
    const stringBytes = jsonStringBytesUpTo(text, this.maxBytes - this.bytes - separatorBytes)
    if (stringBytes === undefined) return false
    this.bytes += stringBytes + separatorBytes
    this.entries += 1
    sink.push(text)
    return true
  }

  /**
   * Finalize a successful completion against the combined cap.
   * @param logs - retained ordered logs.
   * @param value - optional lossless-JSON completion.
   * @returns the completion or output-limit result.
   */
  success(logs: string[], value?: CodeJsonValue): CodeRunResult {
    if (value !== undefined && jsonValueBytesUpTo(value, this.maxBytes - this.bytes) === undefined) return this.limit(logs)
    return { logs, ...value !== undefined ? { value } : {} }
  }

  /**
   * Finalize one failure diagnostic against the combined cap.
   * @param logs - retained ordered logs.
   * @param error - structured runtime failure.
   * @returns the failure or output-limit result.
   */
  failure(logs: string[], error: CodeRunFailure): CodeRunResult {
    if (jsonStringBytesUpTo(error.message, this.maxBytes - this.bytes) === undefined) return this.limit(logs)
    return { logs, error }
  }

  /**
   * Build an explicit output-limit failure with a fitting log prefix.
   * @param logs - ordered logs observed before the limit.
   * @returns bounded output-limit result.
   */
  limit(logs: string[]): CodeRunResult {
    const fullMessage = `outer output exceeded ${this.maxBytes} bytes`
    const messageBytes = fullMessage.length + 2
    const retained: string[] = []
    let retainedBytes = 2
    const logBudget = this.maxBytes - messageBytes
    for (const text of logs) {
      const separatorBytes = retained.length > 0 ? 1 : 0
      const availableBytes = logBudget - retainedBytes - separatorBytes
      const stringBytes = jsonStringBytesUpTo(text, availableBytes)
      if (stringBytes !== undefined) {
        retained.push(text)
        retainedBytes += stringBytes + separatorBytes
        continue
      }
      const prefix = truncateJsonStringBytes(text, availableBytes)
      if (prefix.length > 0) {
        const prefixBytes = jsonStringBytesUpTo(prefix, availableBytes)
        /* v8 ignore next -- truncateJsonStringBytes guarantees the same bound. */
        if (prefixBytes === undefined) throw new Error('output ledger produced an oversized log prefix')
        retained.push(prefix)
        retainedBytes += prefixBytes + separatorBytes
      }
      break
    }
    const message = truncateJsonStringBytes(fullMessage, this.maxBytes - retainedBytes)
    return { logs: retained, error: { kind: 'output-limit', message } }
  }
}

export { decodeWorkerJson, encodeWorkerJson, snapshotCodeJsonValue } from './worker-json.ts'
export { jsonValueBytesUpTo } from './output-json.ts'
export type { WorkerJsonWire } from './worker-json.ts'
