# subagent/：subagent 能力族

[English](README.md) | 中文

subagent seam 允许 agent（智能体）把工作委派给子 agent。与 [bash](../bash/README.md) 和 [llm](../llm/README.md) 能力族一样，这也是一种能力 seam（见[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)），但有一个关键差异：**多个提供方实现在同一上下文中共存，并按名称注册**，而不是采用 bash 的单实现形态。该注册表仿照 LLM（大语言模型）适配器注册表。

| 包 | 角色 | ctx 键 |
|---|---|---|
| `subagent/` | 抽象 subagent seam：具名提供方注册表与词汇 | `ctx.subagents` |
| `subagent-inprocess/` | 共享进程内运行驱动器（不提供提供方；每次运行使用一个清理 effect） | 无 |
| `subagent-spawn/` | 进程内后端：全新的子 agent | （注册到 `ctx.subagents`） |
| `subagent-fork/` | 进程内后端：以父 agent 已完成轮次的前缀作为初始内容的子 agent | （注册到 `ctx.subagents`） |
| `subagent-subprocess/` | 共享进程外机制：环境变量清理、dispose（资源释放）阶梯、隔离配置目录（纯库；不注册任何内容） | 无 |
| `subagent-acp/` | 进程外后端：在派生子进程中运行并通过 ACP（Agent Client Protocol）驱动的子 agent | （注册到 `ctx.subagents`） |
| `tool-subagent/` | 面向模型的 `subagent` 委派工具，基于 `ctx.subagents` | （注册到 `ctx.tools`） |

接口位于 `subagent/subagent/`。进程内 `subagent-spawn` / `subagent-fork` 后端共享 `subagent-inprocess` 驱动器（一个自身不提供提供方的库：两者都依赖它，彼此不依赖），进程外 `subagent-acp` 后端则构建于 `subagent-subprocess` 库之上（凭据环境变量清理、dispose 阶梯、隔离配置目录）。测试只用包内 fixture（测试前置数据）替换子 agent 边界。

提案与设计理由见 [.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md)。
