# context/：请求上下文扩展

[English](README.md) | 中文

这些产品插件无需定义工具，即可增加模型可见的请求上下文。`workspace-context` 包含在默认的 `dsh-agent-spine-demo` 组合包中，且可通过组合包配置将其禁用；`time-context` 与 `tmux-context` 均需显式启用，标准 TUI 组合包则会显式组合 `session-reference`。

| 包 | 职责 | ctx key |
|---|---|---|
| [`session-reference/`](session-reference/README.md) | 其他会话的有界快照 | `ctx.sessionReferences` |
| [`time-context/`](time-context/README.md) | 当前时间与已用时上下文 | — |
| [`tmux-context/`](tmux-context/README.md) | tmux 位置上下文 | — |
| [`workspace-context/`](workspace-context/README.md) | 工作区指令上下文 | — |

[`workspace-context` 决策记录](../../.agents/notes/implemented/feature/2026-06-24-workspace-context.md)解释了每个 agent（智能体）和会话各自隔离的方式，以及相应的生命周期拆分。
