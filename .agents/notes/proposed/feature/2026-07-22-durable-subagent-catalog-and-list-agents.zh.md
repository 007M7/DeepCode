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
- 将这些持久化候选与 parent 的进程内 Task 关联合并，包括尚未实际落盘的活跃 child；
- 排除一次性 child 且不产生 diagnostic；如果候选在枚举后变得不可用，或其描述符损坏或版本不受支持，则排除该候选并产生对应 child 的 diagnostic；
- 仅当非活跃 child 的描述符有效，且其提供方当前已注册并实现 `resume?()` 时，才将它对外标记为 `resumable`；
- 按 `createdAt` 升序、再按 child id 升序稳定返回所有结果 child。

描述符格式、持久化、按 id 查找、直接 parent 鉴权与从持久化存储恢复仍由激活提案负责。列表查询消费这些事实，但不能削弱它们，也不能另行发明第二种描述符表示。

### 枚举决策

第一版使用 `SessionPersistence.list()` 获取已实际落盘的 header，按 `SessionHeader.parentSession` 过滤，再将这些 id 与 parent 拥有的 Task 关联合并。已关联的 child 直接从存活关联中解析，绝不会传给 `SessionPersistence.load()`；只有非活跃的直接 child 候选才会被加载以归并其描述符。激活契约将已预分配 id、却没有持久化 header 和描述符的 child 称为 **unmaterialized child**：按 id 的控制操作会报告非活跃实例不可用，但活跃关联仍会在 `list_agents` 中显示为 `running`。该 Task 进入终态后，只有在持久化描述符通过校验时，这个 child 才会继续可被发现。已实际落盘的一次性 child 没有描述符，因此会被排除。这条路径无需 parent 会话目录事件或新的持久化后端。

这条 O（直接 child 数量）加载路径是正确性基线。如果实测规模日后需要索引，该索引属于派生状态：会话 header 和 child 描述符仍是权威信息，重建或损坏回退必须复现相同结果。索引不能成为第二个鉴权来源，也不能让尚未实际落盘的 child 变得可见。

`SessionPersistence.load()` 可能通过追加合成的结束事件，持久修复中断的 child 日志。第一版接受这项现有的持久化副作用：`listChildren()` 不会创建 Agent，也不会自行追加目录或描述符事件，但它并非严格的存储只读操作。它读取激活契约保留在 child 日志中、对模型隐藏的描述符，因此经过压缩和未经压缩的 child 必须枚举出相同结果。

### `list_agents` 契约

`SubagentControlService.listChildren(parent)` 返回持久化候选与活跃 Task 关联并集中的所有直接可继续 child，以及无法加载、校验或恢复非活跃候选时产生的非致命 diagnostic。控制服务分配 child id 时，关联会记录其创建时间；已实际落盘的 child 则使用 `SessionHeader.createdAt`。这些 child 先按该 `createdAt` 升序、再按 child id 升序排序，diagnostic 使用其候选的同一排序键。面向模型的 `list_agents` 工具不接受参数，它是 `@deepseek-ai/dsh-tool-subagent-control` 中的轻量适配器；它会一并渲染完整的已排序 child 和 diagnostic，并报告两种 child 操作状态：

- `running`：存在由非终态 Task 支撑的激活，包括实际落盘前的启动阶段和 Task 终态发布前的结算阶段；
- `resumable`：没有关联任何激活，存在有效的持久化描述符，且其指定的提供方当前已注册并实现 `resume?()`。

这些值并非 `AgentStatus`。普通 Agent 注册表中没有 Task 关联的条目属于所有权冲突，而不是第三种列表状态。非活跃候选使用三种固定的 diagnostic 原因：格式错误的已提交数据或描述符内容使用 `corrupt`，未知描述符版本使用 `unsupported`，候选消失、出现其他逐 child 加载失败、其提供方缺失或未实现 `resume?()` 时使用 `unavailable`。每条 diagnostic 都标识 child id 及原因，不暴露对模型隐藏的描述符内容；系统会排除该候选，而其他健康的 sibling 仍然可见。如果初始 `SessionPersistence.list()` 操作失败，因为系统无法获得候选集，整次调用都会失败。`parentSession` 指向其他 parent 的 header 会在加载描述符前被过滤，且不产生 diagnostic。

第一版不提供 child 删除操作。如果后续产品行为会删除 child 会话，持久化列表会自然移除已删除的 child；任何未来的派生索引都必须移除或 tombstone 同一条目，避免 `list_agents` 保留陈旧状态。

## 已考虑的替代方案

**将列表查询并入激活 RFC。** 按 id 持久化描述符和从持久化存储恢复无需 parent 到 child 的枚举。保持查询独立，可让 `send_message` 落地时不必同时承担列表状态、扫描性能或删除行为。

**枚举 header 中以该 parent 为 parent 的每个持久化会话。** `parentSession` 能证明谱系，却不能证明 child 可继续。列表查询还必须加载并校验描述符。

**使用存活的 Agent 注册表作为目录。** 系统会在每个 Task 结束后有意 dispose 对应 run，而且注册表状态会在重启时消失，因此无法支持持久化发现。

**持久化 parent 会话目录事件。** 直接 child header 已经提供持久化枚举种子，child 描述符则是重建的权威信息。第二份 parent 日志会重复状态，并造成跨会话顺序和陈旧条目行为，却无助于按 id 恢复。

**某个 child 无法加载时让整次列表查询失败。** 这种做法不会让损坏问题被忽略，但一个损坏的 sibling 会让每个健康 child 都不再可见。逐 child diagnostic 在保持每次排除明确可见的同时，也保留了发现能力。

**添加不会触发修复的描述符检查 API。** 这能使发现严格保持存储只读，但仅为避免中断尾部修复就扩展持久化 seam，而普通会话加载和最终恢复原本就需要执行该修复。第一版接受 `load()` 的语义，并记录这项副作用。

**对面向模型的结果分页或设置上限。** 这可以限制一次工具结果的大小，但会使发现成为有状态操作，而且除非模型继续跟随 cursor，否则可能隐藏更早的 child。第一版不接受参数，并返回经稳定排序的完整集合；拥有大量持久化 child 的部署需要接受相应的上下文成本。

## 验收标准

- 持久化枚举使用已实际落盘的会话 header 作为候选，校验 `parentSession`，并且只包含持久化描述符满足持久化 child handle 契约的非活跃 child；最终结果会将这些 child 与 parent 拥有的活跃关联合并。
- 列表查询不加载 Agent，也不会自行追加目录或描述符事件，但可能对非活跃 child 触发 `SessionPersistence.load()` 的中断尾部修复；已关联的 child 绝不会被加载，且经过压缩和未经压缩的日志会返回相同的 child。
- `list_agents` 不接受参数，返回所有有效的直接可继续 child 及逐 child diagnostic，并按 `createdAt` 升序、child id 升序排序。
- 活跃 Task 关联即使尚未实际落盘，也会显示为 `running`；Task 进入终态后，只有在描述符校验通过，且当前注册的提供方实现 `resume?()` 时，child 才会显示为 `resumable`。
- `list_agents` 不直接透传运行时状态，只使用 `corrupt`、`unsupported` 或 `unavailable` 作为 diagnostic 原因，且绝不在 diagnostic 中暴露描述符内容。
- 恢复 parent 不会激活 child；列表查询读取持久化状态，并且只叠加已经关联的进程内 Task。
- 已预分配但尚未实际落盘的 child id、一次性 child、损坏描述符、不受支持的描述符版本和陈旧的派生索引条目绝不会被标记为可恢复；非 child header 会在加载前被过滤。
- 损坏、不受支持、已消失或无法加载的候选不能隐藏健康的 sibling：系统会排除该候选，并生成一条含 id 和原因的 diagnostic；只有初始持久化列表查询失败时，整次调用才会失败。
- 无密钥测试覆盖压缩前后的发现、活跃的尚未实际落盘 child、从正在运行的关联转换为持久化恢复、提供方缺失、稳定排序、重启、parent header 预过滤、单个 child diagnostic 隔离、加载修复、扫描行为和陈旧索引回退。面向模型的完整列表加 diagnostic 结果具有可运行的快照覆盖。

## 风险

- 列表查询会扫描一次 header，并且可能加载每个直接 child 的日志；后续的派生索引必须保持相同的鉴权、逐 child diagnostic 和回退行为。
- 列表查询可能修复中断的 child 日志并持久化合成的结束事件，即使它不创建 Agent。这是 `SessionPersistence.load()` 的现有契约，而非隐藏的目录写入。
- 第一版没有删除操作，因此只要 child 会话仍保留在持久化存储中，它们就会继续出现在列表里，但存活 Agent 资源仍由活跃 Task 数量限制。
- 无参数工具会返回每个直接可继续 child 和 diagnostic。稳定排序可使结果确定，但不会限制模型上下文的增长；分页或删除仍是后续的产品决策。
- Task 关联仅存在于一个运行时中。除非部署添加共享租约，否则当另一个进程正在处理某个持久化 child 时，当前进程仍可能将其报告为 `resumable`。
