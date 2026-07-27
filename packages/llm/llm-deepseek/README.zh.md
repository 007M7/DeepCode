# @deepseek-ai/dsh-llm-deepseek

[English](README.md) | 中文

harness LLM seam 的 DeepSeek chat-completions 适配器：手写 `fetch` + SSE，将官方协议格式（真源：API 文档 guides/thinking_mode、guides/tool_calls、api/create-chat-completion）转换为 `StreamChunk` 协议。

同一 seam 的第二个库支持实现位于 `@deepseek-ai/dsh-llm-pi-ai`。本包始终拥有 `deepseek` 提供方路由；在同一上下文中装载 `provider: deepseek` 的 pi-ai profile 会按设计抛出 `LlmError('DUPLICATE_ADAPTER')`。

包根目录公开 Cordis 插件契约与 `DeepSeekAdapter`；协议序列化、SSE 解析与 chunk 转换 helper 不属于该根契约。

## 配置

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKey: !!js process.env.DEEPSEEK_API_KEY    # or rely on the env fallback
    baseURL: !!js process.env.DEEPSEEK_BASE_URL  # default: https://api.deepseek.com
    thinking: enabled        # optional; provider default is enabled
    reasoningEffort: high    # optional; off | high | max — omitted ⇒ high
    streamIdleTimeoutMs: 300000 # optional; positive finite Node timer delay; five-minute default
    defaultContextWindow: 256000 # optional positive-integer fallback for models without an exact value
    models:                  # optional; defaults to V4 Flash and V4 Pro
      - id: deepseek-v4-flash
        name: DeepSeek V4 Flash
      - id: private-reasoner
        description: Company-hosted reasoning model
        contextWindow: 64000
```

该插件注册唯一提供方路由 `deepseek`。请求使用 `provider: deepseek` 选择该路由；其 `model` 会作为协议 `model` 字符串原样传递，因此更改 DeepSeek 模型不需要生命周期时注册。省略 `models` 会公布 `deepseek-v4-flash` 和 `deepseek-v4-pro`，两者的上下文窗口均为 128,000 token；显式列表会替换这些默认值，`models: []` 则不公布任何模型。Catalog 配置项通过 `ctx.llm.listModels('deepseek')` 公开给 UI selector 与部署自省，但仍只提供建议：未列出模型 id 仍原样传递。省略配置项 name 默认为其 id。

`contextWindow` 对每个已配置模型都可选，不会通过建议 catalog 公开。`ctx.llm.resolveModelInfo('deepseek', model).context` 先返回精确模型值，再对不含容量的配置项或未列出原样传递 id 返回 `defaultContextWindow`。两者都不存在时，`context` 字段缺失但不会使路由失效。因此，压力敏感插件可以获得部署拥有的容量，不会将模型 selector 视为权威。为 `deepseek` 注册另一个适配器会抛出 `LlmError('DUPLICATE_ADAPTER')`。

同一确切模型结果会在部署策略允许思考时，为每个原样传递模型在 `reasoning` 下公开有序的 `off`、`high` 和 `max` 推理强度。`reasoningEffort` 选择部署默认值，省略时回退为 `high`。`agent/request` 可以在每个会话步骤替换它；解析后的值会记录在 `request/header`。`high` 和 `max` 会启用思考，并序列化为官方顶层 `reasoning_effort`；适配器持有的 `off` 则序列化为 `thinking.type: disabled`，且省略 `reasoning_effort`。不支持的值会在网络 I/O 前以 `UNSUPPORTED_REASONING_EFFORT` 失败。

`thinking: disabled` 是部署锁定：它只公布 `off`，并以 `off` 为默认值。省略 `reasoningEffort` 或将其配置为 `off` 均有效；配置 `high` 或 `max` 会使插件加载失败，直接按请求启用思考也会在网络 I/O 前失败。携带 `GenerateOptions.purpose: 'session-title'` 的请求也会强制禁用思考并省略已解析的推理强度，将有界输出保留给可见标题文本，不改变会话或压缩默认值。

`streamIdleTimeoutMs` 会限制每次未完成提供方读取，包括初始 `fetch`，但不计入消费方在 chunk 间花费的时间。一个稳定 abort 信号会在整个调用中达到请求与 body reader；过期会停止传输并抛出 `LlmError('TIMEOUT')`，较早的调用方 abort 则抛出 `LlmError('ABORTED')`。适配器每次 `stream()` 调用精确发起一次提供方请求；agent 级重试是独立插件策略。

## 应用归因

每个请求都携带 dsh-llm `attributionHeaders()` 的共享归因标头，即用于识别 harness 的必需 `User-Agent` 基线（见 [dsh-llm § 应用归因](../llm/README.md#app-attribution-attributionts)）。在该适配器契约下，直接 DeepSeek 请求与 OpenAI 兼容 gateway 请求都不会获得提供方特定应用归因标头；OpenRouter 应用归因暂缓到未来的显式 OpenRouter 适配器或模式。`GenerateOptions.purpose` 为 `compaction` 的请求（dsh-compact-basic 的辅助摘要调用）还会携带 `x-deepseek-harness-compact: 1`，让宿主可以将压缩流量与会话请求分开。

## 协议格式说明（已通过实时请求与官方文档验证）

- 只支持流式输出（`stream_options.include_usage` 始终开启）。`usage` 可能附着在 finish chunk 上，也可能作为尾随仅 usage chunk 到达；转换器会将两者都延迟到 `[DONE]`，因此 `usage` 始终位于 `finish` 之前，`finish` 之后不会出现任何内容。
- 适配器持有的 `off` 推理强度映射为 `thinking: {type: 'disabled'}`，绝不会以 `reasoning_effort: 'off'` 跨越协议。
- 第一个 thinking 模式 chunk 携带 `reasoning_content: ""`，系统会处理它（不会产生多余 reasoning 块）。
- **Reasoning 回传规则**：对携带工具调用的 assistant 轮次，会将 `reasoning_content` 序列化回历史（thinking 模式 API 必需）；对不含工具调用的轮次，它会被丢弃（不会使用，可节省 token）。
- Cache 计量：`cacheReadTokens` ← `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens`；DeepSeek 不报告 cache-write 指标。

## 错误

非 2xx 响应会抛出稳定 code 的 `LlmError`：`AUTH`（401/403）、`QUOTA`（提供方详细信息标识配额、余额或点数耗尽的响应）、`RATE_LIMIT`（其他 429）、`CONTEXT_WINDOW_EXCEEDED`（提供方 code、type 或 message 标识上下文溢出的 400）、`INVALID_REQUEST`（其他 400）、`SERVER`（5xx），其他情况为 `HTTP_<status>`。其可序列化 `failure` 保留 HTTP 状态，以及有效的正 `Retry-After` 秒数／日期延迟和存在时的 `x-request-id` / `x-deepseek-request-id`。响应前传输失败（DNS、连接被拒绝、TLS、proxy）会抛出命名已配置端点的 `TRANSPORT`，并将原始拒绝链接为 `cause`；调用方 abort 抛出 `ABORTED`，loop 的取消信号仍最具权威。协议违例抛出 `STREAM_CLOSED`（没有 `[DONE]`）或 `MALFORMED_RESPONSE`（JSON payload 错误）。未知协议 `finish_reason`（例如 `content_filter`、`insufficient_system_resource`）会变为 `finish {kind: 'error', failure}` chunk；已完成流如果使用 `stop`（或缺失）finish 但没有开启内容块，就会变为 `finish {kind: 'error'}`，code 为 `EMPTY_RESPONSE`（默认策略会重试）。

## 测试

单元套件使用本地 `node:http` mock SSE 服务器（无网络），覆盖动态 `high`／`off`／`max` 选择、结构化 HTTP 事实、格式错误／截断流、调用方 abort、连接失败，以及 idle 超时确实会 abort 实际 body 的证明。真实 API 覆盖位于 `tests/adapter.e2e.ts`（`pnpm run test:e2e`，由 key 调节）：V4 Flash + V4 Pro，覆盖 thinking 启用／禁用与两种官方 effort 级别，包括 thinking + 工具往返与 reasoning 回传。

## 模型体验

### DeepSeek 请求

#### 模型看到的内容

所选 DeepSeek 模型会收到 harness 系统提示词、消息历史、工具 schema、stop sequence 和调用配置，不含适配器撰写的提示词文本。当之前的 assistant 轮次包含工具调用时，会按要求回传其 reasoning 内容；不含工具调用的轮次会省略 reasoning。

#### Token 影响

精确输入取决于提供方 tokenization。有条件 reasoning 回传会增加工具往返上下文，丢弃其他 reasoning 则避免再次支付这些 token；可用时会报告 cache-read 用量。

#### KV Cache 影响

未更改的已组装前缀可使用 DeepSeek cache 复用，适配器会在 usage 中报告它。模型路由变更，或任何上游提示词、schema、前缀或历史变更，都可能使从第一个改变 token 起的复用失效；reasoning 回传会在工具往返期间追加。

### DeepSeek 响应

#### 模型看到的内容

Reasoning、文本与原始字符串工具参数会转换为 harness chunk，供 loop 记录和组装。

#### Token 影响

生成 token 遵循请求中已记录的推理强度和 `maxTokens`；只有 loop 保留的块会影响后续输入。

#### KV Cache 影响

loop 保留的响应块会追加到下一个请求，并保留其较早可复用前缀；已丢弃块不会影响后续 cache。更改提供方或模型会选择不同 cache 域。

## 已知限制与暂缓事项

- **未映射 `tool_choice`**：它不属于核心词汇（MVP 取舍，与 pi-ai twin 共享）。
- **请求使用原始 `fetch`，而非 `@cordisjs/plugin-http`**：没有共享 proxy／拦截配置；采用暂缓到第二个适配器需要该功能时（`TODO(http)`）。
- **序列化会将 user 与工具结果内容展平为文本块**：会跳过插件添加的块类型，空工具输出会以字面 `(no output)` 跨越协议。
