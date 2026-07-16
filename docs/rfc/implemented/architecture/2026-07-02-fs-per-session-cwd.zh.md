# RFC：将文件系统路径解析基于调用方的会话 cwd

Status: implemented

[English](2026-07-02-fs-per-session-cwd.md) | 中文

## 问题

ACP 桥接层为每个会话提供独立的工作区：`session/new` 将编辑器的项目目录记录为 `SessionHeader.cwd`，`dsh-tool-bash` 将每次 bash 调用的 `workdir` 默认设为调用方 agent 的 `session.header.cwd`（见 [`packages/ui/acp`](../../../../packages/ui/acp) 中的 per-session cwd RFC 相关工作，以及 `dsh-tool-bash` 中的 `resolveWorkdir`）。因此会话 A 中的 bash 命令在 A 的项目目录运行，会话 B 中的在 B 的项目目录运行——一个服务器进程，N 个工作区。

文件系统路径解析使用的是插件加载时的单一 cwd，而 bash 使用的是会话的项目目录。因此，当编辑器项目目录与服务器启动目录不同时，相对路径的解析结果就会不一致；快照测试因为让这两个路径相同而掩盖了这个 bug。

## 决策

将调用方的会话 cwd 透传到路径解析中，与 `dsh-tool-bash` 对 `workdir` 的处理方式完全一致。**调用方**（即工具）提供 cwd；提供方不读取会话或 agent。

- `FileSystem.resolve` 扩展为 `resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget>`。`opts.cwd` 是相对 `path` 的解析基准；绝对 `path` 忽略它；省略 `opts.cwd` 时使用后端自身的默认值。使用 options 对象（而非位置参数 `cwd?`）为将来的解析提示留出空间，无需再次变更签名。
- `dsh-fs-local.resolve` 使用 `resolveLocalTarget(opts?.cwd ?? this.config.cwd, path)`。`config.cwd` 仍是调用方未提供 cwd 时的默认值（非 ACP／无会话场景，以及 `process.cwd()` 本身就是工作区的单会话 stdio 演示）。
- `dsh-tool-fs` 的 `read`/`write`/`edit` 通过共享的 `sessionCwd(exec)` 辅助函数获取会话 cwd（`exec.agent?.session.header.cwd`，与 bash 的 `resolveWorkdir` 一致），并传给 `resolve`。非 agent／无 header 的调用方返回 `undefined`，后端则应用其默认值。

## 曾考虑的替代方案

### 为什么由调用方提供 cwd（而非提供方）

提供方 seam 不应依赖 `dsh-agent`／`dsh-session`：它是一个文本存储后端，沙箱或远程实现同样满足该接口，而它们没有「agent 会话」的概念。工具已经接收到 `ToolExecution`（`exec`），其中携带了 agent，因此工具是将 `exec → cwd` 投影并向提供方传递一个纯字符串的正确位置。这遵循「包边界处显式优于隐式」的约定：基目录作为显式参数到达提供方并由其执行，而非让提供方越界去读取它不应知道的会话。这也与 `dsh-tool-bash` 一一对应，使两个面向模型的文件操作接口以相同方式解析路径。

默认值只存在于**一个**地方：提供方的 `config.cwd`。`sessionCwd` 在没有会话时返回 `undefined` 而非 `process.cwd()`，因此工具永远不会制造一个提供方本来会自行选择的基目录。

## 后果

- 在 ACP 演示中，fs 工具和 bash 现在对每个会话的工作区达成一致；编辑器可以打开任意项目文件夹，两类工具都在该目录下工作。
- `FsTarget` 的标识不变：`targetKey` 仍然是解析后绝对路径的 realpath，因此 observed-state 键控和符号链接标识不受影响——正确的 per-session cwd 产生的 key 与 bash 目标一致。
- 向后兼容：所有现有的 `resolve(path)` 调用（均在测试中）继续正常工作；新参数是可选的。
- 单会话 stdio 演示不受影响：它不提供会话 cwd（其 agent 的会话没有 `cwd`），因此解析回退到 `config.cwd = process.cwd()`，即工作区本身。
