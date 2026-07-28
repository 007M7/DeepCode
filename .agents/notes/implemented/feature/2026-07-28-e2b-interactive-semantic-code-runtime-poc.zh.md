# Agent Note: E2B 交互式、语义与代码运行时 POC

Status: implemented

[English](2026-07-28-e2b-interactive-semantic-code-runtime-poc.md) | 中文

## 问题

[共享 E2B 运行时](2026-07-27-e2b-remote-runtime-poc.md)证明，文件系统操作与一次性命令可以共处一个远程 coding 环境，但组装完成的 coding agent（智能体）还会使用持久终端、语言服务器，以及模型编写的 Code Mode 程序。若这些功能回退到宿主实现，可观测状态就会分裂：Bash 修改存在于 E2B 中，而宿主 PTY、LSP 进程或代码 worker 面向的却是另一个文件系统与进程命名空间。

把完整 harness 进程迁入 E2B 可以统一这些状态，但也会改变插件加载、凭据、模型传输、会话持久性、监管和部署。这个 POC 只需测试现有功能边界，不应把这些彼此独立的问题纳入范围。

## 决策

三个可选提供方扩展现有共享沙箱：

- `@deepseek-ai/dsh-pty-e2b` 在 `ctx.pty` 上注册 E2B 字节 PTY 后端，并把精确的 Agent 所有权保留在现有注册表中。
- `@deepseek-ai/dsh-lsp-e2b` 在 `ctx.lsp` 上注册已配置的远程语言服务器，通过 E2B Filesystem API 读取源代码，并通过 `dsh-subprocess-e2b` 运行服务器。
- `@deepseek-ai/dsh-code-runtime-e2b` 注册 `ctx.codeRuntime`，在全新的远程 worker 中运行每个模型程序，并在宿主进程中分发绑定函数。

三个提供方均注入 `ctx.e2b`，无一创建其他沙箱。可选叠加配置将它们与 `dsh-fs-e2b`、`dsh-subprocess-e2b` 和现有的 `dsh-bash-local` 组合，使文件、前台命令、交互式 shell 进程、语言服务器和代码 worker 观察到同一个远程 cwd。

这些提供方复用 PTY、LSP、Code Runtime 与进程管理 seam，不更改面向模型的消费方或 agent loop（智能体循环）。后端无关的 PTY 文本处理移入 `dsh-pty`；LSP 协议引擎允许位于另一个进程命名空间的服务器使用 `processId: null`；Code Runtime 导出输出账本与无损 JSON 辅助函数，以保持各后端一致。

## 运行时边界

E2B 拥有可变文件系统、命令和 Bash 进程、PTY shell 与前台进程组、语言服务器进程及源码读取、Code Runtime 运行器和 worker，以及 `.dsh-e2b` 下的适配器私有文件。

宿主拥有 Cordis 与插件对象、agent／会话／goal 状态、会话日志及持久化、LLM（大语言模型）调用、提示词与工具、权限决策、PTY 缓冲与就绪状态、LSP JSON-RPC id／队列／协议状态、Code Runtime 类型剥离／输出计量／绑定分发，以及 E2B SDK／网络编排。宿主工作区不会仅因远程复用了其绝对 cwd 字符串就被挂载或同步。

对字节敏感的协议只使用适配 E2B 回调形状所需的最窄适配器。PTY 直接消费 SDK 的字节回调。LSP 与 Code Runtime 会安装无依赖的远程辅助程序，把原始载荷编码为经过验证、以换行分隔的 base64 JSON，并通过 ASCII 传输承载 E2B 已解码的命令回调。

保留沙箱只会保存远程文件与任何未受管的远程状态。重新连接不会重建宿主 PTY 会话、缓冲、进程句柄、LSP 连接或请求、代码 worker、绑定调用、定时器、输出游标或锁。受管进程组会在所属提供方 dispose（资源释放）时终止并等待退出，之后共享所有者才会暂停、脱离或终止沙箱。

## 验证

聚焦单元测试固定配置、发布回滚、字节分帧、多字节边界、就绪状态、信号、超时／中止顺序、输出上限、恶意 Code Runtime 通信，以及等待完全停稳的资源释放。相邻本地后端测试固定共享 PTY 工具函数，以及 LSP 跨命名空间 `processId` 行为。

凭据门控的 Loader 组合会创建一个真实 E2B 沙箱，并演练 FS-to-Bash 与 Bash-to-FS 可见性、多字节 PTY 输出和 `SIGINT`、多字节 LSP 悬停与定义结果、Code Runtime 宿主绑定，以及适配器已捕获 intrinsic 被修改时的类型化 reject、墙钟超时、中止、运行器清理、宿主工作区隔离，以及最终删除沙箱。同一场景分别通过源代码导入与已构建包导出运行。

## 曾考虑的替代方案

**在 E2B 内运行完整 harness。** 不予采纳，因为这会把这项提供方实验与凭据、LLM 传输、插件部署、会话持久化、监管和远程包安装耦合。要证明功能 seam，无需引入任何一项。

**原样使用宿主 PTY、LSP 与 worker 后端。** 不予采纳，因为它们使用宿主的进程与文件系统 API；在不同机器上复用同一个绝对 cwd 字符串并不会共享状态。

**把 E2B Commands 公开为通用传输并绕过功能提供方。** 不予采纳，因为 PTY 需要字节回调和前台信号，LSP 需要字节保真的 stdio 与远程源码路径约束，Code Runtime 则需要双向宿主绑定调用与不可信对等方验证。绕过其注册表还会使面向模型的行为产生分叉。

**先添加通用分布式运行时抽象。** 不予采纳，因为现有三个功能 seam 已承载所需契约。新的跨领域接口会预先假定 POC 范围之外的持久化、同步与重连语义。

**在 `sandboxId` 重连后恢复活动功能句柄。** 不予采纳，因为只有远程身份，无法重建宿主回调、待处理 promise、权限、协议状态或输出游标。若声称保持连续性，就会让陈旧的远程进程看似仍受管理，实际并非如此。

## 后果

组装后的 POC 在不迁移 agent 运行时、不改变模型可见工具契约的前提下，把 coding 环境保留在远程。它证明 PTY、LSP 与 Code Runtime 可以通过现有插件共享 E2B 状态，同时明确列出仍留在宿主的状态。

这不是部署平台。语言服务器安装、模板、卷、快照、网络策略、工作区同步、持久远程句柄和完整 harness 执行仍不在范围内。E2B SDK 缓冲与宿主协议状态仍会占用内存。模型程序与 Node worker 内部机制共享一个 JavaScript realm；有意逃离已捕获远程进程组的进程，也不会因此变得可重新连接或由该组合管理。
