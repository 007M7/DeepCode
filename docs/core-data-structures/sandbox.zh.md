# 进程沙箱

[English](sandbox.md) | 中文

[dsh-sandbox](../../packages/sandbox/sandbox) 的进程沙箱 seam 将同世界子进程的 argv 包装在文件效果策略中，而不将消费方耦合到特定平台运行器。[dsh-sandbox-local](../../packages/sandbox/sandbox-local) 提供 Linux bwrap/Landlock 与 macOS Seatbelt 后端；[dsh-bash-sandbox](../../packages/bash/bash-sandbox) 是第一个消费方。容器、microVM 和远程执行是完整能力 seam 的兄弟实现，而非 `ctx.sandbox` 的提供方。

源码：[`packages/sandbox/sandbox/src/index.ts`](../../packages/sandbox/sandbox/src/index.ts)

## 模式与强制执行

`SandboxMode` 仅管控文件系统效果。`read-only` 拒绝所有写入（必需的 `/dev/null` 接收器除外）；`workspace-write` 允许在工作区根目录及后端承诺的临时区域下写入；`danger-full-access` 绕过隔离。网络与进程可见性不在此处的定义范围内。

```ts type-equiv
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
```

只有前两种模式可以发送给提供方。`danger-full-access` 的消费方直接 spawn 原始 argv，不调用 `ctx.sandbox`。

```ts type-equiv
type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
```

强制执行程度是一个报告事实。`full` 表示后端管控了该模式承诺的所有文件效果；`partial` 表示活跃后端或较旧的内核 ABI 仅管控其中一个子集，因此要求绝对保证的消费方必须拒绝或向上暴露这一区别。

```ts type-equiv
type SandboxEnforcement = 'full' | 'partial'
```

## 逐调用策略

策略在每次调用时完全解析并随调用携带。这使得并发消费方和一次性提权重试能够向同一个提供方请求不同的边界，而无需修改提供方状态。

```ts type-equiv
interface SandboxPolicy {
  /** The file-effect mode this execution runs under. */
  mode: ConfinedSandboxMode
  /** Absolute root directory `workspace-write` may write under. */
  workspaceRoot: string
}
```

## 包装后的 argv 与分类方言

`ConfinedArgv` 是消费方实际 spawn 的内容。除了替换后的 argv，它还携带后端的强制执行事实和两种正交的 stderr 方言。`denialSignatures` 用于识别沙箱正常工作时被隔离命令被阻止的情况。`runnerFailureSignatures` 用于识别沙箱运行器在执行命令之前拒绝或失败的情况；消费方应先检查后者，将其作为沙箱基础设施故障上报，而非普通任务失败。

```ts type-equiv
interface ConfinedArgv {
  /** The wrapped argv (runner, profile, separator, then the caller's argv). */
  argv: string[]
  /** How completely the selected backend enforces the policy's file effects. */
  enforcement: SandboxEnforcement
  /**
   * The selected backend's denial DIALECT: the case-insensitive stderr
   * substrings a file effect denied by THIS backend produces (EROFS text
   * under bwrap's read-only binds, EACCES under Landlock, EPERM under
   * Seatbelt). A consumer that infers denials from a failed run's stderr
   * matches against exactly these rather than a cross-backend union — the
   * union claims denials a given backend never produces.
   */
  denialSignatures: readonly string[]
  /**
   * How the RUNNER ITSELF failing identifies itself: case-insensitive stderr
   * substrings produced when the sandbox binary is missing, refuses its
   * profile, or fails closed before exec'ing the command (`bwrap: `,
   * `landlock-run: `, `sandbox-exec: ` — each covers both the runner's own
   * error prefix and the shell's runner-not-found message). ORTHOGONAL to
   * {@link denialSignatures}: a denial is the confined COMMAND being blocked
   * (the sandbox working as designed); a runner failure means the command
   * NEVER RAN and must surface as a sandbox failure, not a task failure —
   * consumers check these signatures FIRST (a runner's own error text may
   * contain denial words, e.g. an unopenable grant root reporting
   * `Permission denied`).
   */
  runnerFailureSignatures: readonly string[]
}
```

运维人员配置的本地运行器必须为自身的 pre-exec 拒绝方言提供至少一条 `runnerFailureSignatures` 条目；提供方会自动添加外层 shell 的 missing 和 unexecutable 形式。这使得可执行的自定义运行器拒绝其 profile 的情况能够与被包装命令以相同状态码退出的情况区分开来。

## 提供方与 fail-closed 错误

`ctx.sandbox.confine(argv, policy)` 返回一个 `ConfinedArgv`，或在没有可用后端时抛出 `SandboxUnavailableError`（错误码 `SANDBOX_UNAVAILABLE`）。已选定的运行器也可能在执行时 fail-closed，此时其失败签名承载相同的基础设施含义。对于受限策略，静默的无隔离透传永远不合法。

提供方探测在多个候选后端之间仲裁，结果在提供方生命周期内缓存。只有一个候选后端的平台可以直接选定它；执行时拒绝仍保留安全属性。本地提供方将 bwrap 和 Seatbelt 报告为 full，并保留 Landlock 启动器的 full/partial 内核裁定。
