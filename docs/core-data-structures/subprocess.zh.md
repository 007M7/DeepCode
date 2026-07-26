# 进程管理器

[English](subprocess.md) | 中文

进程管理器 seam 分为接口（[dsh-subprocess](../../packages/subprocess/subprocess)，`ctx.subprocess`）与实现（[dsh-subprocess-local](../../packages/subprocess/subprocess-local)）；它的消费方是其他能力 seam 与进程外后端：[bash 执行器家族](bash.md)使用收集模式（collect）的批量输出，LSP 主机使用管道化的协议流 + 收集的 stderr 尾部，ACP（Agent Client Protocol）subagent 后端则使用管道化的协议流 + inherit 的 stderr。该 seam 拥有受管的 `DSH_*` 环境命名空间、共享的凭据清除（`scrubbedParentEnv`）与 `CollectedOutput` 形状；[dsh-bash](../../packages/bash/bash) 重导出这套词汇，使 bash 消费方保持单一导入入口。

源码：[`packages/subprocess/subprocess/src/types.ts`](../../packages/subprocess/subprocess/src/types.ts)

## 受管环境命名空间与捕获的输出

`DSH_*` 变量是归 Harness 所有的子进程事实；实现会在合并调用方快照之前丢弃环境中已有的 `DSH_*` 名称，每条被收集的流都通过 `CollectedOutput` 报告自身的截断与 spill 恢复状态。

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

## Node 形状的 stdio 处置方式（disposition）

每条流的处置方式都显式给出，由各消费方自行选择：原始管道用于协议分帧（LSP JSON-RPC、ACP ndjson），inherit 用于直通的诊断输出，收集模式用于有界的批量输出；其中 spill 文件是可选的，因此诊断尾部（语言服务器的 stderr）可以只在内存中缓冲，不留下任何文件。

```ts type-equiv
/**
 * stdin disposition. `'ignore'` leaves fd 0 on `/dev/null`; `'pipe'` exposes
 * {@link SubprocessHandle.stdin} for the caller's ongoing protocol writes;
 * `{ data }` writes the bytes and closes (the batch shape).
 */
type SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string }
```

```ts type-equiv
/**
 * Bounded in-memory collection for one output stream, with an optional
 * full-stream spill file. Omitting `spill` keeps only the in-memory tail —
 * the diagnostic-tail shape (a language server's stderr); including it makes
 * the complete stream recoverable up to its cap (the bash tool shape).
 */
interface SubprocessCollect {
  /** In-memory cap in bytes; overflow keeps the TAIL. */
  maxBytes: number
  /** Full-stream spill file; absent disables spilling entirely. */
  spill?: {
    /** Whole-stream byte cap; a larger stream discards its now-incomplete spill. */
    maxBytes: number
  }
}
```

```ts type-equiv
/**
 * stdout/stderr disposition. `'pipe'` exposes the raw `Readable` for the
 * caller's protocol decoding; `'inherit'` passes the parent's descriptor
 * through (child diagnostics land on the harness's own stream); a
 * {@link SubprocessCollect} object buffers boundedly with offset-based reads.
 */
type SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect
```

```ts type-equiv
/** Per-stream stdio dispositions, all explicit — this seam applies no defaults. */
interface SubprocessStdio {
  stdin: SubprocessStdinMode
  stdout: SubprocessOutputMode
  stderr: SubprocessOutputMode
}
```

## 完全显式的 spawn spec

该 seam 不应用任何默认值：每项处置方式、限制与目录都在 spec 上显式给出，因此由调用方自己的配置决定它们，而不是由某个隐藏的进程管理器默认值决定。`argv` 绝不经过 shell 解释。

```ts type-equiv
/**
 * A fully-specified spawn request. This seam applies no defaults: every
 * disposition, limit, and directory is explicit, so the caller's own config —
 * not a hidden subprocess-service default — decides them (the `dsh-bash`
 * request/spec split is the owning template).
 */
interface SubprocessSpawnSpec {
  /** Executable and arguments; `argv[0]` is the program. Never shell-interpreted here. */
  argv: readonly string[]
  /** Working directory for the child. */
  cwd: string
  /** Per-stream stdio dispositions. */
  stdio: SubprocessStdio
  /**
   * Grace period in milliseconds for the {@link SubprocessHandle.terminate}
   * escalation and for draining still-open collected pipes after the process
   * exits (an inherited descriptor held by a surviving descendant cannot hold
   * the outcome open indefinitely).
   */
  graceMs: number
  /**
   * Abort signal — starts the terminate escalation on the process tree when
   * it fires. The caller owns deadlines and cause classification; this seam
   * only reacts to the abort.
   */
  signal?: AbortSignal | undefined
  /**
   * Ordinary environment entries merged onto the implementation's scrubbed
   * parent base (see `scrubbedParentEnv`). `DSH_*` names are rejected and
   * belong in {@link dshEnv}; a deliberately forwarded credential-shaped
   * entry survives because this layer merges after the scrub.
   */
  env?: Record<string, string> | undefined
  /**
   * Harness-owned `DSH_*` variables for this execution. The scrubbed base has
   * already discarded ambient `DSH_*` entries, so an unavailable current fact
   * cannot inherit a stale value from the harness process; non-`DSH_*` names
   * on this channel are rejected.
   */
  dshEnv?: DshEnvironment | undefined
}
```

## 句柄：流、读取器与以进程树为范围的终止

spawn 会立即返回一个实时句柄。收集模式的读取器接受全流字节偏移量且从不消费，因此独立的读取器不会抢走彼此的增量；管道化的流归调用方所有。终止在每个平台上都以进程树为范围：`terminate()`（唯一的终止动词）执行 SIGTERM→宽限期→SIGKILL 升级，`waitForExit()` 观察整棵进程树，`dispose(graces)` 运行进程外子进程所需的协作式 stdin EOF→SIGTERM→SIGKILL 阶梯。

```ts type-equiv
/**
 * A live child process rooted in its own process tree. Collected output
 * remains readable after exit; piped streams belong to the caller.
 *
 * Termination is tree-scoped everywhere: POSIX signals the detached process
 * group (falling back to the direct child when the group is gone), Windows
 * terminates the tree via `taskkill /T`, so helper processes cannot outlive
 * the handle unnoticed.
 */
interface SubprocessHandle {
  /** Process id (tree root); -1 when the spawn itself failed. */
  readonly pid: number
  /** The child's stdin, present iff spawned with `stdin: 'pipe'`. */
  readonly stdin: Writable | undefined
  /** The child's raw stdout, present iff spawned with `stdout: 'pipe'`. */
  readonly stdout: Readable | undefined
  /** The child's raw stderr, present iff spawned with `stderr: 'pipe'`. */
  readonly stderr: Readable | undefined
  /** Offset-based readers for collect-mode streams (also readable after exit). */
  readonly collected: SubprocessCollectedOutputs
  /** Resolves at process close with exit facts; rejects only for spawn-level failures. */
  readonly done: Promise<SubprocessOutcome>
  /**
   * Begin the SIGTERM → `graceMs` → SIGKILL escalation on the process tree
   * (Windows force-terminates immediately) — the seam's only termination
   * verb. Idempotent, a no-op once the tree is gone (the pid may be reused),
   * and also triggered by the spec's abort signal.
   */
  terminate(): void
  /**
   * Wait until the process tree has exited — the tree, not just the direct
   * child, so a still-running helper is observable before teardown returns.
   * @param signal - optional bound for the wait.
   * @returns `true` when the tree exited, `false` when the signal aborted first.
   */
  waitForExit(signal?: AbortSignal): Promise<boolean>
  /**
   * Tear the child down to quiescence, resolving only after exit: close stdin
   * (when this handle owns a piped one) and allow cooperative flush for
   * `eofGraceMs`, then SIGTERM with a `graceMs` window (POSIX), then forced
   * tree termination with a final bounded `graceMs` wait.
   * @param graces - the ladder's two windows, from the consumer's Config.
   * @throws when the child still has not exited `graceMs` after the forced tier.
   */
  dispose(graces: SubprocessDisposeGraces): Promise<void>
}
```

```ts type-equiv
/**
 * Cursor-free incremental access to one collected output stream. Offsets are
 * whole-stream byte coordinates owned by the caller, so independent readers
 * cannot consume one another's output; `readFrom(0)` after settlement is the
 * batch result (`lossy` then means the in-memory tail lost its head — the
 * {@link CollectedOutput.truncated} fact).
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

```ts type-equiv
/** Offset-based readers for the streams spawned in collect mode. */
interface SubprocessCollectedOutputs {
  /** Present iff stdout is a {@link SubprocessCollect}. */
  readonly stdout?: SubprocessOutputReader
  /** Present iff stderr is a {@link SubprocessCollect}. */
  readonly stderr?: SubprocessOutputReader
}
```

```ts type-equiv
/**
 * The two grace periods of the cooperative dispose ladder
 * ({@link SubprocessHandle.dispose}). Consumers carry them as defaulted,
 * validated Config fields, so teardown timing is deployment-tunable and this
 * seam hardcodes nothing.
 */
interface SubprocessDisposeGraces {
  /**
   * Tier-1 window (ms): after stdin EOF, how long the child gets to quiesce
   * ON ITS OWN — flush durable state, tear down its own descendants — before
   * escalation to platform termination. Usually WIDER than
   * {@link SubprocessDisposeGraces.graceMs}: a cooperative child's EOF-driven
   * teardown may itself wait on a signal-trapping grandchild plus a final
   * flush.
   */
  eofGraceMs: number
  /**
   * Termination confirmation window (ms): POSIX applies it after `SIGTERM`
   * and again after `SIGKILL`; Windows applies it after the forced tree
   * termination.
   */
  graceMs: number
}
```

## 结果只承载退出事实

`done` 报告 Node close 事件的词汇，不携带原因分类：服务会在中止时终止进程，但绝不判定原因（调用方读取归自己所有的 deadline 信号，例如 bash 执行器的 `timedOut`/`aborted` 拆分）。收集到的输出在结算后仍可经 `handle.collected` 读取，因此批量与流式调用方共用一条访问路径。

```ts type-equiv
/**
 * Exit facts of one closed process — Node's `close`-event vocabulary.
 * Deliberately carries NO timeout or cancellation classification (the caller
 * reads the signal it owns to classify causes) and NO output: collected
 * streams stay readable through {@link SubprocessHandle.collected} after
 * settlement, so batch and streaming callers share one access path.
 */
interface SubprocessOutcome {
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  /** Terminating signal (e.g. 'SIGTERM'); null on normal exit. */
  signal: NodeJS.Signals | null
}
```

## 服务行为

抽象的 [`SubprocessService`](../../packages/subprocess/subprocess/src/index.ts) seam 只定义 `spawn`；[`LocalSubprocessService`](../../packages/subprocess/subprocess-local/src/index.ts) 是本地实现（detached 进程树、按处置方式接线的流、凭据清除、先终止再等待退出的 dispose（资源释放））。seam 契约见 [`dsh-subprocess`](../../packages/subprocess/subprocess/README.md)，具体机制见 [`dsh-subprocess-local`](../../packages/subprocess/subprocess-local/README.md)。
