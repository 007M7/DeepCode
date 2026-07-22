# Agent Note（agent 决策记录）：持久化 subagent 目录与 list_agents

Status: proposed

[English](2026-07-22-durable-subagent-catalog-and-list-agents.md) | 中文

## 问题

可继续的后台 subagent 会公开稳定的 child id，并将重建描述符持久化在该 child 的会话中，因此 `send_message` 无需任何列表查询操作即可恢复已知 child。`list_agents` 的要求不同：parent 重启后，即使调用方不再知道各 child id，也要只枚举该 parent 的直接可继续 child。[可继续的后台 subagent](2026-07-21-continuable-background-subagents.md)负责持久化 child handle 与激活设计；本记录负责枚举及其面向模型的查询。

枚举必须交叉核对不可变的会话谱系、描述符有效性与进程内激活状态，而不能仅为展示就加载或恢复 Agent。它还必须定义缺失、损坏、已删除或不受支持的 child 如何影响列表，以及反复加载大量 child 日志是否需要索引。

## 提案

将 parent 到 child 的枚举与 `list_agents` 作为一个基于持久化 child handle 契约、单独评审的功能。`SubagentControlService.listChildren(parent)` 必须：

- 查找 `parentSession` 将调用方会话标识为 parent 的已实际落盘会话 header；
- 加载并校验每个候选会话的 `subagent/descriptor` 事件，但不激活 child；
- 排除一次性、损坏、不受支持、缺失或并非直接 child 的会话；
- 叠加进程内 Task 关联，但不将该关联视为持久化状态。

描述符格式、持久化、按 id 查找、直接 parent 鉴权与从持久化存储恢复仍由激活提案负责。列表查询消费这些事实，但不能削弱它们，也不能另行发明第二种描述符表示。

### 枚举决策

第一版使用 `SessionPersistence.list()` 获取已实际落盘的 header，按 `SessionHeader.parentSession` 过滤，并且只对这些直接 child 候选调用 `load()` 来归并其描述符。激活契约将已预分配 id、却没有持久化 header 和描述符的 child 称为 **unmaterialized child**：按 id 的控制操作会报告该 id 不可用，持久化列表则不会列出它。已实际落盘的一次性 child 没有描述符，因此会被排除。这条路径无需 parent 会话目录事件或新的持久化后端。

这条 O（直接 child 数量）加载路径是正确性基线。如果实测规模日后需要索引，该索引属于派生状态：会话 header 和 child 描述符仍是权威信息，重建或损坏回退必须复现相同结果。索引不能成为第二个鉴权来源，也不能让尚未实际落盘的 child 变得可见。

列表查询不添加会话事件或 surface 节点。它读取激活契约保留在 child 日志中、对模型隐藏的描述符，因此经过压缩和未经压缩的 child 必须枚举出相同结果。

### `list_agents` 契约

`SubagentControlService.listChildren(parent)` 只返回具有有效可继续描述符的持久化直接 child，再叠加进程内 Task 关联。面向模型的 `list_agents` 工具是 `@deepseek-ai/dsh-tool-subagent-control` 中的轻量适配器，并报告两种操作状态：

- `running`：存在由非终态 Task 支撑的激活，包括启动阶段和 Task 终态发布前的结算阶段；
- `resumable`：存在有效的持久化描述符，且没有关联任何激活。

这些值并非 `AgentStatus`。普通 Agent 注册表中没有 Task 关联的条目属于所有权冲突，而不是第三种列表状态。描述符损坏、版本不受支持、parent 不匹配或 child 缺失时，系统会明确失败，而不会将其静默标记为可恢复。

第一版只读，不提供 child 删除操作。如果后续产品行为会删除 child 会话，持久化列表会自然移除已删除的 child；任何未来的派生索引都必须移除或 tombstone 同一条目，避免 `list_agents` 保留陈旧状态。

## 已考虑的替代方案

**将列表查询并入激活 RFC。** 按 id 持久化描述符和从持久化存储恢复无需 parent 到 child 的枚举。保持查询独立，可让 `send_message` 落地时不必同时承担列表状态、扫描性能或删除行为。

**枚举 header 中以该 parent 为 parent 的每个持久化会话。** `parentSession` 能证明谱系，却不能证明 child 可继续。列表查询还必须加载并校验描述符。

**使用存活的 Agent 注册表作为目录。** 系统会在每个 Task 结束后有意 dispose 对应 run，而且注册表状态会在重启时消失，因此无法支持持久化发现。

**持久化 parent 会话目录事件。** 直接 child header 已经提供持久化枚举种子，child 描述符则是重建的权威信息。第二份 parent 日志会重复状态，并造成跨会话顺序和陈旧条目行为，却无助于按 id 恢复。

## 验收标准

- 枚举使用已实际落盘的会话 header 作为候选，校验 `parentSession`，并且只包含持久化描述符满足持久化 child handle 契约的 child。
- 列表查询不加载 Agent、不追加会话事件，并从经过压缩和未经压缩的日志返回相同的 child。
- `list_agents` 只返回有效的直接可继续 child，并报告 `running` 或 `resumable`，不直接透传运行时状态。
- 恢复 parent 不会激活 child；列表查询读取持久化状态，并且只叠加已经关联的进程内 Task。
- 已预分配但尚未实际落盘的 child id、一次性 child、损坏描述符、不受支持的描述符版本、parent 不匹配的 child 和陈旧的派生索引条目绝不会被标记为可恢复。
- 无密钥测试覆盖压缩前后的发现、重启、错误 parent 访问、不受支持的描述符、扫描行为和陈旧索引回退。面向模型的工具具有可运行的快照覆盖。

## 风险

- 列表查询会扫描一次 header，并且可能加载每个直接 child 的日志；后续的派生索引必须保持相同的鉴权、损坏处理和回退行为。
- 第一版没有删除操作，因此只要 child 会话仍保留在持久化存储中，它们就会继续出现在列表里，但存活 Agent 资源仍由活跃 Task 数量限制。
- Task 关联仅存在于一个运行时中。除非部署添加共享租约，否则当另一个进程正在处理某个持久化 child 时，当前进程仍可能将其报告为 `resumable`。
