# RFC：裁剪无用的公开接口与结果面

Status: proposed

[English](2026-07-04-prune-dead-core-spine-surface.md) | 中文

## 问题

若干包根导出、结果字段和便利方法没有生产消费方。它们之所以存活，要么是因为测试通过公开入口导入内部实现，要么是因为某个类型预设了一个从未出现的调用者。每一项单独看都很小，但合在一起，它们扩大了 SDK 契约、生成的目录、文档和回归矩阵，却没有支撑任何已交付的路径。

生产语料库是 `packages/*/*/src`、示例源码/配置和运行时脚本。测试、package README 和 RFC 行文是发布的证据，但不是固定的调用者。`cordis_inspect` 使 `packages/cordis/tool-cordis/src/api-catalog.ts` 对模型可见，`cordis_mount` 可以通过受保护的真实服务代理调用注入的服务，因此被编目的服务方法和返回形状是真正的动态产品面。下表因此区分了「没有固定的仓库内调用者」与「不可达」：涉及编目词汇的行有意收缩模型编写的 mount 所能发现和调用的内容，而包根的实现辅助函数并不通过该服务门面可达。精确符号搜索得出以下清单：

| 接口面 | 生产证据 | 简化方式 |
| --- | --- | --- |
| `SurfaceManager.invalidate()` | 仅其单元测试调用；seeding 在惰性创建的 manager 存在之前就已完成，且会话从不替换其日志引用。 | 删除该方法及其不可能触发的整体替换契约。 |
| `ToolExecutionResult.callId` | 每个钩子已经接收不可变的 `ToolExecution`；循环和 ACP（Agent Client Protocol）通过 call/session 事件关联。没有消费方读取这个重复的结果字段。 | 移除该字段、复制/不匹配守卫，以及证明该重复不会不一致的测试。 |
| `ReactLoopAgent` 根导出 | 包外的具名导入都是测试；生产代码面向 `Agent` 编程，通过 `ctx.agents` 创建/恢复。 | 返回/接口类型为 `Agent`，将具体循环类设为包内部；保留有意为之的同步纯配置 `AgentLoop.create()` 路径。 |
| `workflow-workerthread` 的 protocol/runtime/session 再导出与具名 `WorkerWorkflowEngine` | 所有包名消费方使用默认引擎；workflow RFC 已将 worker 协议格式定义为私有。 | 保留默认插件类/配置契约；移除重复的具名类导出，将协议模块设为源码私有。 |
| `code-runtime-worker` 的 protocol/bootstrap 再导出 | 包外的生产/e2e 消费方使用 `WorkerCodeRuntime` 和配置，而非 `BootstrapPort`、`PatchableStream` 或 worker 消息/启动类型。 | 保留运行时类/配置契约，将其协议格式/bootstrap 词汇设为源码私有。 |
| ACP 的 translation/presenter 根导出 | `agentOptions`、`streamSessionEventUpdate`、`todosToPlan`、`ToolPresenter`、`nullToolPresenter` 和 `TerminalRendering` 仅有同文件或 ACP 测试消费方；唯一的包外生产消费方挂载的是插件命名空间。 | 保留 `name`、`inject`、`Config`、`AcpConfig` 和 `apply`；将 translation/presentation 辅助函数设为源码私有，在包内测试。 |
| `providerWording` 和 `completedTurnPrefix` 根导出 | 各有一个同包生产调用者；仅 balanced-prefix 辅助函数有一个同包白盒测试。 | 设为源码私有，通过 provider 行为测试。 |
| `depthOf`、`SubagentDepthError`、`SENSITIVE_ENV_PATTERN`、`waitForExit` 和 `exitsWithin` 根导出 | 生产 subagent 后端消费的是进程内 runner 和子进程构造/释放辅助函数，而非这些强制/测试内部实现。 | 保留深度/环境/退出行为，但将辅助函数和 error/regex 设为源码私有；通过 spawn 和释放来测试。 |
| `PersistenceCoordinator.inits`、后端 `inits` 访问器、`seedCoversPrefix` 和 `assertSerializable` | 访问器为白盒测试而存在；`seedCoversPrefix` 没有包外生产导入者；`assertSerializable` 没有生产调用者，且与 coordinator append 边界的无损快照重复。 | 通过 `session/flush` 观察初始化，将 `seedCoversPrefix` 设为源码私有，删除 `assertSerializable`。保留两个后端、`SessionHeader` 和 SQLite 的版本契约。 |
| `LlmError.status` 与 replay status | 适配器/replay 填充它，但生产分支基于稳定的 error code/message，从不读取原始 status。 | 移除未读字段和 replay 管道，同时保留错误分类。 |
| `BlockAssembler.push()` 返回值 | 两个生产调用者都忽略返回的已完成块。 | 返回 `void`；保留有意公开的 `blocks()`/`message()` 契约。 |
| `compactRegion` 的独立 `session` 参数 | 固定调用者传入的对象与 `agent.session` 已经是同一个；模型可见的 mount API 也能调用该方法，但接受两个身份允许挂载的插件提供不一致的配对。 | 保留手动区域 seam，同时有意将其收窄为以 `agent.session` 为唯一真源。 |
| `CompactionResult.startSeq`、`summarySeq`、`endSeq` 和 `summary` | 生产消费方只读取 shadowed range/seq/token 统计；持久日志拥有摘要和事件标识。 | 移除四个结果回显，同时保留两个共享的 transcript（文本记录）渲染器。 |
| `BasicCompactService` 的 estimation/summarization 可见性 | 没有包外生产调用者调用这五个方法；已实现的 RFC 仅将 `estimateContentTokens()` 和 `summarize()` 列为子类钩子。 | 将这两个方法设为 `protected`，将三个仅用于编排的估算器设为 private。 |
| `CodeLogEntry.source`/`level` 和 `RunCodeMeta.dispatches` | 所有生产消费方将日志映射为文本；没有 presenter/模型路径读取其他字段或持久化的 dispatch 计数。 | 将 code-runtime 日志改为字符串（或纯文本条目），移除 result-meta dispatch 管道；保留用于生成确定性 dispatch id 的本地计数器。 |
| `ToolNotFoundError.toolName`、`SystemPrompt.config` 和 `BashTask.command` | 每个存储的公开值都没有生产读取者。 | 移除未读字段，同时保留错误消息、已解析的配置行为和任务生命周期。 |
| 后端包根实现辅助函数 | 下方精确清单仅通过相对同包导入调用。生产命名空间导入挂载的是保留的插件契约，不读取这些属性；具名根消费方是测试。 | 保留每个适配器/提供方/服务及其配置/错误契约；停止在包根导出所列辅助函数/常量。 |
| 消费方包根实现辅助函数 | 下方精确清单仅有同包生产调用者。生产命名空间导入挂载插件契约，不读取辅助属性；具名根消费方是测试。 | 保留插件契约和稳定错误码；将测试移至包内模块或公开行为，停止在包根导出所列辅助函数。 |

### 分组辅助导出清单

- `dsh-llm-deepseek`：`httpErrorCode`、`serializeMessages`、`serializeRequest`、`DONE`、`parseSse`、`mapFinishReason`、`mapUsage` 和 `translate`；`dsh-llm-pi-ai`：`buildModel`、`mapStopReason`、`mapUsage`、`toPiContext` 和 `toStreamChunks`。
- `dsh-bash-local`：`DEFAULT_GRACE_MS`、`ENV_OVERRIDES`、`killGroup`、`OutputCollector` 和 `runBash`；`dsh-bash-sandbox`：`shellQuote`、`classifyDenial` 和 `classifyRunnerFailure`；`dsh-sandbox-local`：`bwrapProfileArgs`、`landlockProfileArgs` 和 `seatbeltProfileArgs`。公开的可变测试注入字段及其类型不在本提案范围内。
- `dsh-fs-local`：`applyLiteralEdit`、`listDirectory`、`probe`、`readForEdit`、`readTextForDiff`、`readWholeText`、`resolveLocalTarget`、`restoreLineEndings`、`streamWholeText` 和 `writeFileAtomic`。
- `dsh-web-fetch-local`：`classifyContentType`、`decoderForCharset`、`isSameOrigin`、`parseCharset` 和 `validateFetchUrl`；`dsh-web-search-exa`：`mapExaResponse` 和 `mapExaResult`；`dsh-web-search-deepseek`：`citationSnippets` 和 `mapAnthropicResponse`；`dsh-web-search-perplexity`：`mapPerplexityResponse` 和 `mapPerplexityResult`。
- `dsh-tool-fs`：`READ_LIMIT`、`STREAM_MIN_SIZE`、`READ_MAX_BYTES`、`READ_MAX_LINE_LENGTH`、`DIFF_CONTEXT`、`applyReadTool`、`parseReadArgs`、`applyWriteTool`、`formatWriteOutput`、`parseWriteArgs`、`applyEditTool`、`formatEditOutput`、`parseEditArgs`、`buildWindow`、`formatReadOutput`、`computeHunkDiffs` 和 `diffsFromMeta`。
- `dsh-tool-web`：`WEB_SEARCH_MAX_RESULTS`、`applyWebSearchTool`、`formatSearchOutput`、`parseSearchArgs`、`presentSearchCall`、`applyWebFetchTool`、`formatFetchOutput`、`parseFetchArgs`、`presentFetchCall`、`renderBody` 和 `htmlToMarkdown`；`dsh-timeout-policy`：`toolTimeoutResult`；`dsh-compact-basic`：`resolveConfig`；`dsh-tool-bash`：`renderResult`。

## 提案

以一次有界的、协调的公开接口面清理，移除或降级上述每一行。更新 package README、JSDoc、生成的 API/事件目录、type-equiv 记录、必要时的 exports map 以及测试，使测试通过所属的公开 seam 来验证行为，而非保留仅为测试而存在的入口点。不折叠任何能力 seam、LLM（大语言模型）适配器、持久化后端或生命周期静默契约。

## 曾考虑的替代方案

**保留测试便利函数和自包含结果字段为公开。** 公开辅助函数可以让白盒测试更方便，自包含的结果字段看起来更符合人体工学，未来的嵌入者可能需要具体循环类或枚举方法。这些好处是假设性的；今天它们让每一处实现和文档都要解释没有已交付调用者能观察到的状态。真正的消费方可以引入它所需的最小契约，其所有权和失败语义已知。

**为模型编写的 mount 保留所有编目成员。** 自引用工具集是一条真实的通用消费路径，而非生成文档的噪音。然而，它的价值来自准确、可组合的服务面，而非无限期保留重复字段或不一致的参数对；上述每一项编目收缩都移除了在同一次执行、agent（智能体）或结果上其他位置已可获得的事实，并在同一个变更中更新 API 参考。

## 验收标准

- 精确符号搜索显示被移除的接口面不出现在本 RFC 和任何已实现 RFC 修正案之外。
- 本 RFC 列出的每一项接口面均已按指定方式移除或降级；清单之外有意保留的扩展/测试契约不受影响。
- 工具执行、压缩（compaction）、两个 LLM 适配器、两个持久化后端、工作流隔离以及 agent 创建/恢复保持其已交付行为。
- 类型检查、覆盖率、快照、doc-sync（文档同步门禁）、module-graph 校验、构建和 hygiene 全部通过。

## 风险

大多数移除在编译时可见但运行时无影响。压缩参数清理有意禁止 session/context 不匹配，同时保留手动区域 seam。外部预发布嵌入者和现有模型编写的 mount 可能导入更少的辅助函数、传入更少的参数或接收更窄的结果形状；这是有意的产品接口面收缩，而非仅仅是生成目录的清理。仓库尚未发布，因此承载不受支持的接口面才是更大的基础成本。
