# @deepseek-ai/dsh-compact

[English](README.md) | 中文

**压缩 seam**：抽象 `CompactService`（`ctx.compact`）定义压缩做什么，即判定历史记录是否过大，并将较早范围摘要为单个表层节点，但不规定如何实现。

本包是压缩能力的接口层，因此各项职责可以独立演进（和替换）：

| 包 | 职责 |
|---|---|
| `@deepseek-ai/dsh-compact`（本包） | 接口：抽象服务 + `compact/*` 事件 + `CompactionResult` + 规范检查点源 + 工具配对边界 helper |
| `@deepseek-ai/dsh-compact-basic` | 后端：`ctx.tokenMeter` 压力 + token 预算保留 + `llm.stream()` 摘要 |
| `@deepseek-ai/dsh-tool-compact`（暂缓） | 面向模型的 `/compact` 工具，基于 `ctx.compact` 实现 |

与 bash seam 不同，该接口依赖 `@deepseek-ai/dsh-session` 和 `@deepseek-ai/dsh-llm`。契约的动词基于 `Session` 定义，其输出使用 `ContentBlock` 词汇，因此无法在不指名这些包的情况下表达。这项对「接口只依赖 cordis」指引的偏离是有意的，并记录在 [压缩能力 seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md) 中。

## 服务 API（`ctx.compact`）

两个方法都是**抽象方法**：触发策略、保留、事件顺序与摘要均属于后端。可复用的请求测量是独立服务 [`ctx.tokenMeter`](../../llm/token-meter/README.md)，而非本接口的一部分。

| 成员 | 语义 |
|---|---|
| `compactIfNeeded(agent, trigger, signal)` | 为 `trigger: 'pressure' \| 'context-overflow'` 考虑自动压缩。压力触发可应用后端的阈值与保留尾部策略；已确认溢出可强制进行有效的平衡缩减。返回 `CompactionResult`，无安全范围时则返回 `null`。后端摘要请求是直接 `ctx.llm.stream()` 调用（不是 loop 步骤），因此每次调用在 `llm/stream` 处拦截。 |
| `compactRegion(start, end, agent, signal?)` | 强制将表层节点 `[start, end]`（包含两端 seq）从 `agent.session` 摘要为单个替换节点，其源为 `COMPACT_CHECKPOINT_SOURCE`。如果压缩已在进行、`start`／`end` 不是表层节点，或 `start` 在表层上位于 `end` 之后，则**抛出异常**。该范围是表层位置 span，不是数值 seq 区间：在之前的 replace 将新鲜高 seq 摘要节点放到已遮蔽范围的位置之后，表层顺序不再跟随 seq 顺序。 |

`CompactionResult` 向调用方保留原始摘要与记账事件 seq，同时保留已遮蔽范围与 token 计量；其经漂移检查的形状位于 [压缩数据结构参考](../../../docs/core-data-structures/compaction.md#compactionresult)。

`compactIfNeeded` 要求必填 `signal`；`compactRegion` 的该参数可选。通过 `ctx.llm.stream()` 摘要的后端**必须** 将它转发到调用的 `GenerateOptions.signal`，因此 abort 或 fiber dispose 会停止进行中的摘要，不会留下越过取消时点继续运行的遗留模型调用。可以从所拥有会话的日志（当前开启的轮次）恢复 `compact/*` 事件所属轮次，因此后端从日志中标记该值，而不信任调用方提供的值。

## 工具配对边界

该接口导出 `toolPairingBalancedBefore(session, seq)` 与 `toolPairingBalancedAfter(session, seq)`，用于对齐和验证压缩边缘。安全边缘不会被尚未回答的 assistant 工具调用跨越。每个 helper 都会验证事件序列位于当前表层，并使用按表层顺序为每个 cut 缓存的 balance 返回答案。

每会话私有 cache 以 `session.surface.replaceGeneration` 与已处理表层配置项数为 key。generation 未变时，fold 只会扩展到尚未处理的尾部配置项；不含新表层配置项的仅日志追加不会读取事件，而 replace generation 会重建当前成员关系与 balance。事件 seq 缺失以及没有之前开启调用的 `tool/result` 会被拒绝为表层状态损坏。

## 表层契约

`SurfaceEventType` 是封闭联合：只有 `user/message`、`assistant/message`、`tool/result` 和 `steering/message` 可以携带 `surfaceOp`。因此 `compact/*` 事件**不能** 出现在表层上。成功压缩改为：

1. 追加 `compact/start`（仅日志）：获取锁；
2. 摘要该范围；
3. 追加 `compact/summary`（仅日志）：溯源信息包括摘要、范围、已遮蔽 seq、token 数与提供方／模型调用 envelope；
4. 追加单个 `user/message`，其携带 `source: COMPACT_CHECKPOINT_SOURCE` 和包含摘要的 `surfaceOp: { op: 'replace', start, end }`：这是**本操作唯一的表层变更**；
5. 追加 `compact/end`（仅日志）：释放锁。

表层变更（第 4 步）位于锁括号**内部**：`compact/end` 是最后一个事件，因此表层变更落地前绝不会释放锁。如果在 `compact/start` 与 `compact/end` 之间崩溃，会留下可检测的遗留锁（一个 `compact/start` 没有匹配的 `compact/end`），而不是虚假声称压缩已完成、但表层从未被遮蔽的 `compact/end`。

`deriveMessages()` 随后将摘要渲染为 user 角色消息，再跟上已保留节点。已遮蔽事件仍保留在原始日志中，因此回放具有确定性。

## 阻塞

压缩通过日志记录的锁串行化：`compactRegion` 会拒绝启动，条件是最后一个 `compact/start` 之后没有匹配的 `compact/end`。锁就是日志（不是内存 mutex），因此它能在回放后存活，持久化后端也可以在重新加载时检测遗留 `compact/start`。锁会括住**整个** 操作：摘要、`compact/summary` 溯源记录*以及* `user/message` 表层替换全部发生在 `compact/end` 之前，因此 `session/event` listener 即使在 `compact/end` 时触发，也绝不会看到锁已释放而表层变更仍在等待。基础后端会在摘要后重新验证已选表层：表层变更会导致拒绝，不相关的仅日志追加不会使替换失效。即使摘要抛出异常，也会追加 `compact/end`，因此失败绝不会将锁卡死。

## 事件

`compact/*` 事件通过 declaration merging 扩展 `SessionEventMap`（可合并扩展）：它们是会话事件，不是 cordis `Events`，三者均仅存在于日志（不含 `surfaceOp`）。各事件 payload 与语义见生成的 [持久化日志事件目录](../../../docs/persistence-catalog.md)。

## 实现后端

继承 `CompactService`，实现 `compactIfNeeded` 与 `compactRegion`，再将子类作为插件加载：它会注册为 `ctx.compact`。每个成功后端都在替换 user 消息上使用 `COMPACT_CHECKPOINT_SOURCE`；`isCompactCheckpointSource()` 可在持久化或克隆后识别该标记，无需依赖后端身份。基于模板或模型的实现可以放在同级包中，不需更改调用方或共享 token meter。

## 模型体验

### 调用后端时的会话历史

#### 模型看到的内容

成功实现会用一个 user 角色摘要检查点替换较早表层范围，即一个 `user/message`，它携带 `surfaceOp: { op: 'replace', start, end }`；原始事件仍会记录，但不再出现在派生模型消息中。seam 本身不执行改写。

#### Token 影响

该接口不会直接产生 token。后端用一份摘要换取多个原本保留的历史 token，并保持近期尾部不变。

#### KV Cache 影响

成功的后端替换会使从第一个已遮蔽历史 token 起的复用失效；seam 本身不会改变请求。

## 已知限制与暂缓事项

- **尚无面向模型的消费方层**：`@deepseek-ai/dsh-tool-compact`（`/compact` 工具）已暂缓；只能通过直接 `ctx.compact` 调用或后端的自动 listener 进行压缩。
- **部分单元溢出不在契约内**：平衡摘要压缩无法拆分一个不可分单元。当可移除的文本型工具结果体量较大时，可选剪枝配套服务仍可修复闭合工具对；无法压缩大型非工具节点，或不可剪枝剩余部分过大的工具单元。
- **单独接近窗口大小的 envelope 不属于表层压缩工作**：压缩缩减派生历史，绝不缩减系统提示词、工具或会话前缀。
