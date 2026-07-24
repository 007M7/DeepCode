# 进程沙箱

[English](sandbox.md) | 中文

[dsh-sandbox](../../packages/sandbox/sandbox) 的进程沙箱 seam 将与宿主共享文件系统和内核的子进程 argv 包装在文件效果策略中，而不将消费方耦合到特定平台运行器。[dsh-sandbox-local](../../packages/sandbox/sandbox-local) 提供 Linux bwrap/Landlock 与 macOS Seatbelt 后端；[dsh-bash-sandbox](../../packages/bash/bash-sandbox) 是第一个消费方。容器、microVM 和远程执行是完整能力 seam 的兄弟实现，而非 `ctx.sandbox` 的提供方。

源码：[`packages/sandbox/sandbox/src/index.ts`](../../packages/sandbox/sandbox/src/index.ts)

## 模式与强制执行

`SandboxMode` 仅管控文件系统效果。`read-only` 拒绝所有写入（必需的 `/dev/null` 接收器除外）；`workspace-write` 允许在工作区根目录及后端承诺的临时区域下写入；`danger-full-access` 绕过隔离。网络与进程可见性不在此处的定义范围内。

```ts type-equiv
/**
 * File-effect policy for confined processes. `read-only` permits only required
 * sinks such as `/dev/null`; `workspace-write` also permits the workspace and a
 * backend-defined temp area; `danger-full-access` bypasses confinement. Network
 * and process visibility are outside this vocabulary.
 */
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
```

只有前两种模式可以发送给提供方。`danger-full-access` 的消费方直接 spawn 原始 argv，不调用 `ctx.sandbox`。

```ts type-equiv
/** A confining (non-`danger-full-access`) mode — the modes a {@link SandboxPolicy} can carry. */
type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
```

强制执行程度是一个报告事实。`full` 表示后端管控了该模式承诺的所有文件效果；`partial` 表示活跃后端或较旧的内核 ABI 仅管控其中一个子集，因此要求绝对保证的消费方必须拒绝或向上暴露这一区别。

```ts type-equiv
/**
 * Enforcement completeness for this host. `partial` means an active backend or
 * older kernel ABI cannot govern every promised file effect; callers requiring
 * an absolute boundary must not treat it as `full`.
 */
type SandboxEnforcement = 'full' | 'partial'
```

## 逐调用策略

完整执行策略会按每次能力调用解析并携带。它包括 `danger-full-access`，因此消费方可以只解析一次策略，再决定是否绕过约束。普通工具调用从调用会话的不可变 cwd 派生 `workspaceRoot`；部署配置是没有 agent（智能体）时的回退值。root 会先按文件系统语义规范化，再做词法规范化，因此包含 `symlink/..` 的 cwd 会标识所生成进程实际运行的目录。

```ts type-equiv
/**
 * The complete file-effect policy resolved for one capability call. The root
 * is carried even under modes that do not consume it so callers can resolve
 * policy once before choosing the enforcement path.
 */
interface SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: SandboxMode
  /** Absolute root directory `workspace-write` may write under. */
  workspaceRoot: string
}
```

`ctx.sandboxPolicy.resolve()` 接收活跃会话；对于已批准的重试，还接收显式模式。该服务拥有优先级与 root 回退规则，使 bash 和 fs 不必重复实现。

```ts type-equiv
/** Inputs that select the sandbox policy for one capability call. */
interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the workspace boundary. */
  session?: Session
  /** Explicit approved mode override, which outranks session policy. */
  mode?: SandboxMode
}
```

只有受约束的执行会到达 `ctx.sandbox`；其提供方策略在保留同一 root 的同时收窄模式。这使并发会话、消费方与一次性提权重试可以向同一提供方请求不同边界，而无需改变提供方状态。

```ts type-equiv
/**
 * What one confined execution is allowed to touch — carried PER CALL, not
 * fixed on the provider: two consumers may confine under different policies
 * at the same instant (bash under `read-only` while a confined child agent
 * needs its state directory writable), and an approved escalated retry is a
 * new call with a wider policy. Defaulting/resolution is an explicit step at
 * the consumer boundary; the provider treats the policy as fully specified.
 */
interface SandboxPolicy extends SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: ConfinedSandboxMode
}
```

## 包装后的 argv 与分类方言

`ConfinedArgv` 是消费方实际 spawn 的内容。除了替换后的 argv，它还携带后端的强制执行事实和两种正交的 stderr 方言。`denialSignatures` 用于识别沙箱正常工作时被隔离命令被阻止的情况。`runnerFailureSignatures` 用于识别沙箱运行器在执行命令之前拒绝或失败的情况；消费方应先检查后者，将其作为沙箱基础设施故障上报，而非普通任务失败。

```ts type-equiv
/**
 * A {@link SandboxProvider.confine} result: the argv to spawn in place of
 * the caller's own, plus the enforcement completeness the selected backend
 * achieves for it.
 */
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
   * Case-insensitive signatures for runner failure before command execution.
   * Consumers check these before denial signatures: runner failure means the
   * command never ran, while denial means confinement worked and blocked it.
   */
  runnerFailureSignatures: readonly string[]
}
```

运维人员配置的本地运行器必须为自身的 pre-exec 拒绝方言提供至少一条 `runnerFailureSignatures` 条目；提供方会自动添加外层 shell 的 missing 和 unexecutable 形式。这使得可执行的自定义运行器拒绝其 profile 的情况能够与被包装命令以相同状态码退出的情况区分开来。

## 提供方与 fail-closed 错误

`ctx.sandbox.confine(argv, policy)` 返回一个 `ConfinedArgv`，或在没有可用后端时抛出 `SandboxUnavailableError`（错误码 `SANDBOX_UNAVAILABLE`）。已选定的运行器也可能在执行时 fail-closed，此时其失败签名承载相同的基础设施含义。对于受限策略，静默的无隔离透传永远不合法。

提供方探测在多个候选后端之间仲裁，结果在提供方生命周期内缓存。只有一个候选后端的平台可以直接选定它；执行时拒绝仍保留安全属性。本地提供方将 bwrap 和 Seatbelt 报告为 full，并保留 Landlock 启动器的 full/partial 内核裁定。
