/**
 * Wire protocol between the host runtime and the worker bootstrap. Everything
 * crossing the message port is structured-clone-plain and versionless — both
 * ends ship in this package, always at the same version. The host treats
 * inbound traffic as HOSTILE (the worker runs model code, which can reach
 * `parentPort` via `import('node:worker_threads')` and forge any of these
 * shapes); the worker treats inbound traffic as trusted.
 *
 * @module @deepseek-ai/dsh-code-runtime-worker/src/protocol
 */

import type { CodeLogEntry } from '@deepseek-ai/dsh-code-runtime'

/** What the host hands the worker at spawn, via `workerData`. */
export interface WorkerBootData {
  /** The type-stripped (plain JS) program body. */
  code: string
  /** Binding namespaces to materialize: the global name plus the function names (functions themselves stay host-side). */
  namespaces: { global: string; names: string[] }[]
  /** Shared byte budget for captured log text; exceeding it drops further entries after one in-band marker. */
  maxLogBytes: number
  /** Byte cap for the rendered completion value (see the value-preparation contract in bootstrap.ts). */
  maxValueBytes: number
}

/** Worker → host: one bridged binding call. */
export interface CallMessage {
  type: 'call'
  /** Worker-issued correlation id; the host answers each id at most once and ignores duplicates. */
  id: number
  /** The namespace global the call targets. */
  global: string
  /** The function name within the namespace. */
  name: string
  /** The single argument, structured-clone-plain. */
  args: unknown
}

/** Worker → host: one captured log entry, streamed eagerly so output survives a mid-run termination (timeout, abort, OOM). */
export interface LogMessage {
  type: 'log'
  entry: CodeLogEntry
}

/**
 * Worker → host: the program settled. `error` carries a program exception
 * (the only failure the bootstrap itself can report — budgets, aborts, and
 * substrate death are observed host-side). `value` is present only on a
 * clean completion that produced one (already size-capped and
 * clone-safe per the bootstrap's value preparation). Logs are NOT carried
 * here — they streamed eagerly as {@link LogMessage}s.
 */
export interface DoneMessage {
  type: 'done'
  value?: unknown
  error?: { message: string }
}

/** Every message the worker sends. */
export type WorkerToHost = CallMessage | LogMessage | DoneMessage

/** Host → worker: the answer to one {@link CallMessage}. */
export type ReplyMessage =
  | { type: 'reply'; id: number; ok: true; value: unknown }
  | { type: 'reply'; id: number; ok: false; message: string }

/**
 * The in-band marker entry text announcing that log capture stopped at the
 * byte budget. Shared wire vocabulary: the worker's LogBuffer emits it when
 * ITS budget exhausts, and the host emits the identical text when its own
 * ledger drops an entry first (forged port traffic, stray pipe bytes) — so
 * a truncated run reads the same however the cap was hit.
 * @param maxBytes - the configured `maxLogBytes` the marker names.
 * @returns the marker line.
 */
export function logTruncationMarker(maxBytes: number): string {
  return `[dsh-code-runtime-worker] log capture truncated at ${maxBytes} bytes`
}
