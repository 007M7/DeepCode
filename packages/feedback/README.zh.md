# feedback/：记录的人类反馈

[English](README.md) | 中文

feedback 家族让人类记录对会话的评价，但不据此采取任何动作。反馈属于持久的会话日志内容，与模型对话以及后续可能读取它的任何策略相互独立。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `command-feedback/` | 与触发方式无关的 `feedback/record` 事件，以及面向用户的 `/feedback` 生产方 | 无 |

被记录的评价仅写入日志：它绝不会进入模型 surface 或派生历史，随附插件也不会消费它。未来的消费方从会话日志中读取 `feedback/record` 事件，而不是改变它们的采集方式。
