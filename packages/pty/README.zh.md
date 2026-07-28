# pty/：持久 PTY 能力家族

[English](README.md) | 中文

`PTY` 的全称是 **Pseudo-Terminal（伪终端）**。这项能力提供持久且限定所有者范围的终端会话，适用于需要跨工具调用保留状态或使用交互式 stdin 的工作流。PTY 是单次 bash 与文件系统工具的补充，不会取代后两者更严格的逐操作契约。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`pty`](pty/README.md)（`@deepseek-ai/dsh-pty`） | 后端注册表、品牌化 id、精确的 Agent 所有权、会话操作与等待完成的清理 | `ctx.pty` |
| [`pty-local`](pty-local/README.md)（`@deepseek-ai/dsh-pty-local`） | 本地 `node-pty` 后端、就绪检测、有界终端状态、沙箱与进程会话监管 | 注册到 `ctx.pty` |
| [`e2b/pty-e2b`](../e2b/pty-e2b/README.md)（`@deepseek-ai/dsh-pty-e2b`） | E2B 字节 PTY 后端、远程前台信号传递、有界终端状态与等待完成的远程清理 | 注册到 `ctx.pty` |
| `tool-pty`（`@deepseek-ai/dsh-tool-pty`） | 6 个面向模型的工具，并为后台发送集成通用任务 | 注册到 `ctx.tools` |

核心设计记录在[持久 PTY Agent Note](../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.md) 中；远程所有权边界记录在 [共享 E2B 运行时 Agent Note](../../.agents/notes/implemented/feature/2026-07-27-e2b-remote-runtime-poc.md) 中。
