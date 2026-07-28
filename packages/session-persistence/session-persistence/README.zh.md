# @deepseek-ai/dsh-session-persistence

[English](README.md) | 中文

抽象的持久会话持久化 seam（`ctx.sessionPersistence`）。它定义持久化后端做什么：持久存储、重新加载和列出会话，而不规定如何实现。它与 `dsh-bash` 功能 seam 模板一致（见[功能 seam](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)）：本包提供抽象服务，同级包提供具体实现，消费方注入接口。

持久化单元就是现有 `SessionEvent`（事件溯源模型：日志是唯一真源），因此不存在并行的「持久消息」类型。不可回放的对话状态元数据（格式版本、cwd、血缘、种子边界、委托深度）作为 `SessionHeader` 单独传输，该类型归 `dsh-session` 所有，并在此重新导出。

## 服务 API（`ctx.sessionPersistence`）

| 方法 | 契约 |
|---|---|
| `locate(meta): SessionLocation \| undefined` | 在不执行 I/O 或实体化的情况下解析绝对的每会话产物目标。没有独立本地产物的后端返回 `undefined`。 |
| `create(meta): Promise<void>` | 注册新会话元数据。可以将物理写入延迟到第一次 `append`（延迟实体化）。 |
| `append(id, events): Promise<void>` | 持久保存一个批次。仅追加；任何修复后，第一个事件 `seq` == 已存储 next-seq；非 JSON 可序列化数据会被拒绝，并命名违规类型。 |
| `load(id): Promise<{ meta; events }>` | 返回已存储 header 和平衡、连续的日志，其中事件已脱离并验证，带标识的消息已深度冻结。协调器会在返回快照中，将消息标识机制引入前的四种消息事件形状升级为当前包装层；其余过时或格式错误的形状仍会被拒绝。实时 load 先 flush 其快照，并在轮次开放时拒绝；冷 load 保留中断的最终轮次，并用合成 `tool/result`/`step/end?`/`turn/end {interrupted}` 事件关闭它。只丢弃撕裂尾部碎片；已提交损坏和未知 `version` 会被拒绝。 |
| `inspect(id, signal?): Promise<{ meta; events }>` | 返回脱离的有效已存储前缀，其中带标识的消息已经升级、验证并深度冻结；不截断撕裂尾部、合成恢复 closer 或发布协调器状态。它与同 id 写入串行化；可选信号会迅速拒绝已排队调用方，阻止该后端读取启动，并取消活动后端读取工作。用于绝不应恢复日志的读模型和其他观察者。 |
| `list(signal?): Promise<SessionHeader[]>` | 从元数据轻量列出，不解析完整日志。可选信号取消后端列表工作。零事件延迟实体化会话不在 `list` 中。 |
| `listSnapshots(signal?): Promise<SessionPersistenceSnapshot[]>` | 返回轻量元数据和不透明品牌化每日志修订，不加载事件日志。日志及其后端存储不变时，修订保持相等；append 或变更性 load 修复后会改变；不会仅因两个存储使用相同本地计数器而冲突。可选信号请求取消后端发现工作；第一方后端在拒绝前结算已启动列表工作，使已等待调用完全停稳。 |

## 每个后端必须遵守的不变量

- **仅追加；崩溃轮次会被关闭，而非截断。** 已 flush 事件绝不重写。崩溃可留下未关闭最终轮次，其事件真实且可能很大；`load` 保留它们，并持久追加合成 closer（为每个未回答 assistant 调用添加按风险分类错误 `tool/result`，再添加 `step/end?`+`turn/end {interrupted}`），以平衡日志，并确保重新载入的历史仍是有效的提供方 transcript。只丢弃从未完整写入的撕裂尾部碎片。
- **连续 seq。**`load` 拒绝日志中间的 `seq` 缺口/解析错误；`append` 的第一个 `seq` 必须等于已存储 next-seq。
- **JSON 可序列化数据。**`append` 通过共享单遍无损 JSON 边界实体化每个直接/回放批次。实时 `Session` 事件已深度冻结，但写入协调器仍将每个事件复制到持久化自有缓冲区。
- **持久性。**`append` 只在批次持久后返回。

## 写入协调器

`PersistenceCoordinator` 负责每 id 状态和串行化、每个实时会话的一个急切写入 controller、延迟实体化、崩溃尾部修复、会话接管和完全停稳 dispose。第一方后端组合一个协调器，实现小型 `PersistenceBackend` 存储钩子接口，并委托其有状态方法。因此 JSONL 和 SQLite 共享生命周期正确性，同时保留不同存储原语；见[协调器 Agent Note](../../../.agents/notes/implemented/architecture/2026-06-18-shared-persistence-write-coordinator.md) 和 [flush controller 简化](../../../.agents/notes/implemented/simplification/2026-07-23-collapse-persistence-flush-state.md)。

每个 `session/event` 将事件复制到会话 controller，并在不阻塞生产者的情况下启动急切 drain。并发通知共享当前 drain；写入期间接纳的事件保持 pending，并触发下一批。`session/flush` 是观察屏障，会等待 controller 无当前或 pending 批次。急切失败会记录日志并保留批次；下一次显式 flush 或后端拆卸重试，并向调用方公开失败。

崩溃修复只适用于冷状态。对于实时 id，`load(id)` 为权威内存日志制作快照，等待该快照持久，并只在平衡时将其与协调器已存储 header 一起返回；开放实时轮次会被拒绝，而不会收到合成中断 closer。冷 load 在后端读取和修复写入期间保留 id，因此同 id 实时 `Session` 的并发发布会拒绝并回滚。HMR 接管通过 `loadStored` 读取，应用协调器 cwd 检查，并绝不关闭活动轮次。

后端读取会在当前形状验证前，规范化消息标识机制引入前的 `user/message`、`assistant/message`、`tool/result` 以及 steering（中途引导）对应的 `steering/message` 载荷。每条导入消息都会获得确定性的 id `legacy-message:<session-id>:<event-seq>`；工具结果的内容替换会继承其目标导入后的 id。协调器对 `load`、`inspect`、无 owner 状态的认领和 HMR 前缀接管使用同一份规范化视图，因此恢复后的会话可以追加当前事件，不会被误判为发生前缀冲突。存储仍然仅追加：读取不会重写旧记录，此后追加的每个事件都使用当前形状。这是[消息标识机制引入前的消息恢复决策](../../../.agents/notes/implemented/bug-fix/2026-07-28-load-pre-identity-session-messages.md)所规定的范围受限的导入例外，并不构成通用的 v0 迁移承诺。

实时会话发出 `session/disposed` 时，协调器等待其 controller，串行化最终 drain，然后释放该精确 `Session` 对象拥有的状态。失败退役会将 controller 保留在实时会话 map 中，使后端拆卸可重试。后端拆卸先停止事件接纳，flush 每个剩余 controller，等待每 id 操作，最后才关闭存储句柄。

无副作用 `locate` 和轻量 `listSnapshots` 查询仍由后端负责，因为它们描述存储拓扑和修订身份，而非写入编排。`listSnapshots(signal?)` 将调用方的精确信号传入后端发现，使观察者可在不脱离该工作的情况下取消。

`PersistenceBackend<TornMarker>` 钩子（协调器与存储之间的唯一 seam）：

| 钩子 | 职责 |
|---|---|
| `name` | dispose 失败 `AggregateError` 的后端标签。 |
| `loadStored(id, signal?)` | 在全部存储范围中按 id 读取已存储前缀。用于 resume/load、非变更 inspect、实时接管和 create 冲突探测。可选信号属于仅观察读取。返回元数据标识 `id`；当且仅当必须截断撕裂尾部时才存在不透明 `tornMarker`。 |
| `appendBatch(meta, events, isMaterialized)` | 持久追加连续批次；尚未实体化时以原子方式延迟实体化。 |
| `commitRepair(meta, tornMarker, closers)` | 使崩溃修复持久：截断撕裂尾部（当且仅当 `tornMarker !== undefined`；标记可为 falsy，例如 seq/offset `0`），并追加 `closers`。不要求原子性。由 load（截断 + closer）和实时接管（仅截断）使用。 |
| `list(signal?)` | 列出全部已存储元数据，观察可选取消。 |
| `close?()` | 可选生命周期拆卸（例如关闭 db 句柄），在 dispose drain 后等待。 |

协调器断言已存储 id，并在修复或实时接管前比较已存储/实时 cwd。其 `inspect()` 路径验证并克隆前缀，不调用 `commitRepair` 或发布写入状态。`tornMarker` 完全不透明：协调器只测试 `!== undefined`，并将其原样往返给 `commitRepair`，绝不检查值（JSONL 后端使用待截断字节偏移，SQLite 后端使用待删除 seq）。第三方后端可以不用协调器直接实现抽象服务，但必须提供相同非变更检查和可信轻量快照修订。详见[写入协调器 Agent Note](../../../.agents/notes/implemented/architecture/2026-06-18-shared-persistence-write-coordinator.md)。

## 测试后端

导入 `runPersistenceContract`（公开 API，包括稳定/变更敏感的轻量修订），其来源为 `tests/contract.ts`；再导入 `runCoordinatorContract`（共享写入路径编排：接管、HMR、冲突、dispose drain、崩溃尾部修复），其来源为 `tests/coordinator-contract.ts`，并使用后端 fixture 调用两者。每个后端都遵守相同仅追加/连续 seq/延迟实体化/可序列化语义和相同编排，因此后端自身 spec 只需在其上测试存储机制（路径净化、fsync 回滚；schema 版本、事务回滚）。

三个后端运行这些套件：内存参考（位于 `tests/`）、`dsh-session-persistence-jsonl`（仅追加文件日志）和 `dsh-session-persistence-sqlite`（`node:sqlite`，每个 `SessionEvent` 是一行 `(session_id, seq, type, time, data, source_event_seqs, surface_op)`）。它们全部通过同一契约 + 协调器套件，证明 seam 真正与后端无关：延迟实体化、load 时崩溃尾部和连续 seq 在文件字节与事务存储上表现相同。

## 元数据与位置类型

从 `dsh-session` 重新导出：`SessionHeader`（不可变会话元数据：`version`、`id`、`createdAt`、`cwd?`、`parentSession?`、`seedLength?`、`delegationDepth?`）。`SessionLocation` 是 `{ readonly kind: string; readonly path: string }`；其 path 是绝对后端目标，不证明产物已存在或包含未 flush 轮次。

## 模型体验

### 恢复的对话历史

#### 模型所见

该 seam 不添加提示词或 schema。Resume 将已存储接口事件恢复为消息历史；已存储请求 header 重建较早调用，新 loop 则为下一次请求组合当前系统提示词、工具和会话前缀。崩溃修复将没有持久调用的 assistant 请求标记为 `TOOL_NOT_STARTED`；有持久调用但无结果时变为 `TOOL_OUTCOME_UNKNOWN`，其文本允许模型重试只读或幂等工作，但要求验证副作用或请求用户，而不是盲目重试。

#### Token 影响

普通持久化期间为零 token。Resume 恢复已保留历史成本，并正常支付当前请求 envelope；每个已修复调用添加引用的已保留错误文本。

#### KV 缓存影响

持久化不修改实时请求前缀。只有当重建历史、当前 envelope 和模型路由匹配时，恢复 loop 才能重用提供方缓存；崩溃修复结果仅追加，不重写较早历史。

## 已知限制与待完成工作

- **无删除或保留接口**：剪枝已存储会话是带外后端维护。
- **`list()` 无分页且无过滤**：它返回每个已存储会话的 header；适合本地存储，大规模时无索引。
- **修复时合成 closer 是唯一崩溃方案**：后端必须在 load 时合成 `tool/result`/`step/end`/`turn/end` closer；没有继续中断轮次而不先关闭它的部分轮次 resume。
