# plan/：plan 协作状态

[English](README.md) | 中文

Plan mode 是一种按 agent（智能体）分开记录到日志的协作状态。它是单一**产品**包，而非通用模式注册表或能力 seam 三包组合。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `plan-mode/` | `plan/mode` 词汇与折叠、在边界生效的状态、`plan:policy` 引导段、`/plan [message]` 进入命令与 `/plan off` 退出命令，以及面向模型的 `exit_plan_mode` 评审工具 | `ctx.planMode` |

活跃状态是会话日志的纯函数，因此恢复和 fork 无需额外机制即可还原该状态。部署通过 Cordis 配置提供 plan 引导内容，而 `exit_plan_mode` 在 Plan mode 未激活时仍保持注册，以稳定请求工具目录。交互式适配器使用插件拥有的 `/plan` 命令；沙箱模式和审批策略仍是独立的强制执行设置。设计详见 [plan 专用协作状态](../../.agents/notes/implemented/simplification/2026-07-22-plan-specific-collaboration-state.md)。
