# dsh-session

[English](README.md) | 中文

事件溯源的会话日志和内存存储。`Session` 是 agent（智能体）全部交互历史的仅追加真源，LLM（大语言模型）消息历史由它*派生*。原始日志之上维护一个 **surface** 层（产生消息事件的有序投影），以便高效派生和压缩（compaction）。

可选配套入口 `@deepseek-ai/dsh-session/invariant` 将此包（package）的关系轨迹检查注册到 `ctx.invariants`：序号单调递增、轮次／步骤闭合，以及同一步骤内的工具调用／结果配对。加载或重新加载时，它会回放现有会话；存储校验、快照、冻结、溯源信息和 surface 准入仍始终由根会话包负责。

## 服务：`SessionStore`（ctx 键：`sessions`）

创建并持有事件溯源的 `Session` 实例。这里有意不实现持久化：插件订阅 `session/event`，在 `session/flush` 时刷新，并可镜像成对的 `session/created`／`session/disposed` 生命周期。

### 公共 API

- `ctx.sessions.create(id?, { seed?, meta? }?)` 校验持久种子／头部数据并生成脱离副本，补齐版本和 id，在未提供 `createdAt` 时使用当前时间，发布会话并将其绑定到调用方 fiber。持久化重建会提供原始的 `createdAt`、`seedLength` 和 `delegationDepth`。
- `ctx.sessions.flush(session)` 通过会话捕获的作用域分发受等待的并行持久性检查点。每个监听器都会启动；调用会等待全部结算后才报告失败。未发布、已脱离和陈旧的对象会被拒绝。
- `ctx.sessions.appendOutOfBand(session, type, data, trigger)` 只接受已在 `OutOfBandSessionEventMap` 中显式准入的插件事件类型。若轮次已打开，它会直接追加；否则会原子地开启一个零步骤插件轮次，依次追加、关闭并刷新。即使目标事件追加失败，仍会关闭并刷新合成轮次，且在整个序列结算前延后脱离操作。
- `findLastMessageTurnEnd(events)` 将由消息触发的开始与结束配对，并返回最近匹配的 `turn/end`。结果消费方使用该折叠逻辑，而不直接取最近的原始轮次边界，因为更晚的注入或插件所有的零步骤轮次具有自己的结果。
- `ctx.sessions.fork(source, boundary?, childSessionId?): Session`：解析实时会话对象或 id，选取截至 `boundary` 事件序号（含该事件）的种子（默认为当前最后一个事件），要求边界为 `turn/end`，再创建带谱系元数据的实时子会话。
- `ctx.sessions.get(id: SessionId): Session | undefined`
- `ctx.sessions.list(): Session[]`

#### 高级：有序清理生命周期原语

仅在清理必须与另一项资源排序时使用拆分生命周期：

- `prepare(id?, options?)` 校验并构造，但不发布。
- `enter(session)` 执行冲突检查，在不通知的情况下发布，并返回一个绑定到该条目的幂等脱离函数。允许并发准备相同 id，但只有一个条目能够成功进入；陈旧的脱离函数无法移除其替代项。
- `announce(session)` 发出唯一一次创建边，并拒绝重复或重入通知。该次分发期间请求的脱离操作会延后，之后再发出成对的释放边；未通知的条目不会发出任何生命周期边。

`dsh-agent-loop` 使用这一拆分，以保证循环的最终刷新先于会话脱离；详见[所有权 Agent Note（agent 决策记录）](../../../.agents/notes/implemented/architecture/2026-06-18-agent-lifecycle-and-ownership-seams.md)。

### 实时服务事件

会话存储会将已通知的创建与释放配对，在提交后发布追加通知并逐个监听器收容失败，同时提供受等待的持久性检查点。确切签名和作用域行为见生成的[事件目录](../../../docs/cordis-catalog/events.md)；载荷见[持久化目录](../../../docs/persistence-catalog.md)。

### 类：`Session`

普通类（不是 Cordis 服务）。通过 `ctx.sessions.create()` 创建。

- `session.append(type, data, opts?)` 会为持久数据和 surface 元数据制作快照并冻结它们，校验标记形态、溯源信息、替换覆盖完整性，以及仅修改内容的单个 `tool/result` 重写，随后同步提交，再在彼此独立的失败收容下通知观察者。对已附加会话的重入追加会被拒绝，运行时检查也覆盖扩宽后的联合类型和已加载日志。
- `session.deriveMessages()` 对每个新的 surface 条目只做一次增量投影，并返回一个新数组，数组元素引用共享的冻结消息。assistant 投影保留提供方／模型溯源信息及适配器私有回放状态。surface 重写会重建投影；不存在原始日志回退。
- `session.deriveEventMessage(event)` 是重建和请求检查使用的规范逐事件投影。
- `session.surface` 暴露只读 `SessionSurface` 视图，由会话唯一的增量 surface 管理器所有；每次提交重写，`replaceGeneration` 都会变化。
- `session.events` 是按追加失效的缓存冻结快照；已接受事件保持深度冻结。
- `session.seq`、`session.id`：当前序号和只读类型化身份。
- `session.header: SessionHeader`：脱离、深冻结的创建元数据（`version`、`id`、`createdAt`，以及可选的 `cwd`／`parentSession`／`seedLength`／`delegationDepth`）。构造时会校验持久记录，并要求其中的 id 与 `session.id` 一致。

### 无损 JSON 工具

持久值需要一种已接受的表示，不能先检查再二次读取。`isJsonValue(value)` 是布尔判断函数；`snapshotJsonValue(value)` 在一趟迭代中校验并复制普通值，无效输入返回 `undefined`，getter 抛出的异常则向外传播。快照辅助函数接受除 `-0` 外的有限 JSON 数值（JSON 会将其改写为 `0`）、稠密普通数组、普通对象或 null 原型对象；它会在规范化前拒绝循环引用、不支持的标量和特殊原型，同时不施加调用栈深度限制。

### 分片行存储编解码器（`chunk-rows.ts`）

提供方以 token 大小的增量流式输出，因此原始日志会存储数百行 `assistant/chunk`，其 JSON 封装远大于载荷。`packChunkRuns(events)` 将每段至少 3 个连续、同块的增量分片打包为一个存储行：`text-chunks`、`reasoning-chunks` 或 `tool-call-chunks`（不含斜杠的裸标签，属于存储词汇而不是 `SessionEventMap` 成员）。`decodeStorageRecord(value)` 则将已解析行展开回完全一致的事件（`seq0`／`time0` 加上每个成员的 `dt` 间隔，可重建每个 `seq`／`time`）。编码器只允许精确形态，并逐字存储任何无法识别的内容；解码器校验带行标签的值，形态错误时抛出异常。编解码器由此包所有，使 JSONL 后端和 fixture（测试前置数据）读取器（`dsh-llm-replay`、`dsh-acp-snapshot`）共享同一编解码器；写入侧开关是后端的 `packChunks` 配置。

### Surface 类型

- `SurfaceOp`：事件进入有序 surface 的方式，即 `'append'`（正常尾部追加）或 `{ op: 'replace', start, end }`（替换从 `start` 到 `end` 的条目，含两端；二者都必须是有效的 surface 序号；`start === end` 时替换一个条目）。压缩用它遮蔽旧事件而不删除它们。
- `SurfaceIntent`：`{ surfaceOp: SurfaceOp; sourceEventSeqs?: number[] }`，可进入 surface 的类型调用 `session.append()` 时必需的第三个参数。
- `SessionSurface`：实时只读 `nodes` 和 `replaceGeneration` 投影，由 `session.surface` 暴露；候选校验仍由 `Session` 私有。
- `foldSurface(events)`：回放规范 surface 契约，得到脱离的当前事件序列与实际替换范围。同一趟处理会拒绝不连续序号、错位或畸形元数据、空或重复溯源信息、来源并非更早事件、无效位置范围，以及没有引用所有已遮蔽 surface 条目的替换。如果一个 `tool/result` 替换修改了当前某个结果的 `content` 之外的任何内容，也会被拒绝；`SurfaceManager` 共享该原子状态转换，但只保留自己的增量序列缓存。
- `isSurfaceEvent(event)`／`isSurfaceEligibleType(type)`：前者将 `SessionEvent` 收窄为形态完整的 surface 事件；后者在校验种子或已加载日志时，检测缺少标记的可进入 surface 事件。

### 请求头重建（`request-header.ts`）

`request/header` 记录非历史请求封装的完整规范快照，其原因为 `initial`、`resume` 或 `change`。`foldRequestHeader()` 选择最新快照；旧版增量事件和已移除的 `fallback` 原因会被拒绝。`messagePrefix` 与派生历史保持分离。详见[可重建请求 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md)。

`user/message` 会将其 `content` 原样呈现为 user-role 消息，无论它是直接人类提示词（来源为 `user`）、合成注入（来源为 `plugin`／`goal`），还是已准入的 Goal Round；`source` 是区分三者的唯一通道。它可以附带 JSON `meta`，用于可回放的插件状态；元数据保持持久，但不包含在 `deriveMessages()` 中。带提示词前缀上下文的 `user/message` 或 `steering/message` 会在 `content` 中保留送给模型的精确合并字节，并存储一个模型不可见的 `envelope`，其中包含直接展示用的 `displayContent` 和前缀上下文的来源／元数据描述符。`displayPromptContent()` 选择面向人的提示词，而不改变派生历史。

`tool/result` 持久保存面向模型的内容、可选内部失败标识和可选呈现元数据。工具成功时的规范 `value` 和便于人类阅读的规范失败消息只存在于执行本地；渲染后的错误内容是回放权威消息。这样会保留现有事件形态，且不改变 `SESSION_FORMAT_VERSION`。

### 会话事件词汇（`types.ts`）

生成的[持久化日志事件目录](../../../docs/persistence-catalog.md)逐成员列举仅追加日志的事件类型、载荷、surface 标记和溯源信息。Token 记账读取每个步骤的 `assistant/chunk { type: 'usage' }` 记录；如果没有用量分片，则将 `assistant/message.usage` 作为已提交步骤的后备。失败的模型请求尝试没有 assistant 消息。提供方／模型／回放溯源信息随 `assistant/message` 一同保存；运行错误的步骤记录在 `turn/end.reason` 上（此时为 `kind: 'error'`），最终模型请求失败时还包含结构化的提供方事实。

`SessionEventMap` 可通过合并扩展：插件使用声明合并添加自身类型（压缩 seam 的 `compact/*`、有界恢复的非 surface `llm/retry`、hook（钩子）桥接层的 `hook/*`）；合并成员会出现在同一目录中。`OutOfBandSessionEventMap` 是独立、默认为空的标记映射：事件所有方必须在其中合并相同键，`appendOutOfBand()` 才接受该仅日志类型；surface 和生命周期类型仍被排除。

此包还定义 `TurnTriggerMap` 和 `TurnEndReasonMap`（用于类型化轮次边界、可合并扩展的和类型；以 `kind` 为标签而不是字符串）。最终模型请求错误保留一个结构化 `LlmFailure`；其他轮次错误保留消息／代码，两者均标识失败步骤。

被中断的实时轮次以粗粒度的 `{ kind: 'aborted' }` 结果结束。调用方身份属于 Agent 的运行时取消信号，不属于持久 transcript（文本记录）；资源释放仍是独立的 `{ kind: 'disposed' }` 终态。

每个 `SessionEvent` 都有两个可选顶层字段（结构元数据）：

- `sourceEventSeqs?: number[]`：溯源信息的源序号（例如 `assistant/chunk` 的序号，它们是 `assistant/message` 的来源；或压缩替换条目背后被遮蔽的条目）。对于 `assistant/message`，存在的 `[]` 记录已知为空的提供方流；省略则表示旧版或其他未记录的溯源信息。其他 surface 事件若有此字段，则要求非空列表。
- `surfaceOp?: SurfaceOp`：事件进入 surface 的方式。非 surface 事件（边界、分片、用量、错误）不含该字段。

### 元数据类型（`types.ts`）

- `SessionHeader`：会话元数据，在发布为 `Session.header` 时写入一次；脱离和深冻结保证运行时不可变：`{ version, id, createdAt, cwd?, parentSession?, seedLength?, delegationDepth? }`。持久化 loader 可返回相同数据类型的可变脱离副本。该类型由此包与 `SessionId` 一同所有，因为 `Session.header` 以它为类型；持久化后端只是重新导出而不拥有它，否则会形成包循环依赖。

### 扩展点

- 持久化插件：订阅 `session/event`（延后写入），并在 `session/flush`（受等待）及 fiber dispose（资源释放）时排空。持久后端读取日志并重新加载到实时会话；这类后端会把元数据 seam（`SessionHeader`、`session.header`）与日志一同存储。
- 回放／fork：`create(id, { seed })` 校验并冻结连续的当前格式日志，再重建 surface；请求头必须包含提供方／模型，assistant 消息必须包含提供方／模型溯源信息，而粗粒度中止结果必须只含 `{ kind: 'aborted' }`（带旧版原因的记录会被拒绝）。`fork(source, boundary?, childSessionId?)` 选择已完成轮次前缀并记录谱系。
- 压缩：`dsh-compact-basic` 为摘要检查点追加一个替换用 `user/message`，而 `dsh-compact-tool-result-prune` 追加仅修改内容的 `tool/result` 替换。工具配对边界策略及其缓存归 [`dsh-compact` seam](../../compact/compact/README.md) 所有；此包拥有有序 surface 成员关系、替换校验与 `replaceGeneration`。

## 模型体验

### 派生消息历史

#### 模型看到的内容

模型会原样接收 `user/message`、`assistant/message`、`tool/result` 和 `steering/message` surface 条目的投影：每个投影都是一条 user-role 或 assistant-role 消息，其内容块保持不变。提示词封装只改变面向人的呈现；其前缀上下文和请求分隔符已经位于事件内容中。工具调用包含在 assistant 消息内。分片、边界、用量、hook 记录、todo 记录以及其他仅日志事件不会添加消息。

#### Token 影响

追加的 surface 条目会在后续步骤中重新发送。`replace` surface 操作会从未来输入中移除被遮蔽条目，但不删除其原始日志记录。

#### KV Cache 影响

追加的 surface 条目会保留可复用前缀。即使底层事件日志保持仅追加，`replace` 操作也会从首条被遮蔽消息起使缓存复用失效。

### 崩溃修复结果

#### 模型看到的内容

如果恢复发现 assistant 工具请求没有持久 `tool/call`，其合成 `TOOL_NOT_STARTED` 结果内容为 `The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.`。如果持久 `tool/call` 没有结果，其 `TOOL_OUTCOME_UNKNOWN` 结果内容为 `The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.`。

#### Token 影响

完整会话的 token 增量为零。恢复时，每个修复后的调用都会添加保留的、针对具体风险的错误文本。

#### KV Cache 影响

保持仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 已记录的请求头

#### 模型看到的内容

会话会重建循环实际发送的系统提示词、工具 schema、调用配置和会话前缀。请求头事件不会向消息历史加入第二份副本；前缀在 `deriveMessages()` 外部前置。

#### Token 影响

日志记录不产生重复 token。重建的前缀、系统文本和 schema 仍会产生正常的逐请求开销。

#### KV Cache 影响

记录日志不会导致失效，精确重建会保持请求前缀一致。后续请求头若更改前缀、提示词或 schema，可能从第一处差异开始使复用失效。

## 已知限制与暂缓工作

- **会话分支／树**（pi 风格条目树）：除非需要超越基于边界的 `fork()` 能力，否则暂缓。
- **`fork()` 仅在实时会话已关闭轮次的边界处切分**：边界必须是 `turn/end` 事件，且源会话必须位于存储中；[fork API](../../../.agents/notes/implemented/feature/2026-06-30-session-store-fork-api.md) 不支持对已持久化但未加载的会话进行 fork。
- **`SESSION_FORMAT_VERSION` 固定为 `0`**：预发布阶段不承诺兼容性；后端会拒绝其他任何版本，首次发布前不提供迁移路径（[政策](../../../AGENTS.md)）。
- **`TurnEndReasonMap` 不含 ACP（Agent Client Protocol）命名的 `refusal`／`max_turn_requests` 变体**：受生产方约束；只有当适配器或循环首次产生这些变体时才加入。
