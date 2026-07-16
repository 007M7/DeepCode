# RFC：停止将 token 流镜像为 agent 事件

Status: implemented

[English](2026-07-02-remove-stream-chunk-mirror.md) | 中文

## 问题

agent loop（智能体循环）将模型的每个 token 增量同时记录为持久的 `assistant/chunk` 会话事件，并发射一个携带相同数据的并行实时 `agent/stream-chunk` Cordis 事件。在 `packages/core/agent-loop/src/loop.ts` 中，两者仅相隔一行：

```ts ignore-check
const chunkEvent = session.append('assistant/chunk', { turn, step, chunk })
chunkSeqs.push(chunkEvent.seq)
ctx.emit('agent/stream-chunk', agent, turn, step, chunk)   // ← the mirror
```

- 持久事件：`assistant/chunk: { turn, step, chunk }`。
- 实时发射：`agent/stream-chunk(agent, turn, step, chunk)`——相同的 `StreamChunk`，相同的 `turn`/`step`。

实时发射相比会话事件唯一多出的东西是实时的 `Agent` 句柄，而唯一的消费方丢弃了它（其处理函数签名为 `(_agent, _turn, _step, chunk)`）。

这与[边界镜像移除](2026-06-20-remove-agent-boundary-mirror-events.md)为轮次/步骤边界消除的重复如出一辙：消费方对同一个持久事实有两个真源，每次修改都必须同时触及两处。那份 RFC 将分片流推迟处理（「`assistant/chunk` 的持久化仍然是承重的，因此分片流后续可以作为镜像来评估，但那是一个独立的决策」），而非一并打包。本 RFC 就是那个独立的决策。

推迟所依赖的前提已经尘埃落定：分片持久化是权威的，且将保留。停止持久化分片、仅保留瞬态实时流事件的提案已被[否决](../../rejected/simplification/2026-06-20-assembled-assistant-messages-only.md)——高保真回放、部分失败的流以及快照回放都依赖持久化的 `assistant/chunk` 流。因此 `session/event` 上的 `assistant/chunk` 是持久的、承重的 token 流，而 `agent/stream-chunk` 是它的纯冗余镜像。

## 决策

从 agent 事件分类体系中移除 `agent/stream-chunk`。token 流通过 `session/event` 以 `assistant/chunk` 的形式读取——持久化和回放已经使用的正是同一条流。`session/event` 是唯一的实时 transcript（文本记录）流（assistant 分片、轮次/步骤边界、工具活动、todo）。

**消费方。** 唯一重要的生产消费方——ACP 桥接层（`dsh-acp`，真正面向编辑器的流式输出接口）——已经从 `session/event` 渲染 `assistant/chunk`，从未使用 `agent/stream-chunk`，因此不受影响。stdio UI（`dsh-ui-stdio`，一个一次性的测试 REPL）是唯一的实时消费方；它在边界迁移时已经有了 `session/event` 监听器，因此其分片渲染被折叠进该监听器的 `assistant/chunk` 分支。合并为一个监听器还消除了一个潜在隐患：`inReasoning` dim-SGR 标志此前在两个独立的监听器（`agent/stream-chunk` 和 `session/event`）之间共享，分片与边界在该标志上竞争时没有确定的顺序；单一监听器按追加顺序处理，使交错变为确定性的。

## 范围

移除：`agent/stream-chunk`。

未触及：
- `assistant/chunk`（持久会话事件）——权威的 token 流，原样保留。本 RFC 移除的是实时镜像，而非持久化（持久化移除提案已被单独否决，见上文）。
- `agent/steering`——本决策未触及（它是控制信号，不是 token 流）。其持久孪生事件是 `steering/message`，镜像发射由其自己的后续 RFC 移除：[移除 `agent/steering` 镜像发射](2026-07-04-remove-agent-steering-mirror.md)。
- `agent/status`、`agent/error`、`agent/created`/`agent/disposed`、`agent/queued`、`agent/session-start`——生命周期/控制事件，不是 transcript 数据，也没有持久副本。

## 曾考虑的替代方案

**移除持久化、仅保留瞬态实时流**——反向裁剪，已被[单独否决](../../rejected/simplification/2026-06-20-assembled-assistant-messages-only.md)：高保真回放、部分失败的流以及快照回放都依赖持久化的 `assistant/chunk` 流。这一点既已确定，实时发射就是配对中冗余的那一半。

## 后果

插件不再能从以 `Agent` 为首参的事件观察 token 增量。它应订阅 `session/event` 并过滤 `assistant/chunk`（如需 `Agent` 句柄，可从 `agent/created`/`agent/disposed` 构建的 session-id→agent 映射中恢复，与边界消费方的做法完全一致）。没有任何生产消费方在分片时需要实时的 `Agent`；这与边界镜像移除所做的权衡完全相同，是可接受的。
