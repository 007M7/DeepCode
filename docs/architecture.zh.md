# DeepSeek Harness 架构

[English](architecture.md) | 中文

**DeepSeek Harness SDK** 使用 Cordis：**一切皆插件**，循环也不例外。

## 概览

每个 harness 都是一个 [Cordis](cordis-primer.md) 上下文，由各包（package）贡献服务、类型化事件和可释放的注册项。

`packages/core/` 汇集默认的 agent（智能体）流程；各项功能仍以插件形式存在。

### 默认服务

| ctx 键 | 包 | 职责 |
|---|---|---|
| — | [`dsh-scope`](../packages/core/scope/README.md) | 作用域上下文注册与共享层存储（库） |
| `ctx.sessions` | `dsh-session` | 内存中的事件溯源会话 |
| `ctx.systemPrompt` | `dsh-system-prompt` | 有序提示词片段、工具 schema 和提示词变量 |
| `ctx.tools` | `dsh-tools` | 工具注册表和[执行流水线](tool-execution-pipeline.md) |
| `ctx.agents` | `dsh-agent` | 活跃 agent、委托创建、`agent/*` 事件和进程内发起方作用域 |
| `ctx.agentLoop` | `dsh-agent-loop` | 实体 `Agent` 驱动器 |

### 功能服务

| ctx 键 | 包族 | 职责 |
|---|---|---|
| `ctx.llm` | [`llm/`](../packages/llm/README.md) | 适配器注册表和模型流式调用 |
| `ctx.tokenMeter` | [`llm/token-meter`](../packages/llm/token-meter/README.md) | 感知回放的单实例请求压力和会话表面压力 |
| `ctx.bash` | [`bash/`](../packages/bash/README.md) | 前台和后台命令执行 |
| `ctx.pty` | [`pty/`](../packages/pty/README.md) | 按 owner 隔离的持久化终端会话 |
| `ctx.sandbox` | [`sandbox/`](../packages/sandbox/README.md) | 同一执行环境内的进程限制（argv 包装、逐调用策略） |
| `ctx.sandboxPolicy` | [`sandbox/`](../packages/sandbox/README.md) | 共享沙箱策略归属点 |
| `ctx.codeRuntime` | [`code-runtime/`](../packages/code-runtime/README.md) | 执行模型编写的程序 |
| `ctx.fs` | [`fs/`](../packages/fs/README.md) | 文件系统提供方原语和策略事件 |
| `ctx.lsp` | [`lsp/`](../packages/lsp/README.md) | 语义导航注册表 |
| `ctx.skills` | [`skill/`](../packages/skill/README.md) | skill（技能）提供方注册表和渐进式披露 |
| `ctx.web` | [`web/`](../packages/web/README.md) | 搜索与抓取提供方注册表 |
| `ctx.compact`，`ctx.toolResultPrune` | [`compact/`](../packages/compact/README.md)/[`compact-tool-result-prune`](../packages/compact/compact-tool-result-prune/README.md) | 摘要压缩（compaction）；可选的无模型结果裁剪 |
| `ctx.subagents` | [`subagent/`](../packages/subagent/README.md) | 具名委托提供方 |
| `ctx.planMode` | [`plan/`](../packages/plan/README.md) | 落日志的 plan 协作状态 |
| `ctx.tasks` | [`tasks/`](../packages/tasks/README.md) | 后台任务注册表和通用 `task_*` 控制工具 |
| `ctx.workflows` | [`workflow/`](../packages/workflow/README.md) | 脚本驱动的多 agent 编排 |
| `ctx.goals` | [`goal/`](../packages/goal/README.md) | 持久化的同会话目标 |
| `ctx.sessionPersistence` | [`session-persistence/`](../packages/session-persistence/README.md) | 会话日志的持久存储 |
| `ctx.sessionQuery` | [`session-query/`](../packages/session-query/README.md) | 实时优先的逻辑语料精确读取和关系追踪 |
| `ctx.sessionTitle` | [`session-title/`](../packages/session-title/README.md) | 基于日志的回退标题和单个可选异步提供方 |
| `ctx.invariants` | [`support/invariants`](../packages/support/invariants/README.md) | 按包名选择包自有运行时检查的注册表 |

## 事件

事件构成服务的扩展 API；完整清单见[事件目录](cordis-catalog/events.md)和[生产方与消费方映射](event-producer-consumer.md)。

### 事件域

- **会话事件**是追加到日志并通过 `session/event` 发出的持久事实。
- **Agent 事件**携带活跃 `Agent`，用于状态、提示词准入、请求塑形、验证和续跑。
- **功能事件**让所属服务边界无需导入循环即可附加策略和适配器。

### 拦截语义

waterfall（瀑布式事件）的行为类似环绕中间件：监听器调用 `next()` 即表示委托，直接返回而不调用它则会否决或接管。完整规则见 [Cordis waterfall 语义](cordis-primer.md#cordis-waterfall-semantics)。

## 默认循环生命周期

已交付的循环通过插件服务和事件，处理从提示词到检查点的工作。

**会话**采用仅追加方式。每个普通**轮次**领取一项已排队的 `send()` 输入；注入不领取输入。后续轮次会等待前一个已领取轮次的检查点，但可以与其共用同一个 `running` 区间（[决策](../.agents/notes/implemented/simplification/2026-07-17-one-send-one-turn.md)）。模型和插件停止轮次时，该轮次结束；一个**步骤**包含一次模型请求及其工具。在[下文时序](agent-lifecycle.md)中，引号标记持久事件。

未提供 id 时，创建流程会生成 `<config-id>-session-<uuid>`；`sessionId` 用于恢复或创建会话，而 `resumeSessionId` 要求已有历史。恢复流程在发布前还原沿袭关系和委托深度。初始化失败会发出 `agent-loop/config-start-failed`；拆卸过程保持静默。

### 轮次流程

```text
choose declarative identity and fresh/resume path
  -> prepare private session + agent.ctx -> await unpublished setup
  -> enter session + agent -> session/created -> agent/created
  -> enable driving -> agent/session-start(source) -> start driver
forever:
  wait for a queued message
  emit agent/status(running)
  TURN:
    'turn/start'
    claimed message + contexts -> agent/prompt-submit
      allowed prompt -> 'user/message' with prompt-prefix context baked in; append separate contexts
      blocked prompt -> 'prompt/blocked' -> 'turn/end'(rejected)
    STEP loop:
      drain steering with the same prefix/separate context placement (no prompt-submit)
      assemble system prompt and tool schemas
      agent/session-prefix (first step)
      agent/pre-step
      snapshot the derived messages (the reconstruction boundary)
      'step/start'
      agent/request (config only) -> log request/header -> checkpoint -> llm/stream (frozen)
      on final adapter-path or terminal in-band failure:
        'step/end'
        agent/request-error(original error, failure facts, immutable prior failures, signal)
        retry in the next numbered step or preserve the original error
      otherwise:
        'assistant/chunk'
        agent/step-result
        'assistant/message' (transformed content or empty success anchor after step-result rejection)
        schedule tool calls by ctx.tools.executionMode:
          exclusive -> one-call barrier
          parallel -> rolling pool, <= maxParallelToolCalls in flight; reclassify before start
          each start -> 'tool/call' -> ordered tools/pre-execute -> checkpoint -> concurrent tools/execute
          each model-order result -> ordered tools/post-execute -> 'tool/result'
        append accepted tool-batch context after all recorded results, then steering
        agent/post-step -> checkpoint complete response/results
        'step/end'
        agent/turn-continuation
        agent/turn-stop (terminal policy)
        stop unless tools or continuation policy ask for another step
    'turn/end'
    checkpoint persistence and notify idle/running status
```

每个步骤都会组装有序提示词片段、工具 schema 和变量；未知引用会使该轮次失败。`dsh-system-prompt` 负责身份和角色设定，循环则提供 `model` 和 `cwd`（[提示词归属](../.agents/notes/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md)）。

工具执行阶段的上下文，包括异步 `inject()` 和工具执行后的 `additionalContexts`，会在结果产生后稳定。steering（中途引导）会在 `agent/post-step` 前排空；该事件会观察持久输出、结果、上下文和 steering。余留内容进入队列。终止型 `agent/turn-stop` 在关闭和刷写期间始终具有最终决定权；后续 steering 会被丢弃，排队提示词仍予保留。

裁剪先于摘要；溢出重试必须取得持久进展。有界的瞬态重试在 `agent/request-error` 上组合；取消优先（[压缩](../.agents/notes/implemented/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md)、[重试](../.agents/notes/implemented/architecture/2026-06-21-bounded-llm-request-recovery.md)）。

### 失败边界

适配器故障会先关闭步骤，再进入 `agent/request-error`；该事件会收到准确的 `Error`、`LlmFailure` 和历史记录。重试会开启另一个步骤；成功会清除历史记录；重试耗尽后，故障存入 `turn/end`。失败分片不会提交消息或工具。

其他故障使用 `agent/error`。取消和资源释放均优先于恢复；尚未分派的工具调用会得到合成的 `tool/call`/`ABORTED_BEFORE_DISPATCH` 对。轮次信号会在 `turn/end` 前失效。实际生效的 `cancel()` 会在清空队列和中止前发出类型化原因；观察方不能否决该操作，空闲状态下的调用不发出任何事件，持久化会记录 `aborted`。dispose（资源释放）会等待系统停稳（[决策](../.agents/notes/implemented/architecture/2026-07-16-explicit-turn-cancellation.md)）。

会话事件均位于轮次边界内。重新加载会用合成的 `interrupted` 轮次结束事件闭合中断的日志尾部。关闭后的故障只通过 `agent/error` 报告；此时已没有安全的轮次内位置。每个轮次有一个 `TurnEndReason`；各变体由 [TurnEndReasonMap](core-data-structures/session.md#why-a-turn-ended-turnendreasonmap) 统一定义。

### Agent 句柄

`ctx.agents` 拥有活跃 agent，并返回 `AgentHandle { agent, dispose() }`。插件使用 `send()`、`steer()`、`inject()`、`cancel()` 和 `whenIdle()`。调用方 fiber、工厂提供方和消费方句柄通过同一个需等待完成的 disposer 共同拥有拆卸过程。

### Agent 作用域

每个 agent 都拥有一个作用域化的 `agent.ctx`；共享存储会在全局工具、提示词和命令条目之上叠加作用域条目，同时保留各领域视图（[决策](../.agents/notes/implemented/architecture/2026-07-12-scoped-layers-store.md)）。作用域监听器会过滤分派，每项作用域贡献都会在撤销时等待清理完成。`CreateAgentOptions.setup(agentCtx)` 在发布前完成组合。类型化解析器从合并后的 `Events` 和 `scopeTarget` 推导载体检查（[语义门禁](../.agents/notes/implemented/process/2026-07-14-typescript-program-backed-semantic-gates.md)）。参见 [agent 作用域](../.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md)和 [subagent 组合](../.agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md)。`AgentLoop` 在 `ctx.agents.withInitiator()` 内运行；私有编排会派生 `agent.session`，而轮次、步骤、信号、cwd 和权限仍保持显式（[决策](../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.md)）。

## 状态

### 会话日志

会话日志是权威依据。`deriveMessages()` 投影出模型历史；原始 `assistant/chunk` 事件留在日志中，以保证回放和 UI 保真。fork、恢复、transcript（文本记录）渲染、遥测和持久化均派生自同一个事件流。

**模型可见 ⟺ 已记录**：日志可以重建每个请求，包括由请求头会话前缀置于开头的 `step/start` 时消息，以及通过折叠 `request/header` 得到的请求头；开发期不变量会断言这一点（[可重建性](../.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md)）。

持久性由插件负责。后端会缓冲同步的 `session/event` 通知。语义检查点策略会在适配器分发前刷写请求，在工具分发前刷写已记录的顶层调用，并在 `agent/post-step` 刷写完整的响应与结果批次；循环仍保留最终的轮次结束检查点。`SessionPersistence` 直接存储 `SessionEvent`，并将元数据存入 `SessionHeader`；JSONL 默认采用带校验和的 Zstandard，SQLite 则遵循同一契约（[决策](../.agents/notes/implemented/bug-fix/2026-07-21-semantic-session-checkpoints.md)）。

`ctx.sessions.appendOutOfBand()` 会把插件所属的纯日志事件加入开放轮次，或创建一个平衡且已刷写的零步骤轮次。`session/title` 按后写覆盖方式折叠，并携带源 seq 和来源信息；其即时回退标题和唯一可选异步提供方都不会延迟 agent 响应。fork 会继承标题（[决策](../.agents/notes/implemented/feature/2026-07-21-log-backed-session-titles.md)）。

### 模型内容

消息使用从可合并扩展的 `ContentBlockMap` 派生的类型化块；`MessageSource`、`FinishReason`、`TurnTrigger` 和 `TurnEndReason` 也采用同一模式定义类型。新增块会协调适配器、UI、压缩、token 计量和持久化；回放计量见 [token-meter.md](core-data-structures/token-meter.md)。

流式输出使用原始分片和 `BlockAssembler`。每次 `LlmAdapter.stream()` 调用代表一次提供方尝试；适配器报告事实，`agent/request-error` 负责恢复。循环会记录分片及成功结果的来源信息和回放状态。远程适配器使用逐次读取空闲看门狗。只有当路由共用同一个适配器实例时，回放状态才会跨路由传递（[契约](core-data-structures/llm-streaming.md)）。

## 扩展与组合

### 功能模式

可替换功能通常拆分为**接口／实现／消费方**：服务和事件、后端，以及面向模型的工具和提示词。Bash 是参考实现；[功能图](capability-seams.md)映射了每个包族。

例外情况会合并不同层次：LLM（大语言模型）合并接口和消费方，文件系统整合策略，web 使用注册表，skill 和 subagent 使用具名提供方。subagent 可以通过 spawn 创建全新实例、fork 一个已完成轮次的前缀，或使用 ACP（Agent Client Protocol）子 agent（[subagent.md](core-data-structures/subagent.md)）。

`dsh-workspace-context` 在 `agent/session-prefix` 上组合基线，并在通过 `ctx.fs` 发现嵌套变更后，于 `tools/post-execute` 追加这些变更；其[决策](../.agents/notes/implemented/feature/2026-06-24-workspace-context.md)记录了隔离方式。`dsh-paths` 负责共享路径。

### 组合包与应用

`dsh-agent-spine-demo` 组合一套主干和可选目标。应用包负责 TUI、单次运行的 CLI（命令行界面）以及 ACP/JSON-RPC 入口（[README](../packages/examples/agent-spine-demo/README.md)、[ui/](../packages/ui/README.md)）。`dsh-jsonrpc-agent` 启动外部 `cordis.yml`；Python SDK 仅在没有显式配置时提供默认项（[Python SDK](../python/README.md)）。轻量部署使用可替换后端和可选工具（[examples/](../examples/AGENTS.md)、[可运行接线](cookbook/extension-cookbook.md#runnable-wirings)、[图谱](graph-atlas.md)）。

### 新行为的归属位置

新行为附加到已有文档记录的扩展点；循环发生变更时，本架构图随之更新。

| 目标 | 机制 |
|---|---|
| 添加模型提供方 | 在 `ctx.llm` 上注册适配器 |
| 添加面向模型的功能 | 在 `ctx.tools` 上注册；schema 进入提示词组装流程 |
| 添加 shell 执行 | 实现并注册 `ctx.bash` 后端 |
| 添加持久化终端执行 | 注册 `ctx.pty` 后端和 `dsh-tool-pty` |
| 添加用户命令 | 在 `ctx.commands` 上注册；适配器无需模型轮次即可发现并分派该命令 |
| 添加后台工作 | 在 `ctx.tasks` 上注册；通用 `task_*` 工具负责收集或停止 |
| 添加文件系统访问或策略 | 实现 `ctx.fs` 提供方，或监听 `fs/*` 策略事件 |
| 限制生成的进程 | 使用 `ctx.sandbox` 后端；消费方在生成进程前包装 argv |
| 拦截请求、工具或轮次 | 使用相应的 `agent/*` 或 `tools/*` 事件；`agent/turn-stop` 是串行终止判定点 |
| 添加历史记录之外的会话稳定前缀 | 组合 `agent/session-prefix`；请求头会记录该前缀 |
| 添加 UI 或编辑器集成 | 驱动 `ctx.agents` 并从 `session/event` 渲染 |
| 添加持久会话状态 | 添加一个 `SessionEventMap` 成员，并从日志渲染和回放 |
| 添加异步会话标题生成 | 在 `ctx.sessionTitle` 上注册唯一提供方 |
| 管理同会话目标 | 使用 `ctx.goals`；通过 `Agent` 和 `agent/*` 续跑 |
| fork 活跃会话 | 使用 `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| 将注册项限定到单个 agent | 使用该 agent 的 `agent.ctx`（参见 Agent 作用域） |

[扩展实操手册（cookbook）](cookbook/extension-cookbook.md)提供插件骨架和功能到服务边界的映射；分步指南涵盖[包](cookbook/adding-a-package.md)、[工具](cookbook/adding-a-tool.md)、[LLM 适配器](cookbook/adding-an-llm-adapter.md)和 [vendored 包](cookbook/adding-a-vendored-package.md)。

## 快速参考
- [术语表](glossary.md)中的领域术语
- [core-data-structures/](core-data-structures/core.md) 中的类型定义
- [事件](cordis-catalog/events.md)和[服务](cordis-catalog/services.md)目录中的准确签名
- [包索引](../packages/README.md)中的包契约
- [Agent Note（agent 决策记录）](../.agents/notes/README.md)
