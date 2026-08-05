# workflow/：动态工作流能力族

[English](README.md) | 中文

工作流 seam：由模型编写 JavaScript 编排脚本，大规模扇出 subagent（分阶段、每个 agent（智能体）的结构化结果、并发上限），其设计参考 Claude Code 动态工作流。这是 bash 形态的能力 seam（见[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)）：每个上下文只有一个引擎实现注册为 `ctx.workflows`；面向模型的工具使用它。

| 包 | 角色 | ctx 键 |
|---|---|---|
| `workflow/` | 抽象工作流 seam：服务基类、运行词汇和 `workflow/*` 事件 | `ctx.workflows` |
| `workflow-workerthread/` | `node:worker_threads` 引擎：每次运行使用一个 worker；脚本的 vm 上下文位于 worker 内，`agent()` 通过消息端口桥接到 `ctx.subagents` | （提供 `ctx.workflows`） |
| `tool-workflow/` | 面向模型的 `workflow` 工具，基于 `ctx.workflows` | （注册到 `ctx.tools`） |
| `tool-ralph/` | 基于 `ctx.workflows` 和全新结构化输出 subagent 提供方的固定全新 agent Ralph 策略 | （注册到 `ctx.tools`） |

接口位于 `workflow/workflow/`。引擎的 `agent()` 钩子使用 [subagent seam](../subagent/README.md)（任何已注册提供方；随产品交付的示例使用 `spawn`），`agent({ schema })` 则使用进程内后端实现的结构化输出支持。worker thread 隔离的是脚本：宿主绝不会被它阻塞，已取消运行经过宽限时间后的终止也会实际生效；但它不是安全边界。如果将来确有需要，可以在同一接口背后换用 isolated-vm／独立进程引擎，以实现真正的沙箱隔离。

通用脚本引擎的决策和暂缓事项见[动态工作流 Agent Note](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md)。独立的 [Ralph 消费方](../../.agents/notes/implemented/feature/2026-07-19-fresh-agent-ralph-workflow-tool.md)会固定脚本和全新提供方策略，而不是再添加一个引擎或 agent loop（智能体循环）模式。
