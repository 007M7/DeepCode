# todo/：todo／规划能力家族

[English](README.md) | 中文

面向模型的 todo 工具。它是单一 **产品**包（package）：这里没有接口／实现 seam，因为该列表是由单一所有者管理的会话状态（每个 agent（智能体）会话拥有自己的列表），而非可替换能力。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `tool-todo/` | 面向模型的 `todo_write` 工具；将完整列表写入会话日志（`todo/write`） | （注册到 `ctx.tools`） |

列表存在于事件溯源会话日志中（`SessionEventMap['todo/write']`，由 [`dsh-session`](../core/session) 拥有）；本包是追加快照的轻量消费方。宿主／客户端运行时会根据会话事件渲染该持久化列表。
