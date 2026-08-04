# bash/：bash 能力家族

[English](README.md) | 中文

能力家族横跨规范执行器 seam、其实现、共享 shell 环境与面向模型的工具。这些全是**产品**包。

| 包 | 职责 | ctx key |
|---|---|---|
| `bash/` | 抽象 bash 执行器 seam（接口 + 词汇；沙箱结果事实携带 [`sandbox/`](../sandbox/README.md) seam 的模式／强制执行词汇，受管环境／输出词汇则从 [`subprocess/`](../subprocess/README.md) seam 重导出） | `ctx.bash` |
| `bash-local/` | 构建在 [`subprocess/`](../subprocess/README.md) 服务之上的本地 `BashExecutor` 实现（命令默认值补全、deadline、终端环境、后台读取合并） | （注册 `ctx.bash`） |
| `bash-sandbox/` | 消费沙箱的 `BashExecutor`（通过 `ctx.sandbox` 包装每个命令 argv，标记拒绝／强制执行事实；扩展 `bash-local` 的机制） | （注册 `ctx.bash`） |
| `pwsh-local/` | 构建在 [`subprocess/`](../subprocess/README.md) 服务之上的本地 PowerShell `BashExecutor` 实现（可执行文件解析、UTF-8 固定 spawn、Windows 终止语义） | （注册 `ctx.bash`） |
| `bash-env/` | 工具无关的受管 `DSH_*` shell 环境注册表，由 shell 工具共享（内置事实 + 受 effect 作用域约束的 contributor） | （注册 `ctx.bashEnv`） |
| `tool-bash/` | 面向模型的 `bash` schema；后台进程注册到通用 [`tasks/`](../tasks/README.md) 运行时 | （注册到 `ctx.tools`） |
| `tool-pwsh/` | 面向模型的 PowerShell 方言 `pwsh` schema（行为镜像 `tool-bash`，减去 sandbox 面）；后台进程注册到通用 [`tasks/`](../tasks/README.md) 运行时 | （注册到 `ctx.tools`） |

接口位于 `bash/bash/`。以 `bash-sandbox` 替换 `bash-local`，同时不改动接口或工具，正是这种拆分存在的意义：叶级 `cordis.yml` 选择一个执行器插件条目；受限实现还需再选择一个 `ctx.sandbox` 提供方插件条目（见 [acp-agent 示例的默认组合](../../examples/acp-agent/)）。
