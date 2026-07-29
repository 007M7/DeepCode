# guard/：循环健康 guard 家族

[English](README.md) | 中文

这组行为 guard 插件会监视 agent（智能体）循环并加以纠正：一部分提醒模型调整方向，另一部分则直接拒绝某个操作。它们都是**产品**包，不设接口／实现 seam：guard 是现有核心 seam（`tools/pre-execute`、`tools/post-execute`、`agent/prompt-submit`、`agent/status`）的自包含消费方，并非可替换能力。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `repeat-tool-guard/` | 当 agent 对完全相同的工具调用反复循环时给出提示 | （监听 `ctx.tools` 的 waterfall（瀑布式事件）） |

建议型 guard 的提示以 `additionalContexts` 形式附在 `tools/post-execute` 决策中传递；agent loop 会在该步骤的工具结果之后，将其追加为有日志记录、来源为插件的 `user/message` 事件（参见[工具包](../core/tools)）。因此，此类 guard 告诉模型的所有内容都能从会话日志中重建。强制型 guard 则在 `tools/pre-execute` 上做出决策，其 `deny` 会成为该调用的错误结果，操作绝不会分派执行。
