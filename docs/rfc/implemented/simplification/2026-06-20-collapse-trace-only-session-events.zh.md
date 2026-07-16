# RFC：将仅用于追踪的会话事实折叠进承载性事件

Status: implemented

[English](2026-06-20-collapse-trace-only-session-events.md) | 中文

## 问题

会话事件词汇中包含一些一等事件，它们既不属于可回放的对话历史，在生产环境中也几乎没有消费方。`usage` 在模型流式分片中已经存在，但循环又额外追加了一个独立的 `usage` 事件。`error` 与 `turn/end { kind: 'error', message, code }` 中的循环失败原因重复；ACP（Agent Client Protocol）结算读取的是 turn-end 原因，ACP 渲染忽略 `error` 事件，`deriveMessages()` 也跳过它。

这些事件让规范的 transcript（文本记录）看起来比实际更像遥测数据。它们增加了事件变体、不变式、测试、快照和持久化用例，但作为独立记录并不承载实际负荷。它们携带的事实仍然有用：token 用量应当保留以供核算，错误的步骤编号也不应悄然消失。简化的方式是将这些事实折叠进消费方本就必须理解的邻近事件，而非减少记录的信息量。

## 决策

仅在信息已被保留、无需并行记录的位置移除独立的追踪事件：

- 成功步骤的 usage 折叠进对应的 `assistant/message`（`assistant/message { turn, step, content, usage? }`），使组装好的模型输出与其核算信息一同传递。
- 失败或中止的步骤如果有 usage 但没有 assistant 内容，则将 usage 挂在一个空内容的 `assistant/message` 上（下方实现说明给出了无信息丢失的证明）——不会有任何已持久化的 usage 分片失去表示。
- 独立 `error` 事件中的步骤编号折叠进 `turn/end.reason`（当 `kind: 'error'` 时：`{ kind: 'error', step, message, code? }`）——`turn/end` 是 ACP 和恢复机制已在消费的持久化轮次结果。
- `agent/error` 和日志保留用于实时诊断；`turn/end` 之后不再有第二条会话日志错误记录。

用户对话日志包含渲染、恢复、审计和核算交互所需的全部信息，消费方无需对账重复的追踪行。

## 曾考虑的替代方案

**保留独立行作为遥测**：这些事件让规范的 transcript 看起来比实际更像遥测数据，代价是增加了事件变体、不变式、测试、快照和持久化用例，却没有消费方使用。如果分析需求真正出现，正确的形态是投影辅助工具或带有独立保留策略的专用遥测存储，而非在对话日志中放置重复的追踪行。

## 验证

`SessionEventMap` 不再包含独立的 `usage` 或 `error`；循环不再追加独立的 usage 事件，持久化的失败通过 `turn/end { kind: 'error', step, message, code? }` 记录；ACP 快照和持久化测试断言不存在仅追踪行；录制的 fixture（测试前置数据）已采用新事件形状，会话格式版本固定为 `0`（按预发布格式策略，后端拒绝任何非 `0` 的存储日志）；文档说明了 token 用量和操作错误的观测位置。

## 后果

消费方不能再从规范日志中筛选独立的 `usage` 或步骤级 `error` 行，必须从承载它们的 assistant/failure 事件中读取这些事实。只有当实现 PR 证明相同的事实仍然存在时，这才是合理的简化；否则独立事件应当保留。

## 实现说明

按提案交付，有一处范围细化（遵循 AGENTS.md「RFC 是提案，不是金科玉律」）：

- **空内容的 `assistant/message` 承载 usage，无数据丢失。** 提案要求的证明（不会有已持久化的 usage 分片失去表示）落在 max-tokens 路径上：一个被截断的步骤有 usage 但内容为空（例如只有一个被丢弃的工具调用），此前会发出独立的 `usage`。现在它记录一条空内容的 `assistant/message { content: [], usage }`。为避免这向提供方 transcript 注入一个无内容的虚假 assistant 轮次，`deriveMessages()` 跳过空内容的 `assistant/message` 事件。一个回归测试断言 usage 仍有表示，且派生历史未被破坏。

**格式版本。** 此变更改动了持久化事件，但预发布会话格式仍固定为 `0`，拒绝任何其他版本且不做迁移。`dsh-session` 拥有写入方和加载校验使用的常量。单调递增的格式版本从首次正式发布开始。

Usage 现在通过 `assistant/message.usage` 观测；操作错误的步骤编号通过 `turn/end.reason`（当 `kind: 'error'` 时）观测。`agent/error` 加日志用于实时诊断，保持不变。
