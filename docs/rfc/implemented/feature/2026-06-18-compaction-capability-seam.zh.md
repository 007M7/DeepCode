# RFC：压缩作为能力 seam（抽象契约 + 基础后端）

Status: implemented

[English](2026-06-18-compaction-capability-seam.md) | 中文

## 问题

长时间运行的 agent（智能体）对话会无限增长。随着事件日志不断累积轮次，派生出的消息历史最终逼近模型的上下文窗口——模型随即在响应中途截断（`max-tokens`）或质量退化。**压缩（compaction）**是缓解手段：用一段简洁的摘要替换一段较早的历史，保持近期上下文完整。

[会话 surface](../../implemented/architecture/2026-06-18-session-surface.md) 正是为此而建的基础设施：它是事件日志之上的链表，带有一个 `surfaceOp: { op: 'replace', start, end }` 操作，专门用于遮蔽一段节点并插入替换内容，`sourceEventSeqs` 记录来源以便决策可确定性回放。剩下的是那个*决定压缩什么、并产出摘要*的插件。

两股力量塑造了设计。第一，压缩是**可替换的**：token 计数可以是 char/4 启发式或真实 tokenizer，摘要生成可以是模型调用、模板或远程服务——这些与*何时*压缩、*压缩哪段*彼此独立变化。第二，`SurfaceEventType` 是封闭的，只有五种事件类型（`user/message`、`assistant/message`、`tool/result`、`context/message`、`steering/message`）；只有它们可以携带 `surfaceOp`。因此一个专属的 `compaction/*` 事件**不能**出现在 surface 上——编译器拒绝在其上放 `surfaceOp`，invariants 插件在运行时也会拒绝。

## 决策

### 压缩是一个能力 seam，接口与实现分离

按照[能力 seam RFC](../../implemented/architecture/2026-06-13-capability-seams.md)，压缩以独立包（package）发布，使契约、算法和（后续的）消费方 surface 各自独立演进：

1. **接口** — `@deepseek-ai/dsh-compact`：一个抽象的 `CompactService`，拥有 `ctx.compact` 键、`CompactionResult` 词汇以及 `compact/*` 会话事件。它将 `compactIfNeeded()` 和 `compactRegion()` 声明为**抽象方法**——契约阐述压缩*做什么*，而非*怎么做*。
2. **实现** — `@deepseek-ai/dsh-compact-basic`：一个具体的 `BasicCompactService`，拥有完整算法——token 估算（每 token 字符数——`charsPerToken` 配置，默认 4——加逐块开销）、尾→头保留遍历、通过 `ctx.llm.stream()` 的摘要生成、surface 替换、锁，以及 `agent/pre-step` 自动压缩监听器。基于 tokenizer 或模板的后端是兄弟包（或覆写两个 protected 估算/摘要钩子的子类）。
3. **消费方** — 推迟。一个 `/compact` 工具和斜杠命令将 `inject: ['compact']` 并调用契约；它们被有意排除在本 RFC 范围之外，以便 seam 先稳定下来。

### 契约依赖 `dsh-session` 和 `dsh-llm`——有意的偏离

能力 seam RFC 规定接口包「只依赖 cordis」（对 `dsh-bash` 成立，其词汇是自包含的）。压缩**无法**遵守这一点：它的动词定义在 `Session` 之上（`compactRegion(session, start, end)`），其输出*就是*内容词汇（`CompactionResult.summary: ContentBlock[]`）。不引用 `Session`/`SessionEvent`（来自 `dsh-session`）和 `ContentBlock`（来自 `dsh-llm`），契约无法表达。

这不是耦合异味——而是契约的领域本身。「只依赖 cordis」的指导原则本来就是「接口只依赖契约真正命名的东西，绝不依赖实现」的简写。`dsh-session` 和 `dsh-llm` 本身就是接口/词汇包，不是实现；`dsh-compact` 仍然不导入任何后端。seam 的真正不变式——*消费方和实现在抽象服务背后独立演进*——完好无损。

### 抽象的 `compactIfNeeded` / `compactRegion`，算法在后端

早期草案将完整算法（保留遍历、token 求和、文本提取）作为接口上的具体方法，只有 `estimateContentTokens()` 和 `summarize()` 是抽象的。这会把契约重新耦合到一种策略：想要不同保留策略或不同事件排序的后端不得不与继承来的具体代码对抗。将两个核心方法都设为抽象，把所有*怎么做*的决策放在后端——它本该在那里——接口则保持为纯粹的*做什么*声明。后端内部仍有分层——`estimateContentTokens()` 和 `summarize()` 是 `protected` 钩子，子后端可以覆写而无需重新实现遍历——但这种分层是后端的私有关注，不是契约的。

`compactIfNeeded(agent, turn, step, fullSystemPrompt, signal)` 接受**必填**参数（而非最初的全可选形态）。自动压缩 seam（见下文）总是提供 agent、生命周期上下文、组装好的系统提示词（计入估算）以及轮次的 abort signal，因此可选性只会在 seam 处引入隐藏默认值。被压缩的会话来自 agent 上下文。`compactRegion(session, start, end, agent, turn, step, signal?)` 保留可选的 signal（手动调用方可以省略）。传递生命周期上下文而非具体模型，使路由 agent 保持诚实：后端的摘要请求可以走 `agent/request`，模型路由插件已在那里选择实际模型。

### 自动压缩运行在 `agent/pre-step`，一个专用的 surface 变更 seam

压缩会变更会话 surface，因此它在步骤开启之前、消息派生之前运行。`agent/request` 仍然是调用配置变换，永远不需要在 surface 变更后重建历史。

解决方案是一个专用的循环 seam：**`agent/pre-step`**（`@mode serial`），由循环在系统组装*之后*、步骤开启（`step/start`）*之前*触发：

```
assembly = ctx.systemPrompt.assemble()
await ctx.serial('agent/pre-step', agent, turn, step, system, signal)  ⟵ compaction mutates the surface here
session('step/start')                 ⟵ the step opens AFTER the seam
messages = session.deriveMessages()   ⟵ single derive, reflects the compaction
request  = waterfall agent/request    ⟵ pure request transform (hooks, model switch)
```

循环在 `agent/pre-step` 之后只派生一次消息。在 `step/start` 之前运行使压缩记录落在任何半开步骤之外，简化崩溃修复。该 seam 是 awaited 且 serial 的，因此 surface 变更不会交错；监听器返回 `void`，不使用 Cordis bail 值作为否决。

### 保留是轮次无关的；工具配对平衡是唯一的结构守卫

自动压缩在**每个**步骤之前触发，而非每轮一次。这对**失控轮次存活至关重要**：一个工具密集的 ReAct 轮次每步追加一个 `assistant/message` + 一个 `tool/result`，surface 在*一轮之内*就会增长。单独一轮就可能超出窗口（「失控轮次」）——而在下一次模型调用溢出之前能挽救它的唯一时机，就是下一步的 `pre-step` 检查点。如果把压缩限制在轮次的第一步（或更糟，逐字保留整个进行中的轮次），就恰好重新打开了压缩存在的意义所要堵住的那个缺口：harness 会在最需要压缩的时候崩溃。

`compactIfNeeded` 保留估算大小达到 `retainTokens` 的最小尾部完整 surface 单元，压缩更早的节点。一个单元是一个完整的已关闭步骤或一条无步骤消息。如果 token 截断点落在步骤内部，保留范围会扩展直到截断处工具配对平衡。平衡按 surface 顺序检查，而非日志序列号，因为替换摘要在旧 surface 位置有新的序列号。`compactRegion` 拒绝将工具调用与其结果拆开的边界。进行中的轮次不享有特殊保留。

因此失控轮次的压缩方式与任何其他历史完全相同：其早期*已关闭*步骤被摘要，近期步骤保持逐字。当唯一可压缩的内容只剩一个不可拆分的开放尾部步骤（其工具调用尚无结果）时，压缩拒绝执行（返回 `null`），待该步骤关闭后重试。

**单单元溢出不在范围内，这是有意的。** 如果单个被保留的单元——一个已关闭步骤，或一个大型自由节点如粘贴的 `user/message`——*单独*超出预算，压缩无能为力，下一次模型调用可能超预算发出。限制单个单元的大小是另一个关注点（输出截断），在别处处理；压缩对此不作承诺，而没有这种机制的 harness 仍然可能在单个超大单元上崩溃。这里诚实地命名了这个边界，而非掩盖它。

### 头部锚定：一个自动检查点，始终在头部

自动压缩始终从 surface 头部开始，将先前的检查点与新压缩的历史合并，使自动检查点始终只有一个。因此 `shadowedRange` 是位置性的而非数值序列区间：一个更新的摘要序列号可能占据更旧的 surface 位置。`shadowedSeqs` 记录权威的 surface 顺序。手动的中间范围压缩可能留下多个检查点。

### 近似收敛不变式

`resolveConfig` 校验数值参数但**不**基于假想的摘要长度不变式拒绝。收敛是动态的：提供方的输出上限可能被隐藏或外显的推理 token 消耗，模型可能输出不可预测大小的摘要。`maxTokens` 只是摘要调用的提供方侧生成上限；推理块在检查点存储前被剥离。如果压缩后的 surface 仍超阈值，`compactIfNeeded()` 最多额外重压缩头部检查点 `compactionRetries` 次，但每次提交的摘要必须小于它遮蔽的内容。唯一的残余情况是上述单单元溢出（一个向后取整的超大步骤可能把保留尾部推过预算）——这恰好是上面声明的范围外关注点，而非抖动 bug。

### Surface 替换：`compact/*` 事件仅存于日志；一条 `user/message` 承载摘要

由于 `SurfaceEventType` 是封闭的，摘要不能搭载在 `compact/*` 事件上。后端改为追加一条**单独的 `user/message`**，带有 `surfaceOp: { op: 'replace', start, end }`，其 `content` 是（带框架的）摘要，其 `sourceEventSeqs` 覆盖被遮蔽的节点*以及*簿记事件。`compact/*` 事件是纯日志记录（锁 + 来源）。surface 变更位于锁**内部**——`compact/end` 是最后追加的事件：

```
compact/start    → log-only. Acquires the lock.
[summarize older range via the backend]
compact/summary  → log-only. Provenance: raw summary, range, shadowed seqs, token count.
user/message     → surfaceOp { op:'replace', start, end }. THE surface mutation (framed summary).
                   deriveMessages() renders it as a user-role message.
compact/end      → log-only. Releases the lock (carries `error` on a recoverable failure).
```

`deriveMessages()` 随后产出 `[summary_as_user_message, ...retained_nodes]`。复用 `user/message` 是诚实的而非变通：摘要确实*就是* user 角色的上下文。

### 检查点框架 + 增量合并（后端私有）

基础后端将摘要包装为已建立的检查点上下文，并标记它以便下一轮增量合并。原始摘要保留在 `compact/summary` 上。框架是后端策略；seam 只承诺一条替换 user 消息承载可能带框架的摘要。

### 通过日志记录的锁实现阻塞，加上崩溃/可恢复失败分类

`compact/start … compact/end` 括号的合理性，按实际承担的工作排序：

1. **可检测的崩溃孤儿 + 来源记录**（首要）。摘要生成是一次慢模型调用，在 `compact/start` *之后*持久化。摘要生成中途崩溃会留下一个没有匹配 `compact/end` 的 `compact/start`——一个可检测的孤儿。最后释放锁（而非最先释放）将崩溃窗口从*静默损坏*转化为可检测的孤儿。
2. **防止并发压缩。** 如果当前轮次持有一个未匹配的 `compact/start`，`compactRegion` 拒绝启动。（循环在 awaited 的 `pre-step` 上是单线程的，因此这也是一个重入绊线——抛出的「already in progress」信号意味着真正的 bug。）

两种失败路径，均有文档记录：

- **崩溃**（循环在摘要生成中途死亡）：一个悬空的 `compact/start`，没有关闭者。因为 `compact/*` 是**仅日志**事件，孤儿是**惰性的**——surface 替换从未落地，所以完整的未压缩历史正确派生。通用轮次修复（`interruptedTurnClosers`）用合成的 `turn/end` 关闭轮次；孤儿位于该 `turn/end` *之前*，因此轮次范围的进行中检查永远看不到它，崩溃不会卡住未来的压缩。压缩在下一个 `pre-step` 简单地重新尝试。
- **可恢复**（摘要生成抛出异常但循环存活）：后端追加带有 **`error`** 字段的 `compact/end`，surface 不受影响，模型调用继续使用完整历史。

`compact/end` 保留其 `error?` 字段（与 `tool/result` 的自包含错误一致——一个事件即可区分成功与失败，无需关联兄弟事件）。没有单独的 `compact/error` 事件。

**核心会话修复保持对压缩无感知——这是有意的。** `interruptedTurnClosers` 从不被教导 `compact/*`。如果教导它，每个未来的 `xxx/start … xxx/end` 插件对都必须修补核心模块——这恰好是能力 seam 架构存在的意义所要避免的耦合。因为仅日志的孤儿是惰性的，不需要特殊修复：通用轮次修复加上未落地 surface 变更的惰性就足够了。

## 曾考虑的替代方案

- **完整算法作为接口上的具体方法**（只有估算/摘要是抽象的）——早期草案；否决，因为它把契约重新耦合到一种保留策略。两个核心方法都是抽象的；`protected` 的估算/摘要钩子是后端的私有分层，不是契约的。
- **压缩运行在 `agent/request` waterfall（瀑布式事件）上**——早期方案；否决，因为它强制了双重派生，且交给监听器的上下文在结构上无法压缩。专用的 `agent/pre-step` seam 使分层在构造上正确。
- **单独的 `compact/error` 事件**——否决：`compact/end` 保留 `error?` 字段，与 `tool/result` 的自包含错误一致——一个事件即可区分成功与失败，无需关联兄弟事件。
- **教导核心轮次修复认识 `compact/*`**——否决：仅日志的孤儿是惰性的，而一个为每个未来 `xxx/start … xxx/end` 插件对打补丁的核心模块，恰好是能力 seam 架构存在的意义所要避免的耦合。

## 后果

- **新包**：`packages/compact/compact`（接口）和兄弟包 `compact-basic`（后端），位于 `packages/compact/` 下，接入根 tsconfig。消费方层推迟。
- **新循环 seam**：`agent/pre-step`（`@mode serial`），在 `dsh-agent` 中声明，由 `dsh-agent-loop` 在系统组装之后、`step/start` 之前触发。这是循环的文档化变更——`docs/architecture.md` 记录了它，生成的 cordis catalog 携带其签名。
- **`SessionEventMap`** 通过声明合并（merge-extensible）获得 `compact/start` / `compact/summary` / `compact/end`；`SurfaceEventType` **不受影响**。这些是会话事件而非 cordis `Events`，因此事件分类门禁无需新增条目。
- **`dsh-session`** 获得工具配对平衡谓词（`isToolPairingBalanced`，位于 `tool-pairing.ts`，从包索引导出），`compactRegion`/`compactIfNeeded` 用它确保折叠区域不会拆开步骤的工具调用/结果对。surface 的 `replace` 操作和 surface 元数据运行时守卫已经存在，直接复用。
- **`dsh-invariants`** 移除其 `surface replace: start must be <= end` 断言：头部锚定的压缩会将高序列号的替换节点放在更旧范围的*位置*，因此 `start > end` 在数值上是正常且有效的（范围是位置性的，由 surface 的 `indexOf` 检查验证，这些检查保持不变）。轮次包含不变式原样复用。
- **接线**：`dsh-compact-basic` 在 `examples/coding-agent` 的 `cordis.yml` 中加载，使 seam 在真实演示中交付（此前未在任何地方加载）。

## 测试

- **单元测试：** 真实 Loader 和 invariant 插件覆盖整单元保留、收敛失败、`compact/end` 的两种结果、头部锚定、开放尾部拒绝、惰性崩溃孤儿，以及在一个超大开放轮次内压缩已关闭步骤。
- **循环测试：** 测试固定每步在 `turn/start` 和 `step/start` 之间有一次 awaited 的 `agent/pre-step`；在那里的 surface 变更落在步骤之外，并出现在单次派生的请求中。
- **带密钥 e2e：** 真实模型和 bash 会话在降低限制下触发压缩，记录完整的 `compact/start…end` 对，缩小 surface，并完成任务。
- **快照缺口：** 失控轮次压缩尚无法回放，因为摘要调用未记录 `assistant/chunk` 事件或 `sessionId`；交错的摘要调用回放仍是后续工作。
