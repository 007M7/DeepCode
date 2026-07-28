# dsh-session-checkpoint-policy

[English](README.md) | 中文

持久化 agent 的语义持久性策略。它会在模型适配器收到请求前、顶层工具正文可产生外部副作用前，以及每个 `agent/step` 边界为事件溯源会话创建检查点，使前一响应与有序工具结果在下一个请求前持久。

## 插件（命名空间：`session-checkpoint-policy`）

该零配置函数插件消费 `ctx.sessions`、`ctx.llm`、`ctx.tools` 以及 `ctx.sessionPersistence` 的存在性。将其与一个持久化后端一起加载：

```yaml
- id: session-persistence
  name: '@deepseek-ai/dsh-session-persistence-jsonl'

- id: session-checkpoints
  name: '@deepseek-ai/dsh-session-checkpoint-policy'
```

持久化与检查点调度刻意拆分为独立 Cordis 插件。持久化后端会立即写入 `session/event` 追加，并把每个已请求 `session/flush` 变成观测屏障；该策略选择请求、工具分派和下一步骤屏障。不带此策略加载后端是有效的，但崩溃可能丢失最新的立即缓冲事件。第一方持久化应用和运行时显式挂载两个插件；专用部署可以刻意省略或替换策略。

策略延迟包装 `llm/stream`，因此下游流只会在实时会话缓冲请求事件持久后构造。它在预执行策略和保护后包装 `tools/execute`；只有在已记录调用持久后，顶层工具正文才会运行。如果取消在 flush 等待期间到达，包装层会返回规范 `ABORTED_BEFORE_DISPATCH` 结果，不进入工具正文。嵌套工具分派重用外层模型可见调用的检查点。`agent/step` 在派生请求前持久前一响应/结果批次。

在模型和工具边界，检查点拒绝会快速失败：适配器和顶层工具正文都不运行。步骤边界拒绝会在另一个请求开始前使轮次失败。并发工具检查点共享会话存储的串行持久化 drain，无法复制序列号。

## 模型体验

### 中断调用

#### 模型所见

插件不添加提示词或工具 schema。工具检查点后、结果前的硬崩溃会留下持久的未匹配调用；会话恢复会提供模型可见的 `TOOL_OUTCOME_UNKNOWN` 结果，该结果由 `dsh-session` 负责。该消息允许重试只读或幂等工作，并要求对可能有副作用的调用验证状态或请求用户确认。

#### Token 影响

成功检查点不添加 token，也不改变请求。恢复会添加一条短工具结果消息，以平衡中断 transcript。

#### KV 缓存影响

修复结果追加在可重用前缀之后，因此不会使较早的缓存条目失效。

## 已知限制与待完成工作

- 该策略持久记录执行意图，而非通用的精确一次副作用。当提供方支持时，有副作用的工具应将 `exec.callId` 作为幂等键转发。
- 流式 `assistant/chunk` 事件没有每分片检查点。它们在下一个语义检查点到达存储，因此硬崩溃可能丢失当前部分响应。
- 持久调用没有结果时，无法证明其外部副作用是否完成。因此，恢复会记录未知结果，而不是自动重试。
