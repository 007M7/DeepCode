# LLM 流式输出

[English](llm-streaming.md) | 中文

[dsh-llm](../../packages/llm/llm) 的协议格式（wire format）级流式输出词汇。[core.md](core.md) 介绍了 `StreamChunk`、`Message` 与 `ContentBlock`；本页拥有完整的分片协议、每个适配器必须遵守的适配器契约（adapter contract），以及共享的 assembler。

源码：[`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

## `StreamChunk`：原始协议

一个流式响应交错包含多种类型的块（文本、推理（reasoning）、多个工具调用）。`index` 将每个 delta 关联到其所属块；`block-end` 携带完整组装好的 `ContentBlock`，消费方无需自行重新组装 delta。这是一个**封闭的**可辨识联合类型：对 `type` 的 `switch` 以 `assertNever` 结尾，因此新增变体会在每个必须处理它的消费方处触发编译错误。

```ts type-equiv
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }
```

## 适配器契约

每个适配器**必须**遵守以下规则，每个消费方可以依赖它们：

- **`usage` 在 `finish` 之前，`finish` 之后不再有任何分片。** 将两者都推迟到提供方的流结束标记，这样尾部的 usage-only 分片就不会违反顺序。
- **工具调用的 `arguments` 全程保持原始 JSON 字符串。** 部分片段通过 `argumentsDelta` 流式传输；如果提供方返回的是已解析的对象，适配器在 `block-end` 时重新序列化为字符串。
- **两条许可的错误路径。** 失败可以从 `stream()` 中 THROW（传输/协议错误），**或者**以 `finish {kind:'error'|'aborted'}` 结束流（提供方带内错误，适用于无法在流中途抛出异常的适配器）。消费方必须同时处理*两种*情况。agent loop（智能体循环）将 finish-error/aborted 转化为轮次错误，绝不会为失败的步骤记录一条正常完成的 assistant 消息。
- **每个提供方 HTTP 请求都携带应用归属头。** 适配器发送 `attributionHeaders()`（见下文）作为 `User-Agent` 基线，并通过协议级测试加以证明（mock 服务器断言收到的 header，或对基于库的适配器使用库的 header 钩子）。

这份契约正是两个适配器作为刻意配对存在的原因：`dsh-llm-deepseek`（手写 fetch/SSE（Server-Sent Events））与 `dsh-llm-pi-ai`（通过 `@earendil-works/pi-ai` 访问同一端点）。两套独立内部实现共享一份契约，正是将协议固定下来的方式：基于库的适配器无法在流中途抛出异常，因此它走通了手写适配器可能不会走到的 finish-chunk 错误路径。

## `AppIdentity`：应用归属

每个适配器向提供方发送的静态公开应用标识（[`packages/llm/llm/src/attribution.ts`](../../packages/llm/llm/src/attribution.ts)）。`attributionHeaders(identity?)` 仅将其映射为标准 `User-Agent` header；本契约有意不支持 OpenRouter 特有的应用归属 header。默认的 `APP_IDENTITY` 从 package manifest（元数据清单）获取版本号；每个字段都是公开的产品事实，不含密钥、路径、会话 id 或用户级标识符，且任何请求级信息都不得影响这些值。设计依据见 [Mandatory `User-Agent` attribution](../rfc/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.md)。

```ts type-equiv
interface AppIdentity {
  product: string
  version: string
  url: string
}
```

## `TokenUsage`

单次调用的 token 用量统计。各计数**互不重叠**：`inputTokens` 仅为未缓存的输入；缓存命中的输入单独报告，计费输入是三者之和。如果提供方将缓存命中合并到单一的 prompt 总量中（如 DeepSeek 的 `prompt_tokens`），适配器需将其减回去。

```ts type-equiv
interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}
```

## `BlockAssembler`

`BlockAssembler`（[`packages/llm/llm/src/assembler.ts`](../../packages/llm/llm/src/assembler.ts)）是唯一的共享实现，将 `StreamChunk` 流折叠回 `ContentBlock` 列表与最终的 `Message`。agent loop 记录原始分片（保证回放保真度），同时将相同的分片送入 assembler，因此权威日志保留了 token 级细节，而派生消息可确定性地重建。需要组装结果而不想重新实现折叠逻辑的消费方使用它。

## seam

`LlmAdapter` 是提供方 seam：继承它、实现 `stream()`、通过 `ctx.llm.registerAdapter(models, adapter)` 注册。`block-start`/`block-end` 的 `index` 关联加上 assembler 意味着适配器只需发出格式正确的分片，块重组不是各适配器需要操心的事。消费方接口（`ctx.llm.stream()`）与 `llm/stream` waterfall（瀑布式事件）在 [architecture.md § Content blocks and streaming](../architecture.md#content-blocks-and-streaming-dsh-llm) 中描述。

`ContentBlockType`（`index` 关联块所携带的键集合）派生自 `ContentBlockMap`：

```ts type-equiv
interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
}
```

块接口详见 [core.md § Content blocks and messages](core.md#content-blocks-and-messages)。
