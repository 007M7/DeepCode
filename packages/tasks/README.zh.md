# tasks/：后台任务能力包族

[English](README.md) | 中文

后台 task id、拥有者隔离、读取、取消、等待和完成通知的共用归属位置。Bash、subagent 及未来的长时间运行工具共用一套面向模型的协议。参见[后台任务运行时 Agent Note（agent 决策记录）](../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md)。

| 包（package） | ctx 键 | 角色 |
|---|---|---|
| [`tasks`](tasks/README.md)（`@deepseek-ai/dsh-tasks`） | `ctx.tasks` | 注册表服务：品牌化 `<kind>-N` id、按拥有者设防的 read／kill／wait／list、结算记账、等待完成的拥有者清理路径，以及防止 `attachSurface` 配置错误的防线 |
| [`tool-tasks`](tool-tasks/README.md)（`@deepseek-ai/dsh-tool-tasks`） | 无 | 面向模型的控制接口：`task_output`、`task_list`、`task_kill`、完成通知注入和后台工作习惯提示词段落 |

注册表拥有跨生产方或接口重载的状态；工具包拥有呈现。生产方通过 `ctx.tasks.start` 注册执行钩子，并自行决定其配置是否公开 `run_in_background`。
