# RFC：将工作流收缩至实际使用的前台核心

Status: rejected — Workflow progress is an intentional observation surface; make it useful through a consumer instead of deleting it.

[English](2026-07-12-collapse-workflow-to-foreground-core.md) | 中文

## 问题

工作流能力执行前台 JavaScript 来编排 subagent，但它同时携带了一套无人消费的进度观测系统。没有任何生产环境的监听器订阅六个 `workflow/*` 事件中的任何一个；监听器仅存在于工作流测试中。尽管如此，seam 仍定义了 run/phase/agent outcome 载荷，worker 仍发送 phase/log/agent 生命周期协议消息，host 通过一个 `liveAgents` 配对账本转发它们，引擎维护 run id 的唯一目的就是关联这些通知。

这套进度词汇不仅未被使用，而且在不重新设计的情况下无法服务于它唯一的具名未来消费方。`WorkflowRunInfo` 包含 `{id, meta}` 但没有父 agent、会话或工具调用标识，而面向模型的工具从不暴露 run id。一个全局 ACP 监听器无法将事件路由到正确的客户端会话。`meta.phases` 从未被查询，`phase(title)` 不会对其做校验，phase 的 `detail`/`model` 和 agent 的 `label`/`phase` 只喂给事件，`whenToUse` 被校验和复制但从未被渲染或用于选择。`phase()` 和 `log()` 仍然跨越 worker 边界，尽管没有接收方。

live handle 在观察者消失后仍重复事件时代的数据。`WorkflowRun.id` 没有非事件消费方，而工具读取 `run.meta.name` 只是为了渲染一个它已经以 `args.meta.name` 形式持有的值；两者都不属于执行/取消 handle。

取消也为一个同步启动提供了两条公开通道。`WorkflowStartRequest.signal` 被传给 worker host，而唯一的生产调用方另外将同一个 signal 桥接到 `WorkflowRun.cancel()`。因为 `start()` 在控制权让出之前就返回了 run，不存在需要请求时取消的就绪窗口；重复的 signal 增加了 host 的 listener/disarm 状态却没有消除任何竞态。

`WorkflowError.fatal` 是同类投机分支的微缩版：每个生产环境的构造都是 fatal 的，`fatal: false` 仅存在于测试中，组合子已经通过 `instanceof` 区分工作流失败。

## 提案

保留实际使用的核心：`agent(prompt, { schema, model })`、`parallel`、`pipeline`、`args`、并发/agent 上限、取消、有界 dispose、结构化结果、worker 隔离，以及前台工具收集。移除所有 `workflow/*` 事件及其仅服务于事件的 info/outcome 类型；移除 `phase()`、`log()`、agent 的 `label`/`phase`、phase 声明、`whenToUse` 及其 worker 消息/host 观察者；将工作流元数据收缩为工具实际使用的 name；移除仅服务于事件的 run id/meta 快照以及合成的 agent-end 账本。将 `WorkflowRun` 收缩为 `result`、`cancel()` 和 `dispose()`；工具渲染请求方持有的 name。移除 `WorkflowStartRequest.signal` 及 worker host 的 input-signal listener/disarm 状态，保留调用方从自身 abort signal 到 `run.cancel()` 的桥接。将 `WorkflowError` 变为单一的 fatal 错误类，不再有布尔模式或 `isFatalWorkflowError()` 辅助函数。

修订已实施的动态工作流 RFC，并更新 seam/tool/worker README、工具 schema、生成的 catalog 与包依赖图、worker type-equiv 记录、单元测试，以及工作流快照/header fixture。如果未来委托进度 UI 工作，应从一份命名了父 agent/会话/工具调用的关联契约出发，而非原样复活此协议。

## 曾考虑的替代方案

**为未来 UI 保留预建的观测词汇。** 当前形状类似 Claude Code 的动态工作流元数据，host 有意地将每个转发的 agent start 与 worker 的 end 或合成的终端 end 配对。移除它意味着放弃形状兼容性，使进度 UI 成为一项全新的设计任务；但现有载荷仍然缺少可路由的归属信息，因此仅靠平衡的生命周期也无法在不重新设计的情况下让具名的 ACP 消费方可行。

## 验收标准

- 工作流公开 seam 仅包含有生产消费方的执行、取消、结果与 dispose 契约。
- 不再保留任何工作流事件、phase/log 协议消息、run-id 生成器、仅服务于进度的元数据、host 配对账本或 fatal 模式分支。
- run handle 不再有 id/meta 回显，取消在同步 `start()` 返回后只有一条持有者拥有的通道。
- parallel/pipeline 行为、上限、取消静默、worker 隔离、结构化输出以及面向模型的工作流场景保持覆盖率。
- 类型检查、覆盖率、快照、doc-sync、module-graph 校验、构建与 hygiene 全部通过。

## 风险

这是对工作流 DSL、事件分类体系、handle 与 start request 的编译可见收缩。现有提供描述性元数据的工作流调用，以及使用 `phase`、`log` 或 label 的脚本，必须相应精简；程序化调用方需自行将 abort 源桥接到返回的 handle；未来的观察者必须添加一个关联性更好的 seam。使工作流真正有用的执行语义不变。
