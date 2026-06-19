/**
 * Execution vocabulary for the bash executor seam. Types only — the abstract
 * service lives in `./index.ts`, implementations in sibling packages
 * (`@deepseek-ai/dsh-bash-local` first).
 *
 * @module dsh-bash/types
 */

/**
 * A caller's execution REQUEST: `workdir` and `timeoutMs` are optional and
 * filled by {@link BashExecutor.resolve} from the implementation's config.
 * This is the model-/plugin-facing shape; pass it to `resolve()` to obtain a
 * fully-resolved {@link BashExecSpec}.
 */
export interface BashExecRequest {
  command: string
  /** Working directory override (default: implementation-configured). */
  workdir?: string | undefined
  /** Timeout override in milliseconds (implementations cap it). */
  timeoutMs?: number | undefined
  /** Abort signal — implementations kill the command when it fires. */
  signal?: AbortSignal | undefined
}

/**
 * A fully-resolved execution SPEC — exactly what {@link BashExecutor.run} /
 * {@link BashExecutor.start} act on. `workdir` and `timeoutMs` are REQUIRED:
 * defaulting and capping already happened in {@link BashExecutor.resolve}, so
 * the executor never hides a `?? config` fallback (explicit > implicit). For
 * background tasks, `start()` ignores `timeoutMs` (background runs have no
 * timeout) — the field is still required because the type is shared.
 */
export interface BashExecSpec {
  command: string
  workdir: string
  timeoutMs: number
  /** Abort signal — implementations kill the command when it fires. */
  signal?: AbortSignal | undefined
}

/** One captured stream: the (possibly truncated) text plus recovery info. */
export interface CollectedOutput {
  /** Collected text — the TAIL of the stream when truncated. */
  text: string
  /** True when bytes were dropped from `text`. */
  truncated: boolean
  /** Path to a file holding the COMPLETE stream, when truncated and available. */
  spillPath?: string
}

/** The outcome of one completed (or killed) foreground run. */
export interface BashRunResult {
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  /** Terminating signal (e.g. 'SIGTERM'); null on normal exit. */
  signal: NodeJS.Signals | null
  /** True when the executor's own timeout killed the command. */
  timedOut: boolean
  /** True when the caller's AbortSignal killed the command. */
  aborted: boolean
  /** The effective timeout applied to this run (after defaulting/capping). */
  timeoutMs: number
  stdout: CollectedOutput
  stderr: CollectedOutput
}

/** Lifecycle of a background task. */
export type BashTaskStatus = 'running' | 'completed' | 'killed'

/** A tracked background task handle. */
export interface BashTask {
  readonly id: string
  readonly command: string
  status: BashTaskStatus
  /** Exit code once finished (null = killed by signal / still running). */
  exitCode: number | null
  /** Terminating signal name, when signal-killed. */
  signal: NodeJS.Signals | null
  /** Resolves when the underlying process closes (never rejects). */
  readonly done: Promise<void>
}

/** One incremental {@link BashExecutor.readOutput} read. */
export interface BashTaskRead {
  task: BashTask
  /** Output produced since the previous read (stderr in a marked section). */
  delta: string
  /** True when truncation dropped unread bytes the delta cannot include. */
  lossy: boolean
  /** Full stdout spill file, when stdout truncation occurred and a safe path is available. */
  stdoutSpillPath?: string
  /** Full stderr spill file, when stderr truncation occurred and a safe path is available. */
  stderrSpillPath?: string
}

/** Completion callback for background tasks. */
export type BashTaskListener = (task: BashTask) => void
