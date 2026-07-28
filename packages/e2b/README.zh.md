# e2b/ — E2B 远程运行时家族

[English](README.md) | 中文

这是一个实验性提供方组合 POC，把可变的编码环境放进同一个 E2B Linux 沙箱。共享所有者与功能适配器分离，使每个远程提供方都等待同一个沙箱身份和生命周期。

| 包（package） | ctx 键 | 职责 |
|---|---|---|
| [`e2b`](e2b/README.md)（`@deepseek-ai/dsh-e2b`） | `ctx.e2b` | 创建或重新连接一个沙箱，创建其工作目录与运行时目录，公开共享 SDK 句柄，并应用配置的 kill/pause/leave 处置方式 |
| [`fs-e2b`](../fs/fs-e2b/README.md)（`@deepseek-ai/dsh-fs-e2b`） | `ctx.fs` | 通过 E2B Filesystem API 实现文件系统 seam |
| [`subprocess-e2b`](../subprocess/subprocess-e2b/README.md)（`@deepseek-ai/dsh-subprocess-e2b`） | `ctx.subprocess` | 通过 E2B Commands 实现受管进程组、stdio 投影与远程 spill 文件 |
| [`pty-e2b`](../pty/pty-e2b/README.md)（`@deepseek-ai/dsh-pty-e2b`） | `ctx.pty` 后端 | 通过 E2B 的字节 PTY API 运行持久交互式 shell |
| [`lsp-e2b`](../lsp/lsp-e2b/README.md)（`@deepseek-ai/dsh-lsp-e2b`） | `ctx.lsp` 提供方 | 在 E2B 内运行已配置的语言服务器并读取查询源代码 |
| [`code-runtime-e2b`](../code-runtime/code-runtime-e2b/README.md)（`@deepseek-ai/dsh-code-runtime-e2b`） | `ctx.codeRuntime` | 远程运行模型编写的程序，同时把绑定桥接到宿主 |

现有的 [`dsh-bash-local`](../bash/bash-local/README.md) 无需 E2B 专用 fork：它把进程机制委托给 `ctx.subprocess`，因此替换该提供方即可让 Bash 进入同一个远程环境。该边界不会迁移 harness 进程、Cordis 对象、模型调用、agent（智能体）／会话状态、会话持久化、skill（技能）、协议状态或 E2B SDK 缓冲。[基础决策](../../.agents/notes/implemented/feature/2026-07-27-e2b-remote-runtime-poc.md)与[运行时扩展决策](../../.agents/notes/implemented/feature/2026-07-28-e2b-interactive-semantic-code-runtime-poc.md)共同界定 POC 边界。
