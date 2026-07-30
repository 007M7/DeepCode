# pty/：持久 PTY 能力家族

[English](README.md) | 中文

`PTY` 的全称是 **Pseudo-Terminal**（伪终端）。这项能力提供持久且限定所有者范围的终端会话，适用于需要跨工具调用保留状态或使用交互式 stdin 的工作流。PTY 是单次 bash 与文件系统工具的补充，不会取代后两者更严格的逐操作契约。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`pty`](pty/README.md)（`@deepseek-ai/dsh-pty`） | 后端注册表、品牌化 id、精确到 agent（智能体）的所有权、会话操作与等待清理完成的机制 | `ctx.pty` |
| `pty-local`（`@deepseek-ai/dsh-pty-local`） | 本地 `node-pty` 后端、就绪检测、有界终端状态、沙箱与进程会话监管 | 注册到 `ctx.pty` |
| `tool-pty`（`@deepseek-ai/dsh-tool-pty`） | 6 个面向模型的工具，以及用于后台发送的通用任务集成 | 注册到 `ctx.tools` |
| `tool-bash-persistent`（`@deepseek-ai/dsh-tool-bash-persistent`） | 一个由所有者隔离可复用 PTY shell 支撑的模型可见 `bash` | 消费 `ctx.pty`，注册到 `ctx.tools` |

设计与暂缓边界记录在[持久 PTY Agent Note（agent 决策记录）](../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.md) 中。
