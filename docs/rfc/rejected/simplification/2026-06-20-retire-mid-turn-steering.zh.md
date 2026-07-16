# RFC：废除中途 steering（中途引导）

Status: rejected — mid-turn steering is an intentional agent capability for between-step user/plugin input and future goal/loop workflows. It is complexity with a product direction, not an accidental duplicate of `send()`.

[English](2026-06-20-retire-mid-turn-steering.md) | 中文

## 问题

agent（智能体）暴露了两条用户消息路径，看起来相近但生命周期语义不同：`send()` 将一条普通用户轮次排入队列，而 `steer()` 在当前运行轮次的步骤之间注入一条消息，空闲时则回退为 `send()`。这一区别渗透到整个栈：`Agent.steer()` 是公开 API，会话日志有持久化的 `steering/message` 事件，agent 事件分类体系有 `agent/steering`，循环在排队消息 FIFO 之外还维护一个 steering FIFO，取消操作需要清空两个队列，`deriveMessages()` 必须将 steering 渲染为带标签的合成用户消息而非普通提示词。

continuation seam 放大了这一成本。`agent/turn-continuation` 默认为 `hadToolCalls || steeringInjected`，因此同一轮次内的 steering 消息即使模型没有请求工具调用也能强制循环再次调用模型。注释中提到了未来的 `/goal`、`/loop` 和预算守卫用途，但当前仓库没有生产级监听器；只有测试注册了该 waterfall（瀑布式事件）。另外，唯一调用 `steer()` 的生产 UI 是 stdio 演示。ACP 在轮次运行期间已经通过普通队列发送提示词。

## 提案

暂时删除中途用户 steering。`Agent.send()` 成为提交用户内容的唯一公开方式；当 agent 正在运行时，内容等待下一轮次。循环仅因工具调用而在轮次内继续，而非因为用户在某步骤运行期间输入了内容。想要中断当前轮次的调用方使用 `cancel()` 再 `send()`。

移除 `Agent.steer()`、steering FIFO、`steering/message`、`agent/steering`、由 steering 驱动的 continuation，以及区分排队消息与 steering 消息的取消逻辑。在同一变更中移除 `agent/turn-continuation`，除非实现 PR 发现了生产级监听器；没有 steering 之后，当前仓库不再有具体的 continuation 消费方。如果将来真正的预算或 goal 插件需要强制 continuation，应以该插件为具体消费方重新引入一个更窄的 seam。

## 验收标准

- `Agent` 暴露唯一的用户消息入口 `send()`。
- 持久化会话事件词汇不再包含 `steering/message`。
- `deriveMessages()` 渲染普通用户消息和上下文注入，不再有 steering 标签路径。
- 循环只有一个排队消息 FIFO，没有同轮次用户消息 continuation 路径。
- `agent/turn-continuation` 被移除或收窄到一个具名的生产级消费方。
- stdio UI 和文档将运行期间的输入描述为排入下一轮次的输入。
- 会话格式版本和录制的 fixture（测试前置数据）已刷新；按预发布格式策略拒绝非当前版本的存储日志。

## 放弃了什么

用户无法在模型处于工具步骤之间时添加同轮次 steering 内容。这种行为在理论上对「你已经在工作了，顺便也考虑一下 X」有用，但它不是 ACP 今天暴露的行为，而且它使轮次边界变得更难推理。更简单的行为是合理的：用户输入成为下一条提示词，取消仍是替换进行中工作的显式手段。

## 相关

本提案与[删除持久化步骤边界](2026-06-20-drop-durable-step-boundaries.md)天然配对，因为移除同轮次 steering 和 `agent/turn-continuation` 之后，工具调用成为一个轮次包含多个模型步骤的唯一原因。

<!-- rfc-format: alternatives-not-recorded (pre-format RFC) -->
