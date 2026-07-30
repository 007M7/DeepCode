# @deepseek-ai/dsh-llm-pi-ai

[English](README.md) | 中文

基于 [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) 的 harness LLM（大语言模型）seam 通用多提供方适配器。一个插件实例拥有一份以路由为键的提供方 profile 字典；每个请求使用 `GenerateOptions.provider` 选择 profile，并从 pi-ai 已安装 catalog 中动态解析 `GenerateOptions.model`。

包（package）根入口导出 Cordis 插件契约与 `PiAiAdapter`；profile 解析、模型构造、回放转换和流转换保留在包内部。

## 配置

按提供方配置凭据与部署特定传输设置，并以提供方路由本身为键。优先使用 `apiKeyEnv`——按请求解析的凭据*引用*——而非字面 `apiKey`，让机密不进入该文件。**两者**都省略，才会把认证委托给 pi-ai 的提供方原生环境发现；已配置却解析不出任何值的引用则相反，会让请求以 `MISSING_CREDENTIAL` 失败，因为放行下去就会用环境里恰好持有的某个无关密钥完成认证。`baseURL` 只会覆盖所选 catalog 模型的端点，保留其 API 家族与兼容性元数据，因此仍支持 `https://proxy.example.com:8443` 等私有 proxy。

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      openai:
        apiKeyEnv: OPENAI_API_KEY
        baseURL: https://proxy.example.com:8443
        reasoning: high
        retryPolicy:
          mode: normal
          maxRetries: 3
          backoff:
            initialDelayMs: 500
            maxDelayMs: 10000
            jitterRatio: 0.1
      anthropic:
        apiKeyEnv: ANTHROPIC_API_KEY
        streamIdleTimeoutMs: 300000
      openrouter:
        apiKeyEnv: OPENROUTER_API_KEY
        headers:
          X-Deployment: production
```

每个字典键都必须存在于 pi-ai 已安装 catalog 中；字典形状使重复项无法表示，发布前的数组形状（每个 profile 携带 `provider` 字段）会加载失败并给出迁移指引。`providers` 也可以为空或整体省略：适配器将以**休眠**姿态挂载——零路由、模型选择器不多一条——一旦 `llm-pi-ai:` settings 分节提供了 profile 就即时注册路由，分节清空时随之撤销。哪些适配器存在归组合面；哪些提供方在运行可以完全交给用户的设置文档。向 `ctx.llm` 注册具有原子性：如果与另一适配器已拥有的任何提供方路由冲突，插件会加载失败，不注册剩余路由。模型 id 不是生命周期配置；未知模型会在发起任何提供方请求前以 `LlmError('UNKNOWN_MODEL')` 失败。

## 动态配置（settings + credentials）

适配器经由一个 thunk **每操作读取一次** profile，而非在构造期冻结。插件在可选的 `ctx.settings` seam 上用同一份 `Config` schema 注册 `llm-pi-ai` namespace，并以其 `cordis.yml` 条目为组合 `base`；由于 `providers` 是字典，base 与用户的 `llm-pi-ai:` settings 分节**按提供方**合并：用户可以新增路由、覆盖组合路由的单个字段，或把路由指向另一个 proxy，全部在下一次请求生效，无需重启。未挂载 settings 服务时，仅由 entry 配置驱动适配器，行为不变。

凭据按每次 stream 调用解析：非空的字面 `apiKey` 优先，其次经可选的 `ctx.credentials` seam 解析 `apiKeyEnv`（活跃环境之下的 `$DSH_HOME/.env`；未挂载 seam 时恰好读取该环境变量）。只有完全没有点名任何凭据的 profile——仅限这一种情况——才交给 pi-ai 的环境发现。路由集合与每条路由捕获的重试策略是注册级事实：两者任一变化时，插件都会原子地替换自己的注册（同一适配器实例，候选集合先经校验），因此某条路由若已被另一适配器占有，先前的路由会继续服务，而改回可用配置时注册会重新生效。提供方键的顺序绝不算作变化。存活 settings 快照若点名未知提供方（或违反任何其他 resolver 约束），则保留最后可用 profile 并记录失败；entry 配置本身仍会使插件加载失败。

适配器通过 `ctx.llm.listModels(provider)` 公开每个已配置提供方已安装的 pi-ai 模型。这是从 `getModels(provider)` 派生的提供方无关 selector 元数据；请求时解析仍会执行权威 catalog 查找，因此发现不会创建第二个模型注册表。`ctx.llm.resolveModelInfo(provider, model)` 会执行一次精确 descriptor 查找，并返回其身份、上下文窗口和可选思考级别，让权威元数据保留在拥有路由的适配器上，而非消费方。

`reasoning.efforts` 列表是 pi-ai 有序的 `getSupportedThinkingLevels(model)` 结果，不经筛选或规范化，其中包括 `off`，以及模型对 `xhigh` 或 `max` 的特定支持。Harness 将每个规范 pi-ai 级别公开为不透明 ID；提供方／模型在协议格式中的表示仍保留在 pi-ai 的 `thinkingLevelMap` 中。因此，不具备推理（reasoning）能力的模型也会公开 pi-ai 的 `off` 选项。配置 profile 的 `reasoning` 值（包括 `off`）在存在时是部署默认值；省略它会保留提供方默认值。每次请求的 `GenerateOptions.reasoningEffort` 优先；任何未出现在确切模型能力中的显式值都会在网络 I/O 前以 `UNSUPPORTED_REASONING_EFFORT` 失败，而不会被自动调整。pi-ai 的通用流选项通过省略 `reasoning` 表示 `off`。

受支持的 profile 字段是 `apiKey`、`apiKeyEnv`、`baseURL`、`headers`、`reasoning`、`thinkingBudgets`、`cacheRetention`、`transport`、`timeoutMs`、`websocketConnectTimeoutMs`、`streamIdleTimeoutMs` 和 `retryPolicy`。每个 profile 的可选重试策略都会与该提供方路由一同捕获；省略时使用有界的常规默认值。流空闲间隔必须是正的有限 Node 定时器延迟，默认为五分钟，且只覆盖未完成提供方读取，不包括消费方思考时间。若已配置标头中有同名项，则以 Harness 应用归因为准。

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

单元测试使用重定向到本地 mock 服务器的 pi-ai catalog 模型，覆盖提供方／profile 路由、每次适配器调用只发起一个协议请求、idle-timeout 响应终止、调用方 abort、原生 API 选择、端点覆盖、归因、转换、回放状态验证，以及一个适配器实例内的跨提供方／模型回放。`tests/dynamic-config.spec.ts` 驱动真实的 settings-local 与 credentials-local provider：settings 里新生的路由实时完成注册，并在用户层重置时随之移除，`apiKeyEnv` 凭据在两次请求之间轮换，点名未知提供方的快照则保留最后可用 profile。`tests/loader-composition.spec.ts` 从仅测试用的 `cordis.yml` 出发，经真实 Loader 拉起休眠姿态，并从磁盘上的一次 `settings.yaml` 编辑注册出它的路由。真实 API 覆盖仍需 key 才会启用，并通过 `pnpm run test:e2e` 运行。

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

- **settings 能新增或覆盖路由，但不能移除组合路由**：用户层合并在组合 `base` 之上，因此删除 `cordis.yml` 提供的提供方属于组合变更；对该 namespace 执行 `replace` 只会重置用户层。
- **`apiKey` 已在 schema 中标注 `role('secret')`，但尚未在任何地方脱敏**：settings 的 `describe()` 信封原样返回值；负责对 secret 角色字段脱敏的 wire／UI 层将随 settings RPC 面一起交付。
- **必须属于 catalog**：已安装 pi-ai catalog 中不存在的自定义模型 id 会以 `UNKNOWN_MODEL` 失败，即使提供方 profile 配置了自定义端点。
- **不支持 `GenerateOptions.stop`**：pi-ai 的通用流选项无法保证所有提供方都支持 stop sequence，因此适配器会拒绝该字段。
- **历史中的 `system` 消息使用 pi-ai 通用上下文转换**：提供方特定位置由 pi-ai 决定，而非由 harness 拥有的协议覆盖决定。
- **无法获取提供方 HTTP 状态**：pi-ai 错误事件不会在所有提供方上公开稳定 HTTP 状态；失败只公开稳定 harness 错误 code。
- **重试策略由提供方持有，而不是 SDK 重试**：每个提供方 profile 都可以配置嵌套的 `retryPolicy`，由 `dsh-llm-retry` 在 agent 的失败步骤 seam 上执行；pi-ai SDK 重试仍保持禁用，因此持久化的 agent 步骤与 `llm/retry` 事件记录每次可见尝试，直接 `ctx.llm.stream()` 调用仍只尝试一次。
