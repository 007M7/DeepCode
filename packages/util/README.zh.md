# util/：底层共享工具

[English](README.md) | 中文

其他分组共享的零依赖原语。当某个包拥有某个微小的基础类型或辅助工具，而该类型或辅助工具为多个功能家族所需，却不属于其中任何一个家族时，该包就归入此处。这样可避免一个功能包仅为使用共享原语而依赖不相关的功能包。这些都是**支持** 包：规模小、稳定，且不依赖 harness。

| 包 | 职责 |
|---|---|
| `brand/` | 仅包含类型的 `Branded<B>` 名义类型原语（无运行时代码，无 harness 依赖） |
| `paths/` | 规范的单根 `DSH_HOME` 解析，以及 harness 用户数据的共享文件系统路径常量和辅助工具（无 harness 依赖） |
| `timeout/` | 超时的时序/分类部分：`clampTimeout`/`deadline`/`timeoutOf`/`TimeoutReason`（纯函数，无 harness 依赖）；终止机制保留在各个功能中 |
| `retention/` | 有界的面向模型输出：`ItemRetainer`/`TextRetainer` 加上中性通知辅助工具（纯工具，无 harness 依赖）；业务语义保留在各个工具中 |
| `atomic-write/` | 原子文件替换：`writeFileAtomic`（独占创建临时文件 + 携带调用方所声明 mode 的 rename）；由设置与凭据存储共用 |
| `native-command/` | 宿主原生 OS 集成的免 shell `execFile` 运行器——utf8 捕获、abort 传播、Windows 窗口隐藏（无 harness 依赖）；命令选择保留在各调用方 |

`dsh-brand` 是规范示例：它只负责 `Branded<B>` 辅助工具，因此功能包可以为自己拥有的 id 添加品牌（`dsh-tasks` 的 `TaskId`、`dsh-session` 的 `SessionId` 等），而只需依赖 `dsh-brand`，无需仅为使用 `Branded` 而引入不相关的包。

`dsh-paths` 为每个包提供同一个可配置的 Harness 主目录，而不将这项横切事实归属给 bash、skill（技能）、telemetry 或组合包。它优先解析显式值，其次是 `$DSH_HOME`，最后回退到 `~/.dsh`；返回绝对路径，但不缓存、创建或修改任何内容。harness 将所有用户数据保存在同一根目录下。

`dsh-timeout` 对超时家族采用相同结构：`dsh-bash` 和 `dsh-web-fetch-local` 都只依赖 `dsh-timeout`，便可将调用方的取消与 deadline 融合，然后区分「已超时」和「已取消」。它刻意只负责时序/分类部分，*终止*机制（对进程组发送 SIGKILL、关闭 fetch socket）保留在各个功能中，因为没有任何共享层可以负责每个功能的终止操作（见[超时库 Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md)）。

`dsh-retention` 对有界工具输出采用同样的拆分方式：工具（`glob`/`grep`/`bash`/`web_fetch`/`web_search`）将项或文本送入 retainer，取回保留的内容以及精确的省略量；分组、退出码、提供方错误和恢复文案则仍由工具负责。它刻意只负责保留机制；`truncated` 只表示因预算而发生了省略，绝不表示「检查不完整」状态（见[保留库 Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-tool-result-retention-library.md)）。
