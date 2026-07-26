# Subprocess

The subprocess seam is split across interface ([dsh-subprocess](../../packages/subprocess/subprocess), `ctx.subprocess`) and implementation ([dsh-subprocess-local](../../packages/subprocess/subprocess-local)); its consumers are other capability seams — today the [bash executor family](bash.md), which passes `['bash', '-c', command]` argv and owns every default. This seam owns the managed `DSH_*` environment namespace and the `CollectedOutput` shape; [dsh-bash](../../packages/bash/bash) re-exports them so bash consumers keep one import root.

Source: [`packages/subprocess/subprocess/src/types.ts`](../../packages/subprocess/subprocess/src/types.ts)

## Managed environment namespace and captured output

`DSH_*` variables are Harness-owned child-process facts; implementations discard ambient `DSH_*` names before merging the caller's snapshot, and each captured stream reports its truncation and spill-recovery state through `CollectedOutput`.

```ts type-equiv
/** One environment key inside the managed {@link DSH_ENV_PREFIX} namespace. */
type DshEnvironmentKey = `${typeof DSH_ENV_PREFIX}${string}`
```

```ts type-equiv
/** Trusted DeepSeek Harness variables for one child-process execution. */
type DshEnvironment = Readonly<Record<DshEnvironmentKey, string>>
```

```ts type-equiv
/** One captured stream: the (possibly truncated) text plus recovery info. */
interface CollectedOutput {
  /** Collected text — the TAIL of the stream when truncated. */
  text: string
  /** True when bytes were dropped from `text`. */
  truncated: boolean
  /** Path to a file holding the COMPLETE stream, when truncated and available. */
  spillPath?: string
}
```

## The fully-explicit spawn spec

The seam applies no defaults: every limit and directory is explicit on the spec, so the caller's own config — not a hidden subprocess-service default — decides them. `argv` is never shell-interpreted.

```ts type-equiv
/**
 * A fully-specified spawn request. This seam applies no defaults: every limit
 * and directory is explicit, so the caller's own config — not a hidden
 * subprocess-service default — decides them (the `dsh-bash` request/spec split
 * is the owning template).
 */
interface SubprocessSpawnSpec {
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
interface SubprocessHandle {
  /** Process id (group leader); -1 when the spawn itself failed. */
  readonly pid: number
  /** Live stdout reader (also readable after exit). */
  readonly stdout: SubprocessOutputReader
  /** Live stderr reader (also readable after exit). */
  readonly stderr: SubprocessOutputReader
  /** Resolves when the process closes; rejects only for spawn-level failures. */
  readonly done: Promise<SubprocessOutcome>
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
interface SubprocessOutputReader {
  /**
   * Read everything captured since `fromByte`. When that offset has slid out
   * of the in-memory tail window the read is `lossy` — it returns the whole
   * retained tail and the gap is only recoverable from the spill file.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 for the first read).
   * @returns the delta text, the next offset, the `lossy` flag, and the spill path when one exists.
   */
  readFrom(fromByte: number): SubprocessOutputRead
}
```

```ts type-equiv
/** One incremental {@link SubprocessOutputReader.readFrom} read. */
interface SubprocessOutputRead {
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

`done` reports raw exit facts. The service kills on abort but never decides why — the caller reads the deadline signal it owns to classify timeout versus cancellation (the bash executor's `timedOut`/`aborted` split).

```ts type-equiv
/**
 * Raw outcome of one closed process. Deliberately carries NO timeout or
 * cancellation classification: the service kills on abort but does not decide
 * why — the caller reads the signal it owns to classify causes.
 */
interface SubprocessOutcome {
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  /** Terminating signal (e.g. 'SIGTERM'); null on normal exit. */
  signal: NodeJS.Signals | null
  stdout: CollectedOutput
  stderr: CollectedOutput
}
```

## Service behavior

The abstract [`SubprocessService`](../../packages/subprocess/subprocess/src/index.ts) seam defines `spawn` only; [`LocalSubprocessService`](../../packages/subprocess/subprocess-local/src/index.ts) is the local implementation (detached groups, tail-keep spill-backed collection, credential scrub, kill-and-join disposal). See [`dsh-subprocess`](../../packages/subprocess/subprocess/README.md) for the seam contract and [`dsh-subprocess-local`](../../packages/subprocess/subprocess-local/README.md) for the mechanics.
