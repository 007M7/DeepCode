# @deepseek-ai/dsh-bash-sandbox

[English](README.md) | 中文

消费 [`@deepseek-ai/dsh-bash`](../bash/) 执行器 seam 的沙箱实现。加载它时，应**用它替代** `@deepseek-ai/dsh-bash-local`，并同时加载 [`ctx.sandbox`](../../sandbox/sandbox/) 提供方（例如 [`@deepseek-ai/dsh-sandbox-local`](../../sandbox/sandbox-local/)）及 [`ctx.sandboxPolicy`](../../sandbox/sandbox-policy/)；后者拥有默认模式 + 工作区根目录，并与受沙箱约束的文件系统共享这些设置。无需使用替代工具插件；`dsh-tool-bash` 会检测执行器的 `sandboxMode` 能力并添加升权字段。

包根目录导出默认与具名的 `SandboxBashExecutor` 插件及其 `Config`；引号处理与结果分类 helper 保留在内部。

每条命令的限制方式都是：把本执行器即将 spawn 的精确 `['bash', '-c', command]` argv 交给提供方，再 spawn 其返回的（已包装）argv。由哪种平台 runner 执行限制，以及是否有 runner 可用（必须快速失败并返回结构化 `SANDBOX_UNAVAILABLE` 错误，绝不能静默无约束运行），属于提供方职责；本包只拥有 bash 侧。

| 模式 | 文件影响 |
|---|---|
| `read-only`（默认） | 任何位置都不可写（在 `/dev` 中只有 `/dev/null` 节点可写，因此 `>/dev/null` 仍可正常工作） |
| `workspace-write` | 只能写入 `workspaceRoot` + `/tmp`（在 bwrap 下为临时目录，在 Landlock 下为宿主 `/tmp`，在 Seatbelt 下为 `/private/tmp` 加每用户临时目录） |
| `danger-full-access` | 不作限制；绝不咨询提供方。前台结果携带 `sandbox: { mode, denied: false }`；后台进程句柄不携带沙箱事实。 |

语义：

- **拒绝是结果事实。** 如果一次失败运行的 stderr 包含所选后端自身的拒绝方言，即提供方在每次包装时加上的特征（bwrap 下的 EROFS 文本、Landlock 下的 EACCES、Seatbelt 下的 EPERM），则结果报告 `BashRunResult.sandbox.denied: true`（从已收集的 stderr 尾部进行保守分类）。每次受限制运行还会携带执行时模式（`result.sandbox.mode`）与提供方强制执行完整性（`result.sandbox.enforcement`：`full`，或在较旧 Landlock ABI 上为 `partial`）。
- **Runner 失败是沙箱失败，绝不是命令失败。** 前台执行会抛出 `SANDBOX_UNAVAILABLE`；已结算的后台进程会标记 `process.sandbox.runnerFailed`，bash 产生方通过通用 `task_output` 渲染它。spawn 失败也会经过结算，因此受限制的后台句柄会保留自身的模式／强制执行事实，并释放每进程计数。
- **部署回退，每次调用策略。** [`ctx.sandboxPolicy`](../../sandbox/sandbox-policy/) 为每次工具调用解析完整的 `SandboxExecutionPolicy`：调用会话提供自身的模式覆盖与不可变 cwd 根目录，部署配置则为无 agent 调用提供回退。已批准的升权只更改该策略的模式，会话根目录仍然附着其上。`resolve()` 把策略带入 spec，因此来自不同项目的重叠命令会在各自的根目录与模式下运行、分类和报告。能力事实 `ctx.bash.sandboxMode` 报告已配置的默认值，因此工具层只在装载该执行器时才公布升权。模型只能通过结果事实了解沙箱：静态 bash 工具描述会解释拒绝标记，系统提示词中不会声明当前模式。
- **只限制文件影响。** 设计上不限制网络与进程可见性：模式词汇不会声称覆盖后端未强制执行的范围。
- 进程机制（spawn、进程组终止、输出收集／spill、后台句柄、凭证清理）继承自 [`dsh-bash-local`](../bash-local/)；runner 选择位于 [`dsh-sandbox-local`](../../sandbox/sandbox-local/)。

seam 上仅拒绝：拒绝是一项已报告事实，本执行器绝不自行协商权限。批准问题位于工具层（`dsh-tool-bash`），由它驱动本包遵守的覆盖。

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: read-only
    workspaceRoot: !!js process.cwd() # fallback for calls without a session cwd
- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'
```

无密钥消费方集成证明是 `tests/bwrap.e2e.ts`、`tests/landlock.e2e.ts` 和 `tests/seatbelt.e2e.ts`（通过 `ctx.bash` 驱动真实提供方 + 真实 runner，在真实世界验证，并在相应 runner 缺失时各自自行跳过）。agent-spine e2e 还会在一个 Cordis 上下文中驱动两个并发会话，并证明每个真实 bash 工具调用只能写入自身项目。可运行 demo 见 [acp-agent 示例的默认组合](../../../examples/acp-agent/)。

## 模型体验

### 间接的 Bash 工具 schema

#### 模型看到的内容

基线是生成的 [`dsh-tool-bash` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-bash)。通过公布一个执行限制的 `sandboxMode`，此后端会为 `bash` 增加 `sandbox_permissions`，其 enum 为 `workspace-write` | `danger-full-access`，并增加 `justification`。后端不添加提示词文本，会话的有效模式仍不会声明。

#### Token 影响

在 `bash` 可见的请求上增加少量固定 schema；模式切换不增加上下文 token。

#### KV Cache 影响

执行器持续公布相同沙箱能力时，前缀保持稳定。更改这些能力会改变 `bash` schema，可能使从该定义起的复用失效；每会话模式切换不会导致失效。

### 间接的 Bash 工具结果

#### 模型看到的内容

在普通有界输出之后，被拒绝的调用会精确追加 `[sandbox: file access denied under <mode> mode]`。当升权可用时，接下来精确追加 `[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`。已结算的后台 runner 失败则追加 `[sandbox: the sandbox runner itself failed under <mode> mode — the command did not run; this is a sandbox problem, not a command failure]`。

#### Token 影响

除普通输出外，正常允许的运行不会增加 token。拒绝或失败会增加上述有条件标记，并保留到压缩。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 配置项失效。

### 间接的 Bash 工具错误

#### 模型看到的内容

如果没有 runner 能强制执行受限模式，前台调用会传播 [`SANDBOX_UNAVAILABLE` 错误；它由 `dsh-sandbox` 持有](../../sandbox/sandbox/README.md#confinement-error-indirectly)。如果 runner 在执行时失败，此后端会提供第一行 stderr 作为详细信息。

#### Token 影响

该次调用可见的是有条件错误文本，并保留在历史记录中直到压缩。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 配置项失效。

## 已知限制与暂缓事项

- **限制只覆盖文件影响**：网络访问与进程可见性不变，因此这些模式不是通用安全沙箱。
- **拒绝从失败命令的 stderr 推断**：后端特征使该推断可跨平台使用，但匹配的应用错误可能被分类为拒绝，也可能遗漏未出现在保留尾部中的拒绝。
- **后台 runner 失败没有即时错误通道**：它记录在已结算进程上，并在调用方使用 `task_output` 读取通用任务时呈现。
- **`danger-full-access` 有意绕过 `ctx.sandbox`**：它是显式无约束模式，不是更宽的沙箱 profile。
