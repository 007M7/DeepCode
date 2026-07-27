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
| [session.md](session.md) | 完整的 `SessionEventMap` 变体目录、`TurnTrigger`/`TurnEndReason`、`deriveMessages()`、轮次封闭不变式 |
| [persistence.md](persistence.md) | 持久性 seam：`SessionPersistence`、JSONL + SQLite 后端、`session/flush`、崩溃恢复、`SessionHeader` |
| [session-query.md](session-query.md) | 逻辑记录、有界精确事件读取、关系追踪、语义筛选器/文档与全文检索结果页 |
| [session-title.md](session-title.md) | 持久标题快照、来源 provenance 与异步提供方契约 |
| [system-prompt.md](system-prompt.md) | 逐次组装的上下文、工具提供方结果、提示词段落与协作式组装 |
| [tools.md](tools.md) | `ToolDefinition` 完整字段、schema DSL、`ToolExecution`/`ToolResult`、工具展示 UI 类型，以及受保护的执行流水线 |
| [user-interaction.md](user-interaction.md) | UI 支持的人工问答 seam：`AskUserQuestionRequest`、answer/options 词汇、提供方 API、错误分类体系 |
| [approval.md](approval.md) | 一次性用户审批 seam：`ApprovalRequest`、`ApprovalOutcome`、逐会话策略、审计与 answerer 契约 |
| [bash.md](bash.md) | bash 执行器 seam：`BashExecRequest`/`Spec`、`BashRunResult`、后台 `BashProcess` 句柄 |
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

`Message` 由角色和块组成。由循环派生的 assistant 消息携带其持久提供方/模型标识，以及可选的适配器私有回放元数据：

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
/**
 * A single message in a conversation history. Loop-derived assistant messages
 * always carry provenance; callers may omit it on hand-built foreign history.
 */
interface Message {
  role: 'system' | 'user' | 'assistant'
  content: ContentBlock[]
  /** Present only on assistant messages produced by a routed adapter. */
  provenance?: AssistantProvenance
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

循环从已记录状态构建每个请求。`EpochHeader` 通过完整的 `request/header` 快照记录调用配置、渲染后的提示词、权威返回工具顺序（由 `toolOrder` 配置；未配置时按字典序）以及会话前缀。结合派生历史，请求便可由会话日志重建。见 [session.md](session.md#the-request-header-event-requestheader) 与[可重建性 Agent Note（agent 决策记录）](../../.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md)。

`agent/request` 接收冻结的调用配置种子，并可返回替代值以切换提供方、模型、推理强度或采样参数。waterfall 结束后，循环会在轮次信号控制下完成确切模型的能力准备，拒绝显式指定但不受支持的推理强度 ID（不自动调整），填入适配器配置的默认值，并记录最终生效值。准备完成的调用直至分派完成始终持有同一项适配器注册。`agent/session-prefix` 为每个循环实例组合一次仅用于请求的 prefix 消息，header 记录实际使用的确切结果。到达 `llm/stream` 的请求会被深度冻结，因此变更会抛异常；请求还携带进程本地循环标识，使观察者不会把单独记录的冻结辅助调用误认成对话请求。

在协议格式上，循环构建的请求按此顺序读取：`system` 槽位（渲染后的提示词组装）→ `messagePrefix`（冻结的会话前缀）→ 派生历史——边界快照，其尾部在轮次首步是最新的 `user/message`，在后续步骤是上一步的工具结果。前缀从不进入派生历史；它的持久记录是 header 事件，开发不变式针对每个循环构建的请求精确重算此等式。

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

十三种事件变体（`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`prompt/blocked`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`steering/message`、`todo/write`、`request/header`）、`deriveMessages()` 投影规则、`TurnTrigger`/`TurnEndReason` 原因以及轮次封闭不变量都在 **[session.md](session.md)** 中。日志如何持久化——`SessionPersistence` seam、JSONL/SQLite 后端、`session/flush` 检查点、崩溃恢复与 `SessionHeader`——则在 **[persistence.md](persistence.md)** 中。

<a id="the-agent-handle"></a>

## Agent 句柄

`Agent` 是每个插件（UI、钩子、orchestrator）面向编程的 surface。具体实现为 dsh-agent-loop 包内部细节；循环外没有任何组件依赖它。

源码：[`packages/core/agent/src/types.ts`](../../packages/core/agent/src/types.ts)

```ts type-equiv
/**
 * Options for {@link Agent.followup}, {@link Agent.queue}, and {@link Agent.steer}.
 * An omitted source attests direct human input as `{ kind: 'user' }` and may
 * authorize policy consumers, so non-human producers must label their content.
 */
interface SendOptions {
  source?: MessageSource
  /**
   * Model-facing contexts captured with this inbox item. A queued prompt exposes
   * them through the default `agent/prompt-submit` allow decision, while steering
   * records them directly at its next checkpoint.
   */
  contexts?: HookContext[]
  /** Opaque JSON state retained on the durable message but hidden from the model. */
  meta?: JsonValue
}
```

```ts type-equiv
/** Options specific to durable synthetic context injection. */
interface InjectOptions {
  /** Defaults to `{ kind: 'plugin', plugin: '' }`; non-human producers should identify themselves. */
  source?: MessageSource
  /** Opaque JSON state retained on the durable message but hidden from the model. */
  meta?: JsonValue
}
```

高级接收形式会显式给出所有默认值，并禁止为注入附加上下文：

```ts type-equiv
/**
 * Fully specified input for {@link Agent.send}. Unlike the intent-named
 * helpers, this form applies no defaults: callers provide content, source,
 * contexts, metadata (including explicit `undefined`), target, and wakeup.
 * The union excludes attached contexts from non-waking next-step injection.
 */
type ResolvedAgentInput = {
  content: ContentBlock[]
  source: MessageSource
  meta: JsonValue | undefined
} & (
  | { target: 'next-turn'; wakeup: boolean; contexts: HookContext[] }
  | { target: 'next-step'; wakeup: true; contexts: HookContext[] }
  | { target: 'next-step'; wakeup: false; contexts: [] }
)
```

FIFO 投递方法返回不透明的 `AgentMessageId`，该 id 在同一条消息的各个 `agent/inbox/*` 事件中保持稳定。注入也返回 id，但会绕过这些事件：

```ts type-equiv
/**
 * Opaque id assigned to one accepted agent input. FIFO inputs carry the same id
 * on their `agent/inbox/*` events; injection bypasses those events.
 */
type AgentMessageId = Branded<'AgentMessageId'>
```

`agent/inbox/*` 实时事件承载一条已接收的消息；注入绕过两个 FIFO，从不出现在这些事件中：

```ts type-equiv
/**
 * One accepted FIFO message, carried by the `agent/inbox/*` live events. `id`
 * is the value returned by the accepting helper or {@link Agent.send},
 * stable across this message's enqueue, dequeue, and discard events. Source
 * defaults, when applicable, are already applied, so these are the exact values
 * the item was accepted with.
 * `steering` is true for an item drained between steps; otherwise it is claimed
 * at a turn boundary. `SendOptions.meta` is intentionally omitted: it is durable
 * model-hidden state that lands on the eventual `user/message`/
 * `steering/message`, not live-event routing data.
 */
interface AgentMessage {
  /** The id returned by the accepting helper or {@link Agent.send}. */
  id: AgentMessageId
  content: ContentBlock[]
  source: MessageSource
  contexts: HookContext[]
  /** Whether the item joined the steering FIFO rather than the queued FIFO. */
  steering: boolean
  /** Whether the item wakes the driver or requests another step. */
  wakeup: boolean
}
```

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

结构化 `Agent` 接口公开四个按意图命名的辅助方法，以及接受完全解析输入的方法。具体驱动器只需实现一次这套路由矩阵，每个辅助方法提供其固定路由与默认值。

```ts type-equiv
/** Public agent handle; its concrete implementation is internal to `@deepseek-ai/dsh-agent-loop`. */
interface Agent {
  /** The single identity shared with {@link session}. */
  readonly id: SessionId
  /** The provider route and model this agent's requests use. */
  readonly options: AgentOptions
  /** The live session this agent drives; its log is the durable source of truth. */
  readonly session: Session
  /** The current lifecycle state, mirrored on every `agent/status` transition. */
  readonly status: AgentStatus
  /** Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. */
  readonly ctx: Context

  /**
   * Queue an ordinary message as its own FIFO-ordered turn and wake the driver.
   * Content, resolved source, and attached contexts are detached, validated,
   * and frozen together; invalid input throws synchronously before notification
   * or enqueue.
   * @param content - the prompt content blocks.
   * @param options - source, attached contexts, and durable model-hidden meta.
   * @returns the accepted message's {@link AgentMessageId}, stable across its `agent/inbox/*` events.
   */
  followup(content: ContentBlock[], options?: SendOptions): AgentMessageId

  /**
   * Queue an ordinary message without waking an idle driver. The item retains
   * FIFO order and is claimed only after another input wakes the driver. A lone
   * queued item leaves `whenIdle()` resolved.
   * @param content - the prompt content blocks.
   * @param options - source, attached contexts, and durable model-hidden meta.
   * @returns the accepted message's {@link AgentMessageId}, stable across its `agent/inbox/*` events.
   */
  queue(content: ContentBlock[], options?: SendOptions): AgentMessageId

  /**
   * Submit steering into the running turn and request another step. An open turn
   * records it at the next steering checkpoint before a request or continuation
   * decision; policy may stop before another step. After turn close and its
   * checkpoint, any remainder is queued for a later turn; terminal
   * `agent/turn-stop`, cancellation, or disposal may discard it. Idle steering
   * becomes a waking ordinary turn.
   * @param content - the steering content blocks.
   * @param options - source, attached contexts, and durable model-hidden meta.
   * @returns the accepted message's {@link AgentMessageId}, stable across its `agent/inbox/*` events.
   */
  steer(content: ContentBlock[], options?: SendOptions): AgentMessageId

  /**
   * Append detached model-facing context without running the model. An open-turn
   * injection joins at the current log position unless the current tool batch is
   * executing; then it waits FIFO until that batch settles and drains before
   * turn close even when interrupted. Idle injection uses a one-shot turn and
   * durability checkpoint. Disposal awaits idle checkpoints; flush failures
   * report through `agent/error`. An omitted source defaults to
   * `{ kind: 'plugin', plugin: '' }`.
   * @param content - the injected context content blocks.
   * @param options - source and durable model-hidden meta.
   * @returns the accepted injection's {@link AgentMessageId}; injection emits no `agent/inbox/*` events.
   */
  inject(content: ContentBlock[], options?: InjectOptions): AgentMessageId

  /**
   * Accept one fully specified input through the same snapshot and routing path
   * as the four intent-named helpers. `next-turn` targets the ordinary FIFO;
   * `next-step`/wakeup targets steering (falling back to an ordinary waking turn
   * while idle); and `next-step` without wakeup injects durable context without
   * running the model. Every field is mandatory and no source or routing default
   * is applied. Invalid input throws synchronously before notification, enqueue,
   * or append.
   * @param input - the resolved content, attribution, context, metadata, and routing facts.
   * @returns the accepted input's {@link AgentMessageId}, carried by FIFO lifecycle events when applicable.
   */
  send(input: ResolvedAgentInput): AgentMessageId

  /**
   * Clear queued and steering work — unless `keepInbox` — and abort the active
   * turn. An effective call first emits `agent/cancel-requested` with the
   * resolved typed cause. The first cause wins for the active turn, and
   * `whenIdle()` resolves after cancellation reaches quiescence. Omitted cause
   * means `{ kind: 'user' }`. Idle cancellation is a no-op and does not arm
   * later work. The active turn snapshots and freezes the cause.
   * @param cause - the stable caller intent carried by the current turn signal.
   * @param options - cancellation options; `keepInbox` preserves pending work.
   */
  cancel(cause?: AgentCancelCause, options?: CancelOptions): void

  /** Resolve at idle quiescence; disposal waits for driver exit rather than only the status transition. */
  whenIdle(): Promise<void>
}
```

`AgentStatus` 为 `'idle' | 'running' | 'disposed'`，`SessionId` 是品牌类型。`running` 描述整个驱动器的排空区间，可能跨越轮次关闭、其持久化检查点以及连续的排队轮次；它不能证明某个轮次仍然打开。`AgentOptions` 可合并扩展：core 声明 `provider?` 与 `model?`（在 `agent/request` 后，分发要求两者都存在）。Persona 归 `dsh-system-prompt` 所有：agent 作用域的 `deployment:persona` 可以遮蔽全局默认值。

cause 是由 TypeScript 强制约束的同进程输入。活跃的 `TurnCancellation` 持有者会把其判别字段复制到仅运行时的 `AbortSignal.reason`，并在发布 `turn/end` 前退役；冻结后的 `AbortSignal.reason` 仍可读取。`agentInterruptReasonOf(signal)` 无需查询环境中的 initiator 状态，即可识别 `user`、`parent` 与仅用于生命周期的 `disposed`。持久 `turn/end` 保留粗粒度 `{ kind: 'aborted' }` 结果；若需记录请求 provenance，应使用单独的持久事件，而不是让终态结果承担额外含义。

[事件分类](../architecture.md#event)拥有 `agent/*` 生命周期、检查点与 waterfall（瀑布式事件）契约。轮次和步骤边界是持久会话事件，而不是 agent emit。

## 发起 Agent

`ctx.agents` 携带的进程本地 initiator 就是上面的确切 `Agent`，不是单独的 frame 或复制的标识。环境中存在该值既不能证明存活，也不代表授权；其生命周期与边界规则由 [initiator 作用域决策](../../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.md)规定。

## 拦截决策

每个 `agent/*` 拦截 waterfall 都返回一个小型、特定于 seam 的类型化联合——统一的 Decision 惯用形状（[tools.md](tools.md) 中工具 seam 的 `PreToolDecision`/`PostToolDecision` 也采用相同形状）。CC/Codex 钩子桥接层把其 `permissionDecision`/`decision`/`continue`/`additionalContext` 字段映射到这些联合上；原生插件则直接返回它们。提示词决策与工具后决策共享一种面向模型的上下文形状 `HookContext`，它必须携带 `source`（缺少 source 会默认成 `{kind:'user'}`，从而把插件上下文错标为用户提示词）。其中的 `content` 作为 user-role 输入逐字到达模型，而 JSON `meta` 持久保存插件状态但不向模型暴露。未指定放置方式或指定为 `separate` 时，上下文会成为一条注入的 `user/message`（来源类别为插件或 goal）；`prompt-prefix` 放置方式可用于提示词和 steering 收件箱附件，会在同一条消息中把上下文置于最终生效的请求之前。两种决策都携带 `additionalContexts[]`，使每一项保留各自的 provenance、元数据与放置方式。Continuation reason 则是 steering 消息，并有意使用更窄的 content/source 形状。

源码：[`packages/core/agent/src/types.ts`](../../packages/core/agent/src/types.ts)

```ts type-equiv
/** Model-facing context injected by a listener or atomically attached to one inbox message. */
interface HookContext {
  content: ContentBlock[]
  source: MessageSource
  /**
   * Model placement. Absent or `separate` records an independent injected
   * `user/message`; `prompt-prefix` prepends this context and a stable
   * request delimiter to the same user-role message as its attached prompt.
   */
  placement?: 'separate' | 'prompt-prefix'
  /** Opaque JSON state retained in the session event but hidden from the model. */
  meta?: JsonValue
}
```

`agent/prompt-submit` 返回 `PromptDecision`（允许该轮次已领取的排队消息——可选地改写其 `content` 或附加 `additionalContexts`——或者记录 `prompt/blocked` 并以 `rejected` 结束这个零步骤轮次）：

```ts type-equiv
/**
 * Prompt interception result. `allow.content` replaces the prompt. Each
 * `additionalContexts` entry follows its declared placement: separate context
 * message by default, or a prefix inside the prompt's user-role message.
 * `block` records a durable `prompt/blocked` and ends the claimed prompt's
 * zero-step turn as rejected. An `allow` returned by a listener is
 * authoritative: a listener wrapping `next()` preserves downstream `content`
 * and `additionalContexts` unless it intentionally replaces them.
 */
type PromptDecision =
  | { kind: 'allow'; content?: ContentBlock[]; additionalContexts?: HookContext[] }
  | { kind: 'block'; reason: string }
```

`agent/turn-continuation` 返回 `ContinuationDecision`（步骤有工具调用或注入了 steering 时，循环默认为 `continue`，否则为 `stop`；`continue` 的 `reason` 会记录为同一轮次中下一个步骤的 steering，因此不携带上下文元数据——即类型化 `/goal` 模式）：

```ts type-equiv
/** Turn continuation override; a continue reason is recorded as next-step steering in the same turn. */
type ContinuationDecision =
  | { action: 'stop' }
  | { action: 'continue'; reason?: { content: ContentBlock[]; source: MessageSource } }
```

`agent/request-error` 接收确切的原始 `RequestError`、其不可变 `LlmFailure`、在连续序列中已批准另一次请求的不可变失败列表、轮次信号以及 `next()`。恢复插件按 `failure.code` 路由，而不是按活跃错误的消息路由；每项策略只统计自身的 code，一次成功请求会清空历史：

```ts type-equiv
/** Model-request failure with an optional machine-routable provider code. */
type RequestError = Error & { code?: string }
```

它返回 `RequestErrorDecision`；`retry` 在恢复 listener 的持久变更之后打开一个带新编号的步骤，而 `fail` 在 `turn/end` 上保留结构化失败：

```ts type-equiv
/** Failed-request recovery decision; `retry` opens another numbered step while listeners delegate by calling `next()`. */
type RequestErrorDecision = { action: 'fail' } | { action: 'retry' }
```

`agent/post-step` 会在 assistant 输出、真实或合成的工具结果、缓冲上下文与 steering 持久化之后、`step/end` 之前被 await。被取消的工具批次在排空后携带 aborted signal 到达这里；其签名为 `(agent, turn, step, signal)`，可回放事实保留在会话日志中，而不是瞬态 payload 中。

`agent/turn-stop` 返回仅停止的 `ContinuationStop` 子集或 `undefined`。循环在折叠普通决策、其 reason 和待处理 steering 之后调用此串行检查点；stop 是终态，会丢弃待处理的 steering。

```ts type-equiv
/**
 * The terminal subset of {@link ContinuationDecision}. A listener on
 * `agent/turn-stop` returns this to make the already-composed continuation
 * outcome terminal; `undefined` abstains.
 */
type ContinuationStop = Extract<ContinuationDecision, { action: 'stop' }>
```

`agent/session-start` 携带 `SessionStartSource`（会话生命周期为何开始；桥接层据此匹配其 SessionStart）：

```ts type-equiv
/** Why a session lifecycle began; seeded creates are `startup`, while persisted loads are `resume`. */
type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'
```

`agent/session-prefix` 在每个循环实例中组合一次 `Message[]`。深度冻结的结果被记录在请求 header 中，并前置于每次派生历史，使其成为会话稳定开场白的归属。恢复的实例会重新组合；会话中途的变更使用仅追加的上下文通道。该 waterfall 直接返回内容，因为它是贡献而非决策。

## `ToolDefinition`

唯一属于核心的流水线编写类型：每个已注册工具*是什么*——一个面向模型的 `ToolSchema` 加上一个 `execute` 函数，以及可选的最终内容回调与 UI 回调。工具作者很少手动构造它（`defineTool` DSL 会用类型化参数构建），但它是注册表持有、循环分发所经过的契约。

其完整字段、`defineTool`/`ValueSchemaSpec`/`ParameterSchemaSpec` 类型化 schema DSL、`ToolExecution`/`ToolExecutionResult` waterfall 形状，以及工具展示 UI 词汇在 **[tools.md](tools.md)** 中。
