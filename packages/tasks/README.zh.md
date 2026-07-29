# tasks/：后台任务能力家族

[English](README.md) | 中文

这是后台任务 id、所有者隔离、读取、取消、等待和完成通知的共用归属位置。Bash、subagent（子 agent）及未来的长时间运行工具共用一套面向模型的协议。参见[后台任务运行时 Agent Note（agent 决策记录）](../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md)和[任务注册表 seam Agent Note（agent 决策记录）](../../.agents/notes/implemented/architecture/2026-07-26-task-registry-seam.md)。

| 包（package） | ctx 键 | 角色 |
|---|---|---|
| [`tasks`](tasks/README.md)（`@deepseek-ai/dsh-tasks`） | `ctx.tasks` | 注册表 seam：带品牌类型的 `<kind>-N` id、按所有者隔离的读取／终止／等待／列出契约、快照词汇、`attachSurface` 配置错误防线，以及快照不变式配套项 |
| [`tasks-local`](tasks-local/README.md)（`@deepseek-ai/dsh-tasks-local`） | 无 | 进程内注册表实现：内存记录、以首次结算为准的簿记，以及会等待执行完毕的所有者清理路径和销毁路径 |
| [`tool-tasks`](tool-tasks/README.md)（`@deepseek-ai/dsh-tool-tasks`） | 无 | 面向模型的控制接口：`task_output`、`task_list`、`task_kill`、完成通知注入和后台工作习惯提示词段落 |

生产方或接口重载时，状态仍由注册表持有；工具包负责呈现。生产方通过 `ctx.tasks.start` 注册执行钩子，并自行决定其配置是否公开 `run_in_background`。
