# Bash 执行器

[English](bash.md) | 中文

Bash 执行 seam：典型的[能力 seam](../rfc/implemented/architecture/2026-06-13-capability-seams.md) 示例，拆分为三个包（package）：接口（[dsh-bash](../../packages/bash/bash)，`ctx.bash`）、实现（[dsh-bash-local](../../packages/bash/bash-local)，本地子进程）和消费方（[dsh-tool-bash](../../packages/bash/tool-bash)，`bash`/`bash_output`/`bash_kill` 工具 schema）。Bash 是**一项可选能力**，不属于 agent loop（智能体循环）主干，因此其词汇定义在此处而非 [core.md](core.md)。沙箱化、容器化或远程后端是实现同一接口的兄弟包。

源码：[`packages/bash/bash/src/types.ts`](../../packages/bash/bash/src/types.ts)

## 请求与规格：`resolve()` 拆分

该 seam 将**面向模型/插件的请求**（`workdir`/`timeoutMs` 可选，由配置填充）与**执行器实际执行的完全解析规格**（这些字段为必填）分离。工具层在二者之间调用 `ctx.bash.resolve(request)`。这是本仓库「在包边界处显式优于隐式」规则的具体体现：阅读 `BashExecSpec` 的人永远不会疑惑工作目录从何而来。

```ts type-equiv
interface BashExecRequest {
  command: string
  /** Working directory override (default: implementation-configured). */
  workdir?: string | undefined
  /** Timeout override in milliseconds (implementations cap it). */
  timeoutMs?: number | undefined
  /** Abort signal — implementations kill the command when it fires. */
  signal?: AbortSignal | undefined
  /**
   * Bytes to write to the command's stdin, then close it. Absent leaves stdin
   * closed/empty (the default for model-driven tool calls). Set by in-process
   * plugins (e.g. the hooks bridges, which write a hook command's JSON payload
   * to its stdin); the model-facing bash tool does not expose it as a parameter
   * (a model that needs stdin uses shell syntax like a heredoc or a pipe).
   */
  stdin?: string | undefined
  /**
   * Extra environment entries for the command, merged AFTER the
   * implementation's credential scrub (so an explicit entry here is honored even
   * when its name matches the scrub pattern — the caller named a value it holds,
   * not the harness's ambient secret). Set by in-process plugins (the hooks
   * bridges set `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, …); the model-facing
   * bash tool does not expose it as a parameter (a model that needs an env var
   * uses shell syntax like `FOO=bar cmd`).
   */
  env?: Record<string, string> | undefined
  /**
   * Opaque OWNER token for a background task — the consumer's isolation key
   * (the tool layer passes the owning agent's `session.header.id`). The
   * executor stores it on the task and exposes it via {@link BashExecutor.ownerOf};
   * the executor itself NEVER interprets it (no access policy lives in the
   * seam — that is the consumer's job). Absent for foreground runs and for an
   * ownerless background start (a non-agent caller).
   */
  owner?: OwnerToken | undefined
  /**
   * Explicit per-call sandbox-policy input, overriding the executor's
   * configured default mode for THIS call. Never a silent default: a
   * consumer sets it only from an explicit policy source — an
   * `'allowed-once'` grant a human just issued through `ctx.approval` (the
   * escalation flow in the sandbox RFC § Escalation, which outranks), or the
   * session's standing override folded from its own `bash/sandbox-mode`
   * events (the sandbox RFC § Per-session mode switching — the user's recorded per-session
   * choice). A sandboxing executor confines THIS call under the given mode;
   * a non-sandboxing executor carries the field and confines nothing (the
   * tool layer stamps neither escalation nor overrides without a sandboxing
   * executor — see {@link BashExecutor.sandboxMode}).
   */
  sandboxMode?: SandboxMode | undefined
}
```

```ts type-equiv
interface BashExecSpec {
  command: string
  workdir: string
  timeoutMs: number
  /** Abort signal — implementations kill the command when it fires. */
  signal?: AbortSignal | undefined
  /**
   * Bytes to write to the command's stdin (then close it), carried through
   * verbatim from {@link BashExecRequest.stdin}. OPTIONAL on the resolved spec
   * (unlike `owner`): it has no config default, so a missing one means "no
   * stdin" — the safe, ordinary case — not a silent footgun, so it stays a
   * plain optional rather than required-but-nullable (see the request field).
   */
  stdin?: string | undefined
  /**
   * Extra environment entries, carried through verbatim from
   * {@link BashExecRequest.env} and merged by the implementation AFTER its
   * credential scrub (an explicit entry wins even when its name matches the
   * scrub pattern). OPTIONAL on the spec for the same reason as `stdin` — no
   * config default, absent means "no extra env".
   */
  env?: Record<string, string> | undefined
  /**
   * Opaque owner token, REQUIRED-but-nullable (mirrors `workdir`/`timeoutMs`
   * being required on the resolved spec): {@link BashExecutor.resolve} carries
   * the request's `owner` through, defaulting a missing one to `undefined`. A
   * required field makes a forgotten owner a VISIBLE `undefined` rather than a
   * silently-absent property that yields an unowned (cross-session-readable)
   * task. `start()` stores it; `run()` (foreground) ignores it.
   */
  owner: OwnerToken | undefined
  /**
   * The sandbox mode this call executes under, REQUIRED-but-nullable for the
   * same visibility reason as `owner`. A sandboxing executor's `resolve()`
   * stamps the effective mode (the request's explicit override, else its
   * configured default) so `run()`/`start()` read the spec, never the config;
   * a non-sandboxing executor carries the request value through verbatim and
   * ignores it (`undefined` under such an executor means what its README says:
   * unconfined execution).
   */
  sandboxMode: SandboxMode | undefined
}
```

`owner` token 是隔离键：执行器存储它但从不解释它（访问策略是消费方的职责），因此一个 agent 启动的后台任务不会被跨会话读取。必填但可空的字段使遗忘的 owner 成为一个可见的 `undefined`，而非一个静默无主的任务。

受信的进程内插件使用 `stdin` 和 `env` 传递钩子载荷与钩子专用变量。面向模型的 bash 工具从其命名的 schema 字段构造请求，不暴露这两个输入，因为 shell 语法本身已提供等价能力；测试防止未来出现 `...args` 展开。这是请求形状的纪律约束，而非安全边界：`dsh-bash-local` 无论这些字段如何都会清洗环境凭证，然后叠加调用方已持有的显式值。见 [bash stdin/env RFC](../rfc/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md)。

该 seam 处理的两个 id 都是[品牌化的](core.md)（零成本 `string` 品牌，与 `SessionId`/`AgentId` 相同的机制）：`BashTaskId`（被跟踪的后台任务，由本地执行器生成 `bash-N`）和 `OwnerToken`（不透明的隔离键）。`OwnerToken` 刻意是一个与 `SessionId` **不同**的品牌，而非别名：bash seam 是一个能力 seam，不得知道 owner token *意味着*什么，因此它从不导入 `dsh-session` 的词汇。`dsh-tool-bash` 消费方是唯一将拥有者 agent 的 `SessionId` 转换为 `OwnerToken` 的边界。对两者施加品牌化，可以防止裸 `string`（或在需要 `OwnerToken` 的地方传入 `BashTaskId`，反之亦然）在面向模型的 `task_id` 路径上通过类型检查。

## 前台运行：`BashRunResult`

一次已完成（或被终止）的前台运行的结果。正交的结果**独立报告**：一个进程可以同时超时并以退出码 0 退出（因为它捕获了信号），因此 `timedOut`、`aborted`、`signal` 和 `exitCode` 各自独立为一个字段；调用方永远不会把一次被截断的运行误读为干净的成功。

```ts type-equiv
interface BashRunResult {
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
  /**
   * Sandbox facts, present iff a sandboxing executor ran the command — an
   * unsandboxed executor (e.g. `dsh-bash-local`) never sets it. See
   * {@link BashSandboxInfo} for the `denied` classification semantics.
   */
  sandbox?: BashSandboxInfo
}
```

每个流是一个 `CollectedOutput`：（可能被截断的）文本加恢复信息。截断时，`text` 是**尾部**，完整流溢出到一个私有文件：

```ts type-equiv
interface CollectedOutput {
  /** Collected text — the TAIL of the stream when truncated. */
  text: string
  /** True when bytes were dropped from `text`. */
  truncated: boolean
  /** Path to a file holding the COMPLETE stream, when truncated and available. */
  spillPath?: string
}
```

## 文件沙箱：`BashSandboxInfo`

消费沙箱的执行器（`dsh-bash-sandbox`）通过 `BashExecutor.sandboxMode` 暴露其配置的回退模式。工具层折叠每个 agent 会话的持久 `bash/sandbox-mode` 覆盖，将生效模式印到请求上，并可为一次用户批准的严格更宽调用替换它。它刻意既不声明当前模式也不叙述切换过程；拒绝结果会指明该命令实际运行时所处的模式。模式/执行词汇由 [`@deepseek-ai/dsh-sandbox` seam](sandbox.md) 拥有并编目，其提供方包装执行器的 argv；模式仅管控文件效果，不涉及网络或进程可见性。

沙箱化运行始终在 `BashRunResult.sandbox` 上报告其执行时的事实：`denied` 是执行器对失败的保守分类——判定为沙箱导致（退出失败且 stderr 携带文件系统权限特征——从不是干净退出或信号终止），从收集到的 stderr 尾部读取；`enforcement` 报告所选后端对该模式文件效果的管控完整程度（`SandboxEnforcement = 'full' | 'partial'`：`partial` 表示较旧的 Landlock ABI 仅管控所请求访问的子集；`danger-full-access` 下不存在此字段，因为没有任何限制）；`runnerFailed` 标记与拒绝相反的情况——沙箱运行器本身失败、命令从未执行（仅在已结算的后台任务上标记；前台运行通过抛出 `SANDBOX_UNAVAILABLE` 错误暴露同一状况）：

```ts type-equiv
interface BashSandboxInfo {
  /** The mode the command actually ran under. */
  mode: SandboxMode
  /**
   * True when the executor classifies this run's failure as the sandbox
   * denying a file operation. The classification is CONSERVATIVE (a failed
   * exit whose stderr carries a filesystem-permission signature) and reads
   * the COLLECTED stderr — the bounded in-memory tail per
   * {@link CollectedOutput} semantics, so a signature that survives only in a
   * spill file is missed toward `denied: false`. A plain command failure
   * keeps `denied: false` even under a sandboxed mode.
   */
  denied: boolean
  /**
   * How completely the runner enforced `mode`'s file effects — see
   * {@link SandboxEnforcement}. Absent exactly when `mode` is
   * `danger-full-access`: nothing is confined, so there is no enforcement to
   * report.
   */
  enforcement?: SandboxEnforcement
  /**
   * True when the executor classifies this failure as the SANDBOX RUNNER
   * itself failing (missing binary, refused profile, fail-closed refusal
   * before exec) — the command NEVER RAN; this is a sandbox failure, not a
   * task failure, and it outranks `denied` (a runner's own error text can
   * contain denial words). Only ever stamped on settled BACKGROUND tasks: a
   * foreground run surfaces the same condition as the thrown
   * `SANDBOX_UNAVAILABLE` error instead (the foreground path has an error
   * channel; a settled task's facts are its only channel).
   */
  runnerFailed?: boolean
}
```

还有一个词汇完成整幅图景：`SANDBOX_UNAVAILABLE` 错误码（由 [sandbox seam](sandbox.md) 拥有）是 `ctx.sandbox` 提供方在受限模式没有可用后端时抛出的错误，执行器将其传播。所选运行器拒绝其 profile 时也触发同一快速失败的前台错误；已结算的后台任务则记录 `runnerFailed`。模型在结果中接收拒绝/运行器事实，仅在拒绝标记指明模式时才获知生效模式，并可通过 `sandbox_permissions` 加 `justification` 请求一次严格更宽的重试；`ctx.approval` 必须在任何执行之前批准该确切调用。完整的策略与切换设计见 [sandbox RFC](../rfc/implemented/feature/2026-07-06-sandbox.md)。

## 后台任务：`BashTask`

通过 `start()` 启动的长时间运行命令被跟踪为 `BashTask`。`BashTaskStatus` 为 `'running' | 'completed' | 'killed'`；`done` 在底层进程关闭时 resolve，从不 reject。沙箱化执行器在任务结算后标记 `sandbox`（分类针对已结算任务收集到的 stderr 运行），因此该字段在运行中以及非沙箱化执行器下不存在。

```ts type-equiv
interface BashTask {
  readonly id: BashTaskId
  status: BashTaskStatus
  /** Exit code once finished (null = killed by signal / still running). */
  exitCode: number | null
  /** Terminating signal name, when signal-killed. */
  signal: NodeJS.Signals | null
  /** Resolves when the underlying process closes (never rejects). */
  readonly done: Promise<void>
  /**
   * Sandbox facts for this task's execution, stamped by a sandboxing executor
   * once the task settles and BEFORE completion listeners are notified — an
   * `onTaskDone` consumer and a `done` awaiter both see it. Denial
   * classification runs against the settled task's collected stderr, so the
   * field cannot exist earlier: absent while the task is running and under an
   * executor that does not sandbox. See {@link BashSandboxInfo} for the
   * `denied` semantics.
   */
  sandbox?: BashSandboxInfo
}
```

`readOutput()` 返回增量的 `BashTaskRead`：自上次读取以来产生的输出，附带一个 `lossy` 标志指示截断是否丢弃了未读字节：

```ts type-equiv
interface BashTaskRead {
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
```

## 服务

`BashExecutor`（`ctx.bash`，抽象——定义于 [`packages/bash/bash/src/index.ts`](../../packages/bash/bash/src/index.ts)）遵循 `LlmService`/`LlmAdapter` 的拆分模式：`resolve`（请求→规格）、`run`（前台）、`start`（后台）、`get`/`ownerOf`/`list`/`readOutput`/`kill`，以及 `onTaskDone`（`BashTaskListener` 完成回调）。spawn 的命令获得一个**清洗后的 env**（丢弃 `*KEY*`/`*SECRET*`/`*TOKEN*`），溢出文件使用一个权限为 0700 的私有目录（随机文件名、仅所有者可打开）。模型输出永远不会获得环境变量或可预测路径。提供这一切的实现是 `dsh-bash-local`；调用它的面向模型的 `bash`/`bash_output`/`bash_kill` schema 位于 `dsh-tool-bash`（并通过[工具展示词汇](tools.md#tool-presentation-ui-vocabulary)作为终端呈现）。
