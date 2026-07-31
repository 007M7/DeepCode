# DeepSeek Harness 架构

[English](architecture.md) | 中文

**DeepSeek Harness SDK** 使用 Cordis：**一切皆插件**，循环也不例外。

## 概览

每个 harness 都是 [Cordis](cordis-primer.md) 上下文；各包（package）贡献服务、类型化事件和可释放的注册项。

`packages/core/` 汇集默认的 agent（智能体）流程；各项功能仍以插件形式存在。

### 默认服务

| ctx 键 | 包 | 职责 |
|---|---|---|
| — | [`dsh-scope`](../packages/core/scope/README.md) | 作用域上下文注册项与共享层存储（库） |
| `ctx.sessions` | `dsh-session` | 内存中的事件溯源会话 |
| `ctx.systemPrompt` | `dsh-system-prompt` | 有序的稳定系统提示词片段、缓存安全的动态上下文、工具 schema 和变量 |
| `ctx.tools` | `dsh-tools` | 工具注册表和[执行流水线](tool-execution-pipeline.md) |
| `ctx.agents` | `dsh-agent` | 活跃 agent、委托创建、`agent/*` 事件、进程内发起方作用域 |
| `ctx.agentLoop` | `dsh-agent-loop` | 实体 `Agent` 驱动器 |

### 功能服务

| ctx 键 | 包族 | 职责 |
|---|---|---|
| `ctx.llm` | [`llm/`](../packages/llm/README.md) | 适配器注册表和模型流式调用 |
| `ctx.tokenMeter` | [`llm/token-meter`](../packages/llm/token-meter/README.md) | 感知回放的单实例请求压力与表面压力 |
| `ctx.bash` | [`bash/`](../packages/bash/README.md) | 前台和后台命令执行 |
| `ctx.subprocess` | [`subprocess/`](../packages/subprocess/README.md) | 供 bash、LSP 与 ACP subagent 后端使用的受管子进程树 |
| `ctx.pty` | [`pty/`](../packages/pty/README.md) | 按 owner 隔离的持久化终端会话 |
| `ctx.sandbox` | [`sandbox/`](../packages/sandbox/README.md) | 通过 argv 包装和逐调用策略限制同一执行环境内的进程 |
| `ctx.sandboxPolicy` | [`sandbox/`](../packages/sandbox/README.md) | 共享沙箱策略归属点 |
| `ctx.codeRuntime` | [`code-runtime/`](../packages/code-runtime/README.md) | 执行模型编写的程序 |
| `ctx.fs` | [`fs/`](../packages/fs/README.md) | 文件系统提供方原语和策略事件 |
| `ctx.lsp` | [`lsp/`](../packages/lsp/README.md) | 语义导航注册表 |
| `ctx.skills` | [`skill/`](../packages/skill/README.md) | skill（技能）提供方注册表和渐进式披露 |
| `ctx.web` | [`web/`](../packages/web/README.md) | 搜索与抓取提供方注册表 |
| `ctx.compact`，`ctx.toolResultPrune` | [`compact/`](../packages/compact/README.md)/[`compact-tool-result-prune`](../packages/compact/compact-tool-result-prune/README.md) | 摘要压缩（compaction）和可选的无模型结果裁剪 |
| `ctx.subagents` | [`subagent/`](../packages/subagent/README.md) | 具名委托提供方 |
| `ctx.planMode` | [`plan/`](../packages/plan/README.md) | 落日志的 plan 协作状态 |
| `ctx.tasks` | [`tasks/`](../packages/tasks/README.md) | 后台任务注册表和通用 `task_*` 控制 |
| `ctx.workflows` | [`workflow/`](../packages/workflow/README.md) | 脚本驱动的多 agent 编排 |
| `ctx.goals` | [`goal/`](../packages/goal/README.md) | 持久化的同会话目标 |
| `ctx.sessionPersistence` | [`session-persistence/`](../packages/session-persistence/README.md) | 会话日志的持久化存储 |
| `ctx.sessionQuery` | [`session-query/`](../packages/session-query/README.md) | 基于 SQLite 全文搜索的实时优先精确检索／过滤／追踪、经工作区授权的模型工具 |
| `ctx.sessionTitle` | [`session-title/`](../packages/session-title/README.md) | 基于日志的回退标题和单个可选异步提供方 |
| `ctx.settings` | [`settings/`](../packages/settings/README.md) | 按插件划分的用户设置命名空间，分层叠加在装配条目之上 |
| `ctx.credentials` | [`credentials/`](../packages/credentials/README.md) | 具名密钥引用，按操作解析，绝不内联进配置 |
| `ctx.directoryPicker` | [`host/directory-picker`](../packages/host/directory-picker/README.md) | GUI 宿主目录选取（`native`／`browse` 交互） |
| `ctx.typert` | [`typert/registry`](../packages/typert/registry/README.md) | 生成的包反射和实时 Zod schema 的运行时注册表 |
| `ctx.invariants` | [`support/invariants`](../packages/support/invariants/README.md) | 按包名筛选包自有运行时检查的注册表 |

## 事件

事件就是服务的扩展 API（[目录](cordis-catalog/events.md)、[生产方与消费方映射](event-producer-consumer.md)）。

### 事件域

- **会话事件**是通过 `session/event` 发出的持久日志事实。
- **Agent 事件**携带活跃 `Agent`，用于状态、提示词准入、请求塑形、验证和续跑。
- **功能事件**让所属服务边界无需导入循环即可附加策略和适配器。

### 拦截语义

waterfall（瀑布式事件）是环绕中间件：监听器通过 `next()` 委托；不调用它而直接返回会否决或接管（[语义](cordis-primer.md#cordis-waterfall-semantics)）。

## 默认循环生命周期

**会话**采用仅追加方式。普通**轮次**领取一项已排队的 `send()` 输入；注入不领取输入。后续轮次会等待前一轮次的检查点，但可以与其共用同一个 `running` 区间（[决策](../.agents/notes/implemented/simplification/2026-07-17-one-send-one-turn.md)）。模型或插件停止轮次时，该轮次结束；一个**步骤**包含一次模型请求及其工具。[下文时序](agent-lifecycle.md)中的引号标记持久事件。

创建时若未提供 id，流程会生成 `<config-id>-session-<uuid>`；`sessionId` 用于恢复或创建会话，而 `resumeSessionId` 要求已有历史。恢复流程在发布前还原沿袭关系和委托深度。初始化失败会发出 `agent-loop/config-start-failed`；拆卸过程保持静默。

### 轮次流程

```text
choose declarative identity and fresh/resume path
  -> prepare private session + agent.ctx -> await unpublished setup
  -> enter session + agent -> session/created -> agent/created
  -> enable driving -> agent/session-start(source) -> start driver
forever:
  wait for queued occurrence
  claim (edit/remove end) -> emit agent/status(running) if starting an interval
  open the next-step acceptance window
  -> agent/prompt-submit
    blocked or failed prompt -> close the window without opening a turn
      append a context-only caller batch immediately
      keep steering and context staged beside it pending for a later admitted turn
    allowed prompt:
      'turn/start'
      append prompt + additional contexts as separate 'user/message' events
    STEP loop:
      agent/step
      drain injected context and steering (steering bypasses prompt-submit)
      assemble system prompt and tools
      materialize changed runtime context as sourced 'user/message'
      snapshot the derived messages (the reconstruction boundary)
      'step/start'
      agent/request (config only) -> prepare adapter defaults/provenance + context capacity under turn signal -> log request/header (+ request/context on route change) -> llm/stream (frozen, registration-bound)
      'assistant/chunk'
      'assistant/message'
      schedule tool calls by ctx.tools.executionMode:
        exclusive -> barrier
        parallel -> rolling pool, <= maxParallelToolCalls; reclassify-at-start; scheduler failure -> stop starts, drain dispatches
        start -> 'tool/call' -> ordered tools/pre-execute -> concurrent tools/execute
        model-order result -> ordered tools/post-execute -> 'tool/result'
      drain accepted tool context and steering
      'step/end'
      continue for tools or steering unless a result concluded the turn
      otherwise agent/turn-stopping -> drain -> continue only for steering
    close the next-step acceptance window
    'turn/end' -> agent/settled
  start the next waking queued message, or emit agent/status(idle)

idle inject:
  append 'user/message'
  do not open a turn or run the model
```

每个步骤都会组装有序的稳定系统提示词片段、缓存安全的动态上下文、工具 schema 和变量；未知引用会使该轮次失败。`dsh-system-prompt` 负责身份和角色设定；循环提供 `provider`、`model` 和 `cwd`（[提示词归属](../.agents/notes/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md)）。

接纳期间和活跃轮次内的 `inject()` 会为下一步骤暂存；工具执行后的 `additionalContexts` 会在结果记录完毕后落定。steering 与其共用这一暂存边界，并请求再执行一个步骤。空闲状态下的 `inject()` 会立即追加，且不改变轮次编号；持久化层会尽快排空。

裁剪先于摘要；溢出重试必须取得持久进展。`agent/request-error` 可以在失败步骤与轮次关闭之间授权一个重试轮次；取消优先。适配器拥有的 `retryPolicy` 使 normal mode 保持有界；always mode 先委托专门恢复，再持续重试直至成功或取消（[压缩](../.agents/notes/implemented/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md)、[重试基础](../.agents/notes/implemented/architecture/2026-06-21-bounded-llm-request-recovery.md)、[提供方策略](../.agents/notes/implemented/feature/2026-07-24-provider-retry-policies.md)）。

### 失败边界

适配器故障会先关闭自身步骤，再由 `agent/request-error` 接收准确的 `Error`、标准化的 `LlmFailure` 和信号。已处理的失败会关闭所在轮次，并从持久历史开启重试轮次，不发出空闲通知；重试耗尽则留下终态 `turn/end`。失败分片既不提交消息，也不提交工具调用。

其他故障使用 `agent/error`。取消和资源释放优先于恢复。在提交请求头之前，轮次信号会取消异步模型能力准备；尚未分派的工具会得到合成的 `tool/call`/`ABORTED_BEFORE_DISPATCH` 对。实际生效的 `cancel(cause)` 在清空队列和中止前发出原因；观察方不能否决；空闲调用不发事件。持久化层将用户或父级取消记录为 `aborted`，拆卸记录为 `disposed`；拆卸会等待完全停稳。原因只影响报告方式，不影响延迟完成的结果上下文处理（[决策](../.agents/notes/implemented/architecture/2026-07-16-explicit-turn-cancellation.md)）。

轮次和步骤事件均位于轮次边界内。空闲 `user/message` 与独立的 `compact/* { turn: null }` 不占用轮次；其锁定时刻标记可以与注入交错。重新加载会为中断的轮次合成结束事件；`session/end-seed` 区分陈旧的压缩遗留项与活跃锁。关闭后仅由 `agent/error` 报告故障。每个轮次有一个 [TurnEndReason](core-data-structures/session.md#why-a-turn-ended-turnendreasonmap)。

### Agent 句柄

`ctx.agents` 拥有 agent，返回 `AgentHandle { agent, dispose() }`。插件使用 `send()`，或使用 `followup()`、`steer()` 和 `inject()` 预设；[`reserveTurnAdmission()`](../packages/core/agent/README.md#agent-interface-typests) 为持久工作同步预留空闲状态，同时不改变排队提示词身份。`cancel()` 与 `whenIdle()` 控制生命周期。需等待完成的资源释放负责拆卸。

### Agent 作用域

每个 agent 都拥有作用域化的 `agent.ctx`；共享存储会将其工具、提示词和命令条目叠加到全局条目之上，同时保留各领域视图（[决策](../.agents/notes/implemented/architecture/2026-07-12-scoped-layers-store.md)）。作用域监听器会过滤分派；贡献都会在撤销时等待清理完成。`CreateAgentOptions.setup(agentCtx)` 在发布前完成组合。类型化解析器从合并后的 `Events` 和 `scopeTarget` 推导载体检查（[语义门禁](../.agents/notes/implemented/process/2026-07-14-typescript-program-backed-semantic-gates.md)）。详情见 [agent 作用域](../.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md)和 [subagent 组合](../.agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md)。`AgentLoop` 在 `ctx.agents.withInitiator()` 内运行；私有编排会派生 `agent.session`，但轮次、步骤、信号、cwd 和权限仍保持显式（[决策](../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.md)）。

## 状态

### 会话日志

会话日志是权威依据。`deriveMessages()` 投影出模型历史；原始 `assistant/chunk` 事件保证回放和 UI 保真。fork、恢复、transcript（文本记录）渲染、遥测和持久化均派生自该事件流。

**模型可见 ⟺ 已记录**：在 `step/start` 之前，循环会将完整的当前运行时上下文快照作为一条带来源的 `user/message` 追加，随后对派生消息制作快照。这些消息与折叠后的 `request/header` 可以重建每个请求。该 header 会标记适配器默认值，使后续提议丢弃这些值并重新解析路由，同时不丢失显式设置。`dsh-agent-loop/invariant` 通过 `ctx.invariants` 断言这一点（[可重建性](../.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md)）。

持久性由插件负责。后端会尽快排空同步的 `session/event` 通知。`session/flush` 屏障位于每次请求与顶层工具分发之前，并在 `turn/end` 之后、处理另一个已排队轮次或观察到空闲状态之前执行。`SessionPersistence` 直接存储 `SessionEvent`，并将元数据存入 `SessionHeader`；JSONL 默认采用带校验和的 Zstandard，SQLite 遵循同一契约（[决策](../.agents/notes/implemented/bug-fix/2026-07-21-semantic-session-checkpoints.md)）。

在轮次之间，事件所有方通过 `Session` 追加纯日志事件，仅为持久性而刷写。`session/title` 需要尽快持久化与生命周期排空；手动压缩会在释放轮次接纳预留前 flush 其标记对。标题工作绝不延迟响应；最新标题按后写覆盖并携带来源信息。标题记录是可继承的 fork 边界（[决策](../.agents/notes/implemented/feature/2026-07-21-log-backed-session-titles.md)）。

### 模型内容

消息使用从可合并扩展的 `ContentBlockMap` 派生的类型化块；同一模式也为 `MessageSource`、`FinishReason`、`TurnTrigger` 和 `TurnEndReason` 定义类型。新增块会协调适配器、UI、压缩、token 计量和持久化；回放计量见 [token-meter.md](core-data-structures/token-meter.md)。

流式输出使用原始分片和 `BlockAssembler`。每次 `LlmAdapter.stream()` 调用代表一次提供方尝试；适配器报告标准化的故障事实，负责处理的 `agent/request-error` 插件会返回重试动作。循环会记录分片、成功结果的来源信息和回放状态。远程适配器使用逐次读取空闲看门狗。回放仅通过共用的适配器实例跨路由传递（[契约](core-data-structures/llm-streaming.md)）。

## 扩展与组合

### 功能模式

可替换功能通常具有**接口／实现／消费方**三层：服务和事件、后端、面向模型的工具和提示词。Bash 是参考实现；[功能图](capability-seams.md)映射了每个包族。

例外情况包括 LLM（大语言模型）合并接口和消费方、文件系统整合策略、web 使用注册表、skill 和 subagent 使用具名提供方。subagent 可以通过 spawn 创建全新实例、fork 一个已完成轮次的前缀，或使用 ACP（Agent Client Protocol）子 agent（[subagent.md](core-data-structures/subagent.md)）。

`dsh-workspace-context` 在第一次 `agent/step` 注入基线，并通过 `tools/post-execute` 追加 `ctx.fs` 发现的变更；其[决策](../.agents/notes/implemented/feature/2026-06-24-workspace-context.md)记录隔离方式。`dsh-paths` 负责共享路径。

### 组合包与应用

`dsh-agent-spine-demo` 组合一套主干和可选目标。应用包负责 TUI、CLI（命令行界面）、ACP 自动化入口和 JSON-RPC 入口（[README](../packages/examples/agent-spine-demo/README.md)、[acp/](../packages/acp/README.md)、[ui/](../packages/ui/README.md)）。`dsh-jsonrpc-agent` 启动外部 `cordis.yml`；Python SDK 在配置缺失时提供默认项（[Python SDK](../python/README.md)）。轻量部署使用可替换后端和可选工具（[examples/](../examples/AGENTS.md)、[可运行接线](cookbook/extension-cookbook.md#runnable-wirings)、[图谱](graph-atlas.md)）。

### 新行为的归属位置

新行为附加到已有文档记录的扩展点；循环发生变更时，本架构图随之更新。

| 目标 | 机制 |
|---|---|
| 添加模型提供方 | 在 `ctx.llm` 上注册其适配器 |
| 添加面向模型的功能 | 在 `ctx.tools` 上注册；schema 加入提示词组装 |
| 添加 shell 执行 | 实现并注册 `ctx.bash` 后端；本地后端通过 `ctx.subprocess` 生成进程 |
| 添加持久化终端执行 | 注册 `ctx.pty` 后端和 `dsh-tool-pty` |
| 添加用户命令 | 在 `ctx.commands` 上注册；适配器无需模型轮次即可发现并分派 |
| 添加后台工作 | 在 `ctx.tasks` 上注册；通用 `task_*` 工具负责收集或停止 |
| 添加文件系统访问或策略 | 实现 `ctx.fs` 提供方，或监听 `fs/*` 策略事件 |
| 限制生成的进程 | 使用 `ctx.sandbox` 后端；消费方在生成前包装 argv |
| 拦截请求、工具或轮次 | 使用相应的 `agent/*` 或 `tools/*` 事件；`agent/turn-stopping` 是停止边界 |
| 添加模型可见上下文 | 调用 `agent.inject()`，追加带来源的 `user/message`，但不创建轮次 |
| 添加 UI 或编辑器集成 | 驱动 `ctx.agents`，从 `session/event` 渲染；仅终端浮层使用 `ctx.tui` |
| 添加持久会话状态 | 扩展 `SessionEventMap`；从日志渲染和回放 |
| 添加异步会话标题生成 | 注册唯一的 `ctx.sessionTitle` 提供方 |
| 管理同会话目标 | 使用 `ctx.goals`；通过 `Agent` 和 `agent/*` 续跑 |
| fork 活跃会话 | 调用 `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| 将注册项限定到单个 agent | 使用其 `agent.ctx`（参见 Agent 作用域） |

[扩展实操手册（cookbook）](cookbook/extension-cookbook.md)提供插件骨架和功能到服务边界的映射；指南涵盖[包](cookbook/adding-a-package.md)、[工具](cookbook/adding-a-tool.md)、[LLM 适配器](cookbook/adding-an-llm-adapter.md)和 [vendored 包](cookbook/adding-a-vendored-package.md)。
