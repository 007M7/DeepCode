# core/：产品 API 主干

[English](README.md) | 中文

会话日志、系统提示词组装、工具注册表、agent（智能体）词汇，以及构成 harness 默认控制主干的具体循环。这些是 **产品** 包（package），插件和消费方以其稳定接口为基础构建。

| 包 | 角色 | ctx 键 |
|---|---|---|
| `scope/` | 带作用域的上下文注册原语（作用域标签、按作用域筛选的分发） | （库，没有 ctx 键） |
| `session/` | 事件溯源会话日志与内存存储 | `ctx.sessions` |
| `system-prompt/` | 提示词段与工具 schema 组装注册表 | `ctx.systemPrompt` |
| `tools/` | 带作用域的工具注册表，以及前置策略、守卫、环绕分发、后置策略与最终结果观测 | `ctx.tools` |
| `agent/` | Agent 接口、实时注册表、进程本地发起方作用域、`agent/*` 事件词汇 | `ctx.agents` |
| `agent-loop/` | 实现公开 `Agent` 契约并拥有循环驱动器的具体插件 | `ctx.agentLoop` |

`scope/` 是此处唯一的非服务包：它是不含依赖的库（`createScope`/`scopeOf`/`scopeTarget`），注册表和循环基于它实现按 agent 分域。它在模块图中位于 `session/` 和 `system-prompt/` 之下，正是为了让二者可以消费它而不形成环。

`agent-loop` 是 `agent` seam 的唯一具体实现，位于此处是因为它就是 harness 的默认产品循环。它在 `ctx.agents.withInitiator()` 中运行每个驱动器。扩展插件依赖 `agent`，即使需要发起调用的 Agent 也是如此；它们绝不直接依赖 `agent-loop`，因此循环保持可替换。

将这条主干接成可运行 agent 的默认组合位于 [`examples/agent-spine-demo`](../examples/agent-spine-demo/README.md)：一个 bundle（组合包）插件，加载控制主干及所选默认能力（`timer` + `llm` + 会话 + 后备会话标题 + 系统提示词 + 工具 + agent + 不变式 + 本地 [skill（技能）系列](../skill/README.md) + `tool-bash` + 工作区上下文 + `agent-loop`），并将 `agent-loop` 的 `agents` 列表作为自身配置转发。它位于 `examples/`，即开箱可运行的演示／参考组合包，而不是 `core/`：`core/` 交付可替换的主干组件，演示组合包则选定其中一种具体组合并添加一个对外交互入口。
