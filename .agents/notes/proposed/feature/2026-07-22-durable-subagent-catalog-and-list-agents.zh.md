# Agent Note（agent 决策记录）：持久化 subagent 目录与 list_agents

Status: proposed

[English](2026-07-22-durable-subagent-catalog-and-list-agents.md) | 中文

## 问题

可继续的后台 subagent 会公开稳定的 child id，并将重建描述符持久化在该 child 的会话中，因此 `send_message` 无需任何列表查询操作即可恢复已知 child。`list_agents` 的要求不同：parent 重启后，即使调用方不再知道各 child id，也要只枚举该 parent 的直接可继续 child。[可继续 subagent](../../implemented/feature/2026-07-28-continuable-subagent-conversations.md)负责持久化 Session 与 Activation 设计；本记录负责枚举及其面向模型的查询。

枚举必须交叉核对不可变的会话谱系、描述符有效性与实时优先的会话语料，而不能仅为展示就加载或恢复 Agent。它还必须定义缺失、损坏、已删除或不受支持的 child 如何影响列表，以及反复加载大量 child 日志是否需要索引。

## 提案

将 parent 到 child 的枚举与 `list_agents` 作为一个基于持久化 child Session 契约、单独评审的功能。`SubagentService.listChildren(parent)` 必须：

- 使用 `ctx.sessionQuery.traceSession(parent.session.id)` 获取调用方直接且实时优先的 child 会话；
- 读取并校验每个候选会话的 `subagent/descriptor` 事件，但不激活 child；
- 排除一次性 child 且不产生 diagnostic；如果候选在枚举后变得不可用，或其描述符损坏或版本不受支持，则排除该候选并产生对应 child 的 diagnostic；
- 只公开描述符带有持久化创建 `label` 的 child；
- 将存活 child 报告为 `running`，只存在于持久化存储中的 child 报告为 `complete`；
- 按 `createdAt` 升序、再按 child id 升序稳定返回所有结果 child。

描述符持久化、按 id 查找、直接 parent 鉴权和不依赖提供方的冷恢复仍归已实现的 Activation 契约负责。本提案会为描述符增加持久化 `label`，并要求列表查询诊断重复的描述符事件；它不能削弱现有事实，也不能发明第二种描述符表示。

### 枚举决策

第一版消费 `ctx.sessionQuery.traceSession(parent.session.id)`，并且只考虑追踪结果的第一层后代。会话查询已经使用实时优先规则合并 `ctx.sessions` 与 `ctx.sessionPersistence`，保持不可变 header 一致性，根据 `SessionHeader.parentSession` 推导直接 child 谱系，并按 `createdAt` 升序、child id 升序排列 sibling。`listChildren()` 不会重复实现这套语料逻辑，也不会检查继续执行管理器的进程内 Activation map。

语料构建先于逐 child 描述符检查。构建初始追踪时如果发生持久化列表查询失败、所观测语料中任意位置的存活／持久化 header 冲突或目标谱系无效，整个 `list_agents` 调用都会失败，因为此时不存在可信的候选集。只有初始追踪成功后的失败才会被隔离到单个候选；因此，这项逐 child 契约中的“损坏 child”是指已加载的事件 surface 或描述符数据损坏，而不是语料级 header 冲突。

会话谱系涵盖的范围比 subagent 身份更广：普通 `ctx.sessions.fork()` 和一次性 subagent 也会创建直接 child。因此，每个候选都必须恰好包含一个有效的 `subagent/descriptor` 事件。激活契约只在初始创建期间写入该事件，从持久化存储恢复时不会追加其他描述符；第二个事件属于损坏，而不是另一次激活的证据。该事件用于区分可继续的后台 subagent 与普通 fork 或一次性 child；其简短创建 `label` 来自委派的 `description`，其余继续执行字段仍是不依赖提供方的冷恢复所使用的重建输入。缺少该事件的候选会被排除，且不产生 diagnostic。

已发布的逻辑记录同时也是状态来源：`SessionRecord.live` 表示 `running`，而 `live: false, persisted: true` 表示 `complete`。`complete` 表示当前没有存活的 Activation，既不表示执行成功，也不表示 child 已永久关闭；`send_message` 仍可物化另一次 Activation。反过来，`running` 只表示会话存活：位于继续执行管理器对应 Activation 之外的存活 Agent 仍会显示为 `running`，但 `send_message` 会拒绝，而不会接管它。child 会话发布前不可见，也不会添加进程内 Activation 条目作为第二个候选来源或状态来源。列表查询是一份快照，可能与发布、dispose 或后续消息发生竞态；`send_message` 仍是消息送达时的权威操作。

subagent 服务将 `sessionQuery` 保持为可选依赖，因此没有该服务时仍可执行 start 和 follow-up。其公开的 `listChildren()` 方法在调用时解析这个可选服务；如果服务缺失，该方法会在执行任何工作前抛出 `SubagentError`，并携带稳定错误码 `SUBAGENT_CONTROL_SESSION_QUERY_UNAVAILABLE`。`@deepseek-ai/dsh-tool-subagent-control` 导出可分别加载的工具插件：`send_message` 适配器只要求 `subagents`，而 `list_agents` 适配器在加载时同时要求 `subagents` 和 `sessionQuery`。因此，部署可以在不加载会话查询的情况下使用 `send_message`；列表工具会在插件加载时捕获配置错误，而其他直接服务消费方会收到同一项明确的调用时契约。

这条描述符读取路径是正确性基线，并不声称工作量只与直接 child 数量呈线性关系。令 D 为直接 child 候选数量，C 为每次持久化列表查询所扫描的持久化会话数量，L_i 为候选 i 的完整日志大小。一次语料追踪后，每个候选会执行两次精确读取。`listChildren()` 使用 `sessionQuery.listEvents(childId)` 定位唯一的描述符事件，并使用 `sessionQuery.readEvent({ sessionId: childId, seq })` 读取该事件；每项操作都会独立加载逻辑会话。对于只存在于持久化存储中的最坏情况，每次精确读取都会重复执行 `persistence.list()`、加载完整 child 日志并克隆其中的事件，因此忽略常数因子后的工作量为 O(D × C + Σ L_i)；存活 child 则会对其完整日志取得两份分离的内存快照。持久化路径可能通过追加合成的结束事件，持久修复中断的 child 日志。第一版接受这些重复读取，将其作为无索引的正确性基线，但部署必须将语料总量和 child 日志大小，而不仅是直接 child 数量，视为容量约束。列表查询不会创建 Agent，也不会自行追加目录或描述符事件，但它并非严格的存储只读操作。对模型隐藏的描述符始终位于对话 surface 之外，并且会在压缩后保留，因此经过压缩和未经压缩的 child 必须枚举出相同结果。

如果实测规模日后需要索引，该索引属于派生状态：会话 header 和 child 描述符仍是权威信息，重建或损坏回退必须复现相同结果。索引不能成为第二个鉴权来源，也不能让尚未发布的 child 变得可见。

### `list_agents` 契约

`SubagentService.listChildren(parent)` 返回会话追踪中找到的每个直接可继续 child，以及无法读取或校验候选时产生的非致命 diagnostic。每个 child 都携带自己的 session id、描述符 `label`，以及两种快照状态之一：

- `running`：逻辑会话记录在 `ctx.sessions` 中存活；
- `complete`：逻辑会话记录只存在于持久化存储中，并且可以由 `send_message` 恢复。

这些值既不是 `AgentStatus`，也不是管理器内部的 Activation 状态。child 按 `SessionHeader.createdAt` 升序、再按 child id 升序排序；diagnostic 使用其候选的同一排序键。面向模型的 `list_agents` 工具不接受参数，它是 `@deepseek-ai/dsh-tool-subagent-control` 中的轻量适配器，会一并渲染完整的已排序 child 和 diagnostic。

diagnostic 使用三种固定原因。格式错误的事件 surface、精确加载 child 时发现的 header 冲突、格式错误的描述符内容和多个描述符事件映射为 `corrupt`。未知描述符版本映射为 `unsupported`。逐 child 读取产生的 `SESSION_QUERY_SESSION_NOT_FOUND`、`SESSION_QUERY_EVENT_NOT_FOUND` 和 `SESSION_QUERY_PERSISTENCE_FAILED` 映射为 `unavailable`。这项阶段边界是有意为之：初始追踪期间发生持久化故障会让操作失败，而同一故障如果始于候选读取期间，可能会让每个受影响的 child 分别产生一条相同的 `unavailable` diagnostic；第一版既不合并这些 diagnostic，也不会把它们提升为全局失败。缺少描述符则视为一次性 child，直接排除且不产生 diagnostic。配置错误、窗口错误和未识别的失败不属于 child diagnostic，会作为操作失败继续向上传播。每条 diagnostic 都标识 child id 及原因，不暴露对模型隐藏的描述符内容；系统会排除该候选，而其他健康的 sibling 仍然可见。系统绝不会读取不属于追踪结果直接后代的会话，也不会为它们产生 diagnostic。

第一版不提供 child 删除操作。如果后续产品行为会删除 child 会话，持久化列表会自然移除已删除的 child；任何未来的派生索引都必须移除或 tombstone 同一条目，避免 `list_agents` 保留陈旧状态。

## 已考虑的替代方案

**将列表查询并入激活 RFC。** 按 id 持久化描述符和从持久化存储恢复无需 parent 到 child 的枚举。保持查询独立，可让 `send_message` 落地时不必同时承担列表状态、扫描性能或删除行为。

**直接通过 `SessionPersistence.list()` 重建谱系。** 这种做法会重复实现会话查询中的实时优先语料合并、不可变 header 一致性检查、直接 child 追踪和确定性排序。列表查询应使用现有可信查询服务，只增加 subagent 特有的描述符校验与渲染。

**列出每个已追踪的 child 会话。** `parentSession` 能证明谱系，却不能证明 child 是可继续的 subagent：普通会话 fork 和一次性 subagent 也使用这个 header 字段。列表查询还必须读取并校验描述符。

**使用存活的 Agent 注册表作为目录。** 系统会在 Activation 结算后有意 dispose 它，而且注册表状态会在重启时消失，因此无法支持持久化发现。

**使用进程内 Activation map 作为第二个目录。** 这种做法能公开管理器驻留状态，却会让会话发现查询与物化及结算耦合，引入另一套排序时钟，并让同一个 child 在其生命周期内改变候选来源。第一版只列出已经发布的逻辑会话，并将 `SessionRecord.live` 视为其快照状态。

**持久化 parent 会话目录事件。** 直接 child header 已经提供持久化枚举种子，child 描述符则是重建的权威信息。第二份 parent 日志会重复状态，并造成跨会话顺序和陈旧条目行为，却无助于按 id 恢复。

**某个 child 无法加载时让整次列表查询失败。** 这种做法不会让损坏问题被忽略，但一个损坏的 sibling 会让每个健康 child 都不再可见。逐 child diagnostic 在保持每次排除明确可见的同时，也保留了发现能力。

**添加不会触发修复的描述符检查 API。** 这能使发现严格保持存储只读，但仅为避免中断尾部修复就扩展持久化 seam，而普通会话加载和最终恢复原本就需要执行该修复。第一版接受 `load()` 的语义，并记录这项副作用。

**对面向模型的结果分页或设置上限。** 这可以限制一次工具结果的大小，但会使发现成为有状态操作，而且除非模型继续跟随 cursor，否则可能隐藏更早的 child。第一版不接受参数，并返回经稳定排序的完整集合；拥有大量持久化 child 的部署需要接受相应的上下文成本。

## 验收标准

- 枚举使用 `ctx.sessionQuery.traceSession(parent.session.id)`，只考虑直接后代，并且不重复实现语料合并、谱系重建或 sibling 排序。
- 列表查询不会加载 Agent、物化 Activation，也不会自行追加目录或描述符事件。初始追踪完成后，它会对每个候选执行两次相互独立的会话查询精确读取；持久化读取可能触发中断尾部修复，且经过压缩和未经压缩的日志会返回相同的 child。
- 有效描述符包含委派的持久化 `label`；普通会话 fork 和一次性 child 缺少该描述符，因此会被排除且不产生 diagnostic。提供方注册状态不影响发现，也不影响不依赖提供方的冷恢复。
- 初始创建恰好写入一个描述符事件，从持久化存储恢复时不写入任何描述符；如果候选包含多个描述符事件，则将其诊断为 `corrupt`。
- `list_agents` 不接受参数，返回每个有效的直接可继续 child 及其 id、label 和 `running` 或 `complete` 快照状态，并返回逐 child diagnostic；结果按 `createdAt` 升序、child id 升序排序。
- 存活的逻辑会话为 `running`；只存在于持久化存储中的逻辑会话为 `complete`，并且仍可在之后通过 `send_message` 恢复。结果不查询进程内 Activation map。
- 恢复 parent 不会激活 child。child 会话发布前不会出现，列表查询可能与发布、dispose 或后续消息送达发生竞态，但不会削弱 `send_message` 在执行时进行的检查。
- `list_agents` 只使用 `corrupt`、`unsupported` 或 `unavailable` 作为 diagnostic 原因，且绝不在 diagnostic 中暴露描述符内容。
- 初始追踪成功后，描述符损坏、不受支持、已消失或无法读取的候选不能隐藏健康的 sibling：系统会排除该候选，并生成一条含 id 和原因的 diagnostic。初始追踪期间发生的语料级持久化、header 一致性或谱系失败会让整次调用失败。
- 逐 child 会话查询失败采用固定映射：无效 surface 和精确加载时的来源冲突映射为 `corrupt`；会话或事件缺失以及持久化失败映射为 `unavailable`；未知描述符版本映射为 `unsupported`；缺少描述符则作为一次性 child 排除。
- 列表工具在插件加载时要求 `sessionQuery`；直接调用 `listChildren()` 时如果缺少该服务，则会在枚举前以 `SUBAGENT_CONTROL_SESSION_QUERY_UNAVAILABLE` 失败，而按 id 的 `send_message` 在没有该服务时仍可使用。
- 无密钥测试覆盖压缩前后的发现、排除普通 fork 和一次性 child、从存活到 complete 的转换、未受管理的存活会话快照、不依赖提供方的发现、持久化 `label` 值、稳定排序、重启、直接 child 追踪、重复描述符拒绝、单个 child diagnostic 隔离、依阶段而异的持久化失败、加载修复、快照竞态和扫描行为。面向模型的完整列表加 diagnostic 结果具有可运行的快照覆盖。

## 风险

- 会话追踪会观察完整的逻辑语料，随后描述符校验会读取每个直接 child 的日志两次。对于只存在于持久化存储中的最坏情况，工作量为 O(D × C + Σ L_i)，而不只是 O(D)，因为每次精确读取都会重新扫描持久化存储，并加载和克隆候选的完整日志。后续的派生索引必须保持相同的鉴权、逐 child diagnostic 和回退行为。
- 语料构建是一个全有或全无的信任边界：一处存活／持久化 header 冲突就可能导致初始追踪失败，并隐藏原本健康的 sibling。只有初始追踪成功后，逐 child 隔离才会生效。
- 会话查询读取可能修复中断的 child 日志并持久化合成的结束事件，即使列表查询不创建 Agent。这是现有的持久化加载契约，而非隐藏的目录写入。
- 第一版没有删除操作，因此只要 child 会话仍保留在持久化存储中，它们就会继续出现在列表里，但存活 Agent 资源仍由驻留 Activation 数量限制。
- 无参数工具会返回每个直接可继续 child 和 diagnostic。稳定排序可使结果确定，但不会限制模型上下文的增长；分页或删除仍是后续的产品决策。
- `running` 和 `complete` 是进程内语料快照，而非消息送达承诺。另一个进程可能在当前进程将某个持久化 child 报告为 `complete` 时激活它；跨进程准确性需要共享租约。
