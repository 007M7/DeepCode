# @deepseek-ai/dsh-subagent

[English](README.md) | 中文

subagent seam 允许一个 agent（智能体）通过具名提供方把工作委派给子 agent。调用方使用统一的服务 API（`ctx.subagents`）；提供方决定子 agent 在当前进程、另一进程还是未来的传输之上运行。

## 包角色

该能力族把稳定接口与实现、面向模型的工具分开：

| 包 | 角色 |
|---|---|
| `@deepseek-ai/dsh-subagent` | 提供方注册表、请求／结果／描述符类型、生命周期事件和可继续子 agent 编排。 |
| `@deepseek-ai/dsh-subagent-spawn` | 支持从持久化存储恢复的全新进程内子 agent。 |
| `@deepseek-ai/dsh-subagent-fork` | 以父 agent 已完成轮次作为初始内容，并支持从持久化存储恢复的进程内子 agent。 |
| `@deepseek-ai/dsh-subagent-acp` | 全新的进程外 ACP（Agent Client Protocol）子 agent（一次性）。 |
| `@deepseek-ai/dsh-tool-subagent` | 基于一个已配置提供方、面向模型的委派工具。 |
| `@deepseek-ai/dsh-tool-subagent-control` | 全局具名 `send_message` 后续操作工具。 |

多个提供方可以使用不同名称共存。因此，部署可以同时公开低成本的进程内子 agent 和隔离的 ACP 子 agent，而无需改变服务契约。

## 服务 API

`SubagentService` 有六个主要操作：

| 成员 | 含义 |
|---|---|
| `registerProvider(provider)` | 按名称注册一个可信的同进程实现。注册受 effect 作用域约束；移除注册会阻止新的启动，但不会撤销已返回给调用方的运行。重复名称会立即失败。 |
| `getProvider(name)` | 返回提供方；不存在时返回 `undefined`。 |
| `list()` | 按插入顺序返回提供方名称。 |
| `start(name, request)` | 校验普通调用方请求，然后等待提供方，直到真实子 agent 就绪。兑现时返回由持有方拥有的 `SubagentRun`；拒绝表示提供方已清理所有局部启动资源。此操作不允许传入继续执行状态。 |
| `startContinuable(spec)` | 分配持久化子 agent id，并注册其初始的由 Task 支撑的激活。要求 `ctx.tasks`、`ctx.agents`、会话持久化及可恢复的提供方。 |
| `followup(parent, childId, content, { source, signal })` | 对持久化子 agent 执行后续操作，术语与 `Agent.followup()` 一致。它会引导当前激活，或启动新 Task 从持久化存储恢复该子 agent。若在在线投递等待准入期间中止 `signal`，则会取消共享激活，并在其完全停稳后拒绝该调用。要求 `ctx.tasks` 和 `ctx.agents`；从持久化存储恢复还要求会话持久化。 |

`SubagentStartRequest.signal` 是必填项，也是规范取消通道。发布前中止会使 `start()` 在回滚后拒绝；发布后中止会取消实时子 agent。请求还可以选择模型、要求结构化输出、限制委派深度、约束子 agent 工具或设置子 agent persona。只有内部继续执行管理器才能把稳定子 agent id 和持久化描述符添加到面向提供方的 `SubagentProviderStartRequest`；从持久化存储恢复时，向提供方的请求同样只会在查找描述符并授权父级后由内部管理器分发。

同进程请求、描述符、结果和事件 payload 都是以不可变方式借用的可信类型值。服务不会克隆或冻结它们；序列化和不可信输入校验属于真实的进程、worker、持久化和模型边界。

## 能力

启动时功能通过 `provider.capabilities` 声明，因为服务必须在创建子 agent 前拒绝不受支持的请求：

- `outputSchema`：强制执行结构化最终结果；
- `depthLimit`：强制执行 `maxDepth`；
- `toolFilter`：应用请求的子 agent 工具限制；
- `persona`：应用每个子 agent 独立的 persona。

运行时功能以可选方法表示，方法是否存在就是功能检查：`SubagentRun.steer?` 只有在活跃子 agent 的请求快照准入消息后才会兑现；无法准入时会拒绝，而不会把消息排入未受跟踪的轮次。`SubagentProvider.resume?` 则会重建持久化的可继续子 agent。run 表示一次可 dispose 的激活，因此有意不提供从持久化存储恢复操作；进程重启后无法重建已 dispose 的 run。

## 持久化描述符

该 seam 拥有版本化的 `subagent/descriptor` 会话事件词汇（`src/descriptor.ts`）：`snapshotSubagentDescriptor()` 会在任何 Task 存在之前校验并分离声明的组合配置，`foldSubagentDescriptor()` 则会在从已加载子 agent 日志中恢复描述符之前，校验当前版本的完整 payload。格式错误的当前版本 payload 会在提供方分发前失败；不受支持的版本会使子 agent 无法恢复。payload 记录提供方名称、已解析的子 agent `agentOptions.provider`/`model`，以及可选的 `persona`/`toolFilter`；这些是显式字段，绝不是可通过合并扩展的 `AgentOptions` 对象，因此无关的扩展值不会破坏继续执行。它省略 `subagentDepth`（持久化 header 的 `delegationDepth` 是单调下界）和 `outputSchema`（单次激活的结果契约）。该事件只进入日志：不含 `surfaceOp`，不进入模型历史，并由仅追加日志跨压缩保留。

## 委派深度

该 seam 拥有实现和消费方共享的深度词汇：`AgentOptions.subagentDepth` 声明、`assertSubagentMaxDepth` 和 `delegationDepthOf(agent)`。持久化的 `SessionHeader.delegationDepth` 具有权威性且单调：运行时选项可以加深计数，但绝不能降低它，因此恢复后的子 agent 不会被重新计为顶层。

`inheritsParentContext` 只用于描述，不能强制执行。它仅说明子 agent 是否能看到父级已完成的对话历史（`fork` 可以；`spawn` 和 ACP 不可以），不表示是否继承工具、服务或权限。

## 所有权与生命周期

`provider.start(request): Promise<SubagentRun>` 是所有权转移边界。兑现前，提供方拥有设置过程，并且每次失败时都必须取消、回滚并使局部资源完全停稳。兑现后，调用方拥有该运行，并且必须在每条路径上调用 `dispose()`。`provider.resume?(request)` 对恢复后的激活采用相同契约；只有继续执行管理器会分发该请求。

`SubagentRun.result` 兑现为 `{ output, structured?, stopReason }`。子 agent 级失败会以非 `completed` 原因兑现；只有 seam 无法表示的基础设施故障才可以拒绝。对于可继续激活，完成的结果还会确认提供方已使其最终状态具备持久性；必需检查点失败会作为基础设施故障拒绝，而不会发布未经确认的输出。`dispose()` 是幂等的，会取消剩余工作，并等待子 agent 资源完全停稳。

本地运行会在 `start()` 兑现前发布普通的子 agent/会话，把该共享会话 id 作为 `SubagentRun.id` 返回，以 `SubagentRun.localAgent` 公开准确的子 agent，并把 `request.parent.session.id` 记录到子 agent 的 `parentSession` header。可继续启动会准确发布由服务分配的 `continuation.sessionId`。远程提供方则生成父级作用域的生命周期 id，并返回 `localAgent: undefined`。

服务只会在普通启动或内部向提供方分发的恢复操作兑现后发出 `subagent/start`。它在同步通知前附加结果观察器，因此即使子 agent 已经结算，也仍会先产生 `subagent/start`，再产生 `subagent/end`。这对事件共享服务生成的 `runId`；其 `local` 标志取自提供方准确 `localAgent` 的快照，因此观察器绝不会从可复用的提供方/会话名称推断运行身份或本地性。

运行事件受执行委派的父级作用域约束。每个监听器都独立隔离：同步抛出或返回的 promise 被拒绝时，只会记录日志，不会阻塞同级监听器或改变运行。

提供方新增和移除还会发出 `subagent/provider-added` 与 `subagent/provider-removed`。面向模型的工具等消费方使用这些事件，因为 Cordis 可能并发加载同级插件；配置顺序不能证明注册顺序。

## 收集模型

面向模型的工具默认同步收集：先等待子 agent 结果，再 dispose 运行，然后才返回。一次性后台委派会在工具中注册普通 Task。可继续后台委派会调用 `ctx.subagents.startContinuable()`；只有 `ctx.tasks` 和 `ctx.agents` 可用时，其内部管理器才会存在，而会话持久化按每项继续执行操作解析。收集和取消使用共享 Task 工具。完整契约见[后台 subagent 任务 Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-background-subagent-tasks.md)、[可继续后台 subagent Agent Note](../../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.md)、[服务合并 Agent Note](../../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.md)、[能力 seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md)和 `src/types.ts`。

## 模型体验

通过 `dsh-tool-subagent` 和 `dsh-tool-subagent-control` 间接产生影响；它们渲染提供方特定的 schema，以及前台、后台或后续操作结果，同时子 agent 工作上下文只留在子 agent 中。

#### KV Cache 影响

不会直接使缓存失效；具名消费方共同负责请求前缀的任何变化。

## 已知限制与延期工作

- **ACP 子 agent 仍为一次性**：`AcpProvider.resume` 需要在提供方专用描述符数据中持久化远端会话 id，并按子 agent 声明继续执行功能，因为 ACP 的 `loadSession` 支持按子 agent 协商，而不是通过提供方方法是否存在来确定。
- **生命周期事件只供观察**：影响运行的 `subagent/end` 延续或决策接口仍需等待具体消费方。
