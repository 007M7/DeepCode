# session-persistence/：持久化能力家族

[English](README.md) | 中文

持久会话的持久化 seam 及其存储后端。接口包（package）负责抽象 `SessionPersistence` 服务和共享写入协调器；后端是注册到 `ctx.sessionPersistence` 的具体实现。全部都是**产品**包。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `session-persistence/` | 持久化 seam + 共享写入协调器 | `ctx.sessionPersistence` |
| `session-checkpoint-policy/` | agent（智能体）请求和工具执行的语义持久性屏障 | （包装 `ctx.llm` / `ctx.tools`，监听 agent 事件） |
| `session-persistence-jsonl/` | JSONL 伴随文件持久化后端 | （注册到 `ctx.sessionPersistence`） |
| `session-persistence-sqlite/` | SQLite 持久化后端 | （注册到 `ctx.sessionPersistence`） |

接口位于 `session-persistence/session-persistence/`；后端是同级包。新存储后端归入此处，并注册到 `ctx.sessionPersistence`。详见[会话持久化](../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md)。
