# DeepSeek Harness 架构

[English](architecture.md) | 中文

**DeepSeek Harness SDK** 基于 Cordis 构建 agent harness（智能体框架）。原则很简单：**一切皆插件**。内置的循环只是一个插件，不是特权内核。

## 概览

一个 harness 就是一个 [Cordis](cordis-primer.md) 上下文。各包（package）贡献服务键、类型化事件和可 dispose（资源释放）的注册：服务暴露稳定的调用（`ctx.llm`、`ctx.tools`、`ctx.sessions`），事件提供拦截与通知（`agent/request`、`tools/pre-execute`、`session/event`），注册则安装提示词段、工具、提供方、适配器或监听器。

`packages/core/` 组织了默认的 agent 流程；周边能力同样是一等的 Cordis 插件。

### 默认服务

| ctx 键 | 包 | 职责 |
|---|---|---|
| — | [`dsh-scope`](../packages/core/scope/README.md) | 作用域上下文注册原语（库） |
| `ctx.sessions` | `dsh-session` | 内存中事件溯源的会话 |
| `ctx.systemPrompt` | `dsh-system-prompt` | 有序提示词段、工具 schema 与提示词变量 |
| `ctx.tools` | `dsh-tools` | 工具注册表与[执行流水线](tool-execution-pipeline.md) |
| `ctx.agents` | `dsh-agent` | 活跃 agent 注册表、公开 `Agent` 句柄、`agent/*` 事件 |
| `ctx.agentLoop` | `dsh-agent-loop` | 内置 `ReactLoopAgent` 驱动器 |

### 能力服务

| ctx 键 | 包族 | 职责 |
|---|---|---|
| `ctx.llm` | [`llm/`](../packages/llm/README.md) | 适配器注册表与流式模型调用 |
| `ctx.bash` | [`bash/`](../packages/bash/README.md) | 前台/后台命令执行 |
| `ctx.sandbox` | [`sandbox/`](../packages/sandbox/README.md) | 同世界进程隔离（argv 包装、逐调用策略） |
| `ctx.codeRuntime` | [`code-runtime/`](../packages/code-runtime/README.md) | 模型编写的程序执行 |
| `ctx.fs` | [`fs/`](../packages/fs/README.md) | 文件系统提供方原语与策略事件 |
| `ctx.skills` | [`skill/`](../packages/skill/README.md) | skill（技能）提供方注册表与渐进式披露 |
| `ctx.web` | [`web/`](../packages/web/README.md) | 搜索/抓取提供方注册表 |
| `ctx.compact` | [`compact/`](../packages/compact/README.md) | 会话日志压缩（compaction） |
| `ctx.subagents` | [`subagent/`](../packages/subagent/README.md) | 命名委托提供方 |
| `ctx.workflows` | [`workflow/`](../packages/workflow/README.md) | 脚本驱动的多 agent 编排 |
| `ctx.sessionPersistence` | [`session-persistence/`](../packages/session-persistence/README.md) | 会话日志的持久化存储 |
| `ctx.sessionQuery` | [`session-query/`](../packages/session-query/README.md) | 活跃优先的逻辑语料库与精确事件读取 |

## 事件

事件构成服务扩展 API；详见完整的[事件目录](cordis-catalog/events.md)与[生产者/消费方映射](event-producer-consumer.md)。

### 事件域

- **会话事件**是持久的、可回放的事实。轮次与步骤边界、用户输入、助手输出、工具调用、工具结果、steering（中途引导）、压缩记录以及工具拥有的持久事实追加到会话日志，并流经 `session/event`。
- **Agent 事件**携带活跃的 `Agent` 句柄，用于状态、诊断、prompt 准入、调用配置塑形、结果校验与续行策略。
- **能力事件**归属于拥有该动作的 seam。`tools/*`、`llm/*`、`system-prompt/*`、`fs/*` 与 `subagent/*` 让策略和适配器无需导入循环即可接入。

### 拦截语义

waterfall（瀑布式事件）的行为类似 around 中间件：监听器通过调用 `next()` 委托下游；不调用 `next()` 直接返回即为否决或接管。完整规则见 [Cordis waterfall 语义](cordis-primer.md#cordis-waterfall-semantics)。

## 默认循环生命周期

内置循环消耗工作队列、组装请求、流式接收模型回答、执行工具、应用续行策略并持久化检查点。每一个暂停点都是一个服务调用或事件，可供插件介入。

**会话**是一个 agent 的仅追加事件日志。**轮次（turn）**消耗一批排队消息，运行到模型不再请求工具且没有插件要求续行为止。**步骤（step）**是一次模型请求加上该响应引发的工具执行。下面的流程中（[时序图伴侣文档](agent-lifecycle.md)），带引号的名称是持久化的会话事件，事件名称是扩展点。

### 轮次流程

```text
prepare private session + agent.ctx -> await unpublished setup
  -> enter session + agent -> session/created -> agent/created
  -> enable driving -> agent/session-start(source) -> start driver
forever:
  wait for queued messages
  emit agent/status(running)
  TURN:
    'turn/start'
    each queued message -> agent/prompt-submit
      allowed prompt -> 'user/message' plus injected context
    every prompt blocked -> 'turn/end'(rejected)
    STEP loop:
      drain steering
      assemble system prompt and tool schemas
      agent/session-prefix (first step)
      agent/pre-step
      'step/start'
      snapshot the derived messages (the reconstruction boundary)
      agent/request (config only) -> log request/header -> llm/stream (frozen)
        'assistant/chunk'
      agent/step-result
      'assistant/message'
      each tool call:
        'tool/call'
        tools/pre-execute -> monotonic guards -> tools/execute -> tools/post-execute -> tools/result
        'tool/result'
      append post-tool context and steering
      'step/end'
      agent/turn-continuation
      agent/turn-stop (terminal policy)
      stop unless tools or continuation policy ask for another step
    'turn/end'
    checkpoint persistence and notify idle/running status
```

循环每步骤渲染一次 prompt 组装。插件贡献有序段、工具 schema 与 `{{name}}` 变量；未知或无值的引用会使轮次失败，而非带着空洞发送。`dsh-system-prompt` 拥有 harness 身份与默认部署人格；agent 作用域的人格可以遮蔽默认值。循环提供 `model` 和 `cwd`。见 [prompt 所有权 RFC](rfc/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md)。

Post-tool 上下文在所有工具结果之后落入，以保持 tool-call/result 的邻接稳定。steering 在步骤之间排空；轮次结束后的普通剩余 steering 作为输入重新入队。终止性的 `agent/turn-stop` 是显式例外：它在普通续行与 steering 折叠之后运行，然后在轮次关闭和刷新期间保持权威，因此这些后续监听器产生的 steering 被丢弃而非成为新的步骤或轮次；普通排队的 prompt 则被保留。

### 失败边界

轮次是容错边界。抛出异常的监听器、适配器错误结束或失败的步骤会以错误原因结束当前轮次，并通过 `agent/error` 报告实时诊断；它不会杀死驱动循环。`cancel()` 清除排队与 steering 工作，在可能时中止活跃的模型/工具边界，并记录相应的轮次结束。dispose 停止循环、等待静默、注销 agent，并让服务 disposer 排空。

每个会话事件都被轮次包围。重新加载崩溃的会话时，系统保留中断的尾部并以合成的 `interrupted` 轮次结束关闭它。持久化轮次已关闭后的失败仅通过 `agent/error` 报告，因为已没有安全的轮次内位置。轮次以一个 `TurnEndReason` 结束（`completed`、`aborted`、`error`、`disposed`、`max-tokens`、`rejected` 或 `interrupted`）；各变体的语义见 [session.md § TurnEndReasonMap](core-data-structures/session.md#why-a-turn-ended-turnendreasonmap)。

### Agent 句柄

`ctx.agents` 拥有活跃 agent 并返回 `AgentHandle { agent, dispose() }`。`Agent` 是其他插件驱动的 API：`send()` 入队工作，`steer()` 注入轮次中内容，`inject()` 追加上下文并在空闲时开启一次性注入轮次，`cancel()` 是公开的停止原语，`whenIdle()` 观察静默状态。调用方 fiber 与具体工厂提供方在结构上共同拥有编程式生命周期；消费方句柄是唯一的非结构性拆卸能力，且每个所有者到达同一个被 await 的 disposer。

### Agent 作用域

每个活跃 agent 拥有一个作用域化的 `agent.ctx`。其注册遮蔽同名全局注册，只接收该 agent 的派发，并随 agent 一起解除。`CreateAgentOptions.setup(agentCtx)` 在发布前组合作用域。[语义门禁 RFC](rfc/implemented/process/2026-07-14-typescript-program-backed-semantic-gates.md) 定义了类型化解析器，从合并的 `Events` 签名与 `scopeTarget` 派生载体检查，消除了手写事件表。见 [agent 作用域 RFC](rfc/implemented/architecture/2026-07-08-agent-scope-contexts.md)；subagent 组合控制另行记录于[此](rfc/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md)。

## 状态

### 会话日志

会话日志是真源。`deriveMessages()` 将会话事件投影为发送给模型的 `Message[]`；原始 `assistant/chunk` 事件留在日志中用于回放和 UI 保真。回放、fork、恢复、transcript（文本记录）渲染、遥测和持久化都从同一事件流派生。

**模型可见 ⟺ 已记录**：日志能重建每次请求——`step/start` 处的消息前置 header 的会话前缀，header 通过折叠 `request/header` 得出——开发不变式对此做断言（[可重建性 RFC](rfc/implemented/architecture/2026-07-05-reconstructable-requests.md)）。

持久性是插件关注点。持久化后端缓冲同步的 `session/event` 通知，循环在轮次结束检查点完成后才继续。`SessionPersistence` seam 直接存储 `SessionEvent`，元数据在 `SessionHeader` 中；JSONL 与 SQLite 共享同一套契约测试。

### 模型内容

消息是类型化内容块（`text`、`reasoning`、`tool-call`、`tool-result`）的数组。联合类型派生自可合并扩展的 `ContentBlockMap`；同一模式也用于 `MessageSource`、`FinishReason`、`TurnTrigger` 与 `TurnEndReason`。新的块类型需要跨适配器、UI 桥接、压缩计价与持久化协调，因此块类型仍是仓库级契约。

流式输出是原始分片协议（从 `block-start` 到 `finish`），`BlockAssembler` 是共享的 chunk 到 block 组装器。循环在组装分片以供派发的同时记录原始 chunk。`LlmAdapter` 是提供方 seam：继承它、实现 `stream()`、用 `ctx.llm.registerAdapter(models, adapter)` 注册。StreamChunk 约定见 [llm-streaming.md](core-data-structures/llm-streaming.md)。

## 扩展与组合

### 能力模式

一个可替换的能力通常拆分为**接口 / 实现 / 消费方**：接口拥有其 `ctx` 键与事件，实现注册后端，消费方通过工具或 prompt 暴露模型行为。Bash 是参考实现；[能力图](capability-seams.md)展示了每个族。

部分 seam 有意偏离模板。LLM（大语言模型）将接口与消费方词汇放在一起，因为适配器就是实现。文件系统在提供方原语周围添加策略门禁。Web 是一个服务加搜索/抓取两个提供方注册表，因此提供方替换不会重命名模型工具。skill 与 subagent 使用命名提供方注册表；本地 skill 扫描项目/用户根目录，其他提供方可以在不改动注册表/工具的情况下添加嵌入式或远程目录。subagent 可以全新 spawn、从父级已完成轮次的前缀 fork，或使用 ACP 子进程（[subagent.md](core-data-structures/subagent.md)）。

### Bundle 与应用

`dsh-agent-spine-demo` 是默认的组合 bundle：一个插件加载共享主干（[README](../packages/examples/agent-spine-demo/README.md)）。应用包将其与前端入口和启动 `bin` 组合：`dsh-stdio-demo` 用于终端 REPL，`dsh-acp-demo` 用于基于 JSON-RPC stdio 的 ACP（无 stdout logger）（[ui/](../packages/ui/README.md)）。`dsh-jsonrpc-agent` 则启动外部 `cordis.yml`；Python SDK 在未设置显式配置通道时注入包默认值，并通过行分隔的 stdio JSON-RPC 驱动 `dsh-jsonrpc`（[Python SDK](../python/README.md)）。一个部署就是一片薄薄的 `cordis.yml` 叶子：可替换的后端、一个应用入口和可选的产品工具（[examples/](../examples/AGENTS.md)、[可运行接线](cookbook/extension-cookbook.md#runnable-wirings)、[关系图索引](graph-atlas.md)）。

### 新行为的归属

新行为应接入已记录的扩展点；修改内置循环需要同步更新本映射。

| 目标 | 机制 |
|---|---|
| 添加模型提供方 | 在 `ctx.llm` 上注册适配器 |
| 添加面向模型的能力 | 在 `ctx.tools` 上注册工具；schema 流入 prompt 组装 |
| 添加命令执行 | 实现并注册 `ctx.bash` 后端 |
| 添加文件系统访问或策略 | 实现 `ctx.fs` 提供方或监听 `fs/*` 策略事件 |
| 隔离 spawn 的进程 | 一个 `ctx.sandbox` 后端；消费方在 spawn 前包装 argv |
| 拦截 prompt、请求、工具使用或续行 | 监听相关的 `agent/*` 或 `tools/*` waterfall；使用串行 `agent/turn-stop` 实现单调终止 |
| 添加历史之外的会话稳定请求前缀 | 在 `agent/session-prefix` 上组合，每个循环实例一次；记录在请求 header 上 |
| 添加 UI 或编辑器集成 | 驱动 `ctx.agents` 并从 `session/event` 渲染 |
| 添加持久化会话状态 | 添加 `SessionEventMap` 成员并从日志渲染/回放 |
| fork 活跃会话 | 使用 `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| 将工具、prompt 段或监听器限定到单个 agent | 通过该 agent 的 `agent.ctx` 注册（见 Agent 作用域） |

[扩展实操手册（cookbook）](cookbook/extension-cookbook.md)提供插件骨架与功能到 seam 的映射；分步指南覆盖[包](cookbook/adding-a-package.md)、[工具](cookbook/adding-a-tool.md)、[LLM 适配器](cookbook/adding-an-llm-adapter.md)与[vendor 包](cookbook/adding-a-vendored-package.md)。

## 快速参考
- 领域术语见[术语表](glossary.md)
- 类型定义见 [core-data-structures/](core-data-structures/core.md)
- 精确的事件与服务签名见[事件目录](cordis-catalog/events.md)
- [服务目录](cordis-catalog/services.md)
- 包契约见[包映射](../packages/README.md)
- [RFC](rfc/README.md)
