# 核心数据结构

[English](core.md) | 中文

本目录编目 DeepSeek Harness 的**数据结构**：每个核心类型代表什么、它的字面形状，以及完整细节在哪里。它与 [architecture.md](../architecture.md) 互补——后者描述*行为*（服务映射、会话/轮次/步骤生命周期、事件分类体系）；本页描述行为所操作的*词汇*。

## 什么算"核心"

harness 是一个微内核：一个极小的核心加上众多插件。大多数类型属于某一个插件或某一项能力。但有少数类型构成**主干**——agent loop（智能体循环）及其事件在*每一个*轮次中使用的语言，无论加载了哪些可选插件。这些就是"核心"。

精确地说，一个数据结构是**核心**的，当且仅当满足以下条件之一：

1. 它流经 agent loop 主干——循环在每个轮次中持有、派生、流式输出或记录它（`Message`、`StreamChunk`、`SessionEvent`、`Agent` 句柄本身），与当前加载了哪些插件无关；**或者**
2. 它是插件作者面向某条流水线编写的代表性类型——`ToolDefinition`（每个工具*是什么*）。

其他一切都记录在**子页面**上，而非本页。划线的规则是：*你编写、持有或接收的类型是核心；为它提供类型推导、渲染或持久化的机制是子页面细节*。因此 `ToolDefinition` 是核心，但为它提供类型推导的 `ValueSchemaSpec`/`ParameterSchemaSpec` 机制、为它提供渲染意图的 `ToolCallView`/`ToolResultView` 词汇，以及存储事件日志的 `SessionPersistence` seam 都不是——它们分别在下列子页面中。

| 子页面 | 负责内容 |
|---|---|
| [llm-streaming.md](llm-streaming.md) | `StreamChunk` 协议格式（wire format）+ 适配器契约（adapter contract）、`BlockAssembler`、`LlmAdapter` seam |
| [token-meter.md](token-meter.md) | 不可变的标量与位置回放度量，附带已消费日志修订号 |
| [scope.md](scope.md) | 作用域注册标识、dispatch 载体，以及拥有的 `Scope` 上下文 |
| [goal.md](goal.md) | 持久 goal 标识、生命周期快照、激活、变更记录与 Round 归属 |
| [commands.md](commands.md) | 人类命令 seam：定义、适配器发现、直接调用、结果与解析视图 |
| [session.md](session.md) | 完整的 `SessionEventMap` 变体目录、`TurnTrigger`/`TurnEndReason`、`deriveMessages()`、执行封闭与独立事件 |
| [persistence.md](persistence.md) | 持久性 seam：`SessionPersistence`、JSONL + SQLite 后端、`session/flush`、崩溃恢复、`SessionHeader` |
| [session-query.md](session-query.md) | 逻辑记录、有界精确事件读取、关系追踪、语义筛选器/文档与全文检索结果页 |
| [session-title.md](session-title.md) | 持久标题快照、来源 provenance 与异步提供方契约 |
| [system-prompt.md](system-prompt.md) | 逐次组装的上下文、工具提供方结果、提示词段落与协作式组装 |
| [tools.md](tools.md) | `ToolDefinition` 完整字段、schema DSL、`ToolExecution`/`ToolResult`、工具展示 UI 类型，以及受保护的执行流水线 |
| [user-interaction.md](user-interaction.md) | UI 支持的人工问答 seam：`AskUserQuestionRequest`、answer/options 词汇、提供方 API、错误分类体系 |
| [approval.md](approval.md) | 一次性用户审批 seam：`ApprovalRequest`、`ApprovalOutcome`、逐会话策略、审计与 answerer 契约 |
| [bash.md](bash.md) | bash 执行器 seam：`BashExecRequest`/`Spec`、`BashRunResult`、后台 `BashProcess` 句柄 |
| [subprocess.md](subprocess.md) | 子进程 seam：完全显式的 `SubprocessSpawnSpec`、基于偏移的输出读取器、不含分类的 `SubprocessOutcome`，以及受管 `DSH_*` 环境词汇 |
| [pty.md](pty.md) | 持久化终端 ID、后端/会话契约、发送就绪状态、有界读取与 owner 可见快照 |
| [sandbox.md](sandbox.md) | 每会话策略解析与进程约束 seam：文件效果模式、执行/提供方策略、`ConfinedArgv`、强制执行与故障关闭错误 |
| [code-runtime.md](code-runtime.md) | 代码执行 seam：`CodeRunRequest`/`Result`、绑定命名空间、捕获日志、`CodeRunFailure` 分类体系 |
| [filesystem.md](filesystem.md) | 文件系统 seam：`FsTarget`、读/写/编辑结果、观测到的文件状态、`FsErrorCode` |
| [lsp.md](lsp.md) | LSP 导航 seam：`LspQueryRequest`/`Result`、`LspProvider`/`Service`、四种操作、`LspError` |
| [skills.md](skills.md) | skill（技能）服务：发现优先级、`SkillSummary`/`SkillDefinition`、会话前缀目录、面向模型的 `skill` 加载 |
| [compaction.md](compaction.md) | 压缩（compaction）seam：`compact/*` 会话事件、`CompactionResult`、`CompactService` 接口 |
| [subagent.md](subagent.md) | subagent seam：命名提供方注册表、`SubagentStartRequest`/`Result`/`Run`、启动时与运行时能力拆分 |
| [web.md](web.md) | Web 访问 seam：`WebSearchRequest`/`Result`、`WebFetchRequest`/`Result`、`WebFetchBody`、提供方可用性、`WebError` |
| [spill.md](spill.md) | spill 存储 seam：`SaveTextSpill`、`SpillOwner`/`SpillSource`、`SpillRef`、品牌类型 `SpillLocator` |
| [workflow.md](workflow.md) | 工作流 seam：`WorkflowStartRequest`、`WorkflowMeta`、`WorkflowRun`/`Result`、`workflow/*` 事件载荷、`WorkflowError` 致命性 |

> 这些页面上的类型声明及其 JSDoc 与源码等价，并由 `pnpm run verify-type-equiv` 检查漂移（见 [development.md](../development.md#documenting-types-verbatim-ts-type-equiv)）。普通块保留完整声明；`public-api` 块保留去除实现体的公开 class 声明。Cordis 服务使用生成的[服务目录](../cordis-catalog/services.md)。

<a id="the-map--derived-union-pattern"></a>

## `…Map → derived-union` 模式

harness 中几乎所有可扩展的和类型都遵循同一形状：一个以判别标签为键的接口（`…Map`），联合类型由 `keyof` 派生。插件通过**声明合并**添加变体——无需修改拥有该类型的包（package）。

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

| Map | 包 | 派生 | 目录 |
|---|---|---|---|
| `ContentBlockMap` | dsh-llm | `ContentBlock` | [下文](#content-blocks-and-messages) |
| `MessageSourceMap` | dsh-llm | `MessageSource` | [下文](#content-blocks-and-messages) |
| `FinishReasonMap` | dsh-llm | `FinishReason` | [下文](#the-model-request-and-result) |
| `TurnTriggerMap` | dsh-session | `TurnTrigger` | [session.md](session.md) |
| `TurnEndReasonMap` | dsh-session | `TurnEndReason` | [session.md](session.md) |
| `SessionEventMap` | dsh-session | `SessionEvent` | [session.md](session.md) |

消费方最常 `switch` 的两个大型判别联合类型是：**`StreamChunk`**（流式协议）和 **`SessionEvent`**（日志条目）。按仓库约定，对标签做 `switch`——不要链式 `if`——这样每个分支都能窄化类型，拼错的标签会编译失败。

<a id="branded-ids"></a>

## 品牌化 ID

跨越包边界的 ID 都经过**品牌化**——结构上是字符串，但在类型层面不可互换（不能把 `SessionId` 传给需要 `CallId` 的位置）。每种类型通过各自的工厂构造；比较、日志记录和 JSON 行为与普通字符串相同。

`Branded<B>` 原语位于独立的纯类型包 [dsh-brand](../../packages/util/brand) 中（没有运行时代码，也不依赖 Harness 包），因此任何包都能品牌化其拥有的 id，而无需依赖无关的能力包。

源码：[`packages/util/brand/src/index.ts`](../../packages/util/brand/src/index.ts)

```ts type-equiv
/** A string carrying a compile-time-only brand `B`. */
type Branded<B extends string> = string & { readonly [BRAND]: B }
```

两个核心 ID 是 `CallId`（关联工具调用及其结果；dsh-llm）和 `SessionId`（活跃 agent 与持久会话共享的标识；dsh-session）。能力包也会品牌化各自的 id，例如 [tasks.md](tasks.md) 中的 `TaskId`。

<a id="content-blocks-and-messages"></a>

## 内容块与消息

一段对话由 `Message` 组成；一条消息是一个类型化**内容块**的数组。块的联合类型从 `ContentBlockMap` 派生。

源码：[`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

```ts type-equiv
/**
 * Merge-extensible content blocks keyed by `type`. New core blocks must land
 * with adapter, UI, and compaction support.
 */
interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
}
```

各块接口（完整字段见源码）：`TextBlock`（`text`）、`ReasoningBlock`（thinking，区别于可见文本）、`ToolCallBlock`（`id: CallId`、`name`、原始 JSON `arguments`）、`ToolResultBlock`（`toolCallId`、嵌套 `content: ContentBlock[]`、`isError?`）。`ContentBlock = ContentBlockMap[ContentBlockType]`。核心集仅限于每条交付路径都尊重的块——多模态内容（图像、音频等）没有核心块类型；需要的功能通过可合并扩展的 map 添加，同时提供适配器/UI/压缩支持。

源码：[`packages/llm/llm/src/message.ts`](../../packages/llm/llm/src/message.ts)

`Message` 是一个带标识且不可变的角色／来源／内容值。模型产生的 assistant 消息会在其来源中携带提供方／模型所有权与可选的适配器私有回放元数据：

```ts type-equiv
/** Provider ownership and adapter-private replay data for an assistant message. */
interface AssistantProvenance {
  /** Provider route that produced the message. */
  provider: string
  /** Provider model id that produced the message. */
  model: string
  /**
   * Lossless-JSON adapter state needed to replay the provider response.
   * `LlmService` exposes it to a target adapter only when that adapter instance
   * currently owns both this historical provider and the target provider.
   */
  replayState?: unknown
}
```

```ts type-equiv
/** One immutable message representation shared by delivery, durable history, and model requests. */
interface Message {
  /** Stable identity preserved across every representation boundary. */
  readonly id: MessageId
  /** Provider-neutral conversation role. */
  readonly role: 'system' | 'user' | 'assistant'
  /** Exact model-facing blocks. */
  readonly content: ContentBlock[]
  /** Required producer provenance. */
  readonly source: MessageSource
}
```

消息来源本身也是一个可合并扩展的和类型：

```ts type-equiv
/**
 * Where a message (or injected content) came from.
 * Merge-extensible sum type — plugins add their own `kind`s.
 */
interface MessageSourceMap {
  user: { kind: 'user' }
  plugin: { kind: 'plugin'; plugin: string }
  model: ModelMessageSource
  tool: ToolMessageSource
}
```

## 流式输出

适配器发出原始**分片**协议；循环记录分片（回放保真度），同时将同一批分片送入 `BlockAssembler` 以重建块和消息。`StreamChunk` 是基于 `type` 的封闭判别联合——`block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta`、`block-end`、`usage`、`finish`。

完整联合类型、适配器契约（usage-before-finish、原始 JSON 工具参数、两条认可的错误路径）和 `BlockAssembler` 在 **[llm-streaming.md](llm-streaming.md)** 中。

<a id="the-model-request-and-result"></a>

## 模型请求

一次模型调用是一个完全组装好的 `GenerateOptions`。适配器以原始 `StreamChunk` 流作答；消费方用 `BlockAssembler` 组装它（见 [llm-streaming.md](llm-streaming.md)）。

源码：[`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

提供方与模型发现使用小型、提供方无关的描述符。模型目录仅供参考：路由仍以已注册提供方为键，适配器也可以接受未列出的模型 id。

```ts type-equiv
/** Display metadata for one registered provider route. */
interface LlmProviderInfo {
  /** Provider route key used by {@link GenerateOptions.provider}. */
  id: string
  /** Human-readable provider name for selectors and diagnostics. */
  name: string
}
```

```ts type-equiv
/** One adapter-discovered model; catalog membership is advisory, not request validation. */
interface LlmModelInfo {
  /** Provider route that owns this model entry. */
  provider: string
  /** Model id passed to {@link GenerateOptions.model}. */
  id: string
  /** Human-readable model name for selectors. */
  name: string
  /** Optional user-facing distinction from otherwise similar models. */
  description?: string
}
```

对正确性敏感的元数据与参考目录分开解析，并归服务该确切路由的适配器所有。上下文容量和推理选项共用同一个确切模型结果，消费方因而无需重复执行权威模型解析。

```ts type-equiv
/** Provider-owned context capacity for one exact provider/model route. */
interface LlmModelContext {
  /** Maximum combined request and response context in tokens. */
  contextWindow: number
}
```

推理强度是另一项针对确切路由的能力。核心为标识符添加品牌类型，但不枚举其值；有序集合、展示名称和可选的部署默认值均由各适配器持有。

```ts type-equiv
/** Adapter-owned identifier for one model's selectable reasoning effort. */
type ReasoningEffortId = Branded<'ReasoningEffortId'>
```

```ts type-equiv
/** Display metadata for one adapter-owned reasoning effort. */
interface LlmReasoningEffortInfo {
  /** Opaque stable value accepted by {@link GenerateOptions.reasoningEffort}. */
  id: ReasoningEffortId
  /** Human-readable effort name for selectors and diagnostics. */
  name: string
  /** Optional user-facing distinction from otherwise similar efforts. */
  description?: string
}
```

```ts type-equiv
/** Selectable reasoning efforts for one exact provider/model route. */
interface LlmModelReasoningInfo {
  /** Supported efforts in adapter-preferred display order. */
  efforts: readonly LlmReasoningEffortInfo[]
  /**
   * Adapter-configured default materialized into requests when callers omit
   * an effort. Absence preserves the provider's own default.
   */
  defaultEffort?: ReasoningEffortId
}
```

```ts type-equiv
/** Exact-route model metadata resolved by its owning adapter. */
interface LlmResolvedModelInfo extends LlmModelInfo {
  /** Provider-owned context capacity when known. */
  context?: LlmModelContext
  /** Adapter-owned selectable reasoning levels when exposed. */
  reasoning?: LlmModelReasoningInfo
}
```

```ts type-equiv
/** A single model request, fully assembled. */
interface GenerateOptions {
  /** Registered provider route selecting the adapter instance. */
  provider: string
  model: string
  /** Adapter-owned reasoning effort selected for this exact model. */
  reasoningEffort?: ReasoningEffortId
  /**
   * Ordered conversation messages, exactly as the provider sees them (after
   * the `system` slot). A loop-built request assembles them as
   * the derived history (dsh-agent-loop); a hand-built one-shot passes any list.
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
  /**
   * Provider-neutral classification for an auxiliary model call. Adapters may
   * map the purpose to model-hidden transport metadata or purpose-specific
   * generation policy. Ordinary conversation requests leave it unset.
   */
  purpose?: 'compaction' | 'session-title'
}
```

模型响应为何停止由可合并扩展的原因表示。提供方终态失败携带流式契约的 [`LlmFailure`](llm-streaming.md#llmfailure)：

```ts type-equiv
/**
 * Why a model response stopped.
 * Merge-extensible so adapters can surface provider-specific reasons.
 */
interface FinishReasonMap {
  'stop': { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  'aborted': { kind: 'aborted'; failure: LlmFailure }
  'error': { kind: 'error'; failure: LlmFailure }
}
```

`FinishReason = FinishReasonMap[keyof FinishReasonMap]`。`TokenUsage`（逐调用计量，含不相交的缓存字段）详见 [llm-streaming.md](llm-streaming.md)。

`GenerateOptions.tools` 携带 `ToolSchema`——工具的 JSON Schema 描述，发送给模型。它声明在 dsh-llm（而非 dsh-tools）中，正是因为它是循环每一步组装请求的一部分：

```ts type-equiv
/**
 * JSON-schema description of a tool, as sent to the model.
 *
 * Declared here (not in dsh-tools) because it is part of {@link GenerateOptions};
 * dsh-tools' ToolDefinition and dsh-system-prompt's PromptAssembly both import
 * it from this package.
 */
interface ToolSchema {
  name: string
  description: string
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>
}
```

面向模型的 `ToolSchema` 是协议格式；产出它的已注册 `ToolDefinition`（schema + `execute`）在 [tools.md](tools.md) 中。

### 请求信封：`LlmCallConfig` 与记录的 header

循环从已记录状态构建每个请求。`EpochHeader` 通过完整的 `request/header` 快照记录调用配置、渲染后的提示词以及权威返回工具顺序（由 `toolOrder` 配置；未配置时按字典序）。结合派生历史，请求便可由会话日志重建。见 [session.md](session.md#the-request-header-event-requestheader) 与[可重建性 Agent Note（agent 决策记录）](../../.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md)。

`agent/request` 接收冻结的调用配置种子，并可返回替代值以切换提供方、模型、推理强度或采样参数。waterfall 结束后，循环会在轮次信号控制下完成确切模型的能力准备，拒绝显式指定但不受支持的推理强度 ID（不自动调整），填入适配器配置的默认值，并记录最终生效值。准备完成的调用直至分派完成始终持有同一项适配器注册。到达 `llm/stream` 的请求会被深度冻结，因此变更会抛异常；请求还携带进程本地循环标识，使观察者不会把单独记录的冻结辅助调用误认成对话请求。

在协议格式上，循环构建的请求先读取 `system` 槽位（渲染后的提示词组装），再读取派生历史——边界快照，其尾部在轮次首步是最新的 `user/message`，在后续步骤是上一步的工具结果。开发不变式针对每个循环构建的请求精确重算此等式。

FIXME(call-config-shape)：重新审视其余哪些字段出于缓存目的确实属于 epoch 层级（`model` 和模型持有的推理强度已明确属于；采样标量目前出于谨慎保留在此）。

```ts type-equiv
/**
 * Provider, model, reasoning effort, and sampling scalars of one conversation's
 * requests. Every field maps 1:1 onto the same-named `GenerateOptions` field;
 * the loop builds requests from the logged header rather than accepting these
 * per call.
 */
interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  temperature?: number
  maxTokens?: number
  stop?: string[]
}
```

## 会话

`Session` 是一份类型化 `SessionEvent` 的**仅追加日志**——唯一的真源。LLM（大语言模型）消息历史从日志*派生*（`deriveMessages()`），而非单独存储。事件词汇从 `SessionEventMap` 派生：

源码：[`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

```ts type-equiv
/**
 * One immutable entry in the session log.
 *
 * A proper discriminated union over `type` (not independent `type`/`data`
 * unions), so `switch (event.type)` narrows `event.data` without casts.
 *
 * The {@link sourceEventSeqs} and {@link surfaceOp} fields are conditional:
 * they only exist on {@link SurfaceEventType} variants (`user/message`,
 * `assistant/message`, `tool/result`, `steering/message`).
 * Non-surface events (boundary markers, chunks, usage, errors) never carry
 * surface metadata — the compiler enforces this at `Session.append()`
 * call sites.
 */
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
     * or the surface nodes shadowed by a compaction replace node). An
     * `assistant/message` may carry a present empty array for a known empty
     * provider stream; omission means unrecorded provenance.
     */
    sourceEventSeqs?: number[]
    /** How this event entered the surface; absent for non-surface events. */
    surfaceOp?: SurfaceOp
  } : object)
}[T]
```

十二种事件变体（`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`steering/message`、`todo/write`、`request/header`）、`deriveMessages()` 投影规则、`TurnTrigger`/`TurnEndReason` 原因以及执行封闭和独立事件规则都在 **[session.md](session.md)** 中。日志如何持久化——`SessionPersistence` seam、JSONL/SQLite 后端、`session/flush` 检查点、崩溃恢复与 `SessionHeader`——则在 **[persistence.md](persistence.md)** 中。

<a id="the-agent-handle"></a>

## Agent 句柄

`Agent` 是每个插件（UI、钩子、orchestrator）面向编程的 surface。具体实现为 dsh-agent-loop 包内部细节；循环外没有任何组件依赖它。

源码：[`packages/core/agent/src/types.ts`](../../packages/core/agent/src/types.ts)

```ts type-equiv
/**
 * Which inbox queue a {@link Agent.send} item joins:
 * - `next-turn` — the item becomes its own turn, claimed at a turn boundary.
 * - `next-step` — during prompt admission or an open turn, the item stages for
 *   the next safe step boundary; otherwise it is promoted per its `wakeup`
 *   flag.
 */
type SendTarget = 'next-turn' | 'next-step'
```

```ts type-equiv
/** Resolved inbox placement reported when an accepted message is enqueued. */
type InboxPlacement = 'queued' | 'steering'
```

```ts type-equiv
/**
 * Options for the unified {@link Agent.send} primitive over the
 * (`target` × `wakeup`) matrix. Named presets: {@link Agent.followup}
 * (`next-turn`/wakeup), {@link Agent.steer} (`next-step`/wakeup), and
 * {@link Agent.inject} (`next-step`/no-wakeup).
 *
 * The object is complete so routing policy is explicit.
 */
interface SendOptions {
  /** Queue the item joins. */
  target: SendTarget
  /**
   * Whether this item makes the model run: wake a parked driver (`next-turn`)
   * or force a continuation step (`next-step` while running). A `false`
   * `next-turn` item queues without waking; a `false`
   * `next-step` item attaches durable context without forcing another step
   * (the injection preset).
   */
  wakeup: boolean
}
```

固定预设的别名方法自带 `target` 与 `wakeup`；其已有标识的 `UserMessage` 会携带角色、内容与 provenance。投递方法不会返回其 `MessageId`，但该 id 在这条消息的各个 `agent/inbox/*` 事件中保持稳定。注入绕过两个 FIFO，从不出现在这些事件中。

```ts type-equiv
/** Options for {@link Agent.cancel}. */
interface CancelOptions {
  /**
   * Preserve queued and steering inbox items instead of discarding them. The
   * active turn is still aborted, but un-started and pending work survives for a
   * later turn and no `agent/inbox/discard` fires.
   */
  keepInbox?: boolean
}
```

```ts type-equiv
/** Stable runtime cause accepted by {@link Agent.cancel}. */
type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
```

`Agent` 是覆盖公开活跃 agent 契约的接口。具体驱动器拥有 `followup`/`steer`/`inject` 别名方法，并将它们经由 `send` 的（`target` × `wakeup`）矩阵路由。

```ts type-equiv
/** Public live-agent handle with aliases over the unified delivery primitive. */
interface Agent {
  /** The single identity shared with {@link session}. */
  readonly id: SessionId
  /** The provider route and model this agent's requests use. */
  readonly options: AgentOptions
  /** The live session this agent drives; its log is the durable source of truth. */
  readonly session: Session
  /** The current lifecycle state, mirrored on every `agent/status` transition. */
  readonly status: AgentStatus
  /**
   * Whether a `next-step` send currently stages for prompt admission or the
   * open turn. Unlike {@link status}, this excludes admission exit and turn
   * settlement, when a waking `next-step` send becomes a queued follow-up.
   */
  readonly acceptsNextStep: boolean
  /** Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. */
  readonly ctx: Context

  /**
   * The unified delivery primitive over the (`target` × `wakeup`) matrix.
   * It routes the caller's typed content and source as follows:
   *
   * - `next-turn` queues an item that becomes the sole ordinary message of its
   *   own FIFO-ordered turn; `wakeup:true` wakes a
   *   parked driver, while `wakeup:false` queues without waking.
   * - `next-step` with `wakeup:true` stages steering during prompt admission
   *   or an open turn; outside that window it falls back to a woken
   *   `next-turn`.
   * - `next-step` with `wakeup:false` injects durable model-facing context
   *   without running the model: admission or an open turn stages it for the
   *   next safe log position, while an injection outside that window appends
   *   immediately without opening a turn. If admission closes without a turn,
   *   a context-only boundary appends immediately; context staged beside
   *   steering remains pending with it.
   * The agent publishes or queues the identified frozen message as-is.
   * @param message - identified model-facing content and its producer provenance.
   * @param options - target queue and wakeup decision.
   */
  send(message: UserMessage, options: SendOptions): void

  /**
   * Clear queued and steering work — unless `keepInbox` — and abort the active
   * turn. An effective call first emits `agent/cancel-requested` with the
   * resolved typed cause. The first cause wins for the active turn, and
   * `whenIdle()` resolves after cancellation reaches quiescence. Idle
   * cancellation is a no-op and does not arm later work.
   * @param cause - the stable caller intent carried by the current turn signal.
   * @param options - cancellation options; `keepInbox` preserves pending work.
   */
  cancel(cause: AgentCancelCause, options?: CancelOptions): void

  /** Resolve at idle quiescence; disposal waits for driver exit rather than only the status transition. */
  whenIdle(): Promise<void>

  /**
   * Queue an ordinary follow-up turn and wake the driver — the
   * `next-turn`/wakeup preset of {@link send}. The item becomes the sole
   * ordinary message of its own turn.
   * @param message - identified prompt content and its producer provenance.
   */
  followup(message: UserMessage): void

  /**
   * Submit steering during prompt admission or an open turn — the
   * `next-step`/wakeup preset of {@link send}. It stages for the next steering
   * checkpoint before a request or stop decision. If the activity fails before
   * that boundary, the remainder stays staged without waking the agent; retry
   * or a later prompt takes it. Outside that window steering falls back to a
   * woken follow-up turn, while cancellation or disposal may discard pending
   * steering.
   * @param message - identified steering content and its producer provenance.
   */
  steer(message: UserMessage): void

  /**
   * Append model-facing context without running the model — the
   * `next-step`/no-wakeup preset of {@link send}. Admission or an open turn
   * stages it at the next safe log position; outside that window it appends
   * immediately without opening a turn. If admission closes without a turn,
   * a context-only boundary appends immediately; context staged beside
   * steering remains pending with it.
   * @param message - identified injected context and its producer provenance.
   */
  inject(message: UserMessage): void
}
```

`AgentStatus` 为 `'idle' | 'running'`，`SessionId` 是品牌类型。dispose（资源释放）会把 agent 从注册表移除并发出 `agent/disposed`；它不是一个终态 status 值。`running` 描述整个驱动器的排空区间，可能跨越连续的排队轮次；它不能证明某个轮次仍然打开。对于需要在把输入作为 steering 加入当前提示词准入／轮次，还是提交为一个新的待准入提示词之间做选择的调用方，`acceptsNextStep` 才是更窄且准确的路由判断条件。`AgentOptions` 可合并扩展：core 声明 `provider?`、`model?` 与 `maxTokens?`（在 `agent/request` 后，分发要求 provider 与 model 都存在）。提供 `maxTokens` 时，它必须是正安全整数，并限制每次对话模型请求的输出；省略时由提供方默认值控制。Persona 归 `dsh-system-prompt` 所有：agent 作用域的 `deployment:persona` 可以遮蔽全局默认值。

cause 是由 TypeScript 强制约束的同进程输入。活跃的 `TurnCancellation` 持有者会把其判别字段复制到仅运行时的 `AbortSignal.reason`，并在发布 `turn/end` 前退役；冻结后的 `AbortSignal.reason` 仍可读取。只有 loop 会在结算时从自己机器私有的 signal 上读回 cause（`user`、`parent` 或仅用于生命周期的 `disposed`）——不存在公开的读取器，signal 也不授予协作监听器任何分类权限。持久 `turn/end` 保留粗粒度 `{ kind: 'aborted' }` 结果；若需记录请求 provenance，应使用单独的持久事件，而不是让终态结果承担额外含义。

[事件分类](../architecture.md#event)拥有 `agent/*` 生命周期、检查点与 waterfall（瀑布式事件）契约。轮次和步骤边界是持久会话事件，而不是 agent emit。

## 发起 Agent

`ctx.agents` 携带的进程本地 initiator 就是上面的确切 `Agent`，不是单独的 frame 或复制的标识。环境中存在该值既不能证明存活，也不代表授权；其生命周期与边界规则由 [initiator 作用域决策](../../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.md)规定。

## 拦截决策

提示词决策与工具后决策使用与持久 user-role 输入相同、带标识的 `UserMessage` 形状。每个 `additionalContexts` 条目都会成为一条独立的 `user/message`，保留各自的标识与 provenance。钩子桥接层把其原生决策字段映射到这些类型化结果上。

源码：[`packages/core/agent/src/types.ts`](../../packages/core/agent/src/types.ts)

`agent/prompt-submit` 在轮次打开前返回 `PromptDecision`。allow 可以改写已领取的提示词或附加 `additionalContexts`；block 拒绝准入且不产生任何轮次事件：

```ts type-equiv
/**
 * Prompt interception result. `allow.content` replaces the prompt, while
 * `additionalContexts` appends model-facing context before the turn starts.
 * An `allow` returned by a listener is authoritative: a listener wrapping
 * `next()` preserves both fields unless it intentionally replaces them.
 */
type PromptDecision =
  | { kind: 'allow'; content?: ContentBlock[]; additionalContexts?: UserMessage[] }
  | { kind: 'block'; reason: string }
```

`agent/request-error` 在失败的模型步骤关闭之后、其轮次关闭之前运行。listener 可以在失败轮次的 signal 仍然存活时修复持久状态或 await 策略工作。处理该错误的 listener 返回 `{ kind: 'retry' }` 且不调用 `next()`；默认的 `undefined` 会让失败保持终态。

```ts type-equiv
/** Action returned by a listener that owns model-request recovery. */
type RequestErrorAction = { kind: 'retry' } | undefined
```

```ts type-equiv
/** Model-request failure with an optional machine-routable provider code. */
type RequestError = Error & { code?: string }
```

`agent/step` 是请求推导前唯一的串行边界。`agent/turn-stopping` 在轮次没有工具或 steering（中途引导）后续时运行，先于最后一次 steering 排空。

`agent/session-start` 携带 `SessionStartSource`（会话生命周期为何开始；桥接层据此匹配其 SessionStart）：

```ts type-equiv
/** Why a session lifecycle began; seeded creates are `startup`, while persisted loads are `resume`. */
type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'
```

## `ToolDefinition`

唯一属于核心的流水线编写类型：每个已注册工具*是什么*——一个面向模型的 `ToolSchema` 加上一个 `execute` 函数，以及可选的最终内容回调与 UI 回调。工具作者很少手动构造它（`defineTool` DSL 会用类型化参数构建），但它是注册表持有、循环分发所经过的契约。

其完整字段、`defineTool`/`ValueSchemaSpec`/`ParameterSchemaSpec` 类型化 schema DSL、`ToolExecution`/`ToolExecutionResult` waterfall 形状，以及工具展示 UI 词汇在 **[tools.md](tools.md)** 中。
