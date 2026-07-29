# session-title/：日志支持的会话标题能力家族

[English](README.md) | 中文

持久化的会话标题状态、一个可选异步提供方 seam，以及两个由模型支持、可选启用的实现。内置首消息回退属于服务本身，因此任何组合都能在不调用辅助模型的情况下为会话生成标题。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`session-title/`](session-title/README.md) | 日志折叠、确定性回退、提供方注册表与刷新 API | `ctx.sessionTitle` |
| [`session-title-llm/`](session-title-llm/README.md) | 共享路由、请求日志记录、提示词、超时、流与验证辅助模块 | 无 |
| [`session-title-first-message-llm/`](session-title-first-message-llm/README.md) | 使用第一条符合条件的用户消息的可选提供方 | 注册到 `ctx.sessionTitle` |
| [`session-title-all-messages-llm/`](session-title-all-messages-llm/README.md) | 使用所有符合条件的用户消息的可选提供方 | 注册到 `ctx.sessionTitle` |

同一时间只能注册一个提供方。共享 demo 主干会挂载回退服务，但默认组合不包含两个模型提供方，因此部署会显式选择辅助成本和重新生成标题的节奏。
