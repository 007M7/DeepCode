# LLM（大语言模型）流式输出

[English](llm-streaming.md) | 中文

[dsh-llm](../../packages/llm/llm) 的协议格式（wire format）级流式输出词汇。[core.md](core.md) 介绍了 `StreamChunk`、`Message` 与 `ContentBlock`；本页拥有完整的分片协议、每个适配器必须遵守的适配器契约（adapter contract），以及共享的 assembler。

源码：[`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

## `StreamChunk`：原始协议

一个流式响应交错包含多种类型的块（文本、推理（reasoning）、多个工具调用）。`index` 将每个 delta 关联到其所属块；`block-end` 携带完整组装好的 `ContentBlock`，消费方无需自行重新组装 delta。这是一个**封闭的**可辨识联合类型：对 `type` 的 `switch` 以 `assertNever` 结尾，因此新增变体会在每个必须处理它的消费方处触发编译错误。

```ts type-equiv
/**
 * Raw streaming protocol emitted by adapters.
 * Block indexes correlate interleaved deltas, and `block-end` carries the
 * assembled block. Adapters emit usage before the terminal finish and nothing
 * afterward; tool arguments remain raw JSON strings. Failures either throw or
 * end with `error`/`aborted`, and consumers must handle both paths.
 */
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | {
    type: 'finish'
    reason: FinishReason
    /** Adapter-private lossless-JSON state for replaying a successful response. */
    replayState?: unknown
  }
```

## `LlmFailure`

每个抛出的失败或最终适配器的带内失败都会规范化为一种可序列化、提供方无关的 payload。`providerRetryAfterMs` 是经校验、由提供方请求的正数延迟，而不是重试决策；`ProviderRequestId` 是用于诊断的不透明品牌字符串。

```ts type-equiv
/** Serializable provider-boundary facts; policy decides whether they are retryable. */
interface LlmFailure {
  /** Human-readable provider or transport failure. */
  readonly message: string
  /** Stable provider-neutral machine-routing code. */
  readonly code: string
  /** HTTP status observed at the provider boundary, when available. */
  readonly status?: number
  /** Provider-requested delay in milliseconds, when valid and available. */
  readonly providerRetryAfterMs?: number
  /** Opaque provider-issued request identifier for diagnostics. */
  readonly requestId?: ProviderRequestId
}
```

## 适配器契约

每个适配器必须遵守以下规则，每个消费方可以依赖它们：

- **`usage` 在 `finish` 之前，`finish` 之后不再有任何分片。** 将两者都推迟到提供方的流结束标记，这样尾部的 usage-only 分片就不会违反顺序。
- **工具调用的 `arguments` 全程保持原始 JSON 字符串。** 部分片段通过 `argumentsDelta` 流式传输；如果提供方返回的是已解析的对象，适配器在 `block-end` 时重新序列化为字符串。
- **两条受支持的错误路径，一种事实形状。** 失败可以从 `stream()` 抛出（传输/协议错误），**或者**以 `finish {kind:'error'|'aborted', failure}` 结束流（无法在流中途抛异常的适配器用它表示提供方带内错误）。`LlmError.failure` 携带同一个 `LlmFailure`。最终适配器边界保留被抛出的确切 `Error` 对象，并将不可变事实关联到该调用；agent loop（智能体循环）关闭失败的步骤，再把错误、事实与不可变的先前已重试事实提供给 `agent/request-error`。若未恢复，结构化失败会成为轮次错误，并且该次尝试不会提交正常 assistant 消息或工具副作用。
- **一次适配器调用就是一次提供方尝试。** 适配器禁用库重试。agent 层恢复会打开另一个持久、带编号的步骤；直接调用 `ctx.llm.stream()` 的调用方仍然只尝试一次。
- **提供方停顿在传输层受到时限约束。** 两个已交付的远程适配器都暴露正数且有限的 `streamIdleTimeoutMs`，默认五分钟。watchdog 只在 iterator `next()` 尚未完成时启动，整个请求使用同一个稳定 signal，把自身到期映射为 `TIMEOUT`，并把更早发生的调用方中止保留为 `ABORTED`。
- **上下文溢出只有一个规范 code。** 两个 DeepSeek 适配器都通过 `isContextWindowExceededError()` 对提供方的显式细节分类并暴露 `CONTEXT_WINDOW_EXCEEDED`，无论失败以抛出的 HTTP `LlmError` 还是带内 finish error 到达。消费方按 code 路由，绝不依赖提供方文本。
- **每个提供方 HTTP 请求都携带应用归属头。** 适配器发送 `attributionHeaders()`（见下文）作为 `User-Agent` 基线，并通过协议级测试加以证明（mock 服务器断言收到的 header，或对基于库的适配器使用库的 header 钩子）。
- **回放状态归适配器所有。** 成功的 `finish` 可以携带重建提供方原生响应所需的无损 JSON 状态。除非 `agent/step-result` listener 改写了内容，否则循环会将其与组装后的 assistant 消息一起存储。后续请求中，仅当历史提供方与目标提供方当前注册到完全相同的适配器实例时，`LlmService` 才会传递该状态。该适配器负责校验状态并拥有所有跨模型或跨提供方转换；其他适配器只会收到提供方无关的内容与 provenance，不会收到私有状态。

该契约由两个有意保持独立的实现锁定：`dsh-llm-deepseek`（手写 fetch/SSE（Server-Sent Events））和 `dsh-llm-pi-ai`（通过 `@earendil-works/pi-ai` 实现的通用多提供方适配器）。基于库的适配器覆盖 finish 分片错误路径，而传输边界测试证明每个空闲 watchdog 都会停止其实际请求。

## `AppIdentity`：应用归属

每个适配器都会向提供方发送的静态公开应用标识（[`packages/llm/llm/src/attribution.ts`](../../packages/llm/llm/src/attribution.ts)）。`attributionHeaders(identity?)` 只把它映射到标准 `User-Agent` header；该契约有意不支持 OpenRouter 特有的应用归属 header。默认 `APP_IDENTITY` 从包（package） manifest（元数据清单）获取版本；每个字段都是公开产品事实——不含 secret、路径、会话 id 或逐用户标识，且任何逐请求信息都不得影响这些值。设计理由见[强制 `User-Agent` 归属](../../.agents/notes/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.md)。

```ts type-equiv
/**
 * Static public application identity sent to LLM providers.
 *
 * Every field is a public product fact, safe on every request: no secrets,
 * local paths, session ids, prompt text, or per-user identifiers belong here,
 * and nothing per-request may influence the values.
 */
interface AppIdentity {
  /** `User-Agent` product token (lowercase, hyphenated). */
  product: string
  /** Product version; sourced from package metadata, never hand-copied. */
  version: string
  /** Public home URL of the app, used as the `User-Agent` comment. */
  url: string
}
```

## `TokenUsage`

逐调用 token 记账。各计数**互不重叠**：`inputTokens` 只包含未缓存输入；缓存输入单独报告，计费输入是三者之和。若提供方把缓存命中折入单一提示词总数（如 DeepSeek 的 `prompt_tokens`），适配器会再将其扣除。`reasoningTokens` 存在时只是信息性细节，已经包含在 `outputTokens` 中；汇总时不得重复相加。

```ts type-equiv
/**
 * Token accounting for one model call (cache fields are optional).
 *
 * Counts are DISJOINT: `inputTokens` is uncached input only; cached input is
 * reported separately as `cacheReadTokens`/`cacheWriteTokens` (billed input =
 * sum of the three). Adapters whose providers fold cache hits into a total
 * prompt count (DeepSeek's `prompt_tokens`) subtract them out.
 */
interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}
```

## `BlockAssembler`

`BlockAssembler`（[`packages/llm/llm/src/assembler.ts`](../../packages/llm/llm/src/assembler.ts)）是唯一的共享实现，负责把 `StreamChunk` 流折叠回 `ContentBlock`、usage、结束原因与回放状态。循环在记录原始分片的同时，把同一批分片送入 assembler，再将组装后的 assistant 内容连同其提供方/模型 provenance 一起存储。需要组装结果、又不想重新实现 fold 的消费方使用它。

```ts public-api
/**
 * Incrementally assembles raw {@link StreamChunk}s into complete
 * {@link ContentBlock}s and a final assistant {@link Message}.
 *
 * The agent loop feeds it while logging raw chunks for replay fidelity, then
 * reads `blocks()` / `message()` / `usage` / `finish` once the stream ends.
 *
 * Tolerant of delta-only protocols (no block-start/end); deltas arriving for
 * an index already closed by `block-end` are ignored (malformed stream) so a
 * misbehaving adapter cannot grow memory or corrupt a completed block.
 */
declare class BlockAssembler {
  /**
   * Feed one chunk into the assembly state.
   * @param chunk - the next raw chunk, in stream order.
   */
  push(chunk: StreamChunk): void;
  /**
   * Assemble all blocks seen so far, in stream order.
   * @returns one block per seen index; an open block assembles from its
   *   accumulated deltas (an unknown block type never closed by `block-end` throws).
   */
  blocks(): ContentBlock[];
  /** Usage from the `usage` chunk; undefined until one arrives. */
  get usage(): TokenUsage | undefined;
  /** Finish reason from the `finish` chunk; `{kind: 'stop'}` when the stream ended without one. */
  get finish(): FinishReason;
  /** Adapter-private replay state from the terminal finish chunk, if any. */
  get replayState(): unknown;
  /**
   * The assembled assistant message.
   * @returns an assistant-role message over `blocks()` (same open-block assembly rules).
   */
  message(): Message;
}
```

## seam

`LlmAdapter` 是提供方 seam：创建子类、实现 `stream()`，再用 `ctx.llm.registerAdapter(providers, adapter)` 注册一个适配器实例。`GenerateOptions.provider` 选择已注册适配器；`GenerateOptions.model` 会传给该适配器，无需在生命周期启动时注册。重复提供方路由会原子失败。可选的 `providerInfo()` 与异步 `listModels()` 方法为 `LlmService.listProviders()` / `listModels()` 提供分离的 selector 元数据。该目录仅供参考，不是请求白名单：适配器仍是权威，并可接受未列出的模型 id。单独的 `resolveModelContext()` 查询会暴露确切路由上对正确性敏感的容量信息，但不会让目录成员关系具有权威性；缺失表示元数据未知，而不是路由无效。适配器查找发生在 `llm/stream` waterfall（瀑布式事件）的终端 continuation，因此 listener 可以在查找前短路调用，或路由一个可变的一次性请求。`block-start` / `block-end` 的 `index` 关联与 assembler 共同意味着适配器只需 emit 格式正确的分片——块重组不是每个适配器各自的问题。消费方 surface（`ctx.llm.stream()`）与 `llm/stream` waterfall 见 [architecture.md § 内容块与流式传输](../architecture.md#content-blocks-and-streaming-dsh-llm)。

```ts public-api
/**
 * Provider-wire adapter for the harness message and stream vocabulary. Register implementations
 * with `ctx.llm.registerAdapter(providers, adapter)`. Every provider HTTP request must include
 * `attributionHeaders()`; prove that at the wire or library header-hook boundary. The hand-rolled
 * DeepSeek and pi-ai adapters intentionally exercise this contract through different internals.
 */
declare abstract class LlmAdapter {
  /**
   * Describe one provider route owned by this adapter.
   * @param provider - a route passed to `registerAdapter()` for this instance.
   * @returns detached display metadata whose id must equal `provider`.
   */
  providerInfo(provider: string): LlmProviderInfo;
  /**
   * List models this adapter can currently advertise for one owned provider.
   * The result is advisory: an adapter may accept unlisted model ids, and
   * consumers must not turn absence into request rejection.
   * @param _provider - one provider route owned by this adapter.
   * @returns discoverable models in adapter-preferred order.
   */
  listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
  /**
   * Resolve context capacity for one model accepted by this adapter. Absence
   * means the adapter does not know the capacity, not that routing is invalid.
   * @param _provider - one provider route owned by this adapter.
   * @param _model - exact model id passed to {@link GenerateOptions.model}.
   * @returns provider-owned context metadata, or `undefined` when unavailable.
   */
  resolveModelContext(
    _provider: string,
    _model: string,
  ): Promise<LlmModelContext | undefined>;
  /**
   * Stream one model call as raw chunks. The only required method.
   * @param options - the fully-assembled request; implementations must honor `options.signal`.
   * @returns the chunk stream, obeying the adapter contract documented on `StreamChunk`.
   */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
```

`ContentBlockType`（`index` 关联块所携带的键集合）派生自 `ContentBlockMap`：

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

块接口详见 [core.md § Content blocks and messages](core.md#content-blocks-and-messages)。
