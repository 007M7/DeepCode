# @deepseek-ai/dsh-llm-pi-ai

[English](README.md) | 中文

基于 [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) 的 harness LLM（大语言模型）seam 通用多提供方适配器。一个插件实例拥有显式提供方 profile 列表；每个请求使用 `GenerateOptions.provider` 选择 profile，并从 pi-ai 已安装 catalog 中动态解析 `GenerateOptions.model`。

包（package）根入口导出 Cordis 插件契约与 `PiAiAdapter`；profile 解析、模型构造、回放转换和流转换保留在包内部。

## 配置

按提供方配置凭证与部署特定传输设置。省略 `apiKey` 会将认证委托给 pi-ai 的提供方原生环境发现。`baseURL` 只会覆盖所选 catalog 模型的端点，保留其 API 家族与兼容性元数据，因此仍支持 `https://proxy.example.com:8443` 等私有 proxy。

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      - provider: openai
        apiKey: !!js process.env.OPENAI_API_KEY
        baseURL: https://proxy.example.com:8443
        reasoning: high
        retryPolicy:
          mode: normal
          maxRetries: 3
          backoff:
            initialDelayMs: 500
            maxDelayMs: 10000
            jitterRatio: 0.1
      - provider: anthropic
        apiKey: !!js process.env.ANTHROPIC_API_KEY
        streamIdleTimeoutMs: 300000
      - provider: openrouter
        apiKey: !!js process.env.OPENROUTER_API_KEY
        headers:
          X-Deployment: production
```

每个提供方名称必须存在于 pi-ai 已安装 catalog 中，且在此插件实例中最多出现一次。向 `ctx.llm` 注册具有原子性：如果与另一适配器已拥有的任何提供方路由冲突，插件会加载失败，不注册剩余路由。模型 id 不是生命周期配置；未知模型会在发起任何提供方请求前以 `LlmError('UNKNOWN_MODEL')` 失败。

适配器通过 `ctx.llm.listModels(provider)` 公开每个已配置提供方已安装的 pi-ai 模型。这是从 `getModels(provider)` 派生的提供方无关 selector 元数据；请求时解析仍会执行权威 catalog 查找，因此发现不会创建第二个模型注册表。`ctx.llm.resolveModelInfo(provider, model)` 会执行一次精确 descriptor 查找，并返回其身份、上下文窗口和可选思考级别，让权威元数据保留在拥有路由的适配器上，而非消费方。

`reasoning.efforts` 列表是 pi-ai 有序的 `getSupportedThinkingLevels(model)` 结果，不经筛选或规范化，其中包括 `off`，以及模型对 `xhigh` 或 `max` 的特定支持。Harness 将每个规范 pi-ai 级别公开为不透明 ID；提供方／模型在协议格式中的表示仍保留在 pi-ai 的 `thinkingLevelMap` 中。因此，不具备推理（reasoning）能力的模型也会公开 pi-ai 的 `off` 选项。配置 profile 的 `reasoning` 值（包括 `off`）在存在时是部署默认值；省略它会保留提供方默认值。每次请求的 `GenerateOptions.reasoningEffort` 优先；任何未出现在确切模型能力中的显式值都会在网络 I/O 前以 `UNSUPPORTED_REASONING_EFFORT` 失败，而不会被自动调整。pi-ai 的通用流选项通过省略 `reasoning` 表示 `off`。

受支持的 profile 字段是 `provider`、`apiKey`、`baseURL`、`headers`、`reasoning`、`thinkingBudgets`、`cacheRetention`、`transport`、`timeoutMs`、`websocketConnectTimeoutMs`、`streamIdleTimeoutMs` 和 `retryPolicy`。每个 profile 的可选重试策略都会与该提供方路由一同捕获；省略时使用有界的常规默认值。流空闲间隔必须是正的有限 Node 定时器延迟，默认为五分钟，且只覆盖未完成提供方读取，不包括消费方思考时间。若已配置标头中有同名项，则以 Harness 应用归因为准。

适配器强制 pi-ai SDK `maxRetries` 为零，因此一次 `stream()` 调用只会发起一次提供方请求。已移除 profile 字段 `maxRetries` 和 `maxRetryDelayMs` 会使加载失败，而不是静默倍增或隐藏单独组合的 agent（智能体）级重试预算。空闲超时会 abort SDK 的稳定请求信号，并以 `TIMEOUT` 呈现；较早的调用方 abort 仍为 `ABORTED`。

## 提供方／模型路由与回放

所选 pi-ai catalog descriptor 提供协议实现。这包括原生 API 差异，例如 descriptor 使用 Responses API 而非 Chat Completions 的 OpenAI 模型；harness 适配器不会按模型名称硬编码端点选择。

成功的 assistant 响应会在自身持久提供方／模型溯源旁存储经版本化的无损 JSON 回放状态。请求时，`LlmService` 只有在历史提供方路由与目标提供方路由当前由同一个 `PiAiAdapter` 实例拥有时，才会传递回放状态。即使目标提供方或模型改变，适配器也会验证状态并恢复 pi-ai 响应 id 与提供方 signature；随后由 pi-ai 判定目标 API 可以复用哪些元数据。没有回放状态的历史会被转换为外来的、与提供方无关的内容，绝不伪装为原生 pi-ai 响应。

如果 listener 改写已组装 assistant 内容，loop 会在记录消息前丢弃回放状态，因为其提供方元数据不再描述该内容。无效版本、格式错误元数据、溯源提供方／模型不匹配，以及内容／块不匹配都会显式以 `LlmError('INVALID_REPLAY_STATE')` 失败。

## 词汇差异

- pi-ai 工具调用参数是已解析对象；harness 存储原始 JSON 字符串。适配器会解析输入，并将输出重新字符串化。
- pi-ai 将失败报告为流内错误事件；它们会映射到 `finish {kind:'error'|'aborted', failure}` 分片。提供方特定错误文本会区分终止型 `QUOTA` 与暂时型 `RATE_LIMIT`，针对已解析模型上下文窗口评估的文本与 usage 信号则将溢出规范化为 `CONTEXT_WINDOW_EXCEEDED`。终止时的 `stop` 若消息不含内容块，则会映射为 `finish {kind:'error'}`，code 为 `EMPTY_RESPONSE`（默认策略会重试），而非成功空消息。
- pi-ai 将推理 token 折叠到输出 usage 中；没有可映射的独立推理计数。
- pi-ai 的 `off` 思考级别会原样穿过 Harness 能力 seam，并在分派时变为被省略的 pi-ai 通用 `reasoning` 选项。
- `GenerateOptions.stop` 会以 `UNSUPPORTED_OPTION` 被拒绝，因为 pi-ai 的通用流式输出接口无法保证所有提供方都支持它。

## 应用归因

每个请求都携带 dsh-llm `attributionHeaders()` 的共享归因标头，并通过 pi-ai `headers` 流选项合并。不会合成提供方特定应用归因标头。详见 [dsh-llm § 应用归因](../llm/README.md#app-attribution-attributionts)。

## 依赖体量

pi-ai 会安装多个提供方 SDK，并延迟加载 catalog 模型所选的 SDK。该可选适配器包将依赖体量隔离在自身范围内。

## 测试

单元测试使用重定向到本地 mock 服务器的 pi-ai catalog 模型，覆盖提供方／profile 路由、每次适配器调用只发起一个协议请求、idle-timeout 响应终止、调用方 abort、原生 API 选择、端点覆盖、归因、转换、回放状态验证，以及一个适配器实例内的跨提供方／模型回放。真实 API 覆盖仍需 key 才会启用，并通过 `pnpm run test:e2e` 运行。

## 模型体验

### 通过 pi-ai 发起的提供方请求

#### 模型看到的内容

所选 catalog 模型会收到 `GenerateOptions.system`、历史、工具，以及 pi-ai 通用流式 API 支持的采样字段。本包不添加提示词文本。只有当适配器验证提供方原生回放元数据与历史内容匹配时，才会恢复这些元数据。

#### Token 影响

精确输入取决于提供方 tokenization。转换不添加模型可见文本；回放元数据可能让原生 API 复用提供方侧状态。

#### KV Cache 影响

转换保留逻辑请求顺序，不添加文本；复用取决于所选提供方的序列化与回放状态。更改适配器实例、提供方、模型或任何上游请求 token，都可能使复用从首个出现差异的 token 起失效。

### 提供方响应

#### 模型看到的内容

pi-ai 事件会变为 harness 推理、文本、工具调用、usage 与 finish 分片。已解析工具参数以原始 JSON 字符串形式通过 harness 边界传递。

#### Token 影响

只有在 loop 记录生成内容后，它才会影响后续输入。提供方不单独报告推理 token 时，pi-ai 会将其折叠到输出 usage 中。

#### KV Cache 影响

已记录响应内容会追加到下一个请求，不会使其较早可复用前缀失效。未记录传输元数据与 usage 计量不影响 cache 身份。

## 已知限制与暂缓事项

- **必须属于 catalog**：已安装 pi-ai catalog 中不存在的自定义模型 id 会以 `UNKNOWN_MODEL` 失败，即使提供方 profile 配置了自定义端点。
- **不支持 `GenerateOptions.stop`**：pi-ai 的通用流选项无法保证所有提供方都支持 stop sequence，因此适配器会拒绝该字段。
- **历史中的 `system` 消息使用 pi-ai 通用上下文转换**：提供方特定位置由 pi-ai 决定，而非由 harness 拥有的协议覆盖决定。
- **无法获取提供方 HTTP 状态**：pi-ai 错误事件不会在所有提供方上公开稳定 HTTP 状态；失败只公开稳定 harness 错误 code。
- **重试策略由提供方持有，而不是 SDK 重试**：每个提供方 profile 都可以配置嵌套的 `retryPolicy`，由 `dsh-llm-retry` 在 agent 的失败步骤 seam 上执行；pi-ai SDK 重试仍保持禁用，因此持久化的 agent 步骤与 `llm/retry` 事件记录每次可见尝试，直接 `ctx.llm.stream()` 调用仍只尝试一次。
