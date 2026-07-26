# dsh-agent-loop

[English](README.md) | 中文

唯一的实体 agent（智能体）插件与循环驱动器。其包（package）内部实现满足 `Agent` 接口，并驱动会话／轮次／步骤生命周期。

这是 harness 中唯一包含实体循环逻辑的包。其他所有内容要么是抽象服务，要么是针对扩展 seam 的插件：新行为应放入插件，而不是这里。

## 服务：`AgentLoop`（ctx 键：`agentLoop`）

### 公开 API

创建与恢复属于同一个受回滚保护的事务：构造私有会话、实体 agent 和带作用域的上下文；等待可选 setup；进入两个注册表；依次宣告 `session/created` 和 `agent/created`；发出 `agent/session-start`；此后才启动驱动器。Setup 接收完整的带作用域 `Context`，作为受信任的同进程组合代码，并且不得驱动尚未发布的 agent。普通的类型化身份与选项输入遵循只读契约以借用方式传入；seed 事件与会话元数据会跨越持久会话边界，因此系统会验证并快照它们。可选的 `AbortSignal` 只取消加载／setup／发布，并在返回的 handle 可见前分离。

调用方 fiber 与 AgentLoop 提供方共同拥有 agent。`AgentFactory.createAgent(ownerCtx, options)` 与 `resume(ownerCtx, options)` 显式接收调用方所有权，而工厂为 `sessions`/`llm`/`tools`/`systemPrompt` 保留自身的依赖上下文；这样，调用方可以只注入 `agents`，而不会缩减新 agent 的服务接口。调用方卸载、handle 释放或提供方卸载都会汇合到同一个记忆化的完全停稳边界。提供方关闭会同时等待资源 teardown，以及已经观测到停用的公开 create/resume 包装层，因此依赖消失后，任何 continuation 都无法继续发布。

每个 agent 与其会话共享一个由调用方选择的 `SessionId`，并假设它在全局唯一；意外的 UUID 冲突不属于受支持模型。两个使用同一 id 的并发操作都可以进行准备，但最终的 `enter()` 调用会裁决发布，所有失败方都会回滚各自的私有资源。每次 detach 都绑定到确切进入的对象，因此陈旧 disposer 无法移除之后出现的同 id 替代项。在同步创建通知期间请求的 detach 会等待该次分发退栈，从而保留 created/disposed 配对。Teardown 顺序为停止并 drain（包括尚未完成的空闲注入 flush）→ detach agent → detach 会话 → 撤销作用域；detach 完成后，即使私有作用域仍在完成清理，该 id 也可以复用。普通、不可 veto 的 `agent/*` 通知通过 `agentEvents(ctx, agent)` 发出；逐步骤组装通过 `assembleContextFor(agent)` 完成；轮次结束时的持久性检查点通过 `ctx.sessions.flush(session)` 完成。

- `ctx.agentLoop.create(id: SessionId, options?: AgentOptions, meta?: { cwd?: string }): Agent`：在确切共享的 agent／会话 id 下同步创建，不运行 setup，并随调用 fiber 释放。声明式配置把 `agents[].id` 视为稳定 label，通常会先生成 `${label}-session-<uuid>`，再调用此边界。应用也可以提供稳定且确切的 `sessionId`：首次使用时创建；重新挂载且持久化内容已存在时，则恢复已经实体化的历史。`resumeSessionId` 要求并加载现有的持久化 id，且与 `sessionId` 互斥。这样，默认的全新重启不会冲突，也无需保留第二个实时路由身份。

`AgentLoop` 还实现 `AgentFactory` seam，并通过 `ctx.agents.setFactory(this)` 注册自身，因此插件会通过接口 `ctx.agents` 创建／恢复 agent：

- `ctx.agents.create({ sessionId, meta?, seed?, agentOptions?, setup?, signal? }): Promise<AgentHandle>`：使用调用方提供的共享 id 以编程方式创建。它会等待尚未发布的 setup 事务，然后才返回；`meta` 携带 cwd／谱系／seed 边界元数据，`seed` 则在会话边界验证并快照持久值后，重建 fork 子级的前缀。`signal` 只在此 Promise 结算前生效。解析得到的 [`AgentHandle`](../agent/README.md) 拥有确切的 teardown。
- `ctx.agents.resume({ resumeSessionId, agentOptions?, setup?, signal? }): Promise<AgentHandle>`：通过 `ctx.sessionPersistence` 加载持久化会话（参见[会话持久化](../../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md)），使用同一 id 注册 agent，重建历史，然后针对全新且尚未发布的 agent 作用域等待 setup，再执行受回滚保护的发布。轮次编号和派生历史从已加载日志继续。此操作要求存在会话持久化后端（不会硬注入，因此非持久化 demo 仍能工作；缺少持久化时，`resume` 会以明确错误拒绝）。`signal` 仅用于创建。返回 `AgentHandle`。

配置驱动的 `ctx.agentLoop.create()` 路径让循环 fiber 拥有其 agent（该路径会丢弃 handle）。对于以编程方式创建的 agent，handle 持有者是唯一面向消费方的 teardown 能力；AgentLoop 提供方卸载是一条独立的结构化 teardown 边，而不是向应用代码公开的另一个 handle。

### 注入的服务

`agents`、`sessions`、`llm`、`tools`、`systemPrompt`：全部 5 个接口服务。

### 不变量配套入口

可选的 `@deepseek-ai/dsh-agent-loop/invariant` 配套入口会向 `ctx.invariants` 注册请求重建。循环会把每个确切的冻结请求记录在 `dsh-llm` 拥有的进程本地身份集合中；随后，配套入口要求存在实时会话，并根据日志独立重建消息边界和折叠后的请求 header。即使调用方冻结直接的一次性调用，或为其附加会话 id，这类调用仍不属于该契约。

### 配置（Schemastery）

```ts
interface Config {
  maxParallelToolCalls?: number // default 10; 1 is serial
  agents: Array<{
    id: string                 // required
    provider?: string
    model?: string
    resumeSessionId?: string   // load this persisted session instead of creating one
    cwd?: string               // optional workspace cwd for the fresh session
  }>
}
```

通过配置创建的 agent 会自动启动。模型调用同时需要 `provider` 和 `model`；`agent/request` 可以在分发前补齐缺失的这一对值。`maxParallelToolCalls` 限制每个 agent 针对并行安全调用使用的滚动池，默认值为 `10`。`cwd` 仅应用于全新会话，而 `resumeSessionId` 保留持久化元数据。通过配置创建的 agent 使用部署 persona；编程式 setup 可以按 agent 遮蔽它。该插件提供逐 agent 的 `provider`、`model` 和 `cwd` 提示词变量；harness 身份与部署 persona 属于 `dsh-system-prompt`。

### 包内部实体驱动器

实体 `ReactLoopAgent` 适配器、其 `Inbox`、`runLoop`，以及绑定实例的发布／启动控制均为包内部实现。包根只导出插件／服务／配置契约，包导出映射不提供 `./src/*` 逃逸路径；生命周期拥有方通过 `ctx.agents` 创建 agent，而不是点名、构造或启动驱动器内部组件。一个准备完成的会话只能由一个实体驱动器认领；所有可观测行为都通过会话事件和 `agent/*` 事件分类体系发生。

`ReactLoopAgent.send()` 实现公开且完全解析的接纳路径。`followup()`/`queue()`/`steer()`/`inject()` 辅助方法会先解析每个可选字段，再委托给它；直接调用方通过 `ResolvedAgentInput` 提供必填的内容、来源、上下文、元数据、目标与唤醒事实。`followup()` 和 `queue()` 加入普通 FIFO，前者会唤醒空闲驱动器，后者则让其保持停驻。认领后的普通项是所属轮次的唯一消息；其上下文是提示词 waterfall（瀑布式事件）的默认附加上下文，只在通过接纳后实体化。缺少 placement 或 placement 为 `separate` 时，会追加一条独立注入的 `user/message`；placement 为 `prompt-prefix` 时，则把上下文、稳定的 `## My request:` 分隔符和有效请求写入同一条 `user/message`，其对模型隐藏的 envelope 保留显示内容和上下文描述符。waterfall 返回的允许决定具有权威性，因此，使用 `next()` 包装下游的监听器会保留下游 `content` 和 `additionalContexts`，除非它有意替换相应字段。后续普通项会等待前一普通轮次的检查点结算；取消、释放、提示词阻止或启动前失败则可能让上下文随消息一同丢弃。运行期间调用 `steer()`，或使用等效的 `send()` 路由，会在不分发 `agent/prompt-submit` 的情况下，把相同记录形态加入 steering FIFO；下一个检查点会对 `steering/message` 应用相同的独立或前缀 placement，但策略仍可以在另一步骤前停止。轮次及其检查点关闭后遗留的 steering 会连同上下文转为之后的排队输入，除非终止轮次策略、取消或释放将其丢弃。`inject()` 和不唤醒的下一步骤接纳要求上下文元组为空，绕过两个 FIFO 并直接追加持久上下文：轮次打开时，注入会在当前步骤执行 assistant 工具调用期间延后到一个 FIFO 中（成功批次把它放在所有结果之后，中断批次则在轮次关闭前 drain）；空闲时，注入会包在一次性 `injection` 轮次中。每次 FIFO 入队都会发布 `agent/inbox/enqueue`；驱动器的认领会发布 `agent/inbox/dequeue`；`cancel()` 在不带 `keepInbox` 时会发布 `agent/inbox/discard`。格式错误的数据会在入队或追加前抛出。

### 循环生命周期（`loop.ts`）

驱动器在其整个生命周期内拥有一个 agent，并在 `ctx.agents.withInitiator(agent, ...)` 内运行。包私有的编排入口点会恢复确切的 Agent，一次性派生 `agent.session`，并让操作局部的辅助函数捕获它，而不是通过浅层接口继续传递实体驱动器或每次操作的 `Session`。如果显式 `Session` 正是辅助函数的实际接口，该辅助函数会保留它；创建、持久化加载、未发布 setup、服务、worker、进程、持久化和 wire 协议则继续保留各自的显式身份。[agent 服务](../agent/README.md#initiating-agent-scope)规定传播、teardown 和分离工作规则。

每次提供方调用成功结束时，都会恰好追加一个 `assistant/message` 完成锚点，包括无内容调用和以 `max-tokens` 结束的调用。成功的 `agent/step-result` 存储其转换后内容；被拒绝的结果会先记录空内容，再继续抛出原始失败。该锚点保留确切的 chunk 溯源（流没有 chunk 时为 `[]`），并在用量可用时保留用量；空内容不会进入派生消息历史。

插件失败会结束当前轮次，而不是结束循环。只有最终适配器分发／迭代失败，以及带内的终止错误或中止结束原因，才进入 `agent/request-error`；中间件、结果处理、工具和 `agent/post-step` 仍属于普通轮次失败。失败步骤关闭后，恢复逻辑会接收确切的实时错误、不可变的提供方事实和不可变的先前失败。重试会在新的编号步骤中根据持久日志重建；成功会清除连续失败历史；耗尽后只在 `turn/end` 上记录一次结构化失败。AgentLoop 私下拥有一个取消持有者，其显式信号覆盖提示词策略、组装、每个步骤、模型与工具工作、恢复、continuation 和终止停止；它会在发布 `turn/end` 前立即退役该持有者，而驱动器可以在持久性 flush 期间继续保持 `running`。有效的 `cancel()` 会先发出仅存在于运行时的类型化 `user | parent` 原因，再清除待处理工作，并以协作方式中止该持有者；通知失败无法 veto 取消，通知观察方排队的工作会被清除，之后由中止观察方排队的工作属于下一轮次，空闲取消则不发出任何内容。持久 `turn/end` 仍使用粗粒度的 `aborted`；未分发的模型工具调用会收到合成的 `tool/call` 与 `ABORTED_BEFORE_DISPATCH` 结果对。释放会在终止分类中胜出；忽略信号的工作必须先结算，系统才能完全停稳。[显式取消决策](../../../.agents/notes/implemented/architecture/2026-07-16-explicit-turn-cancellation.md)规定生命周期与竞态契约。终止 continuation 的停止决定在轮次关闭和持久性 flush 期间始终具有权威性。

在步骤内，独占调用形成屏障；并行安全调用使用有界滚动池，并在启动前重新分类。只有分发／主体会重叠。策略、持久结果和结果上下文仍保持模型顺序。中止会停止新调用、drain 已启动的结果，然后在轮次通过普通中止路径关闭前，drain 已接纳的批次上下文。

### 插件负责的内容

超出「调用模型、运行工具、重复」的所有内容，都属于监听事件分类体系的插件：
- 钩子与策略：相关的 `agent/*` 检查点，加上受守卫保护的 `tools/pre-execute` → `tools/execute` → `tools/post-execute` → 定义拥有的 `finalizeContent` → `tools/result` 流水线；确切事件签名与 mode 位于生成的[事件目录](../../../docs/cordis-catalog/events.md)
- 压缩（compaction）：在 `agent/post-step` 上观测压力；在 `agent/request-error` 上处理规范上下文溢出
- 瞬时模型恢复：`dsh-llm-retry` 监听 `agent/request-error`，使用有限且针对错误码的预算，并发出不进入表层的 `llm/retry` 状态事件
- 沙箱、权限、计划模式：使用 `tools/pre-execute` 提供可扩展的拒绝／询问，使用 `tools.guard()` 提供单调拥有方策略，使用 `tools/post-execute` 处理结果决定，并使用 `tools/result` 进行最终观测
- subagent：在循环外部实现为 `ctx.subagents` 提供方；进程内提供方使用 `ctx.agents.create()` 和拥有的 `AgentHandle` 进行 teardown，而通用的 [`ctx.tasks`](../../tasks/tasks/) 与 [`dsh-tool-subagent`](../../subagent/tool-subagent/) 负责后台收集。
- 持久化：`session/event` + `session/flush`
- UI：`session/event`（assistant token 流、边界、工具活动）+ `agent/*` 控制事件（`agent/status`、`agent/created`/`agent/disposed`）

## 模型体验

### 完整对话请求

#### 模型所见

每个步骤中，循环会发送针对该 agent 呈现的系统提示词、可见工具 schema、冻结的会话前缀和会话派生消息。它提供 `model` 与 `cwd` 变量值，但不添加固定文案。

#### Token 影响

每个步骤都会再次计入系统文本、schema 与前缀。逐 agent 作用域决定初始贡献，而权威组装 waterfall 可以改变最终请求，并使其监听器负责保持协议连贯。

#### KV Cache 影响

只有在同一提供方和模型路由下，系统文本、schema、会话前缀与先前历史保持逐字节相同时，才保持仅追加。携带 token 的组装改写或组合变更可能从第一个改变的请求 token 起使复用失效。

### 保留的消息历史

#### 模型所见

已接纳的 user 消息、assistant 消息、工具调用与结果、注入上下文和 steering 都会记录，并在后续步骤中发送。原始流分片、生命周期边界和其他仅写入日志的事件会被排除。

#### Token 影响

输入会随每条表层消息增长，直到压缩替换遮蔽较旧节点；包含多个步骤的工具轮次会在每个步骤重新发送累积的前缀与历史。

#### KV Cache 影响

普通历史增长仅追加，并保留可复用条目。接口替换或压缩会从第一个被遮蔽的历史 token 起使复用失效。

### 取消后未分发的调用

#### 模型所见

如果后续请求回放一个中止的步骤，取消所阻止分发的每个工具调用都有错误码 `ABORTED_BEFORE_DISPATCH`，结果文本为 `Error: tool call aborted before dispatch`。

#### Token 影响

每个跳过的调用都会在历史中保留一个固定错误结果，直到压缩将其遮蔽。

#### KV Cache 影响

仅追加；每个合成结果都位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与暂缓工作

- **分类是一元的**：安全性取决于比较同级调用或资源的调用必须保持独占（参见[设计原理](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md)）。
- **配置 label 默认每次新建**：省略 `sessionId` 会在每次启动时创建全新的 `${id}-session-<uuid>`；确切的恢复或创建行为要求显式提供稳定的 `sessionId`，而 `resumeSessionId` 要求已有持久化历史。
- **配置 agent 没有逐 agent persona 字段或 setup 钩子**：它们使用部署 persona；只有编程式 `ctx.agents.create()` / `resume()` 工厂选项支持带作用域的 persona／工具组合。
- **没有内置轮次预算**：只要步骤包含工具调用或 steering，默认 continuation 就是 `continue`；限制失控轮次需要使用 `agent/turn-continuation` 强制停止插件。
