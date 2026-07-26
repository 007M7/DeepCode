# 进程管理器

[English](subprocess.md) | 中文

进程管理器 seam 分为接口（[dsh-subprocess](../../packages/subprocess/subprocess)，`ctx.subprocess`）与实现（[dsh-subprocess-local](../../packages/subprocess/subprocess-local)）；它的消费方是其他能力 seam：目前是 [bash 执行器家族](bash.md)，后者传入 `['bash', '-c', command]` argv，并拥有每一项默认值。该 seam 拥有受管的 `DSH_*` 环境命名空间与 `CollectedOutput` 形状；[dsh-bash](../../packages/bash/bash) 将二者重导出，使 bash 消费方保持单一导入入口。

源码：[`packages/subprocess/subprocess/src/types.ts`](../../packages/subprocess/subprocess/src/types.ts)

## 受管环境命名空间与捕获的输出

`DSH_*` 变量是归 Harness 所有的子进程事实；实现会在合并调用方快照之前丢弃环境中已有的 `DSH_*` 名称，每条被捕获的流都通过 `CollectedOutput` 报告自身的截断与 spill 恢复状态。

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

## 完全显式的 spawn spec

该 seam 不应用任何默认值：每项限制与目录都在 spec 上显式给出，因此由调用方自己的配置决定它们，而不是由某个隐藏的进程管理器默认值决定。`argv` 绝不经过 shell 解释。

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

## 句柄与基于偏移量的读取

spawn 会立即返回一个实时句柄。输出读取器接受全流字节偏移量且从不消费，因此独立的读取器不会抢走彼此的增量；bash 工具呈现的消费游标模型，是消费方在这些读取器之上自行持有的状态。

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

## 结果不携带原因分类

`done` 报告原始退出事实。服务会在中止时终止进程，但绝不判定原因：调用方读取归自己所有的 deadline 信号，以区分超时与取消（即 bash 执行器的 `timedOut`/`aborted` 拆分）。

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

## 服务行为

抽象的 [`SubprocessService`](../../packages/subprocess/subprocess/src/index.ts) seam 只定义 `spawn`；[`LocalSubprocessService`](../../packages/subprocess/subprocess-local/src/index.ts) 是本地实现（detached 进程组、以 spill 文件兜底的尾部保留收集、凭据清除、先终止再等待退出的 dispose（资源释放））。seam 契约见 [`dsh-subprocess`](../../packages/subprocess/subprocess/README.md)，具体机制见 [`dsh-subprocess-local`](../../packages/subprocess/subprocess-local/README.md)。
