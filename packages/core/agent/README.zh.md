# dsh-agent

[English](README.md) | 中文

Agent 接口、注册表、进程本地发起方作用域，以及 `agent/*` 事件词汇。每个插件（UI、钩子、编排器）都面向此处定义的 `Agent` handle 编程；它不依赖循环，因此循环可以替换。

可选配套包 `@deepseek-ai/dsh-agent/invariant` 会向 `ctx.invariants` 注册此包的 agent 状态转换检查。根 agent 服务不会隐式加载诊断。

## 服务：`AgentRegistry`（ctx 键：`agents`）

跟踪实时 agent，并在异步驱动器工作中携带发起调用的 Agent，而无需导入具体循环包。

### 公开 API

带作用域的注册表层：`Agent.ctx` 是 agent 的作用域上下文（`dsh-scope`，键 = 该 agent）。通过它注册工具／段／变量／监听器，只对该 agent 生效，并在释放时全部撤销。`agentEvents(ctx, agent)` 是普通 agent 主体操作的融合分发器（一次完成载体 + 注入主体）；其通知 mode 会调用每个监听器，并同时收容同步抛出和返回 Promise 的拒绝。注册表生命周期对复用一个稳定路由载体。`assembleContextFor(agent)` 构建按 agent 的组装上下文（同时包含 `agent` + `scope`）。`installAgentLlmTarget(agentCtx, target)` 在提示词组装期间快照可变的提供方／模型／推理（reasoning）强度选择，将路由应用到提示词变量，并将完整目标应用到一个步骤的请求路由；如果没有选定推理强度，则会清除继承的推理强度，使该目标使用适配器／提供方默认值。`CreateAgentOptions.setup(agentCtx)` 和 `ResumeAgentOptions.setup(agentCtx)` 在新建或恢复的 agent 尚未发布时，组合其带作用域的世界。Setup 是受信任、仅用于组合的同进程代码：只有创建完成后才能驱动 agent。

`AgentOptions` 提供初始的提供方／模型路由，以及可选的正整数 `maxTokens` 输出上限。实体循环会把该上限记录到请求 header，并应用到每次对话模型请求；调用方省略时由提供方默认值控制。

- `ctx.agents.register(agent: Agent): () => void`：记录一个 **已经构造完成** 的 agent。随调用 fiber 释放。
- 高级有序生命周期：`enter(agent, owner): () => void` 强制 `agent.id === agent.session.id`，执行权威 ID 冲突检查，并在不通知的情况下插入；`owner` 显式记录实时创建方 agent 关系（根 agent 为 `undefined`），与持久会话谱系无关。`announce(agent)` 恰好发出一次 `agent/created`。创建监听器同步请求的 detach 会延后到该次分发结束；每次 detach 都会检查捕获的条目对象，因此陈旧能力无法删除后续使用同一 ID 的替代项。异步工厂使用这一拆分；普通插件使用 `register()`。
- `ctx.agents.get(id: SessionId): Agent | undefined`
- `ctx.agents.isOwnedBy(id: SessionId, owner: Agent): boolean`：该确切实时条目是否通过父 agent 的作用域上下文创建；运行时所有权与持久会话谱系无关。
- `ctx.agents.list(): Agent[]`
- `ctx.agents.roots(): Agent[]`：在没有所属 agent 上下文的情况下创建的实时 agent；带谱系的恢复会话仍可能是运行时根。

#### 发起方 Agent 作用域

`AgentLoop` 在发起方边界内运行每个具体驱动器的完整生命周期。并发驱动器彼此隔离：子驱动器的 continuation 携带子 agent，而 `withInitiator()` 返回后，父 continuation 立即重新取得父 agent；drain 跟踪持续到子驱动器的 Promise 结算。创建、持久化加载和未发布 setup 位于子边界之外，因此由父 agent 发起的 setup 会继承父 agent，而 `agentCtx.agent` 显式标识子 agent。

- `ctx.agents.currentInitiator(): Agent | undefined`：读取继承的发起方，不要求其存在。
- `ctx.agents.requireInitiator(): Agent`：读取发起方，缺席时抛出 `no initiating agent is active`。
- `ctx.agents.withInitiator(agent, operation)`：使用一个确切 Agent 运行，并保留操作的确切同步值或 Promise。
- `ctx.agents.withoutInitiator(operation)`：对无关的进程本地工作隐藏继承的发起方。

该作用域携带 `Agent` 本身，并且只在进程内有效。环境中的身份既不是存活证明，也不是授权；在服务、worker、进程、持久化和 wire 边界，显式 Agent 字段仍是权威来源。Teardown 会拒绝新边界，允许注入的依赖方和返回 Promise 的边界 drain，然后禁用底层 `AsyncLocalStorage`；未返回的工作仍归将其分离的子系统所有。如果某个边界继承的异步链开始卸载一个拥有它的 Cordis fiber，该嵌套边界链会从 drain 中释放，使卸载不会等待自身；其 continuation 会在 teardown 后观察到已释放的服务。详细边界与 teardown 契约由[发起方作用域决策](../../../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.md)拥有。

#### 工厂 seam（创建）

Agent *创建* 由实现 `AgentFactory` 的插件（`dsh-agent-loop`）提供，并通过 `setFactory` 注册。这样，创建功能留在 `dsh-agent` 接口上，消费方（UI、ACP 桥接层）可以面向 `ctx.agents` 编程，而不依赖具体循环包。注册表会把已经 traced 的 Service 规范化为具体目标，并通过调用方上下文重新 trace 每次调用；这既避免嵌套 Cordis shadow，也会把显式、绑定调用方的 `ownerCtx` 传给普通工厂。

- `ctx.agents.setFactory(factory: AgentFactory): () => void`：注册创建工厂（循环在构造时调用）。第二个工厂会导致抛出；释放时清空槽位。
- `ctx.agents.create(options: CreateAgentOptions): Promise<AgentHandle>`：创建会话和 agent，在不发布的情况下等待可选 setup，然后通过最终的 `SessionStore.enter()` 与 `AgentRegistry.enter()` 检查发布。不支持并发创建同一 ID：多个操作可以进行准备，但只有一个能进入；每个失败方都会回滚其私有作用域／会话／驱动器。可选且只用于创建的 `signal` 会取消未发布的 setup，并在返回 handle 前分离；之后的取消使用 `handle.dispose()` 或 `agent.cancel()`。发布包含在回滚范围内，回滚期间每条已交付创建边都会成对处理。未注册工厂时拒绝。
- `ctx.agents.resume(options: ResumeAgentOptions): Promise<AgentHandle>`：加载持久化会话（[会话持久化](../../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md)），创建新的未发布 agent 作用域，等待可选 setup，并使用相同的最终进入发布序列。其可选 `signal` 同样只用于创建。未注册工厂或未配置会话持久化时拒绝。

`AgentHandle = { agent: Agent; dispose(): Promise<void> }`。Disposer 是一项 **消费方能力**；仅持有裸注册表条目的观察方不能 teardown agent。调用方 fiber 和已注册工厂提供方是结构化共同拥有者：调用方卸载会强制结构化所有权，而工厂卸载必须停止旧实例，因为它们的作用域依赖表层属于该提供方。任意拥有者调用 `dispose()` 都会到达同一个记忆化静默边界：它停止循环，等待循环退出，注销 agent，从存储中移除其会话，最后撤销其作用域世界。`ctx.agents.get(id)` 仍返回裸 `Agent`；ACP 桥接层与进程内 subagent 后端持有消费方 handle，而配置创建的 agent 已由循环 fiber 拥有。

### 实时事件

`dsh-agent` 声明实时 `agent/*` 协调词汇，使插件不必依赖具体循环。确切签名、分发 mode、作用域筛选规则与 payload 契约位于生成的 [Cordis 事件目录](../../../docs/cordis-catalog/events.md)；[架构轮次流](../../../docs/architecture.md#turn-flow) 展示它们与持久会话事件的相对顺序。

生命周期边有两个重要的本地注意事项。`agent/created` 在作用域 setup 之后、会话与 agent 注册表条目都存在之后运行。Setup 是受信任、仅用于组合的代码；紧随其后且不可 veto 的 `agent/session-start` 通知是第一个受支持的启动注入点。`agent/disposed` 始终表示确切 agent 已离开注册表。AgentLoop 在其驱动器静默后发出该事件，而有序 teardown 此时可能仍在分离会话并撤销作用域；直接注册的自定义 agent 自行拥有任何更强的驱动器顺序契约。

大多数拦截点都是协作式 waterfall。轮次作用域的异步 seam 接收一个显式 `AbortSignal`，其中 `signal` 紧邻 waterfall 最终的 `next`；监听器可以配合，但不得将它保留为控制另一轮次的权限。`agent/step` 是派生请求前的串行检查点，而 `agent/request-error` 是失败模型请求的恢复 waterfall：失败步骤关闭后，它接收确切错误、规范化失败事实和信号。拥有恢复权的监听器返回 `{ kind: 'retry' }` 且不调用 `next()`；循环会关闭失败轮次，并打开一个编号重试轮次。`agent/turn-stopping` 在本可完成的轮次关闭前运行。普通排队提示词保持原样。有效的广义取消会先发出只观测的 `agent/cancel-requested` 及其解析后的类型化原因，再清空队列并中止；通知失败会被收容，不能 veto 停止。信号生命周期由[显式取消决策](../../../.agents/notes/implemented/architecture/2026-07-16-explicit-turn-cancellation.md)拥有；作用域分发与终止结算由 [agent 作用域 runtime 设计 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-12-agent-scope-runtime-design.md#three-execution-boundaries-are-deliberately-one-way)拥有。

`PromptDecision.additionalContexts` 是数组，因此每个上下文都保留自己的来源。获准的提示词内容与每个附加上下文都会在轮次运行前成为各自独立、面向模型的 `user/message` 事件。包装下游允许决策的监听器会保留其 `content` 与 `additionalContexts`，除非有意替换任一字段；返回的允许决策是权威来源。

轮次和步骤边界以及模型 token 流是持久 `session/event` 事实，而不是镜像的 `agent/*` 通知。消费方从会话 feed 读取 `turn/*`、`step/*` 和 `assistant/chunk`；工具策略与结果观测属于 [`dsh-tools`](../tools/README.md) 记录的完整流水线。

### Agent 接口（`types.ts`）

每个插件面向的 handle：

- `agent.send(input, options)`：覆盖（`target` × `wakeup`）矩阵的唯一投递原语。`input` 是既有的 `UserMessageData { content, source }`，而 `SendOptions` 只要求路由策略 `target` 与 `wakeup`。agent 会在发布或入队前为 `input` 创建快照并将其冻结，因此调用方或观察方后续的修改无法改变已接受的消息。它返回被接受消息的不透明 `AgentMessageId`，由该消息的 `agent/inbox/enqueue`/`dequeue`/`discard` 事件携带，调用方可据此把排队项与其生命周期关联；入队事件还会携带解析出的 `queued | steering` 路由归类，使监听器无需从后续状态重建接收时的路由。`target: 'next-turn'` 排队一条独立 FIFO 项，获准后成为其轮次中唯一的普通提示词。`target: 'next-step'` 且 `wakeup: true` 提交 steering（中途引导），而 `target: 'next-step'` 且 `wakeup: false` 注入持久上下文，不运行模型。轮次原理由 [one-send-one-turn Agent Note](../../../.agents/notes/implemented/simplification/2026-07-17-one-send-one-turn.md)拥有。
- `agent.followup(input)`：`send()` 的 `next-turn`／wakeup 预设：排队一个普通后续轮次并唤醒驱动器。
- `agent.steer(input)`：`next-step`／wakeup 预设：提示词接纳期间或轮次打开时，为下一个安全边界暂存 steering，且不分发 `agent/prompt-submit`；该接收窗口之外则委托给会唤醒的后续轮次。接纳失败会保留暂存的 steering，以供重试或之后获准的提示词使用，而取消或 dispose 可能丢弃它。
- `agent.inject(input)`：`next-step`／不唤醒预设：追加面向模型的上下文而不运行模型；下一次请求会看到一条逐字的 user role 消息，其来源由必填的 `input.source` 携带。提示词接纳期间或轮次打开时，注入会在 outbox 中等待下一个安全边界。该接收窗口之外，它会立即追加而不开启轮次；如果接纳结束却未开启轮次，仅含上下文的接纳批次会采用这一回退，而与 steering 一同暂存的上下文则会随其继续待处理。持久化独立地响应 `session/event`。注入不发出 `agent/inbox/*` 事件。
- `agent.acceptsNextStep`：当前发送 `next-step` 时，是否会加入提示词接纳或已打开的轮次。当调用方必须在 steering 与新接纳的提示词之间选择时，应使用这一更窄的路由判定；`status === 'running'` 还涵盖接纳收尾与轮次结算阶段。
- `agent.cancel(cause, options?)`：取消活动轮次，并在未设置 `options.keepInbox` 时取消全部待处理工作。调用方必须显式选择 `user | parent` 原因；活动持有者会在中止前把其判别字段复制为已分离、冻结的信号原因。有效调用会在清除排队与 steering 工作前，随原因发出 `agent/cancel-requested`；丢弃项在 `agent/inbox/discard` 上报告，观察方可以同步状态，但不能 veto 取消。`keepInbox: true` 会中止轮次，但保留排队与 steering 项（不丢弃，且不删除尚未开始的工作）。同进程类型化 seam 不会为无类型调用方添加运行时校验或兼容回退。重复取消活动轮次时，首个信号生效；空闲取消是安全空操作，不发通知。ACP 映射到 `user`，进程内父传播映射到 `parent`。原因只存在于运行时；持久 `turn/end` 保持粗粒度的 `aborted`。
- `agent.whenIdle()`：agent 从 `running` 结算后达到静默时解析（idle ⇒ 立即；disposed ⇒ 等待循环退出）。这是非拥有者的静默观测钩子：观察工作结算，但不 teardown agent。Teardown 独立存在；生命周期拥有者通过 `AgentHandle.dispose()` 停止并注销，并直接等待循环退出。
- `agent.session`、`agent.status`、`agent.options`、`agent.id`

`running` 描述驱动器范围的 drain 区间，而不是轮次仍打开的证明；它可以覆盖轮次关闭、持久性检查点和连续的排队轮次。

### 扩展点

- Agent 创建：`AgentLoop.create()` 是具体配置路径实现（位于 `dsh-agent-loop`），程序化消费方则通过 `ctx.agents.create()`/`ctx.agents.resume()` 创建或恢复有所有权的 agent。替换循环时，应实现 `Agent` 并通过 `ctx.agents.register()` 注册。
- 事件监听器：全部 `agent/*` 事件都在此处声明，不需要依赖循环包。
- Subagent 委派不是 `Agent` 方法；提供方通过工厂 seam 创建或驱动普通 handle，因此委派传输留在核心 agent 接口之外。

## 模型体验

### 用户、steering 与注入消息

#### 模型所见

`send`、`steer` 与 `inject` 会向所属会话提供输入。`agent/prompt-submit`、`agent/step` 和其他已声明事件让插件能够阻止提示词或添加持久请求材料；此接口本身不贡献固定文案。

#### Token 影响

已接受内容成为保留历史或重复会话前缀；被阻止内容不贡献请求 token。大小取决于调用方与插件。

#### KV Cache 影响

已接受历史与 steering 只追加；被阻止的提交不发送请求。会话前缀在循环实例内保持稳定，而新建或恢复的实例可能建立不同前缀。

### Agent 作用域的请求组合

#### 模型所见

通过 `agent.ctx` 进行的注册可以遮蔽提示词段或工具，也可以在未发布 setup 期间安装仅适用于该 agent 的拦截器。

#### Token 影响

此包自身不增加 token；带作用域贡献只影响该 agent，并在释放时消失。

#### KV Cache 影响

只要 agent 的作用域注册不变，前缀就保持稳定。改变提示词段、工具定义或请求监听器的 setup 或 reload，可能从第一个受影响的请求 token 起使复用失效。

## 已知限制与延后工作

- **发起方作用域只存在于进程内**：worker、子进程、HTTP、持久队列和重启会显式物化所需身份。
- **环境身份可能比存活状态更久**：消费方在生命周期敏感工作前，仍要检查 `agent.status`、取消状态和所属能力契约。
- **委派以外的 agent 间通道**：共享状态、流式子输出和后台／轮询语义仍在当前同步 `ctx.subagents` seam 之外。
- **`agent/session-start` 不能为启动设置门禁**：它仍是同步且不可 veto 的通知；必须在发布前完成的异步组合属于工厂的 `setup(agentCtx)` 事务。
- **`cancel()` 默认清空 inbox**：它会中止正在处理的轮次以及排队和 steering 工作；`cancel(cause, { keepInbox: true })` 只中止轮次并保留待处理项。仍不存在只中止步骤、同时让正在处理的轮次继续运行的操作（[停止表层 Agent Note](../../../.agents/notes/implemented/simplification/2026-06-20-public-agent-stop-surface.md)）。
- **每条附加 `UserMessageData` 恰好携带一个 `MessageSource`**：多个插件合并到一次工具调用上的贡献会归入一个来源；无法表示混合来源。
- **`SessionStartSource` 预留 `'clear'`/`'compact'`，但还没有发出方**：在驱动子系统落地前，只会出现 `'startup'`/`'resume'`（`TODO(compaction)`）。
