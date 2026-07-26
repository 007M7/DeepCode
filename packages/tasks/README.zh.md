# tasks/：后台任务能力包族

[English](README.md) | 中文

后台 task id、拥有者隔离、读取、取消、等待和完成通知的共用归属位置。Bash、subagent 及未来的长时间运行工具共用一套面向模型的协议。参见[后台任务运行时 Agent Note（agent 决策记录）](../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md)和[任务注册表 seam Agent Note](../../.agents/notes/implemented/architecture/2026-07-26-task-registry-seam.md)。

| 包（package） | ctx 键 | 角色 |
|---|---|---|
| [`tasks`](tasks/README.md)（`@deepseek-ai/dsh-tasks`） | `ctx.tasks` | 注册表 seam：品牌化 `<kind>-N` id、按拥有者设防的 read／kill／wait／list 契约、快照词汇、防止 `attachSurface` 配置错误的防线，以及快照不变式配套插件 |
| [`tasks-local`](tasks-local/README.md)（`@deepseek-ai/dsh-tasks-local`） | 无 | 进程局部的注册表实现：内存记录、首次结果优先的结算簿记，以及等待完成的拥有者清理与拆卸路径 |
| [`tool-tasks`](tool-tasks/README.md)（`@deepseek-ai/dsh-tool-tasks`） | 无 | 面向模型的控制接口：`task_output`、`task_list`、`task_kill`、完成通知注入和后台工作习惯提示词段落 |

注册表拥有跨生产方或接口重载的状态；工具包拥有呈现。生产方通过 `ctx.tasks.start` 注册执行钩子，并自行决定其配置是否公开 `run_in_background`。
