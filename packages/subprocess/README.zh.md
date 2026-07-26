# subprocess/：进程管理能力家族

[English](README.md) | 中文

spawn 受管子进程组的共用归属位置：完全显式的 spawn spec、附带 spill 文件的有界尾部保留输出、经凭据清除的环境、基于偏移量的增量读取，以及 SIGTERM→宽限期→SIGKILL 的进程组终止。命令默认值补全、shell 语义、deadline 与呈现留在消费方：[bash 执行器家族](../bash/README.md)是第一个消费方，也拥有上述各项。参见[进程管理器 seam Agent Note（agent 决策记录）](../../.agents/notes/implemented/architecture/2026-07-26-subprocess-seam.md)。

| 包（package） | ctx 键 | 角色 |
|---|---|---|
| [`subprocess`](subprocess/README.md)（`@deepseek-ai/dsh-subprocess`） | `ctx.subprocess` | seam 本体：抽象的 `SubprocessService.spawn(spec)`、完全显式的 `SubprocessSpawnSpec`、携带基于偏移量读取器的 `SubprocessHandle`，以及共享的 `DSH_*` 受管环境与 `CollectedOutput` 词汇 |
| [`subprocess-local`](subprocess-local/README.md)（`@deepseek-ai/dsh-subprocess-local`） | 无 | 本地实现：detached 进程组、附带有界私有 spill 文件的尾部保留截断、凭据清除与 `DSH_*` 合并次序、kill 升级，以及先终止再等待退出的 dispose（资源释放） |

服务拥有跨消费方重载的进程存续期；消费方拥有一个进程的含义（一条 bash 命令、未来的非 shell 运行器）以及塑造它的每一项默认值。
