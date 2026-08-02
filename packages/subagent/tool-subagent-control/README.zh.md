# @deepseek-ai/dsh-tool-subagent-control

[English](README.md) | 中文

可选的全局具名 `send_message` 工具：`ctx.subagents.followup()` 之上的轻量适配器。绑定提供方的 `@deepseek-ai/dsh-tool-subagent` 实例会为每种传输注册不同的委派工具；这个单独加载的包（package）只注册一个共享后续操作工具，因此多个委派工具绝不会重复注册全局控制工具。是否加载本工具不会决定委派工具是否启动可继续工作。

本工具不执行生命周期路由。它将每条后续消息的来源标记为 `{ kind: 'coordinator', senderSessionId: parent.id }`；subagent 服务会保留该来源，并在向运行中激活的现有 Task 在线投递消息与创建新 Task、从持久化存储恢复子 agent 之间做出选择。本工具会转发其执行信号，因此，若在在线投递等待准入期间取消，则会取消共享激活，并仅在子 agent 完全停稳后结算。本工具会渲染实际采用的路由及相关 Task id。投递失败会变为出错的工具结果，并明确说明消息未送达。

## 模型体验

### 工具 schema

#### 模型看到的内容

已生成的 [`send_message` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control)：包含 `subagent_id` 和 `message`，说明投递或继续执行的语义，以及通过 `task_output` 收集结果的路径。

#### Token 影响

每个父级请求支付固定的 schema 成本。

#### KV Cache 影响

前缀保持稳定；schema 不会在运行时改变。

### 投递结果

#### 模型看到的内容

消息加入运行中的激活时返回 `message delivered to running task <taskId>`；消息启动一次从持久化存储恢复的激活时返回 `message started task <taskId> continuing subagent <subagent_id>`。同步路由失败，包括所有权冲突、steering（中途引导）竞态失败和缺少在线投递功能，都会成为出错的结果，其消息说明该消息未送达。不存在激活时始终报告 `started`：查找在该 Task 内运行，因此未知、属于其他 parent 或缺少描述符的子 agent 会表现为已启动的 Task 结算为 `failed`（通过 `task_output` 读取），而不是出错的 `send_message` 结果。

#### Token 影响

每次调用产生一条简短确认消息；子 agent 的响应只会在通过 `task_output` 收集时进入父级历史（完成通知是状态行，绝不是响应）。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与延期工作

- **已投递的消息没有独立结果**：其效果体现在当前 Task 的最终结果中；只有已启动的后续操作才拥有新的 Task 结果。
- **投递可能在时序竞态中失败**：消息与 Task 结算、取消或清理发生竞态时会明确失败，不会改用从持久化存储恢复；模型会在 Task 结算后重试。
