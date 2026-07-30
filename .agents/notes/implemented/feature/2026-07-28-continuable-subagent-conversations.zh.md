# Agent Note（agent 决策记录）：可继续的 subagent

Status: implemented

[English](2026-07-28-continuable-subagent-conversations.md) | 中文

本记录取代[可继续的后台 subagent](../../implemented/feature/2026-07-21-continuable-background-subagents.md)中由 Task 支撑的继续执行管理器。它保留[将 subagent 控制合并到 subagent 服务](../../implemented/simplification/2026-07-26-merge-subagent-control-service.md)确立的单一 `ctx.subagents` 服务，以及[以意图命名的 subagent 继续执行操作](../../implemented/simplification/2026-07-27-intent-named-subagent-continuation-operations.md)确立的 `followup` 操作。

## 问题

以前的继续执行管理器让一个 Task、一次提供方执行和一个结果边界共享同一生命周期。Task 结算会 dispose（资源释放）child Agent，Task 完成会注入完成通知，后续输入则重建另一个 Agent。这曾使通用后台工作抽象与会话投递耦合，而可继续 subagent 已经具备会话和 Agent inbox。

如果继续执行管理器为 parent 请求排队，而 Agent 接收用户消息，系统就会出现两个 FIFO，且没有唯一的顺序权威。而把两种消息都交给 Task，则重复了 agent loop（智能体循环）已有的准入、取消和完全停稳机制。`Agent.whenIdle()` 无法恢复单项请求的 Task 结果，因为一个运行区间可能清空多个排队轮次；宽泛的 `Agent.cancel()` 也不能精确移除一项排队请求。

运行时生命周期也比单个轮次更长。subagent 可能已经结束自身轮次，但它创建的 child 仍在运行。此时 dispose parent 运行时，会移除仍负责后代拆卸的 Agent。反之，如果让所有历史 subagent 始终驻留，内存使用就会失去上界。

用户和 parent Agent 还需要在不改变当前轮次的前提下，向同一个在线 child 发送后续工作。将每条继续执行消息作为 follow-up 排队，可以让两类发送方遵循同一项排序规则。

## 决策

一个可继续 subagent 拥有一个持久化会话，并且至多拥有一个进程内激活：

```text
persisted Session
  -> optional live Activation
       -> one retained AgentHandle
       -> Agent inbox as the only turn FIFO
       -> zero or more owned child Activations
```

激活是重建 child Agent 的一次驻留周期。它可以执行多个 FIFO 轮次，并在等待后代时保持驻留。它不是请求、结果、取消或 Task 边界。

继续执行管理器负责激活准入、权限检查、在线所有权图、冷恢复和 child-first dispose。Agent loop 负责全部轮次排序与执行。没有任何可继续 subagent 拥有 Task、激活 FIFO 或 queued 激活状态。

### 物化与公开操作

具名 subagent 提供方只参与准备初始创建规格，此时 `spawn` 与 `fork` 有所区别。其可选的 `prepareContinuable(request): Promise<ContinuableCreateSpec>` 方法就是可继续创建能力。返回的规格只包含与 Agent 实例分离且由提供方决定的创建输入，例如可选的 parent 历史种子；它不包含 Agent、`AgentHandle`、提示词投递、结果、dispose 或恢复操作。管理器会预留 child 身份，解析持久化描述符和通用 Agent 配置，通过私有 activation-owner 作用域调用 `ctx.agents.create()`，将返回的 `AgentHandle` 安装到激活中，建立适用的可继续 parent 所有权，然后调用 `Agent.followup(initialPrompt)`。inbox 接受消息后会产生一个 `MessageId`；`ctx.subagents.startContinuable()` 在此边界返回 `{ childId, messageId }`，不等待轮次开始，也不等待消息写入会话日志。

inbox 接受消息前发生任何失败，操作都会在不返回任何 id 的情况下被拒绝。Agent 创建流程负责 handle 移交前的回滚；移交后，管理器会先 dispose 已创建的 handle、移除激活并回滚 parent `ownedChildren` 中的任何成员关系，再拒绝操作。

`backgroundMode: 'one-shot' | 'continuable'` 仍是部署策略。配置为 continuable 时要求存在 `prepareContinuable`；该方法是否存在会取代 `SubagentProvider.resume?()` 成为能力检查，而具备该能力的提供方仍可运行 one-shot 工作。

冷恢复不会通过 subagent 提供方分发。继续执行管理器会归并通用的进程内描述符，通过同一个 activation-owner 作用域调用 `ctx.agents.resume()`，安装返回的 `AgentHandle`，并提交等待中的 `next-turn`。`SubagentProvider.resume?()` 和 `SubagentProviderResumeRequest` 均不存在，初始提供方名称也不是恢复能力；远程提供方需要单独设计。

`SubagentProvider.start()` 和 `SubagentRun` 只保留在不变的 one-shot 路径上。可继续激活直接持有自身的 `AgentHandle`，绝不创建、包装或保留 `SubagentRun`；因此，`SubagentRun.steer?()` 不存在。

`ctx.subagents.followup(authority, childId, content, { source, signal })` 仍是唯一的继续执行消息操作。`authority` 可以是 `{ kind: 'parent', agent }` 或 `{ kind: 'user' }`；parent 变体仅能从确切的在线 Agent 工具上下文通过准入，只有可信宿主适配器才能提供用户权限。`source` 仍是持久化来源信息，不赋予任何权限。面向模型的 `send_message` 工具只保留稳定的 `subagent_id` 和 `message` 字段，并始终提交一个 follow-up 轮次。start 和 follow-up 都返回已接受的 `MessageId`，两者都不报告管理器如何物化激活。

对于 start 和 follow-up，调用方 signal 只在 inbox 接受消息前持有查找、物化和准入。操作返回 `MessageId` 后，管理器会独立持有该激活；调用方之后的取消不会取消已接受的轮次，也不会 dispose child。

### 持久化会话与在线激活

会话持有稳定的 child 身份、transcript（文本记录）、直接 parent 谱系、委派深度和带版本的继续执行描述符。`SessionHeader.parentSession` 是持久化来源信息和鉴权输入；它不是在线路由能力，也不表示历史 parent 仍然驻留。

空闲的历史会话没有 `AgentHandle`。第一条通过鉴权的 `next-turn` 投递会根据持久化会话恢复激活，并将消息提交到其 inbox。经用户授权的冷恢复不会加载历史 parent Agent。parent 发起的恢复使用经过身份认证的确切在线 parent Agent 执行鉴权；当该 parent 有激活时，还使用它建立所有权，但绝不使用 parent 执行重建。

激活作为消费方会直接持有已发布的 `AgentHandle` 直至结算，而管理器的私有 activation-owner 作用域则是其 Cordis 结构化所有者。可继续 subagent 路径不创建任何中间的带结果执行包装层，包括 `SubagentRun`；一次性委派保持不变，且不属于该生命周期。远程提供方不在此处的范围内，引入时需要单独的激活所有权契约。激活 dispose 后，历史会话不消耗运行时内存。

### 激活生命周期

公开生命周期只有 3 个状态，没有 `queued` 状态：

```text
running
  | Agent quiescent with live children
  v
waiting
  | next-turn
  +--------------------------> running

running or waiting
  | Agent quiescent and no live children
  v
settled
  | AgentHandle.dispose completes
  v
no Activation
```

`running` 表示 Agent 正在执行准入或轮次，或者 inbox 中存在会唤醒 Agent 的工作。`waiting` 表示 Agent 已经完全停稳，但激活仍持有至少一个尚未完成 dispose 的 child 激活。`settled` 表示 Agent 已经完全停稳且所有持有的 child 都已 dispose；随后管理器会 dispose `AgentHandle` 并移除激活。

管理器根据 Agent 是否完全停稳以及所持 child 集合派生这些状态，而不是维护第二套执行状态机。在 `running` 时投递的 `next-turn` 会进入 Agent inbox。在 `waiting` 时投递的 `next-turn` 会唤醒同一个 Agent，并使激活回到 `running`。在 dispose 完成后投递消息则会冷恢复新激活。

管理器会针对每个持久化 child，将投递、child 释放和 dispose 线性化。如果投递与最终 dispose 发生竞争，只有一方能越过准入截止点：投递要么进入仍在线的 Agent inbox，要么等待 dispose 完成后冷恢复新激活。任何调用方都不能向已经开始 dispose 事务的 handle 发送消息。

### 一个 inbox 与 follow-up 投递

Agent inbox 是唯一队列。每条继续执行消息都使用 `Agent.followup()`，并成为一个 FIFO 轮次；继续执行管理器和宿主都不维护另一条消息队列。每个已接受且会唤醒 Agent 的条目都会让当前激活保持在线，直至 `Agent.whenIdle()` 观察到完整的唤醒工作后缀已经结束。

路由只取决于激活的驻留状态：

| 激活状态 | 发送方 | `followup` |
|---|---|---|
| `running` | parent 或 user | 在同一激活中排队 |
| `waiting` | parent 或 user | 唤醒同一激活 |
| 无激活 | parent 或 user | 冷恢复新激活 |

继续执行层不定义单独的投递路由结果。成功投递 `ctx.subagents.followup()` 或 `send_message` 时会返回已接受的 `MessageId`，投递失败则会抛出异常。现有的 `agent/inbox/enqueue`、`agent/inbox/dequeue` 和 `agent/inbox/discard` 事件仍用于观测消息生命周期；适配器可以呈现通用的接受确认，但不暴露 `started`、`queued`、`resumed` 或其他 subagent 专属路由词汇。

### child 所有权

每次激活都持有自身的 `AgentHandle` 和一个 `ownedChildren: Set<SessionId>`。由于一个会话至多有一次在线激活，child 会话 id 足以标识在线 child，无需另一个运行时 incarnation 引用。`SessionHeader.parentSession` 记录持久化的直接 parent 身份，`ownedChildren` 中的成员关系则记录进程内所有权关系。

当经过身份认证的 parent 自身是由继续执行管理器管理的激活时，启动 child 或提交由 parent 发起的工作，会在 child 可以运行或消息可以进入其 inbox 前，将 child 会话 id 加入该 parent 的 `ownedChildren`。该集合非空时，这个 parent 不能结算或 dispose。顶层 Agent 或其他非继续执行 Agent 没有激活，也不会加入该等待图。

只有在 child Agent 完全停稳、该 child 持有的每个 child 都已 dispose、最终持久性检查点结算且 child 的 `AgentHandle` 完成 dispose 后，系统才释放 child。管理器会调用 `ctx.sessions.flush(child.session)`：只有 `true` 确认持久性，`false` 或 rejection 则统一报告为 `DURABILITY_FAILED`。检查点失败会被报告，但不会阻止 handle dispose 或释放所有权，因为保留失败的 child 会让其祖先永久固定在 `waiting`。如果 child 归 parent 所有，管理器随后会通过 `SessionHeader.parentSession` 解析在线 parent，并从其 `ownedChildren` 中移除 child 会话 id；由用户恢复且没有在线 owner 的 child 则没有需要释放的所有权记录。管理器拆卸使用相同的 child-first 顺序。

用户冷恢复会创建一次激活，但不会将其加入历史 parent 的 `ownedChildren`。如果直接 parent 随后向这个在线激活提交工作，且该 parent 自身由继续执行管理器管理，准入过程会在消息入队前建立所有权；非继续执行 parent 仍位于等待图之外。

系统会一直保留所有权，直至 child 激活完成 dispose。后续改进可以更早释放限定到请求的 lease，但这需要精确关联轮次完成，而本 Task-free 提案特意不增加该机制。

顶层拆卸由宿主负责，而不表示为另一次激活。宿主首先要求管理器同步进入 draining，拒绝新的创建、恢复和投递准入；然后按 child-first 顺序 dispose 整个在线激活森林，并等待全部 `AgentHandle.dispose()` 调用。只有该 drain 结算后，宿主才能 dispose 顶层 Agent 和管理器作用域。管理器卸载使用相同的 drain，并涵盖由用户恢复且没有在线 owner 的激活。

activation-owner 作用域之所以存在，是因为普通 Cordis owner effect 按注册逆序撤销，无法表达动态 child 图。管理器初始化时先注册私有作用域的结构化 disposer，再注册自身的 drain disposer，使逆序撤销先执行 drain、再释放该作用域；如果只在与后续 Agent handle 相同的作用域上注册 cleanup effect，结构化 handle dispose 就可能绕过 child-first 顺序。管理器在关闭准入后对在线根节点创建快照，在取消前停止自身的对外生命周期通知，并保留内部所有权簿记，直至每个 handle 都结算。每次激活有一个记忆化的 dispose promise，使宿主关闭、管理器卸载、child 释放和正常结算能够汇合，而不会重复释放。同级分支独立 drain；系统会记录单次 dispose 失败，但仍会尝试其余 handle，聚合 drain 则在所有分支结算后报告失败。这次进程内拆卸不会销毁持久化 child 会话。

### 延后的报告投递

本版本不暴露 `report` 工具，也不提供从 child 到 parent 的内容投递或自动唤醒 parent。持久化 child 会话仍是 child 详细输出的来源。

后续提案可以增加一个普通的面向模型 `report(output)` 工具；模型在一个轮次中可以调用它零次或多次。其投递策略可以区分静默注入 parent 与唤醒 parent；接收方选择、确认、持久性和重试语义均与该工具一并延后决定。增加报告投递无需引入另一个激活状态或执行队列。

### 延后的 steering（中途引导）

本版本不暴露 subagent steering 操作。parent 和用户的继续执行消息始终开启后续 FIFO 轮次，因此继续执行层不存储当前轮次控制方，也不新增能够感知控制方的 Agent 准入 seam。

后续宿主 UI 可以分别暴露 **Steer** 和 **Follow up** 操作。用户 steering 必须严格且仅限在线使用：只有当激活接受下一步骤时，它才能调用现有的 Agent steering 路径；其他情况必须拒绝，而且绝不能转为排队或冷恢复。是否通过面向模型的工具暴露 parent steering 仍需单独设计，因为不同的工具名称可以表达意图，却不能确定 parent 是否可以修改由用户控制的轮次。

### 权限与来源

权限来自可信宿主交互或确切的在线 Agent 工具上下文。`MessageSource` 和 `senderSessionId` 是准入后的持久化来源信息，不是由调用方控制的权限。

本版本授权宿主用户和持久化 child 的直接 parent。系统会根据经过身份认证的 parent Agent 检查 `SessionHeader.parentSession`，然后才将 child 注册到该 parent 的 `ownedChildren`。其他 Agent、祖先、团队和工作流仍被拒绝，直至系统具备显式权限协议。

用户权限可以在 parent 不在线时冷恢复 child。由 parent 发起的投递要求 parent 在准入时在线，并通过所有权关系使其继续在线。

### 持久性、dispose 与恢复

没有 Task 后，系统不再提供 `task_output`、`task_kill`、Task 状态、逐消息结果 promise 或公开 subagent 取消操作。调用方 signal 只能在 inbox 接受消息前中止 start 或 follow-up。消息被接受后，parent 和用户都不能通过 `ctx.subagents` 取消该消息、轮次或激活；`Agent.cancel()` 仍是底层 Agent 能力，但本版本不通过 subagent 服务暴露它。

宿主和管理器拆卸仍是覆盖整个生命周期的停止路径。它会关闭准入，按 child-first 顺序 dispose 每个在线激活森林，并保留持久化会话。

每个轮次都会请求执行会话持久性检查点，激活最终结算时，管理器必须检查 `ctx.sessions.flush()`，而不能忽略其布尔结果。`true` 确认至少有一个持久性 listener 参与，且所有 listener 都成功结算。`false` 或 rejection 会报告 `DURABILITY_FAILED`；普通后台结算会记录该生命周期失败，显式的宿主或管理器 drain 则会在所有分支结算后，将其纳入聚合 rejection。无论结果如何，管理器仍会 dispose handle 并释放所有权，后续恢复时持久化 child 状态可能缺失或陈旧。

只有实际写入 child 会话日志的消息，才能根据其准入来源重建；仅被 inbox 接受并不提供重启保证。

会话和描述符的持久化状态可在重启后保留。激活状态、Agent inbox 内容和所有权图都是进程内状态。进程崩溃可能丢失已被接受但仍留在 inbox、尚未写入会话日志的初始提示词或 follow-up。会话和描述符可能保留，因此后续获得授权的消息仍可冷恢复 child，但丢失的消息不会自动回放。恢复已接受但未完成或未写入日志的消息需要持久化 inbox 协议，本提案不隐含该能力。

### 范围

本版本覆盖可继续的进程内 child，一次性委派保持不变。远程提供方必须具备单独的激活 handle，以及等价的认证控制与 child-first 完全停稳契约，才能支持同样的行为。

它不新增 subagent steering 操作、报告工具、从 child 到 parent 的内容投递、自动唤醒 parent、持久化邮箱、跨进程 lease、中断 inbox 工作的自动回放、团队权限、工作流权限、公开 subagent 取消操作、新的在线激活数量或后代总数限制，以及运行时缓存。现有委派深度策略保持不变。

## 曾考虑的替代方案

**保留由 Task 支撑的激活。** Task 可以提供通用状态、结果收集和取消，但使用 Task 投递会话会产生第二条队列，并重复轮次所有权。本提案放弃这些通用 Task 控制，让 Agent inbox 成为唯一执行顺序。

**每个 `next-turn` 创建一次激活。** 这会恢复独立的结果与取消边界，但需要在 Agent inbox 旁维护管理器 FIFO，还会使所保留的 Agent 跨越人为划分的激活边界。每个驻留周期对应一次激活更小，也直接跟随 `AgentHandle` 生命周期。

**等待期间 dispose Agent。** child 仍属于上一个进程内所有权图时重建 parent，需要持久化所有权与拆卸协议。只为尚未完成的所有权图保留 `AgentHandle`，可以在不让已结算历史驻留的前提下，保留 child-first 拆卸。

**让提供方通过 Agent handle 创建、恢复 child 或投递消息。** 初始提供方只持有 `prepareContinuable()` 及其分离式创建规格这一项差异：child 是全新启动，还是带有 parent 前缀。管理器必须通过私有 activation-owner 作用域自行调用 `ctx.agents.create()`，使该作用域成为每个 handle 的结构化所有者。持久化的进程内会话已经包含初始前缀及通用重建描述符，消息投递则属于 Agent inbox。让提供方持有任何后续 handle、`SubagentRun` 或消息所有权，会保留一条没有已发布行为可承载的 seam，还会因不必要的在线 parent 输入使用户冷恢复更加复杂。

**现在就增加报告投递。** 可重复调用的面向模型工具与该生命周期兼容，但静默投递还是唤醒投递、接收方选择、确认、持久性和重试行为都是独立的产品决策。延后该工具，可以让首个版本专注于会话准入与驻留，又不限制后续策略。

**将 `SessionHeader.parentSession` 视为在线所有权。** 持久化谱系不能证明历史 parent 当前持有 child。在线 parent 的 `ownedChildren` 成员关系会记录进程内关系，而不改变持久化来源。

**在单独的 link 中保留确切的 parent Agent。** parent 激活已经持有自身 `AgentHandle`，而且 `ownedChildren` 会在 child 仍然在线时阻止该激活 dispose。因此，通过会话 id 解析 parent 已经足够，也可以避免冗余的运行时引用。

**为 parent 消息维护单独队列。** 第二个 FIFO 会让它和 Agent 已接受的用户消息之间顺序不明确。单个 Agent inbox 为两种来源提供唯一且可观察的顺序。

**现在就暴露 subagent steering。** 用户 steering 可以是严格且仅限在线使用的宿主操作，但 parent steering 需要当前轮次控制方状态，以保护由用户控制的轮次。首个版本将每条继续执行消息都排队，可以避免引入该状态及其准入竞争。后续 UI 可以新增一项仅限用户的独立操作，而不改变 follow-up 排序。

**返回 subagent 专属的投递路由。** `started`、`queued` 和 `resumed` 等标签重复了激活与 inbox 状态，却没有给调用方提供独立结果。复用 `MessageId` 和现有 inbox 事件，可以让投递关联继续由其所属的 Agent 契约承载。

**使用 child 引用计数。** 计数无法识别哪个 child 仍持有拆卸工作，也允许重复递减错误。身份集合会显式保留取消和 dispose 义务。

## 影响

本实现固定了以下行为：

- 可继续 child 至多拥有一个在线激活和一个 Agent inbox；继续执行管理器没有激活 FIFO 或 queued 激活状态。
- `SubagentProvider.prepareContinuable?()` 只返回分离式 `ContinuableCreateSpec`；配置为 continuable 时要求具备该能力，而 `backgroundMode` 仍是独立的策略选择。
- 管理器通过私有 activation-owner 作用域调用 `ctx.agents.create()`，安装返回的 `AgentHandle` 并建立 parent 所有权，调用 `Agent.followup(initialPrompt)`，然后在 inbox 接受消息并产生 `MessageId` 时返回 `{ childId, messageId }`，而不等待轮次开始或消息写入会话日志。
- 初始提示词被 inbox 接受前的每条失败路径都会导致操作被拒绝且不返回 id，并回滚已创建的任何 handle、激活和 parent `ownedChildren` 成员关系。
- 冷恢复由继续执行管理器调用 `ctx.agents.resume()`，绝不通过初始 subagent 提供方分发；`SubagentProvider.resume?()` 和 `SubagentProviderResumeRequest` 均不存在。
- 可继续激活直接持有 `AgentHandle`，绝不创建、包装或保留 `SubagentRun`；`SubagentProvider.start()` 和 `SubagentRun` 只用于 one-shot，且没有 `SubagentRun.steer?()`。
- 用户可以在不加载历史 parent 的前提下冷恢复持久化 child。
- `followup()` 只接受可信 parent 或用户权限；持久化消息来源信息不能授权投递。
- Parent 和用户的继续执行消息始终使用 `Agent.followup()` 并共享其 inbox FIFO，包括一种来源排在另一种来源之后，以及 child 已有开放轮次的情况。
- `ctx.subagents.followup()` 及其 `send_message` 适配器只返回已接受的 `MessageId`；继续执行层不接受投递 target，也不定义 subagent 专属路由结果。
- 本版本不暴露公开 subagent 取消操作；调用方 signal 只能在 inbox 接受消息前停止 start 和 follow-up，宿主和管理器拆卸则保留 child-first 全局清理。
- 本版本不暴露 subagent steering 操作或当前轮次控制方状态。
- 带有在线所持 child 的空闲 Agent 会产生 `waiting` 激活，其 `AgentHandle` 继续保留。
- 向 `waiting` 投递 `next-turn` 会唤醒同一个激活；完成 dispose 后投递消息会冷恢复新激活。
- 每个由继续执行管理器管理的 parent 激活只会在直接持有的所有 child 激活完成 `AgentHandle` dispose 后进行 dispose；顶层 Agent 不加入等待图。
- 激活最终结算时，只有 `ctx.sessions.flush(child.session) === true` 才确认持久性；`false` 和 rejection 会报告 `DURABILITY_FAILED`，但仍会 dispose child handle 并释放 parent 所有权，使持久性失败不会泄漏 `waiting` 激活。
- 宿主和管理器拆卸会同步进入 draining，拒绝新的物化和投递，停止由管理器负责的对外通知，按 child-first 顺序 dispose 处于快照中的整个在线激活森林，即使个别分支失败也会等待所有分支，之后才 dispose 顶层 Agent 和管理器作用域；私有 activation-owner 作用域会确保 Cordis effect 的逆序撤销不破坏该顺序，每次激活使用一个记忆化的 dispose promise，使并发的正常结算保持幂等。
- 本版本不暴露 `report` 工具，不提供从 child 到 parent 的内容投递，也不自动唤醒 parent。
- 会话日志只能根据准入来源重建实际写入的消息；已被 inbox 接受但未写入日志的消息没有重启保证。
- 可继续 subagent 路径不创建或依赖 Task、`TaskId`、Task 完成通知、Task 取消或中间的带结果执行包装层。
- 单元覆盖固定 `startContinuable()` 在 inbox 接受消息时的返回边界、每条接受前失败路径的完整回滚、接受前后两个阶段的调用方 signal 所有权，以及已接受但未写入日志的消息不会自动回放。
- 单元覆盖固定仅由驻留状态决定的路由表、单 inbox 顺序、通过 inbox 事件关联 `MessageId`、在开放轮次期间 follow-up、等待唤醒、冷恢复、所有权注册与释放、child-first dispose、发送与 dispose 的竞争、最终持久性检查点返回 `false` 和 rejection 时都不泄漏所有权，以及不存在公开 subagent 取消、steering 和报告工具这一事实。
- 一项无密钥整套应用快照覆盖 parent 委派、parent 与用户混合的 follow-up 排队、不存在 subagent steering、报告投递和自动唤醒 parent、保留等待中的 `AgentHandle` 以及 child-first dispose。

### 已接受的代价

移除 Task 会放弃通用后台工作检查、结果收集和精确 Task 取消。如果这些产品功能成为需求，就需要不会重新引入第二条执行队列的请求 ticket 或 inbox 能力。

在后代运行期间保留激活，会按尚未完成所有权图的规模消耗 Agent 资源。现有委派深度策略仍会限制嵌套层级，但本版本不新增在线激活数量或后代总数限制；已结算的历史会话不保留 `AgentHandle`。

进程内 inbox 和所有权图无法协调两个 harness 进程。允许多个进程并发访问同一持久化存储的部署，仍需要持久化 lease 和邮箱协议。

没有报告投递时，完成 child 轮次既不会把内容发送给历史 parent，也不会唤醒它。输出会保留在持久化 child 会话中，直至调用方检查该 transcript 或提交另一个经过授权的轮次。后续报告工具可以增加静默投递或唤醒投递，而无需改变激活生命周期。

将每条继续执行消息排队，意味着 parent 无法立即纠正正在进行的 child 轮次；纠正操作会在下一个轮次执行。后续仅限用户的 UI steering 操作可以缩短该延迟，而无需在此引入 parent 与用户之间的控制方策略。

最终持久性检查点失败时，运行时所有权图仍可完成 drain，但持久化 child 状态会缺失或陈旧。该失败会以 `DURABILITY_FAILED` 的形式被观测到；重试与修复需要单独的恢复设计。
