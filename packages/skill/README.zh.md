# skill/ - skill（技能）能力家族

[English](README.md) | 中文

可复用 agent（智能体）指令的规范能力 seam 由三个包（package）组成：提供方注册表、本地实现，以及面向模型的目录／loader 消费方。全部均为**产品**包。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `skill/` | 提供方注册表、优先级解析、完整/不完整目录快照和完整定义查找 | `ctx.skills` |
| `skill-local/` | 带目录成员关系监视的项目/自定义/用户文件系统提供方 | （注册到 `ctx.skills`） |
| `tool-skill/` | 初始目录和替换目录，以及面向模型的 `skill` loader | （注册到 `ctx.tools`） |

接口位于 `skill/skill/`。提供方同步注册，并通过 `ctx.skills` 执行异步发现；`tool-skill` 只消费该接口，因此嵌入式或远程提供方可替换或补充 `skill-local`，无需改变面向模型的契约。`agent-core` 默认加载该家族，但它仍然是核心控制主干之外的能力，与 [`bash/`](../bash/README.md)、[`fs/`](../fs/README.md)、[`web/`](../web/README.md) 和 [`subagent/`](../subagent/README.md) 并列。
