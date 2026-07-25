# @deepseek-ai/dsh-tool-subagent-control

[English](README.md) | 中文

可选的全局具名 `send_message` 与 `list_agents` 工具是 `ctx.subagents` 之上的轻量适配器。绑定提供方的 `@deepseek-ai/dsh-tool-subagent` 实例会为每种传输注册不同的委派工具；这个单独加载的包只注册一次共享控制工具，因此多个委派工具绝不会重复注册全局控制工具。根插件注册 `send_message`，且只要求 `subagents`；可单独加载的 `./list-agents` 插件注册 `list_agents`，并在加载时额外要求 `sessionQuery`。没有会话查询服务的部署可保留 `send_message` 并省略列表工具。是否加载这些工具不会决定委派工具是否启动可继续工作。

本工具不执行生命周期路由——驻留与冷恢复归 subagent 服务所有。它将 `exec.agent` 作为授权投递的准确实时父级传入，并把每条消息的来源标记为持久化来源 `{ kind: 'coordinator', senderSessionId: parent.id }`；服务会保留该来源，但绝不将其视为权限。每条消息都会通过 `Agent.followup()` 成为子 agent（智能体）的下一个 FIFO 轮次：如果子 agent 仍在工作，该消息会等待其当前轮次结束，因此无法重定向已经在进行的工作。本工具会转发其执行信号，该信号只在 inbox 接受之前掌管准入；一旦子 agent 接受消息，已接受的轮次便无法再通过本工具取消。子 agent 不会回复发送方——通过该 id 查看其 transcript 即是其所做工作的来源。投递失败会变为出错的工具结果，并明确说明消息未送达。

`list_agents` 不接受参数，从调用 Agent 推导 parent id，并在没有 cursor 的情况下渲染 `ctx.subagents.listChildren()` 的完整条目数组。它只负责发现：持久化身份来自每个 child 的描述符，消息送达时的鉴权和 Activation 所有权检查仍归 `send_message` 负责。

## 模型体验

### 工具 schema

#### 模型看到的内容

已生成的 [`send_message` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control)：包含 `subagent_id` 和 `message`，说明消息会成为子 agent 的下一个轮次、子 agent 不会回复，以及失败即表示消息未送达。

#### Token 影响

每个父级请求支付固定的 schema 成本。

#### KV Cache 影响

前缀保持稳定；schema 不会在运行时改变。

### 投递结果

#### 模型看到的内容

接受时返回 `message queued as the next turn for subagent <subagent_id>`；规范输出携带被接受的 `messageId`。失败，包括未授权或未知的子 agent、缺少描述符而无法恢复的子 agent，或准入被拒绝，都会成为出错的结果，其消息说明该消息未送达。

#### Token 影响

每次调用产生一条简短确认消息；子 agent 的响应绝不会通过本工具返回，因此只有当调用方读取子 agent transcript 并转达时，其输出才会进入父级历史。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 列表结果

#### 模型看到的内容

每个条目按追踪结果的稳定顺序占一行：child 使用 `<id> [<status>] — <label>`（`running` 表示逻辑会话存活，`complete` 表示只存在于持久化存储中且可由 `send_message` 恢复），无法读取的候选使用 `<id> [diagnostic: <reason>]`（`corrupt`、`unsupported` 或 `unavailable`），空结果使用 `(no subagents)`。Diagnostic 绝不暴露描述符内容。

#### Token 影响

随 parent 的直接可继续 child 数量线性增长；没有 cursor 或上限，因此长期存活且有许多持久化 child 的 parent 每次调用都会承担完整列表成本。

#### KV Cache 影响

仅追加；每个结果都位于可复用请求前缀之后。

## 已知限制与延期工作

- **已排队的消息没有独立结果**：接受时只返回其 inbox `messageId`；子 agent 在该轮次的工作会落入持久化子 agent Session，按其 subagent id 读取，既不会回传，也不会通过本工具收集。
- **不对当前轮次进行 steering**：每条消息都会开启后续 FIFO 轮次，因此在子 agent 工作时发送的消息只会在其当前轮次结束后运行，无法将其重定向。
- **列表是快照，而非投递承诺**：它可能与发布、dispose 或后续消息发生竞态，另一个进程也可能激活当前进程报告为 `complete` 的 child；跨进程准确性需要共享租约。
- **没有分页或删除**：系统返回完整且稳定排序的集合；只要 child 会话仍在持久化存储中，它就会继续出现在列表中，服务级上限或删除操作留待后续产品决策。
