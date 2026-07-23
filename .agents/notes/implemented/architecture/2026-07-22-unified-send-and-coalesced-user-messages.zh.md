# Agent Note: 将 agent 投递统一到 send(target × wakeup) 并把注入的上下文合并进 user/message

Status: implemented

[English](2026-07-22-unified-send-and-coalesced-user-messages.md) | 中文

## 问题

agent 的对外驱动接口逐渐长出三个近乎平行的动词——`send`、`steer`、`inject`——各自带有独立的选项类型、独立的实时事件叙事，以及独立的持久事件。`send` 和 `steer` 都会把一条冻结的 inbox 记录入队并发出 `agent/queued`；`inject` 则绕过 inbox，写入一条独立的 `context/message` 持久事件。这三个动词实际上只沿两条独立的轴变化：一个队列项加入哪个队列（一个全新的轮次，还是当前活跃的轮次），以及这个队列项是否让模型运行。把这个 2×2 编码成三个手写方法，掩盖了其中的对称性，让“排入一个轮次但不唤醒驱动器”无法表达，也让 `cancel()` 无从在保留排队工作的前提下中止一个轮次。

另外，`context/message` 与 `user/message` 已经趋同：对外接口把二者都投影为逐字的 user 角色内容，唯一真正的区别是注入的上下文携带 `source`/`meta` 且“不是提示词”。一个投影对应两种事件类型，意味着每个消费方都要根据事件类型分支来回答“这是不是一条人类提示词？”，而 goal 系统把这种类型区分当作侧信道使用（第 0 轮的状态变更是 `context/message`，已准入的轮次是 `user/message`）。

## 决策

**一个原语，三个预设别名。** `Agent` 现在是一个抽象类，其唯一的抽象方法 `send(content, { target, wakeup, source, contexts, meta })` 覆盖 (`target` × `wakeup`) 矩阵。`followup`（`next-turn`/wakeup）、`steer`（`next-step`/wakeup）和 `inject`（`next-step`/no-wakeup）是基类上的具体委托方法，因此具体驱动器只需实现一次 `send`，就能继承这些好用的预设。`wakeup` 意为“让模型运行”：为一个 `next-turn` 队列项唤醒处于停泊状态的驱动器，或为一个运行中的 `next-step` 队列项强制继续执行。`send` 默认使用 `{ target: 'next-turn', wakeup: true }`，因此此前每一次裸调用 `agent.send(content)` 都保持完全相同的行为。`next-turn`/no-wakeup（入队但不唤醒）现在可以表达，只是没有别名，也没有当前调用方。

**inject 保留其机制。** `next-step`/no-wakeup 路径正是旧的 `inject`：在当前日志位置追加的持久、面向模型的上下文（在执行中的工具批处理之后延迟处理），或在空闲时的一次性 `injection` 轮次。它完全绕过 FIFO 队列，并把来源默认设为 `{ kind: 'plugin', plugin: '' }`，绝不是 `{ kind: 'user' }`。

**context/message 已移除。** 注入的上下文现在是一条 `user/message`，其 `source` 为非 `user` 类别（plugin 或 goal）。`PromptMessageData` 新增了 `context/message` 原本携带的可选 `meta`。对外接口、派生逻辑和 `SurfaceEventType` 都不再包含 `context/message`；需要判断“这是不是一条人类提示词？”的消费方改为读取 `source.kind === 'user'`，而不是事件类型。这让 goal-authority 的人类授权检查与此前一样严格——注入的消息默认使用 plugin 来源，永远无法满足 `source.kind === 'user'`。

**goal 回放靠轮次而非类型来区分。** 一次 goal 状态变更是一条第 0 轮、来源为 goal 的 `user/message`，携带 `goal/change` 元数据；正数轮次则是一条已准入的继续执行提示词。`decodeGoalEvent` 现在接收一条 `user/message`，并仍会在非 goal 来源携带 goal 元数据、或 goal 来源缺少元数据时立即报错。

**`send` 返回一个 id。** `send`（以及其别名）为被接受的消息返回一个不透明的 branded `AgentMessageId`；`send` 此前的返回值是 `void`。

**三个 inbox 事件取代 agent/queued。** `agent/inbox/enqueue`（一个队列项进入某个 FIFO）、`agent/inbox/dequeue`（驱动器认领了一个）和 `agent/inbox/discard`（`cancel()` 丢弃了待处理项）都携带一条 `AgentMessage`——即被接受的消息，包含其返回的 `id`、`target`/`wakeup`、来源和上下文——因此调用方可以把一个排队项与其生命周期关联起来。注入从不触及 FIFO，也不发出这些事件中的任何一个。每一次 FIFO 入队都会发布一个 enqueue 事件，包括由 loop 生成的携带继续原因的 steer（`agent/turn-continuation` 返回 `{ action: 'continue', reason }`），因此账目会与其后的 dequeue 或 discard 保持平衡。`dsh-agent` 的不变量配套断言 FIFO 守恒：一个按 agent 计的未结算计数，dequeue 和 discard 永远无法把它压到负数。

**cancel 新增 keepInbox。** `cancel(cause?, { keepInbox? })`；当其为 true 时，它中止活跃轮次，但保留排队项和 steering 项（不发出 discard 事件，尚未启动的工作也不会被丢弃）。

## 考虑过的替代方案

- **为注入内容设立专门的 `MessageSource` 类别 `context`。** 不予采纳，因为 `plugin` 已经表示“不是人类”，因此第四种类别会增加一条平行的轴，让授权检查不得不去学习它。注入的上下文改为默认使用 plugin 来源。
- **在 `PromptMessageData` 上设一个类型化的判别字段**（例如 `origin: 'prompt' | 'context'`）来取代事件类型的区分。不予采纳，转而采用 `source`——每个消费方都已经携带它，goal 系统也已经以它为键；第二个判别字段会重复这一事实。
- **在 inbox 事件之外保留 `agent/queued`。** 作为镜像而被否决：`agent/inbox/enqueue` 是同一个入队时刻的信号，只是多带了 `target`/`wakeup` 的事实，而 dequeue/discard 事件补全了单个事件无法描述的 FIFO 生命周期。

## 后果

投递接口现在是一个原语加三个自解释的预设，(`target` × `wakeup`) 矩阵把此前无法表达的组合显式化。一种持久消息类型同时服务提示词、注入的上下文和 goal 轮次，因此对外接口的投影和每一处“是否人类提示词？”检查都简化为一次 `source` 判断。代价是：`Agent` 变成了抽象类，因此对象字面量形式的测试替身必须提供 `followup`，且无法在不重新做类型转换的情况下展开一个类类型的值（原型方法不可枚举）；goal 折叠的通道区分从事件类型改到了 `source.round`；此前过滤 `context/message` 的每个消费方现在改为按来源过滤 `user/message`。轮次封闭与重建的不变量保持不变——空闲状态下的一次注入仍然封装成一个一次性轮次，只是现在发出 `user/message` 而非 `context/message`。

`wakeup` 是“模型是否应当运行”的信号，因此 inbox 区分 `hasWakingQueued`（驱动 loop 以及空闲/静默判定）与 `hasQueued`（是否有任何可 dequeue 的项）：一个孤立的 `next-turn`/no-wakeup 队列项会停泊在空闲状态，并随下一次唤醒 send 一同带出，而 `whenIdle`/`cancel` 依据唤醒信号来结算静默。排队 send 或 steering send 上的 `SendOptions.meta` 会被带到持久的 `user/message`/`steering/message` 上，与注入保持一致。每一次 FIFO 退出都恰好发布一个生命周期事件：一次会丢弃待处理 steering 项的终止性 `agent/turn-stop` 现在会为它发出 `agent/inbox/discard`，而由 loop 生成的继续原因会像一次对外 send 那样被快照并冻结。`gen-cordis-api` 收集导出的类（剥除方法体），因此如今已是类的 `Agent` 及其传递涉及的形状仍会出现在面向模型的 API 目录中。

## 相关

- [one-send-one-turn](../simplification/2026-07-17-one-send-one-turn.md)——本决策所依托的“每轮次只认领一条消息”规则。
- [remove-agent-steering-mirror](../simplification/2026-07-04-remove-agent-steering-mirror.md)——折叠镜像实时事件的先例。
- [explicit-turn-cancellation](2026-07-16-explicit-turn-cancellation.md)——`keepInbox` 所扩展的取消原因信号。
