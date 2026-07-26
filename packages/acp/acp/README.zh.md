# @deepseek-ai/dsh-acp

[English](README.md) | 中文

通过 JSON-RPC stdio 提供的仅面向自动化的 [Agent Client Protocol](https://agentclientprotocol.com) 服务器。程序化客户端可以创建新 harness agent（智能体）、发送文本提示词、收集已提交的 assistant 文本、通过策略解决一次性权限请求并取消工作。仓库中的主要客户端是 [`dsh-subagent-acp`](../../subagent/subagent-acp/README.md)。

此包（package）是传输适配器，而非 UI 集成或能力 seam。它不公开编辑器导航、transcript（文本记录）回放、命令、mode、配置选择器、信息征集、推理、计划、标题或工具展示。交互渲染与人类问题属于 Web 和 TUI 模块。

## 插件

`apply(ctx, config)` 在 stdin/stdout 上打开 `AgentSideConnection` 并驱动 `ctx.agents`。Stdout 专用于协议帧。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `provider` | 无 | 每个已创建 agent 的初始提供方路由。 |
| `model` | 无 | 每个已创建 agent 的初始模型。 |

两个字段都是可选的，以便由另一个 agent/request 监听器提供目标。可运行 ACP 组合同时要求两者。

## 协议契约

| 方法 | 行为 |
|---|---|
| `initialize` | 协商受支持的版本，并仅公布基线提示词（无图像、音频或嵌入上下文能力）。不公布会话、编辑器、终端、文件系统或 MCP 能力。 |
| `authenticate` | 空操作，因为服务器不公布身份验证方法。 |
| `session/new` | 使用绝对主 `cwd` 创建新 agent；接受空的 `additionalDirectories` 和 `mcpServers`，拒绝非空值。 |
| `session/prompt` | 连接文本块，将基线资源链接渲染为带方括号的文本引用，拒绝空输入或超出基线的输入，每个会话只允许一个正在处理的请求，并从该请求拥有的持久 `turn/end` 结算。 |
| `session/cancel` | 仅取消被定址的 agent，并将其待处理提示词结算为 `cancelled`；未知 id 为空操作。 |
| `session/update` | 为每个非空文本块发出一个 `agent_message_chunk`；这些文本块来自已提交的 `assistant/message`。省略原始增量和非消息事件。 |
| `session/request_permission` | 为携带工具调用 id 的桥接层所有批准请求提供一次性允许／拒绝选项。客户端可以自动回答。 |

一个连接可以拥有多个会话。桥接层使用带品牌的 session id 为记录建键，并在路由事件或权限请求前检查精确的 agent 标识。每个会话都有独立的提示词槽位、workspace、取消路径和 disposer。

已提交消息输出有意以逐 token 延迟换取干净的自动化结果。未提交的提供方分片和重试尝试无法泄漏部分文本；推理与工具活动仍保留在会话日志中，以便其他界面观测。

## 生命周期

客户端断开与 Cordis 释放共用同一个记忆化清理流程。桥接层先拒绝新会话和提示词，结算待处理提示词，然后并行释放所有已拥有的 agent handle，并等待它们的循环／会话清理完成。因此，仅 ACP 的插件重载不会遗留 agent。

## 运行

`pnpm --dir /path/to/deepseek-harness run demo:acp` 启动仓库的自动化服务器组合。父 harness 可以通过 [`@deepseek-ai/dsh-subagent-acp`](../../subagent/subagent-acp/README.md) spawn 它；其他 ACP 客户端只需上述核心方法。

## 模型体验

### 提示词文本

#### 模型所见内容

`session/prompt` 文本块会原样连接为一条用户消息；基线资源链接会在该消息中表示为带方括号的 `[resource_link name=… uri=…]` 引用，模型可以使用自身工具打开它。协议元数据、客户端能力、权限选择和 session id 绝不进入模型请求。

#### Token 影响

提示词 token 取决于数据，并保留在该会话的历史中直到压缩。并发 ACP 会话保留独立上下文。

#### KV Cache 影响

仅追加；新用户消息位于可复用请求前缀之后，不会使先前缓存条目失效。

### 权限决策

#### 模型所见内容

没有直接内容。拥有该决策的工具通过常规工具结果路径记录允许、拒绝、取消或不可用结果。

#### Token 影响

只有拥有该决策的工具结果会贡献 token。

#### KV Cache 影响

通过所属工具结果仅追加。

## 已知限制与延后工作

- **仅新会话**：不支持加载、列出、恢复、删除和 fork。
- **仅基线提示词和一个 workspace**：图像、音频、嵌入资源、非空附加目录和 MCP 服务器都会被拒绝；资源链接会被展平为文本引用，而不是已获取内容。
- **仅已提交答案**：实时进度、推理、工具活动、计划、标题和用量不上线。
- **连接拥有的生命期**：一个连接会释放其所有会话；尚未实现每会话关闭。
