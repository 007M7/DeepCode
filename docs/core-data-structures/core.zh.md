# 核心数据结构

[English](core.md) | 中文

本目录编目 DeepSeek Harness 的**数据结构**：每个核心类型代表什么、它的字面形状，以及完整细节在哪里。它与 [architecture.md](../architecture.md) 互补——后者描述*行为*（服务映射、会话/轮次/步骤生命周期、事件分类体系）；本页描述行为所操作的*词汇*。

## 什么算"核心"

harness 是一个微内核：一个极小的核心加上众多插件。大多数类型属于某一个插件或某一项能力。但有少数类型构成**主干**——agent loop（智能体循环）及其事件在*每一个*轮次中使用的语言，无论加载了哪些可选插件。这些就是"核心"。

精确地说，一个数据结构是**核心**的，当且仅当满足以下条件之一：

1. 它流经 agent loop 主干——循环在每个轮次中持有、派生、流式输出或记录它（`Message`、`StreamChunk`、`SessionEvent`、`Agent` 句柄本身），与当前加载了哪些插件无关；**或者**
2. 它是插件作者面向某条流水线编写的唯一标题类型——`ToolDefinition`（每个工具*是什么*）。

其他一切都记录在**子页面**上，而非本页。划线的规则是：*你编写、持有或接收的类型是核心；为它提供类型推导、渲染或持久化的机制是子页面细节*。因此 `ToolDefinition` 是核心，但为它提供类型推导的 `SchemaSpec`/`InferArgs` DSL、为它提供渲染意图的 `ToolCallView`/`ToolResultView` 词汇，以及存储事件日志的 `SessionPersistence` seam 都不是——它们分别在下列子页面中。

| 子页面 | 负责内容 |
|---|---|
| [llm-streaming.md](llm-streaming.md) | `StreamChunk` 协议格式（wire format）+ 适配器契约（adapter contract）、`BlockAssembler`、`LlmAdapter` seam |
| [scope.md](scope.md) | 作用域注册标识、dispatch 载体，以及拥有的 `Scope` 上下文 |
| [session.md](session.md) | 完整的 `SessionEventMap` 变体目录、`TurnTrigger`/`TurnEndReason`、`deriveMessages()`、轮次封闭不变式 |
| [persistence.md](persistence.md) | 持久性 seam：`SessionPersistence`、JSONL + SQLite 后端、`session/flush`、崩溃恢复、`SessionHeader` |
| [session-query.md](session-query.md) | 逻辑会话/事件记录与有界精确事件读取 |
| [system-prompt.md](system-prompt.md) | 逐次组装的上下文、工具提供方结果、prompt 段落与协作式组装 |
| [tools.md](tools.md) | `ToolDefinition` 完整字段、schema DSL、`ToolExecution`/`ToolResult`、工具展示 UI 类型，以及受保护的执行流水线 |
| [user-interaction.md](user-interaction.md) | UI 支持的人工问答 seam：`AskUserQuestionRequest`、answer/options 词汇、provider API、错误分类体系 |
| [approval.md](approval.md) | 一次性用户审批 seam：`ApprovalRequest`、`ApprovalOutcome`、逐会话策略、审计与 answerer 契约 |
| [bash.md](bash.md) | bash 执行器 seam：`BashExecRequest`/`Spec`、`BashRunResult`、后台 `BashTask` |
| [sandbox.md](sandbox.md) | 进程隔离 seam：文件效果模式、`SandboxPolicy`、`ConfinedArgv`、强制执行与 fail-closed 错误 |
| [code-runtime.md](code-runtime.md) | 代码执行 seam：`CodeRunRequest`/`Result`、绑定命名空间、捕获日志、`CodeRunFailure` 分类体系 |
| [filesystem.md](filesystem.md) | 文件系统 seam：`FsTarget`、读/写/编辑结果、观测到的文件状态、`FsErrorCode` |
| [skills.md](skills.md) | skill 服务：发现优先级、`SkillSummary`/`SkillDefinition`、会话前缀目录、面向模型的 `skill` 加载 |
| [compaction.md](compaction.md) | 压缩（compaction）seam：`compact/*` 会话事件、`CompactionResult`、`CompactService` 接口 |
| [subagent.md](subagent.md) | subagent seam：命名提供方注册表、`SubagentStartRequest`/`Result`/`Run`、启动时与运行时能力拆分 |
| [web.md](web.md) | Web 访问 seam：`WebSearchRequest`/`Result`、`WebFetchRequest`/`Result`、`WebFetchBody`、provider 可用性、`WebError` |
| [workflow.md](workflow.md) | 工作流 seam：`WorkflowStartRequest`、`WorkflowMeta`、`WorkflowRun`/`Result`、`workflow/*` 事件载荷、`WorkflowError` 致命性 |

> 本页的类型定义**逐字**粘贴自源码，并由 `pnpm run verify-type-equiv` 进行漂移检查（见 [development.md](../development.md#documenting-types-verbatim-ts-type-equiv)）。为可读性省略了行内 JSDoc；完整契约请跟随源码链接查看。

FIXME(catalog-verbs): the drift gate covers only the nouns (the pasted type shapes); every method surface on these pages is hand-written prose. core-data-structures should probably also generate the *verbs* — the public methods of the cataloged classes — so a signature change cannot silently outdate the catalog.

## `…Map → derived-union` 模式

harness 中几乎所有可扩展的和类型都遵循同一形状：一个以判别标签为键的接口（`…Map`），联合类型由 `keyof` 派生。插件通过**声明合并**添加变体——无需修改拥有该类型的包。

```ts ignore-check
// The pattern, schematically:
interface ThingMap {
  'a': { kind: 'a'; /* … */ }
  'b': { kind: 'b'; /* … */ }
}
type ThingKind = keyof ThingMap          // 'a' | 'b'
type Thing = ThingMap[keyof ThingMap]    // the discriminated union

// A plugin extends it without touching the source package:
declare module '@deepseek-ai/dsh-llm' {
  interface ThingMap {
    'c': { kind: 'c'; /* … */ }
  }
}
```

六个规范 map 使用此模式；插件作者扩展它们：

| Map | 包（package） | 派生 | 目录 |
|---|---|---|---|
| `ContentBlockMap` | dsh-llm | `ContentBlock` | [下文](#content-blocks-and-messages) |
| `MessageSourceMap` | dsh-llm | `MessageSource` | [下文](#content-blocks-and-messages) |
| `FinishReasonMap` | dsh-llm | `FinishReason` | [下文](#the-model-request-and-result) |
| `TurnTriggerMap` | dsh-session | `TurnTrigger` | [session.md](session.md) |
| `TurnEndReasonMap` | dsh-session | `TurnEndReason` | [session.md](session.md) |
| `SessionEventMap` | dsh-session | `SessionEvent` | [session.md](session.md) |

消费方最常 `switch` 的两个大型判别联合类型是：**`StreamChunk`**（流式协议）和 **`SessionEvent`**（日志条目）。按仓库约定，对标签做 `switch`——不要链式 `if`——这样每个分支都能窄化类型，拼错的标签会编译失败。

## 品牌化 ID

跨包边界的 ID 是**品牌化**的——结构上是字符串，但在类型层面不可互换（`AgentId` 不能传给期望 `CallId` 的地方）。构造通过每个类型专属的工厂函数；比较、日志和 JSON 行为与普通字符串一致。

`Branded<B>` 原语位于自己的纯类型包 [dsh-brand](../../packages/util/brand)（无运行时代码，不依赖 harness 包），因此任何包都可以为自己拥有的 ID 品牌化，而无需依赖不相关的能力包（例如 dsh-bash 仅通过 dsh-brand 品牌化 `BashTaskId`/`OwnerToken`，从不引入 dsh-llm）。

Source: [`packages/util/brand/src/index.ts`](../../packages/util/brand/src/index.ts)

```ts type-equiv
type Branded<B extends string> = string & { readonly [BRAND]: B }
```

三个核心 ID：`CallId`（关联工具调用与其结果；dsh-llm）、`SessionId`（dsh-session）、`AgentId`（dsh-agent）。每个都是 `Branded<'CallId'>` 等加上同名工厂函数。能力 seam 也品牌化自己的 ID——见 [bash.md](bash.md) 中的 `BashTaskId`/`OwnerToken`。

## 内容块与消息

一段对话由 `Message` 组成；一条消息是一个类型化**内容块**的数组。块的联合类型从 `ContentBlockMap` 派生。

Source: [`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

```ts type-equiv
interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
}
```

各块接口（完整字段见源码）：`TextBlock`（`text`）、`ReasoningBlock`（thinking，区别于可见文本）、`ToolCallBlock`（`id: CallId`、`name`、原始 JSON `arguments`）、`ToolResultBlock`（`toolCallId`、嵌套 `content: ContentBlock[]`、`isError?`）。`ContentBlock = ContentBlockMap[ContentBlockType]`。核心集仅限于每条交付路径都尊重的块——多模态内容（图像、音频等）没有核心块类型；需要的功能通过可合并扩展的 map 添加，同时提供适配器/UI/压缩支持。

`Message` 是角色加块：

```ts type-equiv
interface Message {
  role: 'system' | 'user' | 'assistant'
  content: ContentBlock[]
}
```

消息来源本身也是一个可合并扩展的和类型：

```ts type-equiv
interface MessageSourceMap {
  user: { kind: 'user' }
  plugin: { kind: 'plugin'; plugin: string }
}
```

## 流式输出

适配器发出原始**分片**协议；循环记录分片（回放保真度），同时将同一批分片送入 `BlockAssembler` 以重建块和消息。`StreamChunk` 是基于 `type` 的封闭判别联合——`block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta`、`block-end`、`usage`、`finish`。

完整联合类型、适配器契约（usage-before-finish、原始 JSON 工具参数、两条认可的错误路径）和 `BlockAssembler` 在 **[llm-streaming.md](llm-streaming.md)** 中。

## 模型请求

一次模型调用是一个完全组装好的 `GenerateOptions`。适配器以原始 `StreamChunk` 流作答；消费方用 `BlockAssembler` 组装它（见 [llm-streaming.md](llm-streaming.md)）。

Source: [`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

```ts type-equiv
interface GenerateOptions {
  model: string
  /**
   * Ordered conversation messages, exactly as the provider sees them (after
   * the `system` slot). A loop-built request assembles them as
   * `EpochHeader.messagePrefix` + the derived history (dsh-agent-loop); a
   * hand-built one-shot passes any list.
   */
  messages: Message[]
  /** System prompt text (adapters map to the provider's system slot). */
  system?: string
  /** Tool schemas (adapters map to the provider's `tools` field). */
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  /**
   * Stop sequences: generation halts as soon as the model produces any one of
   * these strings (adapters map to the provider's stop field, e.g. OpenAI
   * `stop`). The stop string itself is not included in the output.
   */
  stop?: string[]
  signal?: AbortSignal
  /**
   * Session identity stamped by the loop for listener routing. Adapters ignore
   * it; replay uses it to keep concurrent parent and child cursors independent.
   */
  sessionId?: Branded<'SessionId'>
}
```

模型停止生成的原因是一个可合并扩展的结束原因：

```ts type-equiv
interface FinishReasonMap {
  'stop': { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  'aborted': { kind: 'aborted' }
  'error': { kind: 'error'; message: string; code?: string }
}
```

`FinishReason = FinishReasonMap[keyof FinishReasonMap]`。`TokenUsage`（逐调用计量，含不相交的缓存字段）详见 [llm-streaming.md](llm-streaming.md)。

`GenerateOptions.tools` 携带 `ToolSchema`——工具的 JSON Schema 描述，发送给模型。它声明在 dsh-llm（而非 dsh-tools）中，正是因为它是循环每一步组装请求的一部分：

```ts type-equiv
interface ToolSchema {
  name: string
  description: string
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>
}
```

面向模型的 `ToolSchema` 是协议格式；产出它的已注册 `ToolDefinition`（schema + `execute`）在 [tools.md](tools.md) 中。

### 请求信封：`LlmCallConfig` 与记录的 header

循环从已记录的状态构建每个请求。`EpochHeader` 记录调用配置、渲染后的 prompt、权威的返回工具顺序（由 `toolOrder` 配置，未设置时按字典序）以及会话前缀，通过 `request/header` 快照和 delta 实现。结合派生历史，这使得请求可从会话日志重建。见 [session.md](session.md#the-request-header-events-requestheader-and-requestheader-delta) 和[可重建请求 RFC](../rfc/implemented/architecture/2026-07-05-reconstructable-requests.md)。

`agent/request` 接收一个冻结的 call-config 种子，可以返回替换值。`agent/session-prefix` 在每个循环实例中组合一次仅用于请求的前缀消息，header 记录实际使用的确切结果。到达 `llm/stream` 的请求已被深度冻结，因此突变会抛出异常。

在协议格式上，循环构建的请求按此顺序读取：`system` 槽位（渲染后的 prompt 组装）→ `messagePrefix`（冻结的会话前缀）→ 派生历史——边界快照，其尾部在轮次首步是最新的 `user/message`，在后续步骤是上一步的工具结果。前缀从不进入派生历史；它的持久记录是 header 事件，开发不变式针对每个循环构建的请求精确重算此等式。

FIXME(call-config-shape): revisit the exact definition of this type — which fields are genuinely epoch-level for cache purposes (`model` certainly; the sampling scalars sit here out of caution), and where provider-specific extras (reasoning options, extra body params) belong when an adapter needs them.

```ts type-equiv
interface LlmCallConfig {
  model: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
}
```

## 会话

`Session` 是一份类型化 `SessionEvent` 的**仅追加日志**——唯一的真源。LLM（大语言模型）消息历史从日志*派生*（`deriveMessages()`），而非单独存储。事件词汇从 `SessionEventMap` 派生：

Source: [`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

```ts type-equiv
type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    /** Monotonic sequence number within the session. */
    seq: number
    /** Unix epoch milliseconds. */
    time: number
    data: SessionEventMap[K]
  } & (K extends SurfaceEventType ? {
    /**
     * Seq numbers of events that are provenance sources of this event
     * (e.g. the `assistant/chunk` seqs that built an `assistant/message`,
     * or the surface nodes shadowed by a compaction replace node).
     */
    sourceEventSeqs?: number[]
    /** How this event entered the surface; absent for non-surface events. */
    surfaceOp?: SurfaceOp
  } : object)
}[T]
```

十五个事件变体（`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`prompt/blocked`、`context/message`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`steering/message`、`todo/write`、`request/header`、`request/header-delta`）、`deriveMessages()` 投影规则、`TurnTrigger`/`TurnEndReason` 原因，以及轮次封闭不变式在 **[session.md](session.md)** 中。日志如何持久化——`SessionPersistence` seam、JSONL/SQLite 后端、`session/flush` 检查点、崩溃恢复和 `SessionHeader`——在 **[persistence.md](persistence.md)** 中。

## Agent 句柄

`Agent` 是每个插件（UI、钩子、编排器）面向编程的接口。具体实现是 dsh-agent-loop 中的 `ReactLoopAgent`；循环之外没有任何东西依赖该实现。

Source: [`packages/core/agent/src/types.ts`](../../packages/core/agent/src/types.ts)

```ts type-equiv
interface Agent {
  readonly id: AgentId
  readonly options: AgentOptions
  readonly session: Session
  readonly status: AgentStatus

  /**
   * The agent's scope context (`@deepseek-ai/dsh-scope`, key = this agent):
   * registrations through it — tools, prompt sections/variables, listeners,
   * restrictions — are visible to this agent only and unwind when it is
   * disposed; `agent.ctx.on('agent/…')` listeners fire only for this agent.
   */
  readonly ctx: Context

  /**
   * Queue a user message. Starts a turn when idle; otherwise waits for the next
   * turn. Content and the resolved source are accepted as one detached,
   * deeply-frozen lossless-JSON record before notification or enqueue, so
   * caller or `agent/queued` listener in-place mutation cannot change later
   * log/model input. Throws synchronously when either value is not losslessly
   * JSON-serializable; `agent/prompt-submit` may still return an explicit
   * replacement.
   */
  send(content: ContentBlock[], options?: SendOptions): void

  /**
   * Steer a running turn: content is injected between steps of the current
   * turn. Uses the same owned-value and synchronous-validation boundary as
   * {@link send}; when idle, behaves exactly like that method.
   */
  steer(content: ContentBlock[], options?: SendOptions): void

  /**
   * Inject in-session context (file-change notices, skill content, cron
   * notifications, …): appends a `context/message` session event the next model
   * request sees at its chronological position, rendered as tagged synthetic
   * context rather than a user prompt. Does not run the model.
   *
   * Turn-enclosure (the turn-enclosure RFC): an inject while a turn is open joins that turn;
   * an inject while idle wraps its `context/message` in a one-shot `injection`
   * turn (`turn/start` → `context/message` → `turn/end`) and checkpoints it for
   * durability, so every event stays inside a turn and a persistence backend
   * never loses a between-turn notice. The idle checkpoint is fire-and-forget
   * (inject is synchronous): a failing flush is reported via `agent/error`
   * (step `0`) and the logger, never thrown into the caller.
   *
   * Live-adapter review has validated the tagged-envelope rendering against
   * current DeepSeek behavior; provider-specific mismatches belong in that
   * adapter, not in the canonical session vocabulary.
   */
  inject(content: ContentBlock[], options?: SendOptions): void

  /**
   * Cancel ALL pending work for the agent. `cancel()`:
   *
   * - clears the queued FIFO (un-started prompts never run) and the steering
   *   FIFO (steering for the cancelled turn is dropped, not re-enqueued);
   * - aborts the in-flight step if one is running (the turn ends `aborted`);
   * - drops a turn that is about to start (a `cancel()` landing in the
   *   pre-step window — after a `send()` queued but before the loop flips to
   *   `running`, or after `running` is emitted but before the first step) so
   *   that queued prompt does not run and cannot be batched into the cancelled
   *   turn.
   *
   * After `cancel()`, `whenIdle()` resolves on the post-cancel quiescent state.
   * `cancel()` on an idle agent with nothing queued or running is a safe no-op
   * — it does NOT arm anything that would drop a later legitimate prompt.
   */
  cancel(reason?: string): void

  /**
   * Resolve once the agent has reached quiescence after settling out of
   * `running`, or immediately if it is already idle with no queued work. A
   * non-owner's quiescence-observation hook: a consumer that does NOT own the
   * agent's lifecycle awaits this to proceed only after queued/running work has
   * fully stopped, rather than returning while the driver is still streaming or
   * about to start a queued turn — without itself tearing the agent down. (A
   * lifecycle OWNER does not need it: `AgentHandle.dispose()` already awaits the
   * loop-exit promise directly as part of stopping and unregistering. So this is
   * for a non-owning observer — e.g. a test awaiting a turn to settle, or a
   * monitor — that wants the settle signal but must not dispose the agent.)
   *
   * "Quiescence", not merely "status changed": a disposed agent emits
   * `agent/status('disposed')` from inside its disposer, BEFORE the driver loop
   * has unwound — so `whenIdle()` resolving on `disposed` must wait for the loop
   * to actually exit (the implementation chains the loop-exit promise), not just
   * observe the status flip. A mid-step disposal that never reaches `idle` still
   * unblocks the await this way.
   */
  whenIdle(): Promise<void>

  // Subagent delegation is realized on top of this interface by the
  // `@deepseek-ai/dsh-subagent` seam, not by a method here: a backend creates
  // the child through `ctx.agents.create` (fork seeds the child Session with a
  // balanced prefix of the parent's log via `CreateAgentOptions.seed`; spawn
  // starts fresh) and drives it as an ordinary Agent handle, so steer() and
  // event subscription work uniformly. See docs/core-data-structures/subagent.md.
}
```

`AgentStatus` 为 `'idle' | 'running' | 'disposed'`，`AgentId` 是品牌化的。`AgentOptions` 可合并扩展，当前包含 `model?`。Persona 属于 `dsh-system-prompt`：agent 作用域的 `deployment:persona` 可以遮蔽全局默认值。

[事件分类体系](../architecture.md#event)拥有 `agent/*` 生命周期、检查点和 waterfall（瀑布式事件）契约。轮次和步骤边界是持久的会话事件，而非 agent 发射。

## 拦截决策

每个 `agent/*` 拦截 waterfall 返回一个小型的、seam 特定的类型化联合——统一的 Decision 惯用法（工具 seam 的 `PreToolDecision`/`PostToolDecision` 在 [tools.md](tools.md) 中遵循相同形状）。CC/Codex 钩子桥将其 `permissionDecision`/`decision`/`continue`/`additionalContext` 字段映射到这些类型上；原生插件直接返回它们。它们共享一个面向模型的上下文信封 `HookContext`，通过 `inject()` 作为 `context/message` 注入，因此携带一个必需的 `source`（缺少 source 会默认为 `{kind:'user'}`，将插件上下文错误标记为用户提示词）。

Source: [`packages/core/agent/src/types.ts`](../../packages/core/agent/src/types.ts)

```ts type-equiv
interface HookContext {
  content: ContentBlock[]
  source: MessageSource
}
```

`agent/prompt-submit` 返回 `PromptDecision`（允许一条已出队的排队消息——可选地重写其 `content` 或附加 `additionalContext`——或阻止它；一个批次中所有 prompt 都被阻止时，会打开一个零步骤轮次并以 `rejected` 结束）：

```ts type-equiv
type PromptDecision =
  | { kind: 'allow'; content?: ContentBlock[]; additionalContext?: HookContext }
  | { kind: 'block'; reason: string }
```

`agent/turn-continuation` 返回 `ContinuationDecision`（循环的默认行为是：当步骤有工具调用或 steering（中途引导）被注入时 `continue`，否则 `stop`；`continue` 的 `reason` 被记录为同一轮次中下一步的 steering——类型化的 `/goal` 模式）：

```ts type-equiv
type ContinuationDecision =
  | { action: 'stop' }
  | { action: 'continue'; reason?: HookContext }
```

`agent/turn-stop` 返回仅停止的 `ContinuationStop` 子集或 `undefined`。循环在折叠普通决策、其 reason 和待处理 steering 之后调用此串行检查点；stop 是终态，会丢弃待处理的 steering。

```ts type-equiv
type ContinuationStop = Extract<ContinuationDecision, { action: 'stop' }>
```

`agent/session-start` 携带 `SessionStartSource`（会话生命周期为何开始；桥接层据此匹配其 SessionStart）：

```ts type-equiv
type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'
```

`agent/session-prefix` 在每个循环实例中组合一次 `Message[]`。深度冻结的结果被记录在请求 header 中，并前置于每次派生历史，使其成为会话稳定开场白的归属。恢复的实例会重新组合；会话中途的变更使用仅追加的上下文通道。该 waterfall 直接返回内容，因为它是贡献而非决策。

## `ToolDefinition`

唯一属于核心的流水线编写类型：每个已注册工具*是什么*——一个面向模型的 `ToolSchema` 加上一个 `execute` 函数和可选的 UI 展示器。工具作者很少手动构造它（`defineTool` DSL 会用类型化参数构建），但它是注册表持有、循环分发所经过的契约。

其完整字段、`defineTool`/`SchemaSpec`/`InferArgs` 类型化 schema DSL、`ToolExecution`/`ToolExecutionResult` waterfall 形状，以及工具展示 UI 词汇在 **[tools.md](tools.md)** 中。
