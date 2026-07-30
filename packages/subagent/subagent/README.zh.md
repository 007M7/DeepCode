# @deepseek-ai/dsh-subagent

[English](README.md) | 中文

subagent seam 允许一个 agent（智能体）通过具名提供方把工作委派给子 agent。调用方使用统一的服务 API（`ctx.subagents`）；提供方决定子 agent 在当前进程、另一进程还是未来的传输之上运行。

## 包角色

该能力族把稳定接口与实现、面向模型的工具分开：

| 包 | 角色 |
|---|---|
| `@deepseek-ai/dsh-subagent` | 提供方注册表、请求／结果／描述符类型、生命周期事件和可继续子 agent 编排。 |
| `@deepseek-ai/dsh-subagent-spawn` | 全新的进程内子 agent；支持可继续子 agent。 |
| `@deepseek-ai/dsh-subagent-fork` | 以父 agent 已完成轮次作为初始内容的进程内子 agent；支持可继续子 agent。 |
| `@deepseek-ai/dsh-subagent-acp` | 全新的进程外 ACP（Agent Client Protocol）子 agent（一次性）。 |
| `@deepseek-ai/dsh-tool-subagent` | 基于一个已配置提供方、面向模型的委派工具。 |
| `@deepseek-ai/dsh-tool-subagent-control` | 全局具名 `send_message` 后续操作工具。 |

多个提供方可以使用不同名称共存。因此，部署可以同时公开低成本的进程内子 agent 和隔离的 ACP 子 agent，而无需改变服务契约。

## 服务 API

`SubagentService` 具有以下操作：

| 成员 | 含义 |
|---|---|
| `registerProvider(provider)` | 按名称注册一个可信的同进程实现。注册受 effect 作用域约束；移除注册会阻止新的启动，但不会撤销已返回给调用方的运行。重复名称会立即失败。 |
| `getProvider(name)` | 返回提供方；不存在时返回 `undefined`。 |
| `list()` | 按插入顺序返回提供方名称。 |
| `start(name, request)` | 校验普通调用方请求，然后等待提供方，直到真实的一次性子 agent 就绪。兑现时返回由持有方拥有的 `SubagentRun`；拒绝表示提供方已清理所有局部启动资源。可继续子 agent 绝不通过此操作进入。 |
| `startContinuable(spec)` | 建立一个持久化可继续子 agent，并投递其初始提示词。子 agent 的 inbox 接受该提示词时，兑现为 `{ childId, messageId }`，无需等待轮次开始或消息写入 Session 日志；此前任何失败都会以无 id 拒绝，并完全回滚该子 agent。要求 `ctx.agents`、会话持久化以及具备 `prepareContinuable` 能力的提供方。 |
| `followup(parent, childId, content, { source, signal })` | 将来自确切在线直接父级的一条后续消息作为子 agent 的下一个 FIFO 轮次投递，术语与 `Agent.followup()` 一致，并返回被接受的 `MessageId`。驻留中的子 agent 由其 inbox 直接接受（唤醒处于 waiting 的 Activation）；不驻留的则从其持久化 Session 冷恢复。要求 `ctx.agents`；冷恢复还要求会话持久化。 |
| `drainContinuable()` | 同步关闭可继续准入，然后以子先于父的顺序 dispose 每一个实时 Activation 森林。host 会在 dispose 顶层 agent 之前调用它，使任何后代都不会比拥有其拆卸职责的运行时存活更久。任一分支失败时，会在所有分支结算后抛出聚合错误。 |

`SubagentStartRequest.signal` 是必填项，也是一次性 `start` 的规范取消通道。发布前中止会使 `start()` 在回滚后拒绝；发布后中止会取消实时子 agent。请求还可以选择模型、要求结构化输出、限制委派深度、约束子 agent 工具或设置子 agent persona。对于可继续启动或后续操作，调用方信号只在 inbox 接受之前掌管查找、物化和准入；此后由管理器独立拥有 Activation，因此调用方后续取消既不会取消已接受的轮次，也不会 dispose 子 agent。

后续操作的权限来自子 agent 持久化 header 中记录的确切在线直接父级。后续操作上的 `source` 是保留在所投递消息上的持久化来源，不授予任何权限。

同进程请求、描述符、结果和事件 payload 都是以不可变方式借用的可信类型值。服务不会克隆或冻结它们；序列化和不可信输入校验属于真实的进程、worker、持久化和模型边界。

## 能力

启动时功能通过 `provider.capabilities` 声明，因为服务必须在创建子 agent 前拒绝不受支持的一次性请求：

- `outputSchema`：强制执行结构化最终结果；
- `depthLimit`：强制执行 `maxDepth`；
- `toolFilter`：应用请求的子 agent 工具限制；
- `persona`：应用每个子 agent 独立的 persona。

可继续创建对应可选的 `SubagentProvider.prepareContinuable?()` 方法：方法是否存在就是能力检查，因此服务会在没有该方法的提供方上拒绝已配置的可继续启动，而具备该方法的提供方仍可服务普通一次性委派。该方法只返回分离的 `ContinuableCreateSpec`（`{ seed? }`）——这是数据，绝非能力：它不携带任何 Agent、`AgentHandle`、提示词投递、结果、dispose 或恢复操作，因为准备之后，继续执行管理器拥有身份预留、组合、Agent 创建、提示词投递、冷恢复、所有权和 dispose。一次性 `SubagentRun` 表示一次可 dispose 的前台委派，只有一个结果，且没有冷恢复操作。

## 持久化描述符

该 seam 拥有版本化的 `subagent/descriptor` 会话事件词汇（`src/descriptor.ts`）：`snapshotSubagentDescriptor()` 会在子 agent 会话存在之前校验并分离声明的组合配置，`foldSubagentDescriptor()` 则会在从已加载子 agent 日志中恢复描述符之前，校验当前版本的完整 payload。格式错误的当前版本 payload 会在物化前失败；不受支持的版本会使子 agent 无法恢复。payload 记录提供方名称、已解析的子 agent `agentOptions.provider`/`model`，以及可选的 `persona`/`toolFilter`；这些是显式字段，绝不是可通过合并扩展的 `AgentOptions` 对象，因此无关的扩展值不会破坏继续执行。它省略 `subagentDepth`（持久化 header 的 `delegationDepth` 是单调下界）和 `outputSchema`（可继续子 agent 从不捕获它）。该事件只进入日志：不含 `surfaceOp`，不进入模型历史，并由仅追加日志跨压缩保留。

## 委派深度

该 seam 拥有实现和消费方共享的深度词汇：`AgentOptions.subagentDepth` 声明、`assertSubagentMaxDepth` 和 `delegationDepthOf(agent)`。持久化的 `SessionHeader.delegationDepth` 具有权威性且单调：运行时选项可以加深计数，但绝不能降低它，因此恢复后的子 agent 不会被重新计为顶层。

`inheritsParentContext` 只用于描述，不能强制执行。它仅说明子 agent 是否能看到父级已完成的对话历史（`fork` 可以；`spawn` 和 ACP 不可以），不表示是否继承工具、服务或权限。

## 一次性所有权与生命周期

`provider.start(request): Promise<SubagentRun>` 是所有权转移边界，也是唯一由 Task 支撑的后台路径。兑现前，提供方拥有设置过程，并且每次失败时都必须取消、回滚并使局部资源完全停稳。兑现后，调用方拥有该运行，并且必须在每条路径上调用 `dispose()`。

`SubagentRun.result` 兑现为 `{ output, structured?, stopReason }`。子 agent 级失败会以非 `completed` 原因兑现；只有 seam 无法表示的基础设施故障才可以拒绝。`dispose()` 是幂等的，会取消剩余工作，并等待子 agent 资源完全停稳。

本地运行会在 `start()` 兑现前发布普通的子 agent/会话，把该共享会话 id 作为 `SubagentRun.id` 返回，以 `SubagentRun.localAgent` 公开准确的子 agent，并把 `request.parent.session.id` 记录到子 agent 的 `parentSession` header。远程提供方则生成父级作用域的生命周期 id，并返回 `localAgent: undefined`。

## 可继续子 agent 与 Activation

可继续子 agent 拥有一个持久化 Session 和至多一个进程内 **Activation**——即被重建的子 agent 的一个驻留时段，而不是请求、结果、取消或 Task 边界。Agent inbox 是唯一的轮次队列，因此继续执行管理器负责驻留，而 Agent 循环负责所有轮次排序与执行。任何可继续路径都不会创建 Task 或中间的承载结果的包装器。

管理器根据 Agent 停稳状态和所拥有子集推导三个内部驻留条件，而非维护第二个状态机：running（存在活跃准入、进行中的轮次或唤醒型 inbox 工作）、waiting（已停稳但仍拥有至少一个未 dispose 的子 agent）、settled（已停稳且所有拥有的子 agent 都已 dispose，因此管理器 dispose `AgentHandle` 并移除 Activation）。每条后续消息都使用 `Agent.followup()` 并成为一个 FIFO 轮次，且不会对当前轮次进行 steering（中途引导）。路由只取决于驻留状态：running 入队、waiting 唤醒同一 Agent，无 Activation 时则冷恢复一个新的。

管理器预留子 agent 身份、解析持久化描述符，通过私有的 activation-owner 作用域调用 `ctx.agents.create()`（冷恢复时为 `ctx.agents.resume()`），把返回的 `AgentHandle` 安装到 Activation 中，建立任何可继续父级所有权，然后提交提示词。冷恢复绝不通过提供方分发，因为持久化 Session 已持有初始前缀，折叠后的描述符即是全部重建输入。

受继续执行管理的父级 Activation 会在子 agent 能够运行之前，把每个子 agent 的 Session id 记录到 `ownedChildren` 集合中，并且只有在每个所拥有的子 agent Activation 完成 `AgentHandle` dispose 之后才会 dispose（子先于父）。顶层及其他非继续执行的 Agent 没有 Activation，处于该等待图之外。最终结算只把 `ctx.sessions.flush(child.session) === true` 视为持久性确认；`false` 或拒绝会报告 `DURABILITY_FAILED`，但仍会 dispose 句柄并释放所有权，因为保留失败的子 agent 会使其祖先永久停留在 `waiting`。

## 生命周期事件

服务会为每次一次性运行以及每个已驻留的可继续 Activation 时段发出一对 `subagent/start`/`subagent/end`，因此可继续子 agent 可用与一次性运行相同的词汇观察，且不会暴露管理器是物化、唤醒还是冷恢复了它们。对于一次性启动，它会在同步的 `subagent/start` 之前附加结果观察器，因此即使子 agent 已经结算，也仍会先产生 `subagent/start`，再产生 `subagent/end`；在驻留前失败的可继续时段不发出任何事件。这对事件共享服务生成的 `runId`；`local` 标志取自提供方准确 `localAgent` 的快照（可继续子 agent 恒为 true），因此观察器绝不会从可复用的提供方/会话名称推断运行身份或本地性。`provider` 字段是生命周期来源信息，而非提供方仍在注册的声明：已接受的一次性 run 可在提供方移除后才进入就绪状态，冷恢复时段也会保留描述符中的初始提供方名称，而不要求该提供方仍处于注册状态。

运行事件受执行委派的父级作用域约束。每个监听器都独立隔离：同步抛出或返回的 promise 被拒绝时，只会记录日志，不会阻塞同级监听器或改变运行。

提供方新增和移除还会发出 `subagent/provider-added` 与 `subagent/provider-removed`。面向模型的工具等消费方使用这些事件，因为 Cordis 可能并发加载同级插件；配置顺序不能证明注册顺序。

## 收集模型

面向模型的工具默认同步收集：先等待子 agent 结果，再 dispose 运行，然后才返回。一次性后台委派会在工具中注册普通 Task，其通用状态、收集和取消工具负责后续交互。可继续后台委派会调用 `ctx.subagents.startContinuable()`，只返回持久化子 agent id；子 agent 自 inbox 接受起就拥有自己的轮次，因此没有 Task、没有结果 promise，也没有公开的子 agent 取消操作——调用方通过 `send_message` 后续操作工具发送后续工作，而持久化子 agent Session 仍是子 agent 详细输出的来源。只有 `ctx.agents` 可用时，继续执行管理器才会存在，而会话持久化按每项继续执行操作解析。完整契约见[后台 subagent 任务 Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-background-subagent-tasks.md)、[可继续后台 subagent Agent Note](../../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.md)、[服务合并 Agent Note](../../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.md)、[能力 seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md)和 `src/types.ts`。

## 模型体验

通过 `dsh-tool-subagent` 和 `dsh-tool-subagent-control` 间接产生影响；它们渲染提供方特定的 schema，以及前台、后台或后续操作结果，同时子 agent 工作上下文只留在子 agent 中。

#### KV Cache 影响

不会直接使缓存失效；具名消费方共同负责请求前缀的任何变化。

## 已知限制与延期工作

- **ACP 子 agent 仍为一次性**：ACP 的 `prepareContinuable` 需要在提供方专用描述符数据中持久化远端会话 id，并按子 agent 声明继续执行功能，因为 ACP 的 `loadSession` 支持按子 agent 协商，而不是通过方法是否存在来确定。远程提供方还需要一份独立的 Activation 所有权契约，具备等效的经认证控制和子先于父的停稳保证，才能支持可继续子 agent。
- **无 report 投递**：MVP 不提供 `report` 工具、子到父的内容投递或自动唤醒父级；已完成的子 agent 轮次会把其输出留在持久化子 agent Session 中，直到调用方查看该 transcript 或提交另一个经授权的轮次。
- **无 host-user 继续执行**：`followup()` 要求确切在线直接父级。未来 host 适配器需要具体的经认证交互，才能让该 seam 获得单独的用户能力。
- **无 subagent steering**：每条后续消息都会开启后续 FIFO 轮次，因此父级无法重定向已经在进行的轮次；管理器不保存任何当前轮次控制器状态。
- **驻留仅限进程内**：Activation inbox 与所有权图不会在两个 harness 进程之间协调；对单个持久化存储的并发访问仍然需要持久化邮箱和跨进程租约协议。
- **不重放已接受但未记录的消息**：只有写入子 agent Session 日志的消息才能连同其被接受时的来源一起重建。崩溃可能丢失从未写入日志、已被接受的初始提示词或后续消息；此后一条经授权的消息可以冷恢复该子 agent，但丢失的消息不会自动重放。
