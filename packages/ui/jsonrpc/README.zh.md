# @deepseek-ai/dsh-jsonrpc

[English](README.md) | 中文

`jsonrpc` 插件通过 stdio 提供以换行符分隔的 JSON-RPC，使进程外 SDK 客户端能够驱动 harness agent（智能体）。[`HarnessSdkServer`](src/server.ts) 持有协议方法和通知；传输与具名线类型位于 [`dsh-sdk-protocol`](../../sdk/sdk-protocol/README.md)，与客户端 SDK 共享；[`jsonrpc-demo`](../../examples/jsonrpc-demo/README.md) 提供外围的 `cordis.yml` 应用。

## 组装

`inject: ['agents']`。服务器按 `sessionId` 获取或创建一个 agent。只有服务建立快照时的生命周期 `local` 标志为 true，服务器才会转发 subagent 完成事件；提供方名称、子级 id 和持久化谱系均不能证明本地性。已注册的适配器优先；未被持有的 `deepseek` 路由会挂载 `dsh-llm-deepseek`，任何其他未被持有的提供方都会导致初始化失败。其他功能由外围 `cordis.yml` 提供。

## 配置

`maxTokensAsSuccess` 默认为 `false`。对于需要区分「因 token 上限而结束但可接受的 agent 结果」与「基础设施故障」的评测宿主，请将其设为 `true`。`JsonRpcConfig.input`、`output` 和 `exit` 是仅供运行时使用的传输 seam；生产环境使用进程 stdio 和 `process.exit`。

## stdout 即协议

Stdout 只承载 JSON-RPC 帧。部署不得组合 stdout logger；诊断应写入 stderr。

## 关闭与退出语义

插件响应 `shutdown`，将 SDK 持有的 agent 和订阅 dispose（资源释放）至完全停稳，关闭传输层，然后以代码 0 退出。EOF 和信号退出由 app bin 处理，后者会 dispose 根上下文。仅卸载此插件会停止服务，但不会退出进程。

## 协议说明

`initialize.serverInfo.name` 的协议稳定值为 `deepseek-harness-sdk-runtime`。一个会话只接受一个进行中的提示词；重叠请求会立即失败，其他会话保持独立，当前请求结算后该会话可再次使用。`session.finished` 报告由该提示词消息触发的轮次结果；后续注入或插件持有的零步骤轮次仍会作为 `session.event` 通知流式发出，但不能替换该提示词的状态。持久化根目录和 persona 由 `cordis.yml` 提供。

## 模型体验

### SDK 用户消息

#### 模型看到的内容

对于每个已接受的 `session/prompt`，对话模型会将调用方提供的 `contentBlocks` 原样接收为该 SDK 会话中的一条用户消息。此包（package）不会添加系统提示词文本或工具 schema；这些内容来自外围 `cordis.yml` 中的插件。

#### Token 影响

依数据而定的用户消息 token 会进入保留的会话历史，并在后续轮次中重复发送，直至另一个包将其压缩（compaction）。JSON-RPC 帧、会话通知和服务器内部记录不会增加模型上下文 token。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与延期工作

- **协议没有逐会话关闭或提示词取消方法**：SDK 创建的 agent 会一直存活到进程关闭；一条已接受的提示词必须运行到 agent 空闲，该会话才能接受下一条。
- **stdout 纯净性由部署保证**：外围配置仍可能加载 stdout logger 并破坏 JSON-RPC 通道；此插件不会检查或否决同级 logger。
- **自动挂载适配器仅支持 DeepSeek**：`initialize` 可以复用任何预先注册的模型适配器，但唯一的回退行为是挂载 `dsh-llm-deepseek`。
