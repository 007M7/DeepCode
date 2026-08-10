# Agent Note: 将工作流收缩至已使用的前台核心

Status: rejected — 工作流进度是有意设计的观测接口面；应通过消费方使其发挥作用，而非删除它。

[English](2026-07-12-collapse-workflow-to-foreground-core.md) | 中文

## 问题

工作流能力在执行句柄之外还携带一套只供观察的生命周期。脚本即使没有 UI 监听器也能完成，因此这套界面看似可删除；但它是唯一与提供方无关、能够报告真正开始过的成员、精确标签与阶段以及配对结果的事实来源。

顶层 `dsh-tool-workflow` 消费方现在利用这些事件，把四类最小 `tool-workflow/*` 事实写入调用方父 Session；`ui-workflow-run` 再把它们重建为持久 Chat 节点。投影由消费方拥有，因为只有它同时持有调用 Agent、知道工具执行是顶层还是嵌套，并能让记录故障与工作流执行隔离。`WorkflowRun.id` 与 `meta` 因此用于把实时引擎事件关联到该条精确持久记录，而不是复制展示状态。

删除事件词汇、成员标签或阶段、运行身份，会移除当前回放和导航结果，而不再只是清理未使用脚手架。下方提案继续记录应避免的收缩；[Chat 中的持久工作流运行](../../implemented/feature/2026-08-10-durable-workflow-runs-in-chat.md)拥有当前消费方与边界。

## 提案

保留已使用的核心：`agent(prompt, { schema, model })`、`parallel`、`pipeline`、`args`、并发/agent 上限、取消、有界 dispose（资源释放）、结构化结果、worker 隔离与前台工具收集。移除所有 `workflow/*` 事件及其仅供事件使用的 info/outcome 类型；移除 `phase()`、`log()`、agent 的 `label`/`phase`、phase 声明、`whenToUse` 及其 worker 消息/host 观测者；将工作流元数据收缩为工具实际使用的 name；移除仅供事件使用的 run id/meta 快照与合成的 agent-end 账本。将 `WorkflowRun` 收缩为 `result`、`cancel()` 和 `dispose()`；工具渲染请求方持有的 name。移除 `WorkflowStartRequest.signal` 及 worker host 的 input-signal listener/disarm 状态，保留调用方从其 abort signal 到 `run.cancel()` 的桥接。将 `WorkflowError` 变为单一的 fatal 错误类，不再有布尔模式或 `isFatalWorkflowError()` 辅助函数。

修订已实施的动态工作流 Agent Note，并更新 seam/工具/worker README、工具 schema、生成的 catalog 与包依赖图、worker type-equiv 记录、单元测试以及工作流快照/header fixture（测试前置数据）。如果进度 UI 工作被立项，应从一份命名了父 agent/会话/工具调用的关联约定出发，而非原样复活这套协议。

## 曾考虑的替代方案

**把持久记录移入工作流引擎。** 引擎知道运行与成员生命周期，却不拥有调用方父 Session，也不知道顶层与嵌套工具边界。把这些事实交给引擎会让提供方 seam 耦合到单一消费方，并使记录故障进入引擎执行域。由工具拥有的投影补齐了缺失所有权，同时不扩展 worker 消息或 service 合同。

## 验收标准

- 工作流公开约定仅包含有生产消费方的执行、取消、结果与 dispose 约定。
- 不再保留任何工作流事件、phase/log 协议消息、run-id 生成器、仅供进度使用的元数据、host 配对账本或 fatal 模式分支。
- run handle 不再有 id/meta 回显，取消在同步 `start()` 返回后只有一条持有者拥有的通道。
- parallel/pipeline 行为、上限、取消后的完全停稳、worker 隔离、结构化输出与面向模型的工作流场景保持测试覆盖。
- 类型检查、覆盖率、快照、doc-sync（文档同步门禁）、module-graph 校验、构建与 hygiene 全部通过。

## 风险

这是对工作流 DSL、事件分类体系、handle 与 start request 的编译可见收缩。现有提供描述性元数据的工作流调用，以及使用 `phase`、`log` 或 label 的脚本，都必须相应精简；程序化调用方需自行将 abort source 桥接到返回的 handle；未来的观测者必须添加一个关联性更好的事件约定。使工作流有用的执行语义不变。
