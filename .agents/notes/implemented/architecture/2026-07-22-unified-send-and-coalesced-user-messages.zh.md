# Agent Note: 将 agent 投递统一到 send(target × wakeup) 并把注入的上下文合并进 user/message

Status: implemented

[English](2026-07-22-unified-send-and-coalesced-user-messages.md) | 中文

## 问题

agent 的对外驱动接口逐渐长出三个近乎平行的动词——`send`、`steer`、`inject`——各自带有独立的选项类型、独立的实时事件叙事，以及独立的持久事件。`send` 和 `steer` 都会把一条冻结的 inbox 记录入队并发出 `agent/queued`；`inject` 则绕过 inbox，写入一条独立的 `context/message` 持久事件。这三个动词实际上只沿两条独立的轴变化：一个队列项加入哪个队列（一个全新的轮次，还是当前活跃的轮次），以及这个队列项是否让模型运行。把这个 2×2 编码成三个手写方法，掩盖了其中的对称性，让“排入一个轮次但不唤醒驱动器”无法表达，也让 `cancel()` 无从在保留排队工作的前提下中止一个轮次。

另外，`context/message` 与 `user/message` 已经趋同：对外接口把二者都投影为逐字的 user 角色内容，唯一真正的区别是注入的上下文携带非 user `source` 且“不是提示词”。一个投影对应两种事件类型，意味着每个消费方都要根据事件类型分支来回答“这是不是一条人类提示词？”，而 goal 系统把这种类型区分当作侧信道使用（第 0 轮的状态变更是 `context/message`，已准入的轮次是 `user/message`）。

## 决策

**一个原语，三个预设别名。** `Agent` 接口的 `send(input, { target, wakeup })` 覆盖 (`target` × `wakeup`) 矩阵。其 `UserMessageData` 输入持有不可分割的模型可见 `content` 与生产方 `source`；完整的 `SendOptions` 只持有路由策略。`followup`（`next-turn`/wakeup）、`steer`（`next-step`/wakeup）和 `inject`（`next-step`/no-wakeup）都接收这一项输入并固定策略。`wakeup` 意为“让模型运行”：为一个 `next-turn` 队列项唤醒处于停泊状态的驱动器，或为一个运行中的 `next-step` 队列项强制继续执行。`next-turn`/no-wakeup（入队但不唤醒）可以表达，只是没有别名，也没有当前调用方。

**inject 保留其机制。** `next-step`/no-wakeup 路径正是旧的 `inject`：持久的面向模型上下文会追加到当前日志位置；轮次打开时，它会延迟到执行中的工具批处理之后，空闲时则直接追加在两个轮次之间。它完全绕过 FIFO 队列，而必填的 `UserMessageData.source` 会保留调用方显式提供的来源信息。

**context/message 已移除。** 注入的上下文现在是一条 `user/message`；上下文生产方显式提供合适的非 `user` 类别 `source`，类型化 source 变体携带所有特定于领域的持久来源信息。对外接口、派生逻辑和 `SurfaceEventType` 都不再包含 `context/message`；需要判断“这是不是一条人类提示词？”的消费方改为读取 `source.kind === 'user'`，而不是事件类型。

**goal 回放靠轮次而非类型来区分。** 一次 goal 状态变更是一条第 0 轮、来源为 goal 的 `user/message`，其 source 携带完整变更；正数轮次则是一条已准入的继续执行提示词。`decodeGoalEvent` 接收一条 `user/message`，并在 goal 状态内容与其类型化 source 不一致时立即报错。

**`send` 返回一个 id。** `send`（以及其别名）为被接受的消息返回一个不透明的 branded `AgentMessageId`；`send` 此前的返回值是 `void`。

**三个 inbox 事件取代 agent/queued。** `agent/inbox/enqueue`（一个队列项进入某个 FIFO）、`agent/inbox/dequeue`（驱动器认领了一个）和 `agent/inbox/discard`（`cancel()` 丢弃了待处理项）都将各自的 `AgentMessage` 载荷类型限定为仅包含被接受消息所返回的 `id`、内容和来源；调用方因此可以把一个排队项与其生命周期关联起来，而无需依赖驱动器的路由状态。注入从不触及 FIFO，也不发出这些事件中的任何一个。每一次 FIFO 入队都会发布一个 enqueue 事件，包括 `agent/turn-stopping` 监听器提交的 steering，因此账目会与其后的 dequeue 或 discard 保持平衡。`dsh-agent` 的不变量配套断言 FIFO 守恒：一个按 agent 计的未结算计数，dequeue 和 discard 永远无法把它压到负数。

**一条已接受消息只保留一种表示。** 持久的用户角色输入和附加的模型可见上下文都直接使用 `UserMessageData { content, source }`；公开的 `AgentMessage` 在此基础上增加用于关联的 `id`，循环私有的 `PendingMessage` 再增加 `wakeup`。一条成为 steering 的排队消息会以同一个 `PendingMessage` 对象进入 outbox，而注入和工具产生的上下文则以普通 `UserMessageData` 进入。因此，outbox 直接存储这两种类型的联合，而不再把 steering 与一份重复的内容和来源副本包装在一起。提供方原生的助手消息仍是适配器拥有的输出类型，不参与这套输入层级。

**cancel 新增 keepInbox。** `cancel(cause, { keepInbox? })`；调用方显式选择 cause，且 `keepInbox: true` 会中止活跃轮次，同时保留排队项和 steering 项（不发出 discard 事件，尚未启动的工作也不会被丢弃）。

## 考虑过的替代方案

- **为注入内容设立专门的 `MessageSource` 类别 `context`。** 不予采纳，因为 `plugin` 已经表示“不是人类”，因此第四种类别会增加一条平行的轴，让授权检查不得不去学习它。由插件产生的注入上下文会显式提供其 plugin 来源。
- **在 `UserMessageData` 上设一个类型化的判别字段**（例如 `origin: 'prompt' | 'context'`）来取代事件类型的区分。不予采纳，转而采用 `source`——每个消费方都已经携带它，goal 系统也已经以它为键；第二个判别字段会重复这一事实。
- **在 inbox 事件之外保留 `agent/queued`。** 作为镜像而被否决：`agent/inbox/enqueue` 是同一个入队时刻的信号，只是多带了 `target`/`wakeup` 的事实，而 dequeue/discard 事件补全了单个事件无法描述的 FIFO 生命周期。

## 后果

投递接口现在是一个原语加三个自解释的预设，(`target` × `wakeup`) 矩阵把此前无法表达的组合显式化。一种持久消息类型同时服务提示词、注入的上下文和 goal 轮次，因此对外接口的投影和每一处“是否人类提示词？”检查都简化为一次 `source` 判断。`Agent` 契约仍是接口，因此其他实现和对象字面量形式的测试替身只需实现同一个最小结构接口。goal 折叠的通道区分从事件类型改到了 `source.round`；此前过滤 `context/message` 的每个消费方现在改为按来源过滤 `user/message`。空闲状态下的注入会在两个轮次之间追加 `user/message`，既不打开轮次，也不运行模型。

`wakeup` 是“模型是否应当运行”的信号，因此 inbox 会区分能唤醒的排队工作与任何可 dequeue 的项：一个孤立的 `next-turn`/no-wakeup 队列项会停泊在空闲状态，并随下一次唤醒 send 一同带出，而 `whenIdle`/`cancel` 依据唤醒信号来结算静默。每一次 FIFO 退出都恰好发布一个生命周期事件，特定于领域的持久事实则通过类型化消息 source 传递，而非通过平行的元数据通道。直接使用待处理项的表示方式，使公开生命周期事件保持可关联，既无需维护第二个 steering 包装层，也避免其持久数据发生分歧。

## 相关

- [one-send-one-turn](../simplification/2026-07-17-one-send-one-turn.md)——本决策所依托的“每轮次只认领一条消息”规则。
- [remove-agent-steering-mirror](../../archived/simplification/2026-07-04-remove-agent-steering-mirror.md)——折叠镜像实时事件的先例。
- [explicit-turn-cancellation](2026-07-16-explicit-turn-cancellation.md)——`keepInbox` 所扩展的取消原因信号。
