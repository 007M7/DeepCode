# subagent/：subagent 能力家族

[English](README.md) | 中文

subagent（子 agent）seam 允许 agent（智能体）把工作委派给子 agent。与 [bash](../bash/README.md) 和 [llm](../llm/README.md) 能力家族一样，这也是一种能力 seam（见[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)），但有一个关键差异：**多个提供方实现在同一上下文中共存，并按名称注册**，而不是采用 bash 的单实现形态。该注册表仿照大语言模型（LLM）适配器注册表。

| 包（package） | 角色 | ctx 键 |
|---|---|---|
| `subagent/` | Subagent 服务：具名提供方注册表、词汇、持久化描述符与可选的由 Task 支撑的继续执行编排 | `ctx.subagents` |
| `subagent-inprocess/` | 共享进程内运行驱动器（不含提供方；每次运行使用一个清理 effect） | 无 |
| `subagent-spawn/` | 进程内后端：支持冷恢复的全新子 agent | （注册到 `ctx.subagents`） |
| `subagent-fork/` | 进程内后端：以父 agent 已完成轮次的前缀作为初始内容、支持冷恢复的子 agent | （注册到 `ctx.subagents`） |
| `subagent-acp/` | 进程外后端：在 spawn 的子进程中运行并通过 ACP（Agent Client Protocol）驱动的一次性子 agent | （注册到 `ctx.subagents`） |
| `subagent-dsh-sdk/` | 进程外后端：在 spawn 的子进程中运行的子 harness 运行时，经 TypeScript SDK 客户端走 stdio JSON-RPC 驱动 | （注册到 `ctx.subagents`） |
| `tool-subagent/` | 面向模型的 `subagent` 委派工具，基于 `ctx.subagents` | （注册到 `ctx.tools`） |
| `tool-subagent-control/` | 基于 `ctx.subagents`、可选且全局名称唯一的 `send_message` 后续消息工具 | （注册到 `ctx.tools`） |

接口和继续执行编排位于 `subagent/subagent/`。原始 `start` / `resume` 分发仍与 Task 和持久化无关；只有在 Task 与 Agent 服务存在时，内部管理器才会把持久化子会话绑定到可 dispose、由 Task 支撑的 activation，并且只在继续执行操作运行时解析持久化服务。进程内 `subagent-spawn` / `subagent-fork` 后端共享 `subagent-inprocess` 驱动器（一个自身不含提供方的库：两者都依赖它，彼此不依赖），进程外 `subagent-acp` / `subagent-dsh-sdk` 后端则经由 [`subprocess/`](../subprocess/README.md) seam spawn 其子进程（共享的凭据清除、以进程树为范围的拆卸、dispose（资源释放）阶梯）。测试只用包内 fixture（测试前置数据）替换子 agent 边界。

设计理由见 [.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md)、[.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.md](../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.md) 和 [.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.md](../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.md)。
