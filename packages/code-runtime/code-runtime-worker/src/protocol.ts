/**
 * Versionless, structured-clone wire protocol between co-shipped host and worker code. The host
 * treats inbound traffic as hostile because model code can forge `parentPort` messages; the
 * worker trusts host replies.
 * @module @deepseek-ai/dsh-code-runtime-worker/src/protocol
 */

/** What the host hands the worker at spawn, via `workerData`. */
export interface WorkerBootData {
  /** The type-stripped (plain JS) program body. */
  code: string
  /** Binding namespaces to materialize: the global name plus the function names (functions themselves stay host-side). */
  namespaces: { global: string; names: string[] }[]
  /** Hard cap for the combined serialized outer logs plus completion value or failure diagnostic. */
  maxOutputBytes: number
}

/** Worker → host: one bridged binding call. */
interface CallMessage {
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

/** Worker → host: captured text, streamed eagerly so output survives a mid-run termination (timeout, abort, OOM). */
interface LogMessage {
  type: 'log'
  text: string
}

/** Worker → host: worker-side capture or completion measurement exceeded the outer cap. */
interface OutputLimitMessage {
  type: 'output-limit'
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
  error?: { kind: 'exception' | 'invalid-output' | 'output-limit'; message: string }
}

/** Every message the worker sends. */
export type WorkerToHost = CallMessage | LogMessage | OutputLimitMessage | DoneMessage

/** Host → worker: the answer to one {@link CallMessage}. */
export type ReplyMessage =
  | { type: 'reply'; id: number; ok: true; value: unknown }
  | { type: 'reply'; id: number; ok: false; message: string }
