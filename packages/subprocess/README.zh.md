# subprocess/：进程管理能力家族

[English](README.md) | 中文

同一执行世界中的共享进程基底：规范化 cwd／运行时存储、可执行文件查找、采用原始或收集式 stdio 的完全显式受管子进程树，以及一项负责 PTY 分配、前台进程组和完整会话清理的深层终端进程原语。命令默认值补全、shell 语义、deadline、协议分帧、就绪检测与呈现留在消费方：[bash 执行器](../bash/README.md)、[LSP 主机](../lsp/README.md)、[PTY shell 后端](../pty/README.md)、[基于进程管理的 Code Runtime](../code-runtime/code-runtime-subprocess/README.md)与 [ACP（Agent Client Protocol）subagent 后端](../subagent/README.md)。参见[进程管理器 seam Agent Note（agent 决策记录）](../../.agents/notes/implemented/architecture/2026-07-26-subprocess-seam.md)。

| 包（package） | ctx 键 | 角色 |
|---|---|---|
| [`subprocess`](subprocess/README.md)（`@deepseek-ai/dsh-subprocess`） | `ctx.subprocess` | seam 本体：执行世界坐标与可执行文件查找、普通受管 spawn、终端进程原语、句柄生命周期，以及共享的环境／输出词汇 |
| [`subprocess-local`](subprocess-local/README.md)（`@deepseek-ai/dsh-subprocess-local`） | 无 | 本地实现：detached 进程树、有界收集／spill、`node-pty`、前台／会话检查、进程树信号发送、运行时存储，以及先终止再等待退出的资源释放 |

服务拥有跨消费方重载的进程存续期；消费方拥有一个进程的含义（一条 bash 命令、未来的非 shell 运行器）以及塑造它的每一项默认值。
