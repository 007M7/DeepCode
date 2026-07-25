# ui/：面向用户和 SDK 客户端的集成接口

[English](README.md) | 中文

面向用户的交互通道和进程外 SDK 服务器。这些是**产品** 包（package）：由用户或 SDK 客户端直接操作的真实接口。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `commands/` | 用户命令注册表：共享发现元数据、作用域遮蔽、取消以及 UI 直接分派 | `ctx.commands` |
| `user-approval/` | 一次性用户审批机制、封闭的结果词汇、审计事件和逐会话审批策略 | `ctx.approval` |
| `permission/` | 面向用户的权限预设（`workspace-write`/`danger-full-access`）：用一个产品级选择器组合沙箱模式与审批策略两个调节项，并写入各自的会话事件 | `ctx.permission` |
| `user-interaction/` | UI 支持的确认工具所使用的抽象用户问答 seam | `ctx.userInteraction` |
| `tool-ask-user/` | 模型侧 `ask_user_question` 工具，基于 `ctx.userInteraction` 实现 | （注册到 `ctx.tools`） |
| `tui/` | 交互式 pi-tui 终端通道：渲染会话标题、事件和工具意图，响应 `ctx.userInteraction`，并托管由 effect 持有的插件浮层 | `ctx.tui`（驱动 `ctx.agents`） |
| `jsonrpc/` | 面向进程外 SDK 客户端的 stdio JSON-RPC 服务器 | （驱动 `ctx.agents`） |
| `app-boot/` | app bin 的共享启动粘合层：加载 `.env`、Loader 快速失败保护、感知快照的配置解析，以及等待整棵树停稳的启动序列 | （供各 bin 使用的库） |

UI 集成属于客户端驱动插件，而非对循环的修改：它使用现有的 `agent/*` 事件分类和 `dsh-agent` 工厂。[`tui`](tui/README.md) 是交互式终端入口，并提供终端本地的 `ctx.tui` 扩展服务；[`jsonrpc`](jsonrpc/README.md) 为进程外 SDK 客户端提供服务，而非交互式单次任务使用 `cli-demo`。[`commands`](commands/README.md) 是 TUI 使用的纯用户发现与分派通道；命令输入和输出不会成为模型消息。

`user-approval`、`user-interaction` 和 `tool-ask-user` 位于此处，因为向用户提问是由 UI 支持的产品功能，并不属于提供方无关的核心主干。`user-approval` 持有一次性的 `ctx.approval` 决策机制及其策略层级；应答方仍归拥有 agent（智能体）的通道或自动化传输层所有。`user-interaction` 保持提供方无关（`ctx.userInteraction`），`tool-ask-user` 是其模型侧消费方，而交互式 app 包提供具体实现。

基于 [`agent-spine-demo`](../examples/agent-spine-demo/README.md) 组合的可运行 app bundle 位于 [`examples/`](../examples/README.md)（`tui-demo`、`acp-demo`、`jsonrpc-demo`）。`acp-demo` 和 `jsonrpc-demo` 持有启动 bin；`tui-demo` bundle 则由产品 [`dsh`](../../apps/cli/README.md) CLI 启动。`ui/` 保留可复用的用户／SDK 通道插件和共享 `app-boot` 粘合层；仅供自动化使用的 ACP 传输层位于 [`acp/`](../acp/README.md)。每个入口都持有自己的 stdout 策略，叶子 `cordis.yml` 则提供后端与可选工具。
