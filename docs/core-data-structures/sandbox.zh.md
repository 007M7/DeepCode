# 进程沙箱

[English](sandbox.md) | 中文

[dsh-sandbox](../../packages/sandbox/sandbox) 的进程沙箱 seam 将与宿主共享文件系统和内核的子进程 argv 包装在文件效果策略中，而不将消费方耦合到特定平台运行器。[dsh-sandbox-local](../../packages/sandbox/sandbox-local) 提供 Linux bwrap/Landlock 与 macOS Seatbelt 后端；[dsh-bash-sandbox](../../packages/bash/bash-sandbox) 是第一个消费方。容器、microVM 和远程执行是完整能力 seam 的同级实现，而非 `ctx.sandbox` 的提供方。

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

强制执行完整性是后端报告的事实。`full` 表示后端管控了该模式承诺的所有文件效果；`partial` 表示活跃后端或较旧的内核 ABI 仅管控其中一个子集，因此要求绝对保证的消费方必须拒绝或向上暴露这一区别。

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

只有受约束的执行会到达 `ctx.sandbox`；传给提供方的策略在保留同一 root 的同时收窄模式。这使并发会话、消费方与一次性提权重试可以向同一提供方请求不同边界，而无需改变提供方状态。

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

`RunnerFailureRule` 汇集用于判定 runner 在执行命令前失败的证据。消费方要求进程以非零状态退出，并同时满足可选的允许退出码门控，以及余下某一 stderr 行中不区分大小写的致命签名。系统会先按不区分大小写的整行精确匹配移除信息性排除项，因此无害的 runner 通知本身不能证明失败。匹配到的行仍可用作错误详情；分类过程不会重写 stderr。

```ts type-equiv
/**
 * Evidence that identifies a sandbox runner failing before it executes the
 * wrapped command. A consumer first applies {@link allowedExitCodes} when
 * present, removes {@link informationalLines} by case-insensitive exact line
 * equality, then matches {@link fatalSignatures} case-insensitively within
 * each remaining stderr line. Exit status alone never proves runner failure.
 */
interface RunnerFailureRule {
  /** Nonzero process exit codes on which this rule may match; omitted permits any nonzero exit. */
  allowedExitCodes?: readonly number[]
  /** Non-empty substrings identifying a fatal runner diagnostic on one stderr line. */
  fatalSignatures: readonly string[]
  /** Benign stderr lines excluded by exact full-line equality before fatal matching. */
  informationalLines?: readonly string[]
}
```

`ConfinedArgv` 是消费方实际 spawn 的内容。除了替换后的 argv，它还携带后端的强制执行事实和两种正交的 stderr 分类器。`denialSignatures` 用于识别沙箱正常工作时受限命令被阻止的情况。`runnerFailureRules` 用于识别沙箱 runner 在执行命令之前拒绝或失败的情况；消费方应先检查后者，将其作为沙箱基础设施故障上报，而非普通任务失败。

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
   * Structured runner-failure evidence rules. Consumers require a matching
   * fatal stderr line (after informational exclusions) and any rule-specific
   * exit-code gate before checking denial signatures: runner failure means the
   * command never ran, while denial means confinement worked and blocked it.
   */
  runnerFailureRules: readonly RunnerFailureRule[]
}
```

面向运维人员的本地提供方配置键仍为 `runnerFailureSignatures`：运维人员配置的 runner 必须为自身的 pre-exec 拒绝方言提供至少一个非空、单行、不区分大小写的子串。提供方会将这些条目映射到一条规则。消费方直接 spawn `ConfinedArgv.argv`，因此当 Node 提供可归因的 `ENOENT`／`EACCES` 证据时，缺失的 runner、不可执行的 runner，或 shebang 解释器不可用的可执行脚本会在 spawn 通道遭拒，而不是由 stderr 规则判定；进程启动后，126 或 127 等子进程退出码仍按普通结果处理，除非匹配所选 runner 文档所定义的致命签名。

## 提供方与 fail-closed 错误

`ctx.sandbox.confine(argv, policy)` 返回一个 `ConfinedArgv`，或在没有可用后端时抛出 `SandboxUnavailableError`（错误码 `SANDBOX_UNAVAILABLE`）。直接 spawn 所返回的 argv 时，任何拒绝都能证明受限启动从未开始；但只有在调用方拥有的 workdir 经独立验证可用，且 `ENOENT` 或 `EACCES` 带有明确指向提供方 argv[0] 的 Node 来源信息时，该拒绝才具有基础设施含义，并以原始错误作为详细信息。没有精确错误路径的裸 `syscall: 'spawn'`、任何其他错误码、无效或不可用的 workdir、资源失败、无关 syscall 或无结构拒绝仍保留消费方的普通命令启动语义。进程启动后，匹配到的结构化规则标识 runner 拒绝。对于受限策略，静默的无隔离透传永远不合法。

提供方探测在多个候选后端之间仲裁，结果在提供方生命周期内缓存。只有一个候选后端的平台可以直接选定它；执行时拒绝仍保留安全属性。本地提供方将 bwrap 和 Seatbelt 报告为 full，并保留 Landlock 启动器的 full/partial 内核裁定。
