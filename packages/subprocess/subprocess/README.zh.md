# @deepseek-ai/dsh-subprocess

[English](README.md) | 中文

进程管理器 seam（`ctx.subprocess`）。抽象的 `SubprocessService` 只暴露一个方法：`spawn(spec): SubprocessHandle`，外加所有消费方共享的词汇：完全显式的 `SubprocessSpawnSpec`、携带基于偏移量的非消费式输出读取器的 `SubprocessHandle`、`SubprocessOutcome`、`CollectedOutput`，以及受管的 `DSH_*` 环境命名空间（`DSH_ENV_PREFIX`、`DshEnvironment`）。本地实现位于 [`dsh-subprocess-local`](../subprocess-local/README.md)。

## 契约

- `spawn(spec)` 立即返回一个实时句柄；`done` 在进程关闭时以退出事实 resolve（`SubprocessOutcome` 不携带输出，也不携带原因分类），仅在 spawn 层面失败时 reject。
- spec 完全显式（argv、cwd、按流划分的 stdio 处置方式（disposition）、宽限期），因为随部署变化的默认值属于调用方 seam 的配置，而不属于某个隐藏的进程管理器默认值（`dsh-bash` 的 request/spec 拆分是这条规则的所属模板）。`argv` 绝不经过 shell 解释；需要 shell 的消费方自行传入 `['bash', '-c', command]`。
- stdio 按流采用 Node 形状：`'pipe'` 把原始流交给调用方做自己的协议分帧（LSP 的 JSON-RPC、ACP（Agent Client Protocol）的 ndjson），`'inherit'` 直通父进程描述符以承载诊断输出，收集模式（collect）`{ maxBytes, spill? }` 则缓冲一段有界尾部，外加可选的完整流 spill 文件。收集模式的读取器接受全流字节偏移量且从不消费，因此独立的读取器不会抢走彼此的增量；偏移量滑出内存尾部窗口的读取标记为 `lossy`，并在 spill 文件存在时指向它。收集到的输出在结算后仍可读取。
- 终止在每个平台上都以进程树为范围（POSIX 用 detached 进程组并以直接子进程回退；Windows 用 `taskkill /T`）：`kill(signal)` 以 Node 风格只发送一个信号，结算后为空操作；`terminate()`（以及 spec 的 abort 信号）执行 SIGTERM→宽限期→SIGKILL 升级；`waitForExit()` 观察整棵进程树；`dispose(graces)` 运行进程外子进程所需的协作式 stdin EOF→SIGTERM→SIGKILL 阶梯。管理器只响应中止，但绝不判定原因（deadline 与原因分类归调用方所有）。
- `scrubbedParentEnv()` / `SENSITIVE_ENV_PATTERN` 是唯一一份共享的凭据清除定义：环境中形似凭据的名称与 `DSH_*` 名称都会被丢弃，显式 `env` 在清除之后合并（有意转发的键会保留下来），`dshEnv` 则经由自身带校验的通道携带当前 harness 事实；`splitEnvChannels()` 把消费方配置中单一的混合 env 映射按这两条通道切分（lsp-local 的服务器配置与 ACP 后端只暴露一个映射，而配置的 `DSH_*` 事实必须走受管通道，普通通道会拒绝它）。无法把 spawn 路由到该服务的调用点（node-pty 后端、由 SDK 管理的传输层）改为导入凭据清除函数。
- 服务自身的 dispose（资源释放）会终止所有仍在运行的受管进程并等待其退出。

参见[进程管理器数据结构目录](../../../docs/core-data-structures/subprocess.md)与 [seam Agent Note（agent 决策记录）](../../../.agents/notes/implemented/architecture/2026-07-26-subprocess-seam.md)。

## 模型体验

通过消费方 seam 间接影响（目前是 `dsh-tool-bash` 背后的 bash 执行器家族）；进程输出与生命周期面向模型的全部渲染归消费方所有。

#### KV Cache 影响

不会直接失效；请求前缀变更由具名消费方负责。

## 已知限制与暂缓事项

- **node-pty 与由 SDK 管理的 spawn 只共享凭据清除**：PTY 后端的终端 fork 与 MCP SDK 自己的 stdio 传输层无法把 spawn 路由到这道 seam（fork/spawn 调用归库所有）；它们改为导入 `scrubbedParentEnv`，使环境策略保持单一来源。
- **dispose 阶梯假定子进程配合 stdin EOF**：依赖其他信号（SIGHUP 惯例、控制 socket）才能完全停稳的子进程，需要自己的第一阶，通用阶梯才适用。
