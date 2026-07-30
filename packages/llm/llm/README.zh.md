# dsh-llm

[English](README.md) | 中文

提供方无关的 LLM（大语言模型）词汇与抽象服务。本包（package）定义 agent loop（智能体循环）、会话日志和每个插件使用的规范语言。

## 服务：`LlmService`（ctx key：`llm`）

一个适配器注册表加单一流式调用接口，可通过 waterfall（瀑布式事件）拦截。

### 公开 API

- `ctx.llm.registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle` 为给定提供方路由注册一个适配器实例。注册要么全部成功，要么全部不生效，并且会随调用 fiber 一起 dispose（资源释放）。返回的释放器还携带 `replace(providers)`：候选路由集合会在任何东西变动之前完整校验，因此与另一适配器冲突时，当前路由保持注册且继续服务，而替换本身是一个同步区段，不存在可观察的空档。`replace([])` 合法——一个持有零条路由的注册——这与空的初始注册不同。
- `ctx.llm.listProviders(): LlmProviderInfo[]` 按注册顺序描述已注册提供方路由。
- `ctx.llm.providerRetryPolicy(provider: string): ResolvedRetryPolicy` 返回注册时捕获的提供方重试策略，并解析 normal 默认值。
- `ctx.llm.listModels(provider: string): Promise<LlmModelInfo[]>` 发现某个已注册提供方当前公布的模型。
- `ctx.llm.resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>` 从拥有精确路由的适配器解析经校验的确切模型身份、可用上下文和推理（reasoning）元数据；异步适配器可选地支持取消。
- `ctx.llm.resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>` 校验显式推理强度，并填入适配器配置的默认值，但不自动调整。
- `ctx.llm.prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>` 解析配置并将其当前适配器注册捕获为一次可取消、一次性调用。
- `ctx.llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>` 将一次模型调用流式输出为原始分片（token 级增量）。消费方使用 `BlockAssembler` 将分片组装为块／消息。

`LlmService` 保留来自最终适配器选择、同步 dispatch、iterator 构造与迭代的错误，并将其溯源绑定到该次模型调用返回的精确流句柄。`isLlmAdapterFailure(stream, value)` 只报告该调用最终适配器边界的错误；`llmFailureOf(stream, value)` 返回关联的不可变 `LlmFailure`；`llmRetryPolicyOf(stream)` 返回在该边界选中的确切注册所对应的不可变策略，即使之后释放或替换路由也不变。未到达最终适配器的调用没有服务策略。嵌套模型调用、`llm/stream` middleware 和下游消费方失败对外层调用仍未分类。分类绝不替换或更改适配器原有的带代码 `Error`。

提供方与模型元数据是发现接口，不是路由白名单。`registerAdapter()` 仍拥有提供方排他性，并为每条路由捕获适配器的重试策略；适配器则可以接受 `listModels()` 中不存在的模型 id，消费方禁止因模型未列出而拒绝请求。返回的 selector 元数据与输入脱离，无效或重复适配器配置项会以 `INVALID_ADAPTER` 或 `INVALID_CATALOG` 失败。

确切模型元数据是独立的正确性查询，不是 catalog 装饰或全局 LLM 设置。`resolveModelInfo()` 会向拥有精确提供方／模型路由的适配器查询一次；适配器可以描述未列出的动态模型，缺少 `context` 或 `reasoning` 字段只表示相应能力不可用。无效的身份、上下文或推理元数据会以 `INVALID_MODEL_INFO`、`INVALID_MODEL_CONTEXT` 或 `INVALID_MODEL_REASONING` 失败。

推理标识符是由适配器持有的不透明字符串，而非核心枚举。适配器会公布有序可选列表；模型能力 API 提供 `off` id 时，列表也会包含它。`resolveCallConfig()` 只接受与已公布标识符完全一致的值，在存在 `defaultEffort` 时填入它，否则保留提供方默认值。异步模型解析器会接收调用方的 signal，并且必须在取消后迅速结束。`prepareCall()` 还会让精确适配器注册跨越请求头记录和最终分派，因此 HMR（热模块替换）不会将一个适配器的能力结果与另一个适配器的请求混用；复用其一次性句柄或更改调用配置字段会以 `INVALID_PREPARED_CALL` 失败。不支持的显式或配置推理强度会在提供方 I/O 前以 `UNSUPPORTED_REASONING_EFFORT` 失败。

### 事件

| 事件 | 模式 | 用途 |
|---|---|---|
| `llm/stream` | waterfall | 拦截／包装每次流式模型调用，用于缓存、日志或路由 |

### 扩展点

- 继承 `LlmAdapter` 并调用 `ctx.llm.registerAdapter(providers, adapter)`，添加一条或多条提供方路由。`GenerateOptions.provider` 选择适配器；`GenerateOptions.model` 属于适配器，可以动态解析。覆盖 `providerRetryPolicy()` 以提供由提供方持有的恢复配置，覆盖 `providerInfo()` 和异步 `listModels()` 以公开 selector 元数据；精确身份、容量或可选推理强度可用时，实现 `resolveModel()`；异步解析器必须响应其可选的取消 signal。默认实现使用有界的 normal 重试策略，将路由和模型 id 用作名称，不公布模型，也不返回容量或推理元数据。
- 包装 `llm/stream` 时，通过 `ctx.on()` waterfall listener 实现缓存、日志或路由。发出分片后重试的包装层没有持久尝试边界；因此已发布 agent 重试策略改用 `agent/request-error`。

### 消息（`message.ts`）与内容块（`types.ts`）

`Message` 是投递、持久历史和模型请求共享的不可变值。每条消息从创建起都必须具有 `MessageId`、角色、内容和带类型的来源。`createMessage(input)` 生成标识，并返回与输入分离且深度冻结的值；`createUserMessage({ content, source })` 固定 user 角色；`createAssistantMessage({ content, source })` 固定 assistant 角色与模型来源类别；`createToolResultMessage({ callId, content, isError })` 固定 user 角色，并将工具来源与其结果块耦合；`freezeMessage(message)` 导入已有标识，绝不将其替换。改写消息时会保留标识，并产生另一个冻结值。浏览器端代码会从依赖最少的 `@deepseek-ai/dsh-llm/message` 入口导入这些值构造函数，而不是从包含服务的包根入口导入。

消息内容是类型化内容块数组：`text`、`reasoning`、`tool-call`、`tool-result`。联合从可合并扩展的 `ContentBlockMap` 派生，因此插件可以通过 declaration merging 添加块类型。assistant 消息使用模型来源，其中携带提供方／模型溯源与可选适配器私有回放状态。dispatch 前，`LlmService` 只在历史提供方路由与目标提供方路由当前由完全相同的适配器实例拥有时才保留该状态；随后由适配器判定能否在模型／提供方间恢复或转换该状态。核心块集只包含每条已发布路径都支持的块。多模态内容（图像、音频等）没有核心块类型；需要它的功能会通过 map 添加，并一并添加相应的适配器／UI／压缩（compaction）支持。

流式输出是原始分片协议（`block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta`、`block-end`、`usage`、`finish`）。`BlockAssembler` 是将分片组装为块／消息的唯一共享实现。

### 调用配置（`call-config.ts`）

`LlmCallConfig` 是一个会话中各次请求的提供方、模型、可选的适配器持有推理强度和采样标量（`provider`、`model`、`reasoningEffort`、`temperature`、`maxTokens`、`stop`，每个都与同名 `GenerateOptions` 字段 1:1 映射）。它是作为请求标头一部分记录在会话日志中的每会话状态（见 dsh-session `request/header` 事件），绝不是可静默调整的每次调用旋钮：`agent/request` waterfall 会提议替换，`prepareCall()` 在轮次 signal 控制下校验并填入默认值，loop 随后记录生效值，再使用已准备调用中与注册绑定的流。`callConfigEquals(a, b)` 是逐字段真实变更检测器；`deepFreeze(value)` 是 loop 在 dispatch 前对每个已构建请求应用的所有权 helper（`llm/stream` listener 与适配器只读，绝不改写）。`markAgentLoopRequest()` 为该精确对象添加进程本地 loop 溯源，`isAgentLoopRequest()` 让观测方可以将其与同样可能冻结并关联会话、但独立记录的辅助调用区分。`GenerateOptions.purpose` 对已记录辅助压缩与会话标题调用分类，让适配器可以应用目的特定传输策略，而不改变普通会话请求。

### 应用归因（`attribution.ts`）

每个产品适配器都会在提供方 HTTP 请求上发送应用身份。`attributionHeaders(identity?)` 构建标准 `User-Agent`，默认为公开 `APP_IDENTITY`；白标部署可以替换它，但不能抑制它。适配器会直接验证 wire 标头，或通过自身库 hook 验证。详见 [归因 Agent Note（agent 决策记录）](../../../.agents/notes/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.md)。

### 类

- `LlmAdapter`：提供方适配器的抽象基类。唯一必需方法是 `stream()`。
- `BlockAssembler`：将原始分片逐步组装为完整内容块，并能据此创建带标识且冻结的 assistant 消息。agent loop 向它提供原始分片（同时记录以供回放），并读取已组装块以构建历史。
- `HarnessError`：harness 错误分类体系的基类，包含稳定 `code` 字符串（与面向人的 `message` 不同）加 `cause` 链接。它位于所有其他包都从中导入的叶子包中，因此可以共享单一基类，无需新的依赖边。各包的错误（`LlmError`、`ToolArgsError`、`InvariantError` 等）都继承自它。`isHarnessError(value)` 在 seam 处收窄类型。
- `LlmError`：继承自 `HarnessError`；其稳定 `code` 字符串（`NO_ADAPTER`、`DUPLICATE_ADAPTER` 与 `AUTH`／`RATE_LIMIT` 等适配器 code）与冻结可序列化 `failure.code` 匹配。Payload 还可以保留已验证状态、`Retry-After` 和品牌化提供方请求 id 事实；策略位于错误之外。
- `errorChain(value)`：渲染抛出值的完整 `cause` 链与 AggregateError 成员，供诊断表层使用，包括 UI 通知、logger 行和持久 `turn/end` 消息。因此 undici 的 `TypeError: fetch failed` 等传输包装层会显示底层 `ECONNREFUSED`／DNS／TLS 详细信息，而不是将其遮蔽。该函数只负责渲染：请按 `code` 路由，绝不解析结果。
- `CONTEXT_WINDOW_EXCEEDED_CODE`：当请求超过模型上下文窗口时，无论通过 HTTP 异常抛出还是带内 finish 交付，两个 DeepSeek 适配器都使用的提供方无关 code。`isContextWindowExceededError(detail)` 是它们针对 OpenAI 兼容提供方详细信息的共享保守分类器。
- `QUOTA_EXCEEDED_CODE`：帐户配额、余额、点数、预算或用量限制耗尽时使用的非短暂提供方无关 code。`isQuotaExceededError(detail)` 使这些失败与请求速率限制保持区分。
- `EMPTY_RESPONSE_CODE`：两个适配器都使用的提供方无关 code，用于表示退化的提供方生成结果：一个未携带任何内容块的终止 `stop`。它会被分类为错误 finish（而非成功空消息），因为尝试未产生持久内容；`dsh-llm-retry` 默认重试它。

### 真实适配器

两个适配器使用不同内部机制实现 `LlmAdapter`：[`@deepseek-ai/dsh-llm-deepseek`](../llm-deepseek) 针对 `deepseek` 路由使用直接 fetch 加 `eventsource-parser` SSE（Server-Sent Events）分帧，[`@deepseek-ai/dsh-llm-pi-ai`](../llm-pi-ai) 则通过 `@earendil-works/pi-ai` 动态解析已配置提供方／模型对。两者都遵循 `StreamChunk` 约定，定义见 `types.ts`：usage 先于 finish，工具参数保持原始字符串，错误使用两种已批准路径之一。设计理由见 [双 LLM 适配器](../../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md)。

## 模型体验

无。服务不添加任何与模型绑定的文本、schema 或消息；它只会填入并记录适配器配置的推理强度。

#### KV Cache 影响

透传；注册表保留已组装请求前缀，cache 复用与路由边界属于所选适配器和提供方。

## 已知限制与暂缓事项

- **本服务不执行重试、缓存或速率限制**：提供方注册会存储重试策略，但 `llm/stream` 仍是单次尝试调用包装 seam。agent loop 会将已验证模型请求失败单独提供给 `agent/request-error`，其默认行为是保留原始失败；`@deepseek-ai/dsh-llm-retry` 是共享示例主干加载的可选执行器。
- **`GenerateOptions` 采样只包含 `temperature`／`maxTokens`／`stop`**：没有 `tool_choice`、`top_p` 或 penalty 字段；有产生方落地时词汇才会增长（见 [已删除惰性旋钮](../../../.agents/notes/archived/simplification/2026-07-04-drop-inert-request-knobs.md)）。
- **受产生方约束的变体在实际产生前不会加入**：`prefill`、每工具 `strict`、块 `cache` 提示与 `agent` 消息源变体因没有产生方而被剪除（见 [Agent Note](../../../.agents/notes/archived/simplification/2026-07-04-prune-producerless-vocabulary-variants.md)）。
- **`BlockAssembler` 只处理核心块类型**：如果插件添加块类型的流从未由 `block-end` 关闭，`blocks()` 会抛出异常。
- **`APP_IDENTITY.url` 指向一个尚不存在的仓库**：`FIXME`：创建公开 `deepseek-ai/deepseek-harness-sdk` 仓库是首次发布的前置条件。
- **`GenerateOptions.sessionId` 是本地声明的品牌类型**：导入 dsh-session 的 `SessionId` 会产生循环；未来拥有 id 的包可以消除该权宜之计。
