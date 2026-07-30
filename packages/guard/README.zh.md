# guard/：循环健康 guard 家族

[English](README.md) | 中文

这组行为 guard 插件会监视 agent loop（智能体循环）中的低效模式，并提醒模型调整方向。这里只有一个**产品**包（package），不设接口／实现 seam：guard 是现有核心 seam（`tools/post-execute`、`agent/prompt-submit`、`agent/status`）的自包含消费方，并非可替换能力。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `repeat-tool-guard/` | 当 agent 对完全相同的工具调用反复循环时给出提示 | （监听 `ctx.tools` 的 waterfall，即瀑布式事件） |

提示以 `additionalContexts` 形式附在 `tools/post-execute` 决策中传递；agent loop 会在该步骤的工具结果之后，将其追加为有日志记录、来源为插件的 `user/message` 事件（参见[工具包](../core/tools)）。因此，guard 告诉模型的所有内容都能从会话日志中重建。
