/**
 * Vocabulary for the process-manager seam: fully-specified spawn requests,
 * bounded output with spill recovery, and live process handles. Command
 * defaulting, shell semantics, and presentation belong to consumers such as
 * the bash executor seam.
 * @module dsh-process/types
 */

/** Namespace prefix reserved for DeepSeek Harness-managed child environment facts. */
export const DSH_ENV_PREFIX = 'DSH_' as const

/** One environment key inside the managed {@link DSH_ENV_PREFIX} namespace. */
export type DshEnvironmentKey = `${typeof DSH_ENV_PREFIX}${string}`

/** Trusted DeepSeek Harness variables for one child-process execution. */
export type DshEnvironment = Readonly<Record<DshEnvironmentKey, string>>

/** One captured stream: the (possibly truncated) text plus recovery info. */
export interface CollectedOutput {
  /** Collected text — the TAIL of the stream when truncated. */
  text: string
  /** True when bytes were dropped from `text`. */
  truncated: boolean
  /** Path to a file holding the COMPLETE stream, when truncated and available. */
  spillPath?: string
}

/**
 * A fully-specified spawn request. This seam applies no defaults: every limit
 * and directory is explicit, so the caller's own config — not a hidden
 * process-manager default — decides them (the `dsh-bash` request/spec split
 * is the owning template).
 */
export interface ProcessSpawnSpec {
  /** Executable and arguments; `argv[0]` is the program. Never shell-interpreted here. */
  argv: readonly string[]
  /** Working directory for the child. */
  cwd: string
  /** Stdout in-memory cap; overflow spills to disk (tail kept in memory). */
  stdoutMaxBytes: number
  /** Stderr in-memory cap; overflow spills to disk (tail kept in memory). */
  stderrMaxBytes: number
  /** Per-stream spill-file cap; larger streams retain only their in-memory tail. */
  maxSpillBytes: number
  /** Grace period for kill escalation and for inherited pipes after process exit. */
  graceMs: number
  /**
   * Abort signal — kills the process group when it fires. The caller owns
   * deadlines and cause classification; this seam only reacts to the abort.
   */
  signal?: AbortSignal | undefined
  /**
   * Bytes to write to the child's stdin, then close it. Absent (or empty)
   * leaves stdin closed/empty.
   */
  stdin?: string | undefined
  /**
   * Ordinary environment entries merged after the implementation's credential
   * scrub. `DSH_*` names are rejected and belong in {@link dshEnv}.
   */
  env?: Record<string, string> | undefined
  /**
   * Harness-owned `DSH_*` variables for this execution. Implementations
   * discard ambient `DSH_*` entries before merging this snapshot, so an
   * unavailable current fact cannot inherit a stale value from the harness
   * process, and reject non-`DSH_*` names supplied through this channel.
   */
  dshEnv?: DshEnvironment | undefined
}

/**
 * Raw outcome of one closed process. Deliberately carries NO timeout or
 * cancellation classification: the manager kills on abort but does not decide
 * why — the caller reads the signal it owns to classify causes.
 */
export interface ProcessOutcome {
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  /** Terminating signal (e.g. 'SIGTERM'); null on normal exit. */
  signal: NodeJS.Signals | null
  stdout: CollectedOutput
  stderr: CollectedOutput
}

/** One incremental {@link ProcessOutputReader.readFrom} read. */
export interface ProcessOutputRead {
  /** Stream text from the requested offset (the whole retained tail when lossy). */
  text: string
  /** Whole-stream offset to resume from on the next read. */
  nextOffset: number
  /** True when the requested offset slid out of the in-memory tail window. */
  lossy: boolean
  /** Path to the full-stream spill file, when one was created and remains intact. */
  spillPath?: string
}

/**
 * Cursor-free incremental access to one live output stream. Offsets are
 * whole-stream byte coordinates owned by the caller, so independent readers
 * cannot consume one another's output.
 */
export interface ProcessOutputReader {
  /**
   * Read everything captured since `fromByte`. When that offset has slid out
   * of the in-memory tail window the read is `lossy` — it returns the whole
   * retained tail and the gap is only recoverable from the spill file.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 for the first read).
   * @returns the delta text, the next offset, the `lossy` flag, and the spill path when one exists.
   */
  readFrom(fromByte: number): ProcessOutputRead
}

/**
 * A live child process. `kill()` starts the group SIGTERM→grace→SIGKILL
 * escalation; buffered output remains readable after exit.
 */
export interface ProcessHandle {
  /** Process id (group leader); -1 when the spawn itself failed. */
  readonly pid: number
  /** Live stdout reader (also readable after exit). */
  readonly stdout: ProcessOutputReader
  /** Live stderr reader (also readable after exit). */
  readonly stderr: ProcessOutputReader
  /** Resolves when the process closes; rejects only for spawn-level failures. */
  readonly done: Promise<ProcessOutcome>
  /** Begin SIGTERM→grace→SIGKILL on the process group. Idempotent. */
  kill(): void
}
