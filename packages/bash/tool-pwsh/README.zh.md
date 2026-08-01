# @deepseek-ai/dsh-tool-pwsh

[English](README.md) | 中文

面向模型的 `pwsh` 工具，注册在 `ctx.bash` 执行器 seam 之上。面向由 PowerShell 执行器（如 `@deepseek-ai/dsh-pwsh-local`）支撑 `ctx.bash` 的 Windows 组合；工具契约是 PowerShell 方言：原生 `C:\...` 路径与 `$env:NAME` 变量。刻意保持最小——无后台任务、无沙箱升级、无持久 shell：在完整 bash 工具功能集获得 PowerShell 孪生之前，这就是 "works on my Windows machine" 画像。

需要一个已加载的执行器实现；插件在 `ctx.bash` 存在之前保持 pending（`inject: ['tools', 'bash', 'systemPrompt']`）。

包根只暴露 Cordis 插件契约（`name`、`inject`、`Config`、`apply`）以及纯函数 `renderPwshOutput` 及其结果类型；执行与呈现是同一包测试覆盖的实现细节。

该插件还贡献 `tool:pwsh` 提示词段（order 105）：检查每个结果上的 `[exit code: N]` 标记，并在继续前调查失败。

## 工具

### `pwsh`

| 参数 | 类型 | 说明 |
|---|---|---|
| `command` | string（必填） | 通过 `pwsh -Command` 运行。调用之间不保留状态——用 `workdir`，不要用 `cd`。 |
| `description` | string（必填） | 命令的一句话主动语态摘要（5-10 词），仅用于 UI/日志展示——不影响执行。 |
| `timeoutMs` | number | 毫秒级超时覆盖。执行器应用其配置的默认值与上限。 |
| `workdir` | string | 本次调用的工作目录。默认取调用 agent（智能体）的会话 cwd（`session.header.cwd`），使每个会话在自己的工作区运行；相对 `workdir` 基于同一身份解析。 |

`command`、`workdir` 与 `timeoutMs` 在执行前经 `ctx.bash.resolve()` 按执行器配置默认值解析。workdir 默认值在工具层取自调用 agent 的 `session.header.cwd`，先于 `resolve()` 应用——每个会话的 cwd 必须来自 `exec.agent`，因为 N 个会话共享一个执行器；只有没有会话 cwd 时，执行器才回退到自己的配置 / `process.cwd()`。

### 受管 shell 环境

每次调用都会收到一份新收集的受信 `DSH_*` 环境。`DSH_HOME` 是由 [`@deepseek-ai/dsh-paths`](../../util/paths/README.md) 解析的 Harness 绝对主目录（`dshHome` 配置，其次环境变量 `$DSH_HOME`，再其次 `~/.dsh`），`DSH_SHELL=1` 标识受管子进程。agent 调用额外收到 `DSH_SESSION_ID=agent.session.header.id`。该快照经由专用 `BashExecRequest.dshEnv` 通道传递；`process.env` 永不被修改。

结果文本包含 stdout、可选的 `[stderr]` 分段，以及适用的超时、信号与退出码标记：`[timed out after <timeoutMs>ms]`、`[killed by signal: <signal>]` 与 `[exit code: N]`，仅在累积文本缺少换行时才补一个分隔换行。非零退出仍是模型自行解读的结果，而不是 `isError`。只有基础设施失败——spawn 错误与中止（`tool call aborted`）——才产生 `isError`。

规范成功值为已完成前台进程的 `{ kind: 'foreground', ...BashRunResult }`。程序化消费方使用类型化字段，而不解析渲染文本。

## UI 呈现

工具拥有自己的 `presentCall`/`presentResult` 渲染意图。调用是携带命令、描述与可选 cwd 的 `terminal` 卡片；完成结果是 `generic` 卡片，渲染输出放在 `console` 围栏内。这些 presenter 是纯函数且可重放。

## 模型体验

### 系统提示词

#### 模型看到的内容

该插件注册作用域内的每个请求都包含下方 pwsh 指导。作用域工具限制可以隐藏 schema，而不移除这个独立注册的提示词段。

##### Pwsh 指导

```markdown
Check the [exit code: N] marker on every pwsh result; investigate failures before moving on.
```

#### Token 影响

插件激活期间每个请求有少量固定输入成本。

#### KV Cache 影响

注册作用域与提示词文本不变时前缀稳定。插件激活或销毁可能使该提示词段的复用失效。

### 工具 schema

#### 模型看到的内容

模型看到生成的 [`pwsh` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-pwsh)。agent 作用域的工具限制可以为该 agent 移除定义。

#### Token 影响

工具可见时每个请求有固定的 schema 成本。

#### KV Cache 影响

可见性与工具定义不变时前缀稳定。限制或配置变更可能从第一个改变的 token 起使复用失效。

### 前台结果

#### 模型看到的内容

渲染器输出依赖数据的 stdout 尾部，然后是可选 `[stderr]` 与 stderr 尾部。条件行恰为 `[timed out after <timeoutMs>ms]`、`[killed by signal: <signal>]` 与 `[exit code: <exitCode>]`。

#### Token 影响

调用前零结果 token。输出按流有界，每条已发出行在压缩前保留在历史中。

#### KV Cache 影响

只追加；新可见内容跟在可复用请求前缀之后，不会使既有 KV-cache 条目失效。

### 工具错误

#### 模型看到的内容

校验与基础设施失败被规范化为 `Error: <message>`。本包的稳定消息为 `invalid command: expected a non-empty string`、`invalid description: expected a non-empty string`、`invalid timeoutMs: expected a positive number, got <value>` 与 `tool call aborted`。

#### Token 影响

只有失败的调用会增加这些保留 token；中止的调用不增加命令输出。

#### KV Cache 影响

只追加；新可见内容跟在可复用请求前缀之后，不会使既有 KV-cache 条目失效。

## 已知局限与延期工作

- **仅前台**——没有 `run_in_background`；长时间运行的工作必须留在执行器超时之内，或等待 bash 工具孪生。
- **无沙箱升级**——没有 `sandbox_permissions`/`justification`；受约束的组合通过执行器拒绝，升级等待完整孪生。
- **PowerShell 方言契约**——模型必须写 PowerShell（原生路径、`$env:` 变量），而不是 bash；没有方言翻译。
- **Windows 默认路线图延期**——让 Windows 主机默认用 `pwsh` 而非 `bash`，以及 pwsh TUI/GUI 渲染支持，都另行规划，刻意不纳入本包。
