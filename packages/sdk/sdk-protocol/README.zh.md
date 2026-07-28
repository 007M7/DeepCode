# @deepseek-ai/dsh-sdk-protocol

[English](README.md) | 中文

DeepSeek Harness SDK 运行时的共享线协议：一个按换行分帧的 JSON-RPC 2.0 传输类，加上线两端共同使用的具名请求、结果与通知类型。包（package）根枚举协议消费方接口；源模块不以深层导入形式导出。服务端是 [`dsh-jsonrpc`](../../ui/jsonrpc/README.md) 插件；客户端是 [`dsh-sdk-client`](../sdk-client/README.md)（TypeScript）与 [Python SDK](../../../python/README.md)（后者镜像这些形状但不导入它们）。纯库——无插件、无 Config、无注册。

## 传输

`JsonRpcLineTransport` 在调用方持有的字节流上为 JSON-RPC 2.0 分帧，每行一个紧凑 JSON 帧、以 `\n` 结尾。带 `id` 与 `method` 的帧是请求，仅 `id` 是响应，仅 `method` 是通知；非法 JSON 行被忽略。`start()` 挂接流监听器，`close()` 摘除监听器并拒绝挂起请求、但不销毁流。缺失请求处理器时应答 `-32601`；处理器拒绝则应答携带错误消息的 `-32603`。错误响应会以 `JsonRpcResponseError` 拒绝挂起的 `request()`，保留线上的 `code` 与可选 `data`。`JsonRpcTransportPeer` 是服务器类所依赖的出站表面（request/notify）。

## 线类型

`types.ts` 为 `HarnessSdkServer` 所服务协议的每个载荷命名：

| 方向 | 方法 | 类型 |
|---|---|---|
| client→server | `initialize` | `InitializeParams` → `InitializeResult` |
| client→server | `session/prompt` | `SessionPromptParams` → `SessionPromptResult`（仅在回合尘埃落定后应答） |
| client→server | `shutdown` | 无参数 → `{}` |
| server→client | `session.event` | `SessionEventNotification`（运行时内每个会话，不过滤） |
| server→client | `session.finished` | `SessionFinishedNotification`（每个被接受的 prompt 一条） |
| server→client | `subagent.started` | `SubagentStartedNotification` |
| server→client | `subagent.finished` | `SubagentFinishedNotification`（仅进程内 run） |

`HarnessSdkRequestMap` 与 `HarnessSdkNotificationMap` 按方法名索引这些类型。`InitializeParams.maxTokens` 是可选的正安全整数，用于限制 SDK 创建的 agent 及其进程内后代每次对话模型输出；省略时由提供方默认值控制。通知载荷类型依赖 `SessionEvent`（`dsh-session`）、`ContentBlock`（`dsh-llm`）与 `SubagentStopReason`（`dsh-subagent`）——协议以完整会话日志封套进行流式传输，因此会话词汇表是线契约的一部分。`serverInfo.name` 保持线上稳定值 `deepseek-harness-sdk-runtime`。

## Model Experience

None, as this package defines the client-facing wire protocol; the model-visible surfaces belong to the runtime plugins composed behind the serving [`dsh-jsonrpc`](../../ui/jsonrpc/README.md) entry.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **无协议版本协商** —— 握手只携带 `serverInfo.version`（`0.0.1`，客户端不校验）；预发布立场，无兼容承诺。
- **无取消与会话关闭方法** —— 客户端放弃回合的方式是关闭运行时进程；见 [`dsh-jsonrpc` README](../../ui/jsonrpc/README.md)。
- **server→client 请求是死能力** —— 传输层支持，但服务器从不发送；Python SDK 的应答表面为未来审批流预留。
