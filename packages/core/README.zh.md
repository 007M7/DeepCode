# core/：产品 API 主干

[English](README.md) | 中文

会话日志、系统提示词组装、工具注册表、agent（智能体）词汇，以及构成 harness 默认控制主干的具体循环。这些是 **产品** 包，插件和消费方以其稳定接口为基础构建。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`scope/`](scope/README.md) | 带作用域的上下文注册原语 | 库，无 ctx 键 |
| [`session/`](session/README.md) | 事件溯源会话日志与内存存储 | `ctx.sessions` |
| [`system-prompt/`](system-prompt/README.md) | 提示词与工具 schema 组装注册表 | `ctx.systemPrompt` |
| [`tools/`](tools/README.md) | 带作用域的工具注册表与执行流水线 | `ctx.tools` |
| [`agent/`](agent/README.md) | Agent 接口、注册表与事件词汇 | `ctx.agents` |
| [`agent-loop/`](agent-loop/README.md) | 默认的具体 agent 驱动器 | `ctx.agentLoop` |

`scope` 提供共享的作用域原语。`agent` 拥有公开 seam，`agent-loop` 则是其默认实现；扩展插件依赖 seam，使驱动器保持可替换。

可运行组合属于 [`examples/agent-spine-demo`](../examples/agent-spine-demo/README.md)；本组只负责可替换的主干组件。
