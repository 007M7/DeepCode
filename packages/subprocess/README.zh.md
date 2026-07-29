# subprocess/：子进程能力家族

[English](README.md) | 中文

这里集中提供受管子进程树的 spawn 能力：完整指定的 spawn spec，采用 Node 风格、按流划分的 stdio 处置方式（disposition），包括原始管道、inherit、附带 spill 文件的有界尾部保留收集；harness 中所有 spawn 调用方共用的凭据清除机制；基于偏移量的增量读取；以进程树为范围、带 SIGTERM→宽限期→SIGKILL 升级的信号发送；以及协作式 dispose（资源释放）阶梯。命令默认值补全、shell 语义、时限、协议分帧与呈现留在消费方：[bash 执行器](../bash/README.md)、[LSP 主机](../lsp/README.md)与 [ACP（Agent Client Protocol）subagent 后端](../subagent/README.md)。参见[subprocess seam Agent Note（agent 决策记录）](../../.agents/notes/implemented/architecture/2026-07-26-subprocess-seam.md)。

| 包（package） | ctx 键 | 角色 |
|---|---|---|
| [`subprocess`](subprocess/README.md)（`@deepseek-ai/dsh-subprocess`） | `ctx.subprocess` | seam 本体：抽象的 `SubprocessService.spawn(spec)`、完全显式且带按流划分 stdio 处置方式的 `SubprocessSpawnSpec`、`SubprocessHandle`（流、基于偏移量的读取器、terminate/waitForExit/dispose），以及共享的凭据清除 + `DSH_*`/`CollectedOutput` 词汇 |
| [`subprocess-local`](subprocess-local/README.md)（`@deepseek-ai/dsh-subprocess-local`） | 无 | 本地实现：detached 进程树、按处置方式接线的流、附带有界私有 spill 文件的尾部保留截断、`DSH_*` 合并次序、带升级的进程树信号发送、dispose 阶梯，以及先终止再等待退出的 dispose |

即使消费方重载，进程生命周期仍由服务负责管理；消费方负责定义进程的含义（一条 bash 命令、未来的非 shell 运行器），以及决定塑造该进程的每一项默认值。
