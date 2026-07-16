# RFC：会话前缀——置于派生历史之前的仅请求消息

Status: implemented

[English](2026-07-07-session-prefix.md) | 中文

## 问题

插件经常拥有一段会话级别稳定的开场内容，模型必须始终看到它：技能目录、AGENTS.md 摘要、工作区基线。在这个 seam 出现之前，harness 只提供两个归属位置，但对这类内容来说两个都不对。系统提示词是一个渲染后的单字符串：消息形态的内容（user 角色的 `<system-reminder>` 信封、多消息引导序列）放不进去，而且提供方对对话消息与系统文本的权重处理不同。持久化历史（`agent.inject()`、会话开始时的 `context/message`）会让开场内容变成永久记录：每个 `deriveMessages()` 消费方都会回放它，压缩（compaction）的保留遍历拥有它，fork 会把它以陈旧状态烘焙进去，resume 无法刷新它——一份在会话诞生时捕获的目录会比它所描述的世界活得更久。

显而易见的第三个选项——让插件在请求发出时编辑 `messages`——被[可重建请求 RFC](../architecture/2026-07-05-reconstructable-requests.md) 禁止：每个由循环构建的请求都是会话日志的纯函数，因此承载开场内容的通道必须精确记录它所发送的内容。缺失的是一个带持久记录的仅请求消息通道。

## 决策

`agent/session-prefix` 是 agent 事件映射上的一个 waterfall（瀑布式事件）（[`packages/core/agent/src/types.ts`](../../../../packages/core/agent/src/types.ts)）：监听器接收一个冻结的空种子并返回一个扩展（规范的贡献方式是前置，`[mine, ...await next()]`，在协议格式上产生注册顺序）。循环（[`packages/core/agent-loop/src/loop.ts`](../../../../packages/core/agent-loop/src/loop.ts)）在每个循环实例中触发一次，延迟到该实例首次 `agent/pre-step` 之前；组合后的列表被深拷贝、深冻结、缓存在实例上，并在该实例发送的每个请求中置于**整个**派生历史之前——紧接在提供方的 system 槽位之后（[协议格式顺序](../../../core-data-structures/core.md#the-request-envelope-llmcallconfig-and-the-logged-header)）。

三个属性承载了这一设计：

- **仅请求，记录在 header 中。** `deriveMessages()` 从不返回前缀；它唯一的持久记录是实例锚定的 `request/header` 快照上的 `EpochHeader.messagePrefix`——可重建请求 RFC 已经为请求的非历史部分拥有的通道，因此不引入新的会话事件。开发不变式（[dsh-invariants](../../../../packages/support/invariants/src/index.ts)）对每个循环构建的请求重新计算 `messagePrefix + 边界派生`；未记录的前缀无法到达协议格式。
- **按实例冻结。** 复用是结构性的，而非靠纪律保证：缓存的产物在会话中途不可变，因此提供方的 prompt 缓存在构造上成立，前缀以每步零边际成本扩展了可缓存区域。进程重启或 `ctx.agents.resume()` 是一个新实例：它重新组合，任何漂移都可归因地落在 `'resume'` header 快照上。这就是该 seam 创建的路由规则：会话冻结的开场内容走前缀；会话中途变化的内容走仅追加历史通道（`agent.inject()`、`tools/post-execute` 决策的 `additionalContext`、prompt-submit 的 `additionalContext`——[拦截 seam RFC](2026-06-30-interception-seams.md)），每条都是一次性持久化的 `context/message`，之后被前缀缓存覆盖。
- **在压力门禁之前组合。** 组合先于实例的首次 `agent/pre-step`，且 seam 将组合值传递下去：`agent/pre-step` 携带 `sessionPrefix` 参数，`CompactService.compactIfNeeded(agent, fullSystemPrompt, sessionPrefix, signal)` 将其计入 token 压力估算——如果门禁读取的是上一个实例折叠后的前缀，那么在一个贡献者增长了的 resume 或 fork 实例的首步上会低估压力，跳过压缩并发出超窗口的首请求。组合过程中如果 cancel/dispose 落入 waterfall 内部，组合结果被丢弃、永不缓存：一个感知中止的监听器的降级回退不会泄漏到后续请求中，下一轮次在活跃 signal 下重新组合。

由于组合在边界快照之前运行，组合监听器的会话追加会加入**当前**请求的派生历史。压缩在结构上无法触及前缀（或系统提示词）：它重写的是表面节点，而 header 状态从不进入表面。

## 测试

[拦截测试](../../../../packages/core/agent-loop/tests/interception.spec.ts)固定了无 header 增量时的组合一次复用、前置顺序、空前缀省略、不可变性，以及组合先于 pre-step；[取消测试](../../../../packages/core/agent-loop/tests/cancel.spec.ts)固定了丢弃与重新组合。会话编解码器、不变式和压缩测试覆盖 header 往返、请求重建和前缀感知的压力计算。快照规范化保留前缀计数，而[固定 header 场景](../testing/2026-07-06-pin-request-header-content-in-one-scenario.md)拥有内容，默认示例保持无前缀。不需要前缀专属的 e2e 测试，因为该 seam 是确定性的且与提供方无关；带密钥的[请求缓存 e2e](../../../../packages/core/agent-loop/tests/request-cache.e2e.ts) 覆盖了其缓存经济性。

## 曾考虑的替代方案

- **每请求 `before`/`after` 槽位，每步重新计算**（最初提出的形态：每个请求触发一次 waterfall，贡献冻结的 `before` 消息置于历史之前、新鲜的 `after` 消息置于历史之后）：否决。每步重新组合 `before` 会引入静默漂移——除非每步记录一个 header 增量，否则没有东西将其锚定到日志——而 `after` 槽位位于不断增长的历史之后，其 token 在每个请求中重新支付，且其后的所有内容不可缓存。与各替代方案对比衡量，当前每种更新模式都能由持久追加更廉价地服务（支付一次，此后缓存读取），唯一没有归属的内容是会话稳定的开场——它需要的是冻结，而非重新计算。
- **系统提示词分区**（`system-prompt/assemble`）：对此类内容否决。组装渲染为单一 `system` 字符串，消息形态的开场放不进去；且系统提示词被设计为每步重新组装（变化时带 header 增量），而开场内容需要的是按实例冻结的语义。
- **持久化历史开场**（会话开始时 `inject()`）：否决。永久历史正是问题陈述中的失败模式——到处回放、可被压缩、跨 resume 陈旧。
- **按轮次而非按实例组合**：否决。轮次边界的重新组合要么与日志静默失同步，要么强制每次变化产生一个 header 增量，且它每次触发都会破坏提供方缓存；合理的刷新点是实例边界，`'resume'` 快照已经在那里可归因地记录漂移。
- **在首请求时延迟组合，让压缩读取折叠后的 header**（首次合入时的形态）：评审中被取代。折叠值只从实例的第二个请求起才与活跃前缀匹配，因此在 resume/fork 实例的首步上，压力门禁读取的是**上一个**实例的前缀，可能低估压力。在首次 pre-step 之前组合并通过 seam 传递活跃值，使估算在每一步都精确。
- **承载前缀的专用会话事件**：否决。header 事件在设计上就是请求的非历史记录；第二个事件会成为同一事实的第二个归属，以及又一个需要保持完整的编解码器。

## 后果

- `agent/pre-step` 和 `CompactService.compactIfNeeded` 携带 `sessionPrefix` 参数：每个 pre-step 监听器和压缩后端都能看到真实的每实例值（所有仓库内实现在同一个变更中更新，遵循预发布立场）。
- 内容在会话中途变化的贡献者不会被重新读取，直到下一个实例——这是设计意图。需要会话中途目录更新的部署应将变更通知路由到仅追加历史通道，支付一条持久化 `context/message`。
- 被放弃的 `after` 槽位使请求尾部没有仅请求通道；仓库中没有任何东西需要它，且加回它会重新引入该设计旨在避免的每步重复支付成本。
- `request/header-delta` 的 `messagePrefix` 分支（整数组替换，空数组编码向缺失的过渡）为编解码器完备性而存在；循环从不行使它，因为缓存的前缀在实例内不可变。
- 空组合是规范的缺失状态：无贡献者的部署不记录额外 header 字节，其请求就是裸派生。
