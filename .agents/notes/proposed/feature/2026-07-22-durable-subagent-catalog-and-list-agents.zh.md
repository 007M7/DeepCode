# Agent Note（agent 决策记录）：持久化 subagent 目录与 list_agents

Status: proposed

[English](2026-07-22-durable-subagent-catalog-and-list-agents.md) | 中文

## 问题

可继续的后台 subagent 会公开稳定的 child id，并将重建描述符持久化在该 child 的会话中，因此 `send_message` 无需任何列表查询操作即可恢复已知 child。`list_agents` 的要求不同：parent 重启后，即使调用方不再知道各 child id，也要只枚举该 parent 的直接可继续 child。[可继续 subagent](../../implemented/feature/2026-07-28-continuable-subagent-conversations.md)负责持久化 Session 与 Activation 设计；本记录负责枚举及其面向模型的查询。

枚举必须交叉核对不可变的会话谱系、描述符有效性与实时优先的会话语料，而不能仅为展示就加载或恢复 Agent。它还必须定义缺失、损坏、已删除或不受支持的 child 如何影响列表，以及反复加载大量 child 日志是否需要索引。

## 提案

将 parent 到 child 的枚举与 `list_agents` 作为一个基于持久化 child Session 契约、单独评审的功能。`SubagentService.listChildren(parentSessionId: SessionId)` 必须：

- 使用 `ctx.sessionQuery.traceSession(parentSessionId)` 获取 parent 的直接且实时优先的 child 会话；
- 读取并校验每个候选会话的 `subagent/descriptor` 事件，但不激活 child；
- 默默排除不含描述符的候选；如果候选变得不可用，或其描述符损坏或版本不受支持，则排除该候选并产生对应 child 的 diagnostic；
- 公开每个拥有受支持且有效描述符的 child；该描述符必须带有持久化的创建 `label`，而其提供方当前是否已注册不影响公开；
- 将存活 child 报告为 `running`，只存在于持久化存储中的 child 报告为 `complete`；
- 按 `createdAt` 升序、再按 child id 升序稳定返回所有结果 child。

描述符持久化、按 id 查找、直接 parent 鉴权和不依赖提供方的冷恢复仍归已实现的 Activation 契约负责。本提案会为描述符增加持久化 `label`，并要求列表查询诊断重复的描述符事件；它不能削弱现有事实，也不能发明第二种描述符表示。

### 枚举决策

第一版消费 `ctx.sessionQuery.traceSession(parentSessionId)`，并且只考虑追踪结果的第一层后代。目标可以存活，也可以只存在于持久化存储中；追踪逻辑语料不会加载或恢复 Agent。会话查询已经使用实时优先规则合并 `ctx.sessions` 与 `ctx.sessionPersistence`，保持不可变 header 一致性，根据 `SessionHeader.parentSession` 推导直接 child 谱系，并按 `createdAt` 升序、child id 升序排列 sibling。`listChildren()` 不会重复实现这套语料逻辑，也不会检查继续执行管理器的进程内 Activation map。

语料构建先于逐 child 描述符检查。构建初始追踪时如果发生持久化列表查询失败、所观测语料中任意位置的存活／持久化 header 冲突或目标谱系无效，整个 `list_agents` 调用都会失败，因为此时不存在可信的候选集。只有初始追踪成功后的失败才会被隔离到单个候选；因此，这项逐 child 契约中的“损坏 child”是指已加载的事件 surface 或描述符数据损坏，而不是语料级 header 冲突。

会话谱系涵盖的范围比 subagent 身份更广：普通 `ctx.sessions.fork()` 和一次性 subagent 也会创建直接 child。会话 header 不新增 `kind` 判别字段；每个候选必须改为恰好包含一个有效的 `subagent/descriptor` 事件。Activation 契约只在初始创建期间写入该事件，从持久化存储恢复时不会追加其他描述符；第二个事件属于损坏，而不是另一次 Activation 的证据。该事件是已追踪 child 属于可继续后台 subagent 的唯一证据；其简短创建 `label` 来自委派的 `description`，其余继续执行字段仍是不依赖提供方的冷恢复所使用的重建输入。缺少该事件的候选属于普通 fork、一次性 child 或其他不可继续的会话，系统会将其排除且不产生 diagnostic。

已发布的逻辑记录同时也是状态来源：`SessionRecord.live` 表示 `running`，而 `live: false, persisted: true` 表示 `complete`。该状态直接来自追踪结果，不会导致额外加载 child 日志。`complete` 表示当前没有存活的 Activation，既不表示执行成功，也不表示 child 已永久关闭；`send_message` 仍可物化另一次 Activation。反过来，`running` 只表示会话存活：位于继续执行管理器对应 Activation 之外的存活 Agent 仍会显示为 `running`，但 `send_message` 会拒绝，而不会接管它。child 会话发布前不可见，也不会添加进程内 Activation 条目作为第二个候选来源或状态来源。列表查询是一份快照，可能与发布、dispose 或后续消息发生竞态；`send_message` 仍是消息送达时的权威操作。

subagent 服务将 `sessionQuery` 保持为可选依赖，因此没有该服务时仍可执行 start 和 follow-up。其公开的 `listChildren(parentSessionId: SessionId)` 方法在调用时解析这个可选服务；如果服务缺失，该方法会在执行任何工作前抛出 `SubagentError`，并携带稳定错误码 `SUBAGENT_CONTROL_SESSION_QUERY_UNAVAILABLE`。`@deepseek-ai/dsh-tool-subagent-control` 导出可分别加载的工具插件：`send_message` 适配器只要求 `subagents`，而 `list_agents` 适配器在加载时同时要求 `subagents` 和 `sessionQuery`。因此，部署可以在不加载会话查询的情况下使用 `send_message`；列表工具会在插件加载时捕获配置错误，而其他直接服务消费方会收到同一项明确的调用时契约。

这条描述符读取路径是正确性基线，并不声称工作量只与直接 child 数量呈线性关系。令 D 为直接 child 候选数量，C 为每次持久化列表查询所扫描的持久化会话数量，L_i 为候选 i 的完整日志大小。一次语料追踪后，每个候选都会执行 `sessionQuery.listEvents(childId)`。没有描述符的候选会被排除；含有多个描述符的候选会直接产生 diagnostic，无需再次读取；只有恰好含有一个描述符的候选才会通过 `sessionQuery.readEvent({ sessionId: childId, seq })` 再次加载。此次读取返回的不可变会话 header 必须与追踪时观测到的相同，包括直接 parent 关系，并且读取目标仍必须是先前定位的描述符事件；任何不一致均视为该 child 损坏。对于只存在于持久化存储中的最坏情况，每次精确读取都会重复执行 `persistence.list()`、加载完整 child 日志并克隆其中的事件，因此忽略常数因子后的工作量为 O(D × C + Σ L_i)；恰好含有一个描述符的候选承担两次这类成本，其他候选只承担一次。存活候选同样会对其完整日志取得一份分离的内存快照；读取其描述符时则会取得两份。持久化路径可能通过追加合成的结束事件，持久修复中断的 child 日志。第一版接受这些重复读取，将其作为无索引的正确性基线，但部署必须将语料总量和 child 日志大小，而不仅是直接 child 数量，视为容量约束。列表查询不会创建 Agent，也不会自行追加目录或描述符事件，但它并非严格的存储只读操作。对模型隐藏的描述符始终位于对话 surface 之外，并且会在压缩后保留，因此经过压缩和未经压缩的 child 必须枚举出相同结果。

如果实测规模日后需要索引，该索引属于派生状态：会话 header 和 child 描述符仍是权威信息，重建或损坏回退必须复现相同结果。索引不能成为第二个鉴权来源，也不能让尚未发布的 child 变得可见。

### `list_agents` 契约

`SubagentService.listChildren(parentSessionId: SessionId)` 返回 `Promise<SubagentListEntry[]>`，其中的单个数组不会将 child 与 diagnostic 分开，而是保留追踪结果中的候选顺序。`SubagentListEntry` 是一个由只读 `kind` 判别的封闭联合类型：

- `kind: 'child'` 携带只读的 `id: SessionId`、持久化 `label: string` 和 `status: 'running' | 'complete'`；
- `kind: 'diagnostic'` 携带只读的 `id: SessionId` 和 `reason: 'corrupt' | 'unsupported' | 'unavailable'`。

有效描述符产生一个 child 条目，逐 child 检查失败产生一个 diagnostic 条目，缺少描述符的候选不产生条目。child 状态 `running` 表示逻辑记录在 `ctx.sessions` 中存活；`complete` 表示该记录只存在于持久化存储中。这些值既不是 `AgentStatus`，也不是管理器内部的 Activation 状态，结果不公开内部 `createdAt` 排序键。成功完成、失败、取消和停止原因等精确 Activation 状态与持久化结果需要单独的持久化激活记录，不在本提案范围内。

面向模型的 `list_agents` 工具不接受参数，从当前正在执行的 Agent 推导 `parentSessionId`，并作为 `@deepseek-ai/dsh-tool-subagent-control` 中的轻量适配器。它按数组顺序将 child 渲染为 `<id> [<status>] — <label>`，将 diagnostic 渲染为 `<id> [diagnostic: <reason>]`；空数组渲染为 `(no subagents)`。

diagnostic 使用三种固定原因。格式错误的事件 surface、精确加载 child 时发现的 header 冲突、读取结果中的不可变 header 与追踪到的候选不一致或不再指向请求的直接 parent、读取目标不再是先前定位的描述符事件、格式错误的描述符内容和多个描述符事件映射为 `corrupt`。未知描述符版本映射为 `unsupported`。逐 child 读取产生的 `SESSION_QUERY_SESSION_NOT_FOUND`、`SESSION_QUERY_EVENT_NOT_FOUND` 和 `SESSION_QUERY_PERSISTENCE_FAILED` 映射为 `unavailable`。这项阶段边界是有意为之：初始追踪期间发生持久化故障会让操作失败，而同一故障如果始于候选读取期间，可能会让每个受影响的 child 分别产生一条相同的 `unavailable` diagnostic；第一版既不合并这些 diagnostic，也不会把它们提升为全局失败。缺少描述符则作为不可继续 child 排除，且不产生 diagnostic。配置错误、窗口错误和未识别的失败不属于 child diagnostic，会作为操作失败继续向上传播。每条 diagnostic 都标识 child id 及原因，不暴露对模型隐藏的描述符内容；系统会排除该候选，而其他健康的 sibling 仍然可见。系统绝不会读取不属于追踪结果直接后代的会话，也不会为它们产生 diagnostic。

diagnostic 是瞬时查询结果，不属于会话事件或目录状态。推导 diagnostic 时，除了产生该结果的 `listEvents()` 或条件性 `readEvent()` 操作外，不会执行额外加载。

第一版不提供 child 删除操作。如果后续产品行为会删除 child 会话，持久化列表会自然移除已删除的 child；任何未来的派生索引都必须移除或 tombstone 同一条目，避免 `list_agents` 保留陈旧状态。

## 已考虑的替代方案

**将列表查询并入激活 RFC。** 按 id 持久化描述符和从持久化存储恢复无需 parent 到 child 的枚举。保持查询独立，可让 `send_message` 落地时不必同时承担列表状态、扫描性能或删除行为。

**直接通过 `SessionPersistence.list()` 重建谱系。** 这种做法会重复实现会话查询中的实时优先语料合并、不可变 header 一致性检查、直接 child 追踪和确定性排序。列表查询应使用现有可信查询服务，只增加 subagent 特有的描述符校验与渲染。

**列出每个已追踪的 child 会话。** `parentSession` 能证明谱系，却不能证明 child 是可继续的 subagent：普通会话 fork 和一次性 subagent 也使用这个 header 字段。列表查询还必须读取并校验描述符。

**为 `SessionHeader` 添加 `kind` 判别字段。** header 仍不会携带校验或恢复可继续 subagent 所需的重建数据，因此列表查询无论如何都必须读取描述符。将描述符作为唯一的 subagent 判别信息，可避免引入第二个分类来源。

**使用存活的 Agent 注册表作为目录。** 系统会在 Activation 结算后有意 dispose 它，而且注册表状态会在重启时消失，因此无法支持持久化发现。

**使用进程内 Activation map 作为第二个目录。** 这种做法能公开管理器驻留状态，却会让会话发现查询与物化及结算耦合，引入另一套排序时钟，并让同一个 child 在其生命周期内改变候选来源。第一版只列出已经发布的逻辑会话，并将 `SessionRecord.live` 视为其快照状态。

**按当前提供方可用性过滤。** 提供方注册状态属于进程本地状态，即使描述符仍然持久存在，该状态也可能发生变化。即使继续执行不依赖提供方，过滤仍可能隐藏持久化或存活 child。因此，列表查询根据描述符确立持久化身份，而 `send_message` 在消息送达时执行权威的鉴权与驻留状态检查。

**持久化 parent 会话目录事件。** 直接 child header 已经提供持久化枚举种子，child 描述符则是重建的权威信息。第二份 parent 日志会重复状态，并造成跨会话顺序和陈旧条目行为，却无助于按 id 恢复。

**某个 child 无法加载时让整次列表查询失败。** 这种做法不会让损坏问题被忽略，但一个损坏的 sibling 会让每个健康 child 都不再可见。逐 child diagnostic 在保持每次排除明确可见的同时，也保留了发现能力。

**分别返回 child 和 diagnostic 数组。** 分离的数组会引入两个排序域，或者要求公开另一个排序键才能重建候选顺序。一个带判别字段的条目数组既能保留追踪顺序，也能保证 child 与 diagnostic 字段的类型安全。

**添加不会触发修复的描述符检查 API。** 这能使发现严格保持存储只读，但仅为避免中断尾部修复就扩展持久化 seam，而普通会话加载和最终恢复原本就需要执行该修复。第一版接受 `load()` 的语义，并记录这项副作用。

**立即为查询分页或设置上限（暂缓）。** 这可以限制一次结果的大小，但会使模型发现成为有状态操作，而且除非模型继续跟随 cursor，否则可能隐藏更早的 child。第一版没有 cursor、分页参数或候选数量上限配置，而是返回经稳定排序的完整集合；如果实测规模需要限制，服务级限制仍留待后续决策。

## 验收标准

- `listChildren(parentSessionId: SessionId)` 使用 `ctx.sessionQuery.traceSession(parentSessionId)`，接受存活或只存在于持久化存储中的目标，只考虑直接后代，并且不重复实现语料合并、谱系重建或 sibling 排序。
- 列表查询不会加载 Agent、物化 Activation，也不会自行追加目录或描述符事件。初始追踪完成后，它会对每个候选调用一次 `listEvents()`，且只对恰好含有一个描述符的候选调用 `readEvent()`；持久化读取可能触发中断尾部修复，且经过压缩和未经压缩的日志会返回相同的 child。
- 会话 header 不新增 subagent `kind`；受支持且有效的描述符是唯一的 subagent 判别信息，并包含委派的持久化 `label`。普通会话 fork 和一次性 child 缺少该描述符，因此会被排除且不产生 diagnostic。
- 初始创建恰好写入一个描述符事件，从持久化存储恢复时不写入任何描述符；如果候选包含多个描述符事件，则将其诊断为 `corrupt`。
- `listChildren()` 返回一个有序的 `SubagentListEntry[]`；其封闭的 `kind: 'child' | 'diagnostic'` 联合类型只携带上文定义的字段。每个有效 child 或逐 child diagnostic 占据其追踪候选按 `createdAt`、再按 id 排列的位置，缺少描述符则不产生条目。diagnostic 是瞬时结果，除了产生该结果的候选操作外不需要其他查询。
- `list_agents` 不接受参数，从当前正在执行的 Agent 推导 parent id，并在没有 cursor 的情况下渲染完整结果。child、diagnostic 和空结果使用上文定义的固定文本形式。
- 存活的逻辑会话为 `running`；只存在于持久化存储中的逻辑会话为 `complete`。结果不检查进程内 Activation map 或提供方可用性，并将消息送达时的鉴权与驻留状态检查留给 `send_message`。
- 恢复 parent 不会激活 child。child 会话发布前不会出现，列表查询可能与发布、dispose 或后续消息送达发生竞态，但不会削弱 `send_message` 在执行时进行的检查。
- `list_agents` 只使用 `corrupt`、`unsupported` 或 `unavailable` 作为 diagnostic 原因，且绝不在 diagnostic 中暴露描述符内容。
- 初始追踪成功后，描述符损坏、不受支持、已消失或无法读取的候选不能隐藏健康的 sibling：系统会排除该候选，并生成一条含 id 和原因的 diagnostic。初始追踪期间发生的语料级持久化、header 一致性或谱系失败会让整次调用失败。
- 逐 child 会话查询失败采用固定映射：无效 surface、精确加载时的来源冲突、相对于追踪结果的不可变 header 或直接 parent 不匹配，以及已变化的读取目标映射为 `corrupt`；会话或事件缺失以及持久化失败映射为 `unavailable`；未知描述符版本映射为 `unsupported`；缺少描述符则作为不可继续 child 排除。
- 列表工具在插件加载时要求 `sessionQuery`；直接调用 `listChildren()` 时如果缺少该服务，则会在枚举前以 `SUBAGENT_CONTROL_SESSION_QUERY_UNAVAILABLE` 失败，而按 id 的 `send_message` 在没有该服务时仍可使用。
- 无密钥测试覆盖压缩前后的发现、排除普通 fork 和一次性 child、从存活到 complete 的转换、未受管理的存活会话快照、提供方缺失时不排除 child、持久化 `label` 值、稳定排序、重启、直接 child 追踪、重复描述符拒绝、单个 child diagnostic 隔离、依阶段而异的持久化失败、加载修复、快照竞态和扫描行为。面向模型的完整列表加 diagnostic 结果具有可运行的快照覆盖。

## 风险

- 会话追踪会观察完整的逻辑语料，随后描述符校验会读取每个直接 child 的日志一次，并对恰好含有一个描述符的候选读取两次。对于只存在于持久化存储中的最坏情况，工作量为 O(D × C + Σ L_i)，而不只是 O(D)，因为每次精确读取都会重新扫描持久化存储，并加载和克隆候选的完整日志。后续的派生索引必须保持相同的鉴权、逐 child diagnostic 和回退行为。
- 语料构建是一个全有或全无的信任边界：一处存活／持久化 header 冲突就可能导致初始追踪失败，并隐藏原本健康的 sibling。只有初始追踪成功后，逐 child 隔离才会生效。
- 会话查询读取可能修复中断的 child 日志并持久化合成的结束事件，即使列表查询不创建 Agent。这是现有的持久化加载契约，而非隐藏的目录写入。
- 第一版没有删除操作，因此只要 child 会话仍保留在持久化存储中，它们就会继续出现在列表里，但存活 Agent 资源仍由驻留 Activation 数量限制。
- 查询会返回每个直接可继续 child 和 diagnostic，不设服务 cursor 或候选数量上限。稳定排序可使结果确定，但不会限制模型上下文的增长；服务分页或删除仍是后续的产品决策。
- `running` 和 `complete` 是进程内语料快照，而非消息送达承诺。另一个进程可能在当前进程将某个持久化 child 报告为 `complete` 时激活它；跨进程准确性需要共享租约。
