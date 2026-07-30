# @deepseek-ai/dsh-subagent

[English](README.md) | 中文

subagent seam 允许一个 agent（智能体）通过具名提供方把工作委派给子 agent。调用方使用统一的服务 API（`ctx.subagents`）；提供方决定子 agent 在当前进程中、另一进程中，还是通过未来的传输机制运行。

## 包（package）的角色

该系列包把稳定接口与实现、面向模型的工具分开：

| 包 | 角色 |
|---|---|
| `@deepseek-ai/dsh-subagent` | 提供方注册表、请求/结果类型和生命周期事件。 |
| `@deepseek-ai/dsh-subagent-spawn` | 全新的进程内子 agent。 |
| `@deepseek-ai/dsh-subagent-fork` | 以父 agent 已完成轮次作为初始内容的进程内子 agent。 |
| `@deepseek-ai/dsh-subagent-acp` | 全新的进程外 ACP（Agent Client Protocol）子 agent。 |
| `@deepseek-ai/dsh-tool-subagent` | 基于一个已配置提供方、面向模型的工具。 |

多个提供方可以使用不同名称共存。因此，部署可以同时公开低成本的进程内子 agent 和隔离的 ACP 子 agent，而无需改变服务契约。

## 服务 API

`SubagentService` 有四个主要操作：

| 成员 | 含义 |
|---|---|
| `registerProvider(provider)` | 按名称注册一个可信的同进程实现。注册受 effect 作用域约束；移除注册会阻止新的启动，但不会撤销已返回给调用方的运行。重复名称会明确报错。 |
| `getProvider(name)` | 返回提供方；不存在时返回 `undefined`。 |
| `list()` | 按插入顺序返回提供方名称。 |
| `start(name, request)` | 校验请求的能力和语义值，然后等待提供方，直到真实子 agent 就绪。兑现时返回由持有方拥有的 `SubagentRun`；拒绝表示提供方已清理启动过程中取得的全部资源。 |

`SubagentStartRequest.signal` 是必填项，也是规范取消通道。发布前中止会使 `start()` 在回滚后拒绝；发布后中止会取消正在运行的子 agent。请求还可以选择模型、要求结构化输出、限制委派深度、约束子 agent 工具或设置子 agent persona。

同进程请求、描述符、结果和事件 payload 都是以不可变方式借用的可信类型值。服务不会克隆或冻结它们；序列化和不可信输入校验属于真实的进程、worker、持久化和模型边界。

## 能力

启动时功能通过 `provider.capabilities` 声明，因为服务必须在创建子 agent 前拒绝不受支持的请求：

- `outputSchema`：强制执行结构化最终结果；
- `depthLimit`：强制执行 `maxDepth`；
- `toolFilter`：应用请求的子 agent 工具限制；
- `persona`：应用每个子 agent 独立的 persona。

## 委派深度

该 seam 拥有实现和消费方共享的深度词汇：`AgentOptions.subagentDepth` 声明、`assertSubagentMaxDepth` 和 `delegationDepthOf(agent)`。持久化的 `SessionHeader.delegationDepth` 具有权威性且单调：运行时选项可以加深计数，但绝不能降低它，因此恢复后的子 agent 不会被重新计为顶层。

运行时功能是 `SubagentRun` 上的可选方法：`sendMessage?` 可对正在运行的子 agent 进行 steering（中途引导），`resume?` 则异步创建延续运行。方法是否存在就是能力检查。

`inheritsParentContext` 只用于描述，不能强制执行。它仅说明子 agent 是否能看到父级已完成的对话历史（`fork` 可以；`spawn` 和 ACP 不可以），不表示是否继承工具、服务或权限。

## 所有权与生命周期

`provider.start(request): Promise<SubagentRun>` 是所有权转移边界。兑现前，提供方拥有设置过程，并且每次失败时都必须取消、回滚并使启动过程中已取得的资源完全停稳。兑现后，调用方拥有该运行，并且必须在每条路径上调用 `dispose()`。

`SubagentRun.result` 兑现为 `{ output, structured?, stopReason }`。子 agent 级失败会以非 `completed` 原因兑现；只有 seam 无法表示的基础设施故障才可以拒绝。`dispose()` 是幂等的，会取消剩余工作，并等待子 agent 资源完全停稳。

本地运行会在 `start()` 兑现前发布普通的子 agent/会话，把该共享会话 id 作为 `SubagentRun.id` 返回，以 `SubagentRun.localAgent` 公开该子 agent 本身，并把 `request.parent.session.id` 记录到子 agent 的 `parentSession` header。远程提供方则生成父级作用域的生命周期 id，并返回 `localAgent: undefined`。

服务只会发出 `subagent/start`，而且是在 `start()` 兑现后。它在同步通知前附加结果观察器，因此即使子 agent 已经结算，也仍会先产生 `subagent/start`，再产生 `subagent/end`。这对事件共享服务生成的 `runId`；其 `local` 标志取自提供方准确 `localAgent` 的快照，因此观察器绝不会从可复用的提供方/会话名称推断运行身份或本地性。

运行事件受执行委派的父级作用域约束。每个监听器都独立隔离：同步抛出或返回的 promise 被拒绝时，只会记录日志，不会阻塞同级监听器或改变运行。

提供方新增和移除还会发出 `subagent/provider-added` 与 `subagent/provider-removed`。面向模型的工具等消费方使用这些事件，因为 Cordis 可能并发加载同级插件；配置顺序不能证明注册顺序。

## 收集模型

面向模型的工具默认同步收集：先等待子 agent 结果，再对运行执行 dispose（资源释放），然后才返回。后台委派不会改变该 seam；消费方把启动过程和最终运行注册到通用 `ctx.tasks` 运行时，随后使用共享任务工具进行收集和取消。完整契约见[后台 subagent 任务 Agent Note（agent 决策记录）](../../../.agents/notes/implemented/feature/2026-07-08-background-subagent-tasks.md)、[能力 seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md)和 `src/types.ts`。

## 模型体验

通过 `dsh-tool-subagent` 间接产生影响；它渲染提供方特定的 schema，以及前台或通用后台结果，同时子 agent 工作上下文只留在子 agent 中。

#### KV Cache 影响

不会直接使缓存失效；具名消费方负责请求前缀的任何变化。

## 已知限制与暂缓事项

- **运行时 steering 和延续只是 seam 能力**：当前工具中没有消费 `sendMessage` 和 `resume` 的面向模型消费方。
- **生命周期事件只供观察**：影响运行的 `subagent/end` 延续或决策接口仍需等待具体消费方。
