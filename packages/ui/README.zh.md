# ui/：面向用户和 SDK 客户端的集成接口

[English](README.md) | 中文

面向用户的交互通道和进程外 SDK 服务器。这些是**产品**包（package）：由用户或 SDK 客户端直接操作的真实接口。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `commands/` | 用户命令注册表：共享发现元数据、作用域遮蔽、取消以及 UI 直接分派 | `ctx.commands` |
| `user-approval/` | 一次性用户审批机制、封闭的结果词汇、审计事件和逐会话审批策略 | `ctx.approval` |
| `permission/` | 面向用户的权限预设（`workspace-write`/`danger-full-access`）：通过一项产品级选择组合沙箱模式与审批策略两个可调参数，并写入各自的会话事件 | `ctx.permission` |
| `user-interaction/` | UI 支持的确认工具所使用的抽象用户问答 seam | `ctx.userInteraction` |
| `tool-ask-user/` | 模型侧 `ask_user_question` 工具，基于 `ctx.userInteraction` 实现 | （注册到 `ctx.tools`） |
| `jsonrpc/` | 面向进程外 SDK 客户端的 stdio JSON-RPC 服务器 | （驱动 `ctx.agents`） |
| `app-boot/` | app bin 的共享启动粘合层：加载 `.env`、会明确报错的 Loader 保护机制、感知快照的配置解析，以及等待整棵树停稳的启动序列 | （供各 bin 使用的库） |

UI 集成属于由客户端驱动的插件，而非对循环的修改：它使用现有的 `agent/*` 事件分类和 `dsh-agent` 工厂。[`jsonrpc`](jsonrpc/README.md) 为进程外 SDK 客户端提供服务，非交互式的一次性任务则使用 `cli-demo`。[`commands`](commands/README.md) 是面向交互式适配器的仅面向用户的发现与分派通道；命令输入和输出不会成为模型消息。

`user-approval`、`user-interaction` 和 `tool-ask-user` 位于此处，因为向用户提问是由 UI 支持的产品功能，并不属于无提供方的核心主干。`user-approval` 负责一次性的 `ctx.approval` 决策机制及其策略层级；应答逻辑仍由负责 agent（智能体）的通道或自动化传输层提供。`user-interaction` 保持提供方无关（`ctx.userInteraction`），`tool-ask-user` 是其模型侧消费方，而交互式 app 包提供具体的提供方。

基于 [`agent-spine-demo`](../examples/agent-spine-demo/README.md) 组合的可运行 app bundle 位于 [`examples/`](../examples/README.md)（`cli-demo`、`acp-demo`、`jsonrpc-demo`），各自拥有入口契约。产品 [`dsh`](../../apps/cli/README.md) CLI（命令行界面）不使用 demo bundle。`ui/` 保留可复用的用户／SDK 通道插件和共享 `app-boot` 粘合层；仅供自动化使用的 ACP（Agent Client Protocol）传输层位于 [`acp/`](../acp/README.md)。每个入口都负责自己的 stdout 策略，叶子 `cordis.yml` 则提供后端与可选工具。
