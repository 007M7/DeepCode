# bash/：bash 能力家族

[English](README.md) | 中文

规范的三包能力 seam（见[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)）：抽象执行器接口、具体实现，以及消费该接口的面向模型工具。这些全是**产品**包。

| 包 | 职责 | ctx key |
|---|---|---|
| `bash/` | 抽象 bash 执行器 seam（接口 + 词汇；沙箱结果事实携带 [`sandbox/`](../sandbox/README.md) seam 的模式／强制执行词汇，受管环境／输出词汇则从 [`subprocess/`](../subprocess/README.md) seam 重导出） | `ctx.bash` |
| `bash-local/` | 构建在 [`subprocess/`](../subprocess/README.md) 服务之上的本地 `BashExecutor` 实现（命令默认值补全、deadline、终端环境、后台读取合并） | （注册 `ctx.bash`） |
| `bash-sandbox/` | 消费沙箱的 `BashExecutor`（通过 `ctx.sandbox` 包装每个命令 argv，标记拒绝／强制执行事实；扩展 `bash-local` 的机制） | （注册 `ctx.bash`） |
| `tool-bash/` | 面向模型的 `bash` schema；后台进程注册到通用 [`tasks/`](../tasks/README.md) 运行时 | （注册到 `ctx.tools`） |

接口位于 `bash/bash/`。以 `bash-sandbox` 替换 `bash-local`，同时不改动接口或工具，正是这种拆分存在的意义：叶级 `cordis.yml` 选择一个执行器插件条目；受限实现还需再选择一个 `ctx.sandbox` 提供方插件条目（见 [acp-agent 示例的默认组合](../../examples/acp-agent/)）。
