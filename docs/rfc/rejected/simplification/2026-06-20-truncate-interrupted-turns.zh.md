# RFC：加载时截断被中断的末尾轮次

Status: rejected — a single turn can contain substantial real work, including many steps and large tool output. Preserving interrupted turns is preferable to silently dropping that tail on load.

[English](2026-06-20-truncate-interrupted-turns.md) | 中文

## 问题

当前的持久化契约会保留最后一个已持久写入但从未关闭的轮次。加载时，`interruptedTurnClosers()` 扫描尾部，为未应答的工具调用合成错误的 `tool/result` 事件，在步骤未关闭时追加 `step/end`，追加 `turn/end { kind: 'interrupted' }`，并要求后端持久提交这段修复。协调器、JSONL 后端、SQLite 后端、会话事件词汇、不变式、文档和测试都对这条合成关闭路径建了模。

这是为了保留上一次崩溃轮次的部分工作而引入的大量机制。它还会生造从未发生过的事件。合成的工具结果有用处（它使提供方历史保持合法），但也意味着恢复后的日志中包含了没有任何工具产出过的、模型可见的文本。当前设计在尚无已发布产品、也没有真实的恢复 UX 来证明部分轮次恢复确有价值的情况下，就优化了最大化的尾部保留。

## 提案

加载时只保留到最后一个已完成的轮次。后端仍然容忍并截断撕裂的末尾记录，但如果解析出的持久前缀在一个已打开的 `turn/start` 之后结束，规范的修复方式是丢弃上一个 `turn/end` 之后的所有事件。不合成 `tool/result`，不合成 `step/end`，不追加 `turn/end { interrupted }`，也不需要 `interrupted` 轮次结束原因。

这使持久化的轮次边界变得简单：一个已完成的 `turn/end` 就是检查点。最后一个检查点之后的内容都是崩溃尾部。下一次提示词从最后一个已知合法的提供方 transcript 恢复，而非从部分重建的末尾轮次恢复。

## 验收标准

- `TurnEndReasonMap` 移除 `interrupted` 变体。
- `interruptedTurnClosers()` 及其测试消失。
- 持久化协调器的修复钩子截断后端特定的撕裂/未关闭尾部状态，不追加关闭事件。
- [会话持久化文档](../../../../packages/session-persistence/session-persistence/README.md)说明加载返回到最后一个已完成轮次，不包含部分末尾轮次。
- 快照测试与契约测试随其所固定的行为一起更新。
- 会话格式版本与已记录的 fixture（测试前置数据）一并刷新；按预发布格式策略，非当前版本的存储日志被拒绝，不提供迁移路径。

## 放弃了什么

一次崩溃可能丢失末尾轮次中的真实工作：上一个 `turn/end` 之后追加的助手文本、工具调用和工具输出。这是有意为之的简化。产品尚未发布，末尾轮次恢复的语义未经用户验证，而一个干净的「已完成轮次即检查点」模型在解释、测试和实现上都容易得多。未来如果需要「恢复部分崩溃工作」功能，应当设计为一个面向用户的显式恢复视图，而非静默插入规范 transcript 的合成事件。

## 相关

本 RFC 是对[会话持久化](../../implemented/architecture/2026-06-14-session-persistence.md)和[轮次封闭不变式](../../implemented/architecture/2026-06-15-turn-enclosure-invariant.md)的直接简化。它还移除了持久化步骤边界事件的大部分动机，使 [drop durable step boundary events](2026-06-20-drop-durable-step-boundaries.md) 的变更范围更小。

<!-- rfc-format: alternatives-not-recorded (pre-format RFC) -->
