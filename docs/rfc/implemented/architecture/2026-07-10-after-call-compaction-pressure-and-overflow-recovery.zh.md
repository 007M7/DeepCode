# RFC：调用后压缩压力与上下文溢出恢复

Status: implemented

[English](2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md) | 中文

## 问题

自动压缩最初运行在 `agent/pre-step`，并接收已装配提示词与会话前缀。这个边界必然只是临时状态：`agent/request` 仍可能路由到另一个模型或改变调用配置，工具 schema 没有与压缩输入在同一位置冻结，而下一次 assistant 输出、工具结果、缓冲上下文与 steering 此时还不存在。继续扩充 pre-step 签名只能移动陈旧边界，无法让它变得精确。

成功调用也不是唯一的压力信号。提供方可能在返回 usage 之前就因上下文窗口超限拒绝请求，一些成功调用也不提供 usage。因此，系统需要可重放的调用后压力，以及一条狭窄的失败恢复路径；当压缩无法证明取得有效进展时，必须保留原始提供方错误。

## 决策

### 成功压力移动到持久 post-step 检查点

`agent/pre-step` 收窄为 `(agent, turn, step, signal)`。它仍是 `step/start` 之前的通用串行检查点，但不再携带压缩专用的提示词或前缀字段。

循环在 assistant 输出、所有已分发或合成的工具结果、工具后上下文与 steering 都持久化之后、`step/end` 之前，触发等待式串行 `agent/post-step(agent, turn, step, signal)`。该位置让压力策略看到完整的成功调用状态，同时不会拆开 assistant 工具调用与其结果。监听器失败属于普通 turn 失败，绝不会进入模型请求恢复。

`dsh-compact-basic` 从持久请求头解析精确的最新实际路由模型，并让该模型的 `ctx.tokenMeter` handle 计量规范日志信封与当前表层。自动压力不会回退到 `AgentOptions.model`。没有请求头的会话尚无已完成路由请求可供判断，因此不执行工作。持久记录的未知模型会携带精确名称抛出 `TOKEN_METER_MODEL_UNCONFIGURED`，使原本成功的 turn 失败；操作性的选择或摘要失败则警告并继续使用完整历史。

### 请求恢复只覆盖最终模型边界

`RequestError`、`RequestErrorDecision` 与 `agent/request-error` waterfall 表示最终适配器已经选定之后的失败。私有 `WeakSet` 标记在分发、异步迭代器构造与迭代过程中保留原始抛出错误的身份。终止性的带内 `error` 或 `aborted` finish 进入同一路径。提示词装配、请求中间件、请求日志、结果处理、工具、post-step 监听器与清理仍属于普通失败。

恢复运行前，失败 step 已经关闭。重试会打开下一个编号 step，并从持久日志重建请求；连续恢复尝试计数只在提供方请求成功后重置。两个 DeepSeek 适配器都把识别出的提供方上下文限制错误规范化为 `CONTEXT_WINDOW_EXCEEDED`。

如果取消发生在 assistant 工具调用已经持久化之后、所有调用完成分发之前，循环会为每个尚未分发的调用记录合成的 aborted `tool/result`，随后进入正常中止路径。因此，表层不会仅因取消赢得竞态而留下孤立的持久工具调用。

### CompactService 暴露意图，而不拥有 token 核算

`CompactService.compactIfNeeded(agent, trigger, signal)` 接收 `trigger: 'pressure' | 'context-overflow'`。接口不增加估算方法或 token 类型；`ctx.tokenMeter` 继续作为可复用的核算所有者。

对于 `pressure`，compact-basic 应用所选 meter profile 的阈值与保留尾部策略，比较标量和表层的 `logRevision`，并用同一个 meter 完成范围定价、来源、被遮蔽 token 数与非缩小摘要拒绝。通用默认值保持为阈值比例 `0.8`、保留历史 `floor(contextWindow × 0.16)`、摘要模型 `''`、`maxTokens: 8192`、`compactionRetries: 1` 与 `auto: true`。

对于规范化溢出，compact-basic 绕过标量压力与普通保留 token 预算。它在保留最新不可分割单元的同时，选择最大的工具配对平衡头部范围，并在同一 signal 下只尝试一次缩小压缩。自动监听器先记录 `session.surface.replaceGeneration`，只有压缩成功且 generation 增加时才返回 `{ action: 'retry' }`。后端若只返回结果但没有替换表层，不能授权重试。

`maxOverflowRetries` 可选且默认为 `1`；`0` 只禁用溢出恢复，不会禁用压力检查。`auto: false` 不注册任何自动监听器。非规范化错误、尝试耗尽、已经中止的 signal、缺失或未知路由模型、没有安全范围、generation 未变化，以及恢复抛错都会委托给下一个监听器。若没有后续恢复，循环报告原始提供方错误对象与代码。即使恢复工作并发完成，取消或销毁仍具有最终优先级。

默认摘要器仍依次解析显式配置、最近记录的路由与 agent options。因为直接 `llm/stream` 中间件可以重新路由该辅助调用，`compact/summary.model` 记录分发后最终可变的 `GenerateOptions.model`，而不是 waterfall 之前的候选值。

## 测试

生命周期测试固定 post-step 位于持久工具、上下文与 steering 工作之后，覆盖无内容与达到 token 上限的成功、最终适配器分发/迭代器/带内边界、重试编号、尝试重置、取消、销毁、合成工具结果与原始错误身份。

压缩测试固定低摩擦默认值、实际路由模型选择、精确未知模型行为、低于阈值的强制溢出、最新工具配对保留、非缩小拒绝、generation 证明、上限、禁用监听器、单次下游委托与辅助摘要路由来源。真实循环组合同时覆盖抛出式和带内溢出：失败 step 关闭，压缩落在两次尝试之间，下一个编号请求从替换表层重建。

## 考虑过的替代方案

- **保留临时 pre-step 压力并增加更多参数**——不予采纳，因为后续路由与请求变换仍在更早快照之外，同时通用生命周期会耦合到单个插件。
- **重试相同编号的 step**——不予采纳，因为恢复会在失败边界之后追加持久事件。新 step 保持边界配对与可重建性。
- **只要 `compactIfNeeded` 返回结果就重试**——不予采纳，因为自定义后端可能报告成功却没有改变模型可见状态。`replaceGeneration` 才是权威证明。
- **让 compact-basic 解析提供方措辞**——不予采纳，因为分类属于适配器，而且必须同时覆盖抛出式与带内交付。
- **恢复时使用通用模型/窗口回退**——不予采纳，因为基于错误上下文容量执行破坏性策略可能掩盖原始提供方失败。未知持久路由会原样委托。

## 后果

压力现在描述实际完成的路由请求，包括持久工具结果与仅请求前缀字段，而不是对下一次调用的临时猜测。当成功 usage 锚点不存在时，规范化溢出提供兜底路径。恢复有上限、受取消所有，并保持单调：只有模型可见的表层 generation 变化后才重试。

代价是成功 step 增加一个串行检查点，并需要适配器持续维护溢出分类。提供方措辞与启发式字符密度仍是维护风险。表层压缩依然无法修复仅信封本身就超出窗口的情况，也不能拆分单个不可分割的超大消息或工具单元。

本 RFC 只取代[压缩能力接缝 RFC](../feature/2026-06-18-compaction-capability-seam.md) 中的 pre-step 自动触发部分。服务拆分、独立 token meter、平衡范围契约、日志记录锁、摘要替换与唯一 `summarize()` 子类 hook 均保持不变。
