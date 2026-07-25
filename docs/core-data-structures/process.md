# Process Manager

The child-process manager seam is split across interface ([dsh-process](../../packages/process/process), `ctx.processes`) and implementation ([dsh-process-local](../../packages/process/process-local)); its consumers are other capability seams — today the [bash executor family](bash.md), which passes `['bash', '-c', command]` argv and owns every default. This seam owns the managed `DSH_*` environment namespace and the `CollectedOutput` shape; [dsh-bash](../../packages/bash/bash) re-exports them so bash consumers keep one import root.

Source: [`packages/process/process/src/types.ts`](../../packages/process/process/src/types.ts)

## The fully-explicit spawn spec

The seam applies no defaults: every limit and directory is explicit on the spec, so the caller's own config — not a hidden process-manager default — decides them. `argv` is never shell-interpreted.

```ts type-equiv
/**
 * A fully-specified spawn request. This seam applies no defaults: every limit
 * and directory is explicit, so the caller's own config — not a hidden
 * process-manager default — decides them (the `dsh-bash` request/spec split
 * is the owning template).
 */
interface ProcessSpawnSpec {
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
```

## Handles and offset-based reads

A spawn returns a live handle immediately. Output readers take whole-stream byte offsets and never consume, so independent readers cannot steal one another's deltas; the consuming-cursor model the bash tool presents is consumer-owned state over these readers.

```ts type-equiv
/**
 * A live child process. `kill()` starts the group SIGTERM→grace→SIGKILL
 * escalation; buffered output remains readable after exit.
 */
interface ProcessHandle {
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
```

```ts type-equiv
/**
 * Cursor-free incremental access to one live output stream. Offsets are
 * whole-stream byte coordinates owned by the caller, so independent readers
 * cannot consume one another's output.
 */
interface ProcessOutputReader {
  /**
   * Read everything captured since `fromByte`. When that offset has slid out
   * of the in-memory tail window the read is `lossy` — it returns the whole
   * retained tail and the gap is only recoverable from the spill file.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 for the first read).
   * @returns the delta text, the next offset, the `lossy` flag, and the spill path when one exists.
   */
  readFrom(fromByte: number): ProcessOutputRead
}
```

```ts type-equiv
/** One incremental {@link ProcessOutputReader.readFrom} read. */
interface ProcessOutputRead {
  /** Stream text from the requested offset (the whole retained tail when lossy). */
  text: string
  /** Whole-stream offset to resume from on the next read. */
  nextOffset: number
  /** True when the requested offset slid out of the in-memory tail window. */
  lossy: boolean
  /** Path to the full-stream spill file, when one was created and remains intact. */
  spillPath?: string
}
```

## Outcomes carry no cause classification

`done` reports raw exit facts. The manager kills on abort but never decides why — the caller reads the deadline signal it owns to classify timeout versus cancellation (the bash executor's `timedOut`/`aborted` split).

```ts type-equiv
/**
 * Raw outcome of one closed process. Deliberately carries NO timeout or
 * cancellation classification: the manager kills on abort but does not decide
 * why — the caller reads the signal it owns to classify causes.
 */
interface ProcessOutcome {
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  /** Terminating signal (e.g. 'SIGTERM'); null on normal exit. */
  signal: NodeJS.Signals | null
  stdout: CollectedOutput
  stderr: CollectedOutput
}
```

## Service behavior

The abstract [`ProcessManager`](../../packages/process/process/src/index.ts) seam defines `spawn` only; [`LocalProcessManager`](../../packages/process/process-local/src/index.ts) is the local implementation (detached groups, tail-keep spill-backed collection, credential scrub, kill-and-join disposal). See [`dsh-process`](../../packages/process/process/README.md) for the seam contract and [`dsh-process-local`](../../packages/process/process-local/README.md) for the mechanics.
