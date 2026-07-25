# Agent Note: 统一 agent 投递并把注入的上下文合并进 user/message

Status: implemented

[English](2026-07-22-unified-send-and-coalesced-user-messages.md) | 中文

## 问题

agent 的对外驱动接口逐渐长出三个近乎平行的动词——`send`、`steer`、`inject`——各自带有独立的选项类型、独立的实时事件叙事，以及独立的持久事件。`send` 和 `steer` 都会把一条冻结的 inbox 记录入队并发出 `agent/queued`；`inject` 则绕过 inbox，写入一条独立的 `context/message` 持久事件。这三个动词实际上只沿两条独立的轴变化：一个队列项加入哪个队列（一个全新的轮次，还是当前活跃的轮次），以及这个队列项是否让模型运行。把这个 2×2 编码成三个手写方法，掩盖了其中的对称性，让“排入一个轮次但不唤醒驱动器”无法表达，也让 `cancel()` 无从在保留排队工作的前提下中止一个轮次。

另外，`context/message` 与 `user/message` 已经趋同：对外接口把二者都投影为逐字的 user 角色内容，唯一真正的区别是注入的上下文携带 `source`/`meta` 且“不是提示词”。一个投影对应两种事件类型，意味着每个消费方都要根据事件类型分支来回答“这是不是一条人类提示词？”，而 goal 系统把这种类型区分当作侧信道使用（第 0 轮的状态变更是 `context/message`，已准入的轮次是 `user/message`）。

## 决策

**一种接受机制，四种意图辅助方法。** 具体循环把 `followup`、`queue`、`steer` 和 `inject` 解析到同一个（`target` × `wakeup`）接受机制中。`followup` 是 `next-turn`/wakeup，`queue` 是 `next-turn`/no-wakeup，`steer` 是 `next-step`/wakeup，`inject` 是 `next-step`/no-wakeup。公开的结构化接口将该机制暴露为 `send(ResolvedAgentInput)`；调用方若已持有完全解析的路由信息，即可使用该方法。使用时必须提供所有字段，可辨识输入类型也不允许注入携带附加上下文。取代旧接口的选择由[按意图命名的投递决策](2026-07-24-intent-named-agent-delivery.md)负责说明。内部的 `wakeup` 表示「让模型运行」：为一条普通消息唤醒处于停泊状态的驱动器，或强制运行中的 steering 继续执行。

**inject 保留其机制。** `inject` 在当前日志位置追加持久、面向模型的上下文（在执行中的工具批处理之后延迟处理），或在空闲时开启一个一次性的 `injection` 轮次。它完全绕过 FIFO，不接受附加上下文，并把来源默认设为 `{ kind: 'plugin', plugin: '' }`，绝不是 `{ kind: 'user' }`。

**context/message 已移除。** 注入的上下文现在是一条 `user/message`，其 `source` 为非 `user` 类别（plugin 或 goal）。`PromptMessageData` 新增了 `context/message` 原本携带的可选 `meta`。对外接口、派生逻辑和 `SurfaceEventType` 都不再包含 `context/message`；需要判断“这是不是一条人类提示词？”的消费方改为读取 `source.kind === 'user'`，而不是事件类型。这让 goal-authority 的人类授权检查与此前一样严格——注入的消息默认使用 plugin 来源，永远无法满足 `source.kind === 'user'`。

**goal 回放靠轮次而非类型来区分。** 一次 goal 状态变更是一条第 0 轮、来源为 goal 的 `user/message`，携带 `goal/change` 元数据；正数轮次则是一条已准入的继续执行提示词。`decodeGoalEvent` 现在接收一条 `user/message`，并仍会在非 goal 来源携带 goal 元数据、或 goal 来源缺少元数据时立即报错。

**投递返回一个 id。** 每种投递方法都为被接受的输入返回一个不透明的 branded `AgentMessageId`。FIFO 方法通过其 inbox 生命周期事件携带这个 id；注入绕过这些事件。

**三个 inbox 事件取代 agent/queued。** `agent/inbox/enqueue`（一个队列项进入某个 FIFO）、`agent/inbox/dequeue`（驱动器认领了一个）和 `agent/inbox/discard`（`cancel()` 丢弃了待处理项）都携带一条 `AgentMessage`——即被接受的消息，包含其返回的 `id`、steering/wakeup 事实、来源和上下文——因此调用方可以把一个排队项与其生命周期关联起来。注入从不触及 FIFO，也不发出这些事件中的任何一个。每一次 FIFO 入队都会发布一个 enqueue 事件，包括由 loop 生成的携带继续原因的 steer（`agent/turn-continuation` 返回 `{ action: 'continue', reason }`），因此账目会与其后的 dequeue 或 discard 保持平衡。`dsh-agent` 的不变量配套断言 FIFO 守恒：一个按 agent 计的未结算计数，dequeue 和 discard 永远无法把它压到负数。

**cancel 新增 keepInbox。** `cancel(cause?, { keepInbox? })`；当其为 true 时，它中止活跃轮次，但保留排队项和 steering 项（不发出 discard 事件，尚未启动的工作也不会被丢弃）。

## 考虑过的替代方案

- **为注入内容设立专门的 `MessageSource` 类别 `context`。** 不予采纳，因为 `plugin` 已经表示“不是人类”，因此第四种类别会增加一条平行的轴，让授权检查不得不去学习它。注入的上下文改为默认使用 plugin 来源。
- **在 `PromptMessageData` 上设一个类型化的判别字段**（例如 `origin: 'prompt' | 'context'`）来取代事件类型的区分。不予采纳，转而采用 `source`——每个消费方都已经携带它，goal 系统也已经以它为键；第二个判别字段会重复这一事实。
- **在 inbox 事件之外保留 `agent/queued`。** 作为镜像而被否决：`agent/inbox/enqueue` 是同一个入队时刻的信号，只是多带了已接受的路由事实，而 dequeue/discard 事件补全了单个事件无法描述的 FIFO 生命周期。

## 后果

具体驱动器只有一个投递机制。四种常用辅助方法以调用方意图封装其（`target` × `wakeup`）矩阵，而 `send` 则向高级调用方暴露完全解析后的矩阵。一种持久消息类型同时服务提示词、注入的上下文和 goal 轮次，因此对外接口的投影和每一处「是否人类提示词？」检查都简化为一次 `source` 判断。goal 折叠的通道区分从事件类型改到 `source.round`，此前过滤 `context/message` 的每个消费方都改为按来源过滤 `user/message`。轮次封闭与重建的不变量保持不变：空闲状态下的一次注入仍然封装成一个一次性轮次，只是现在发出 `user/message` 而非 `context/message`。

在内部，`wakeup` 是“模型是否应当运行”的信号，因此 inbox 区分 `hasWakingQueued`（驱动 loop 以及空闲/静默判定）与 `hasQueued`（是否有任何可 dequeue 的项）：一个孤立的 `queue()` 项会停泊在空闲状态，并随下一条会唤醒驱动器的后续消息一同带出，而 `whenIdle`/`cancel` 依据唤醒信号来结算静默（一个孤立的静默项走 `whenIdle` 的快速路径，因此不会让任何等待者悬而未决）。排队消息或 steering 消息上的 `SendOptions.meta` 会被带到持久的 `user/message`/`steering/message` 上，与注入保持一致；它有意不放在实时的 `AgentMessage` 上，后者只携带路由事实。每个已入队的 id 都恰好得到一个终止性生命周期事件：一次会丢弃待处理 steering 项的终止性停止会为它发出 `agent/inbox/discard`，既在轮次内的停止点，也在轮次结束后对迟到 steering 的清空时；dispose（资源释放）会在 loop 退出前丢弃所有仍在等待的项。`agent/inbox/*` 的事件载荷已被冻结，因此监听器无法在分发中途修改共享的关联对象，而由 loop 生成的继续原因会像公开 steering 一样被快照并冻结。注入会在打开空闲状态的一次性轮次之前校验其载荷；`InjectOptions` 不包含附加上下文，而 `ResolvedAgentInput` 中不唤醒的下一步变体要求使用空上下文元组。

## 相关

- [one-send-one-turn](../simplification/2026-07-17-one-send-one-turn.md)——本决策所依托的“每轮次只认领一条消息”规则。
- [remove-agent-steering-mirror](../simplification/2026-07-04-remove-agent-steering-mirror.md)——折叠镜像实时事件的先例。
- [explicit-turn-cancellation](2026-07-16-explicit-turn-cancellation.md)——`keepInbox` 所扩展的取消原因信号。
- [intent-named-agent-delivery](2026-07-24-intent-named-agent-delivery.md)——公开辅助方法以及接受完全解析输入的接口。
