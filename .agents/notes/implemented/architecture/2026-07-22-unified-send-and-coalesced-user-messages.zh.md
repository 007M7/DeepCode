# Agent Note: 将 agent 投递统一到 send(target × wakeup) 并把注入的上下文合并进 user/message

Status: implemented

[English](2026-07-22-unified-send-and-coalesced-user-messages.md) | 中文

## 问题

agent 的对外驱动接口逐渐长出三个近乎平行的动词——`send`、`steer`、`inject`——各自带有独立的选项类型、独立的实时事件叙事，以及独立的持久事件。`send` 和 `steer` 都会把一条冻结的 inbox 记录入队并发出 `agent/queued`；`inject` 则绕过 inbox，写入一条独立的 `context/message` 持久事件。这三个动词实际上只沿两条独立的轴变化：一个队列项加入哪个队列（一个全新的轮次，还是当前活跃的轮次），以及这个队列项是否让模型运行。把这个 2×2 编码成三个手写方法，掩盖了其中的对称性，让“排入一个轮次但不唤醒驱动器”无法表达，也让 `cancel()` 无从在保留排队工作的前提下中止一个轮次。

另外，`context/message` 与 `user/message` 已经趋同：对外接口把二者都原样投影为 user 角色内容，唯一真正的区别是注入的上下文携带非 user `source` 且“不是提示词”。一个投影对应两种事件类型，意味着每个消费方都要根据事件类型分支来回答“这是不是一条人类提示词？”，而 goal 系统把这种类型区分当作侧信道使用（第 0 轮的状态变更是 `context/message`，已准入的轮次是 `user/message`）。

## 决策

**一个原语，三个预设别名。** `Agent` 接口的 `send(message, { target, wakeup })` 覆盖 (`target` × `wakeup`) 矩阵。完整的 `UserMessage` 持有标识、角色、模型可见 `content` 与生产方 `source`；完整的 `SendOptions` 只持有路由策略。`followup`（`next-turn`/wakeup）、`steer`（`next-step`/wakeup）和 `inject`（`next-step`/no-wakeup）都接收这一条消息并固定策略。`wakeup` 意为“让模型运行”：为一个 `next-turn` 队列项唤醒处于停泊状态的驱动器，或为一个运行中的 `next-step` 队列项强制继续执行。`next-turn`/no-wakeup（入队但不唤醒）可以表达，只是没有别名，也没有当前调用方。

**inject 保留其机制。** `next-step`/no-wakeup 路径正是旧的 `inject`：持久的面向模型上下文会追加到当前日志位置；当提示词准入流程或某个轮次占用下一个安全边界时，它会延迟处理，而在该窗口之外则直接追加。它完全绕过 FIFO 队列，而必填的 `UserMessage.source` 会保留调用方显式提供的来源信息。

**context/message 已移除。** 注入的上下文现在是一条 `user/message`；上下文生产方显式提供合适的非 `user` 类别 `source`，类型化 source 变体携带所有特定于领域的持久来源信息。对外接口、派生逻辑和 `SurfaceEventType` 都不再包含 `context/message`；需要判断“这是不是一条人类提示词？”的消费方改为读取 `source.kind === 'user'`，而不是事件类型。

**goal 回放靠轮次而非类型来区分。** 一次 goal 状态变更是一条第 0 轮、来源为 goal 的 `user/message`，其 source 携带完整变更；正数轮次则是一条已准入的继续执行提示词。`decodeGoalEvent` 接收一条 `user/message`，并在 goal 状态内容与其类型化 source 不一致时立即报错。

**`send` 不返回标识。** 调用方已经持有完整消息及其不透明的 `MessageId`；消息的创建与冻结由[带标识的不可变消息值决策](2026-07-28-identified-immutable-message-values.md)负责，而不是由路由负责。

**Inbox 生命周期事件携带单次入队标识。** `agent/inbox/enqueue`（一个队列项进入某个 FIFO）、`agent/inbox/update`（待处理的 queued 项被编辑）、`agent/inbox/dequeue`（驱动器认领一个项）和 `agent/inbox/discard`（待处理项被丢弃）都会携带一个 `InboxItem`：仅属于本次入队的 `InboxItemId`、已接受的 `UserMessage`，以及生产方在接受消息时捕获的已解析 `queued | steering` 放置方式。单次入队标识让观察方和重连镜像能够区分同一 `MessageId` 的多次发送，无需根据后续状态或会话历史重建路由。注入从不触及 FIFO，也不发出这些事件中的任何一个。每次 FIFO 入队都会发布一个 enqueue，并且恰好发布一个终态 dequeue 或 discard；update 不是终态。`dsh-agent` 的不变量配套断言这种 FIFO 守恒。

**准入接受 next-step 输入，但不会因此成为一个轮次。** 循环会在 `agent/prompt-submit` 前打开一个私有的 next-step 接受窗口，使其贯穿整个轮次，并在 `turn/end` 前关闭。因此，在准入期间收到的 steering 和注入会一起留在 outbox 中并加入已准入的轮次。如果准入被阻止或失败，仅含调用方上下文的批次会采用空闲注入的立即追加行为，而 steering 及与其一同暂存的上下文仍可重试；两种路径都不会写入被拒绝的提示词。后续提示词获准时，保留在 outbox 中的输入会先于该提示词进入其轮次，而当前准入期间接受的输入则留在提示词之后。在 `turn/end` 前关闭窗口，可以保留这样的规则：可重入的晚到 steering 会成为一个独立的排队轮次。`Agent.acceptsNextStep` 会公开一次 `next-step` 发送当前是否会加入该窗口；`status` 仍是更宽泛的活动信号，而非路由判据。

**一条已接受消息只保留一种表示。** 持久的用户角色输入和附加的模型可见上下文都直接使用带标识且冻结的 `UserMessage`。循环把该值与私有路由状态存放在一起，不会将其标识、内容或来源复制到另一种公开形状中。一条成为 steering 的排队消息会在 outbox 中保留同一个消息值，而注入和工具产生的上下文则各自携带带标识的消息。[带标识的不可变消息值决策](2026-07-28-identified-immutable-message-values.md)取代了本记录此前的 `UserMessageData`/`AgentMessage` 层级，并将这一表示扩展到 assistant 消息和工具结果消息。

**空闲唤醒在接受之后发生。** 在发布 enqueue 前，一次会唤醒驱动器的排队发送会先取得完全停稳所有权，并把驱动器准入调度到一个会在该次发送返回 id 后运行的微任务中。因此，同一同步调用栈中的每次发送都会基于同一份准入前状态解析放置方式，而可重入的取消或拆除在已调度的准入结算前无法完成退役。空闲时的两次 `steer()` 调用会保留为两个 FIFO 轮次，而不会因第一次调用打开准入窗口而把第二次吸纳进去。

**cancel 新增 keepInbox。** `cancel(cause, { keepInbox? })`；调用方显式选择 cause，且 `keepInbox: true` 会中止活跃轮次，同时保留排队项和 steering 项（不发出 discard 事件，尚未启动的工作也不会被丢弃）。

## 考虑过的替代方案

- **为注入内容设立专门的 `MessageSource` 类别 `context`。** 不予采纳，因为 `plugin` 已经表示“不是人类”，因此第四种类别会增加一条平行的轴，让授权检查不得不去学习它。由插件产生的注入上下文会显式提供其 plugin 来源。
- **在 `UserMessage` 上设一个类型化的判别字段**（例如 `origin: 'prompt' | 'context'`）来取代事件类型的区分。不予采纳，转而采用 `source`——每个消费方都已经携带它，goal 系统也已经以它为键；第二个判别字段会重复这一事实。
- **在 inbox 事件之外保留 `agent/queued`。** 作为镜像而被否决：`agent/inbox/enqueue` 是同一个入队时刻的信号，只是带有已解析的放置方式，而 dequeue/discard 事件补全了单个事件无法描述的 FIFO 生命周期。
- **根据 agent 状态或会话日志推导 inbox 放置方式。** 不予采纳，因为 `running` 同时涵盖准入与结算，而重连基线即使缺少此前的轮次边界，也需要最初的接受结果。生产方已经拥有精确的路由决策。

## 后果

投递接口现在是一个原语加三个自解释的预设，(`target` × `wakeup`) 矩阵把此前无法表达的组合显式化。一种持久消息类型同时服务提示词、注入的上下文和 goal 轮次，因此对外接口的投影和每一处“是否人类提示词？”检查都简化为一次 `source` 判断。`Agent` 契约仍是接口，因此其他实现和对象字面量形式的测试替身只需实现同一个最小结构接口。goal 折叠的通道区分从事件类型改到了 `source.round`；此前过滤 `context/message` 的每个消费方现在改为按来源过滤 `user/message`。空闲状态下的注入会在两个轮次之间追加 `user/message`，既不打开轮次，也不运行模型。

`wakeup` 是“模型是否应当运行”的信号，因此 inbox 会区分能唤醒的排队工作与任何可 dequeue 的项：一个孤立的 `next-turn`/no-wakeup 队列项会在空闲状态保持停泊，并随下一次会唤醒驱动器的 send 一同出队；`whenIdle`/`cancel` 则依据唤醒信号判断何时达到完全停稳。每一次 FIFO 退出都恰好发布一个生命周期事件，特定于领域的持久事实则通过类型化消息 source 传递，而非通过平行的元数据通道。直接使用待处理项的表示方式，使公开生命周期事件保持可关联，既无需维护第二个 steering 包装层，也避免其持久数据发生分歧。后续的[可寻址队列操作](../feature/2026-07-29-addressable-queue-operations.md)决策在该单次入队标识上增加了实时变更，但不改变单消息单轮次或持久消息契约。

## 相关

- [one-send-one-turn](../simplification/2026-07-17-one-send-one-turn.md)——本决策所依托的“每轮次只认领一条消息”规则。
- [remove-agent-steering-mirror](../../archived/simplification/2026-07-04-remove-agent-steering-mirror.md)——折叠镜像实时事件的先例。
- [explicit-turn-cancellation](2026-07-16-explicit-turn-cancellation.md)——`keepInbox` 所扩展的取消原因信号。
- [带标识的不可变消息值](2026-07-28-identified-immutable-message-values.md)——本路由决策现在所依托的消息标识与表示契约。
