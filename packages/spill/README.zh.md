# spill/ - spill 存储能力家族

[English](README.md) | 中文

工具输出 spill 的能力 seam：一个抽象存储接口、一个本地文件系统实现，以及一个使用该实现的工具结果策略。全部均为**产品**包（package）。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `spill/` | 抽象 spill 存储 seam（`saveText`：持久化过大的工具文本，返回定位信息与取回指引） | `ctx.spillStore` |
| `spill-local/` | 本地文件系统后端：名称可防止路径遍历的私有会话级文件 | （注册到 `ctx.spillStore`） |
| `spill-policy/` | `tools/post-execute` 策略：将过大的纯文本结果替换为预览和 spill 定位信息 | （无服务接口） |

接口位于 `spill/spill/`。这种拆分方式与 bash/fs 相同：seam 只负责存储，`spill-local` 负责文件系统机制，`spill-policy` 负责决定何时 spill 以及面向模型的通知。预览机制位于 [`util/retention`](../util/README.md)；策略只组合两者，不会让任何一方承担对方的职责。

设计原理见[工具输出 spill Agent Note（agent 决策记录）](../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md)，其中说明了为什么最终结果 spill 要与工具自行提前 spill（bash 流、subagent rollout）分离，以及为什么创建操作应由运行时 spill seam 而非面向模型的 `write` 工具承担。
