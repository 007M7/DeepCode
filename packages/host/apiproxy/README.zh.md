# @deepseek-ai/dsh-host-apiproxy

[English](README.md) | 中文

所有客户端形态共用的 API 网关：TS 契约（`src/api/`，不依赖 Node，可从浏览器导入）、fetch 载体对（`src/fetch/`：宿主侧的 `toFetchHandler`，以及客户端侧的 `AbstractApiClient` 与平台子类）和宿主侧实现（`src/api-proxy.ts`：`createApiProxy` 加上默认导出的 `ApiProxyService` 网关插件，其配置为 `{provider, model, workspaceRoot?}`，提供 `ctx.apiProxy`）。该包（package）在设计上与传输方式无关，不注册任何路由；载体（目前为 HTTP，未来可以是 IPC）自行包装 `ctx.apiProxy`。已发布的核心组合位于 [`apps/cli/cordis.yml`](../../../apps/cli/cordis.yml)。

## 契约层（`/api`）

协议消息组成一个四象限可辨识联合：发起方 × 请求／响应，与物理通道解耦。四种消息分别是 `ClientRequest`（POST `/api/<method>` 的请求体）、`ServerResponse`（该 POST 的响应体）、`ServerRequest`（SSE 帧）和 `ClientResponse`（POST `/api/respond` 的请求体）。响应始终回显对应请求的 `rpcId`，绝不签发新值。方法的参数与返回值结构只存在于领域接口签名（`SessionsApi`、`HostApi`、`EventsApi`）中；`RpcMethodMap` 注册方法，其他所有位置均通过 `RequestPayload<K>`／`ResponseValue<K>` 派生。Zod schema 以 `satisfies z.ZodType<Wire<T>>` 锚定类型，并分两层解析：先解析信封，再解析业务载荷，随后按方法分发。业务错误由 `RpcResult` 的错误分支承载（`RpcErrorDetailsMap` 封闭错误码集合）；HTTP 状态只表达载体层结果。每个 `/api` POST 都必须声明 `application/json` 媒体类型——否则在分发前即以 415 拒绝，因此跨站"简单请求"（浏览器不经 CORS 预检就会发出）永远无法盲目执行有副作用的方法。

分层与协议决策记录在 [GUI 分层与 RPC 协议 RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)中；浏览器侧消费架构记录在 [Web 客户端架构 RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md)中。

`session.history` 的尾页（不带 `beforeSeq`）额外携带一个可选的 `projections` 块——`ctx.sessionProjections`（`@deepseek-ai/dsh-session-projection`）上每个已注册单元的水位线快照，`asOfSeq` = 这些值共同反映到的最后一个事件 seq（空日志为 `-1`）。网关还订阅注册表的变更流，为每个状态发生变化的单元铸造一个 `session/projection` mux 帧（`{sessionId, key, value, seq}`——实时推送状态，绝不入日志；客户端按 seq 高者胜维护一个按会话的通用值仓）。载体不持有任何领域知识（每个值在注册表内部已过其单元自己的 schema；协议 schema 对 `values`/`value` 保持宽松）；loadOlder 页永不携带该块，未装注册表的组合则两个面都不提供。

会话标题与其他所有领域一样搭乘这对通用投影机制——历史尾页的 `projections` 块外加 `title` 键下的 `session/projection` 帧（专设的 `session/title` 帧已下线）。标题不会加入 `session.list`；冷会话在其中仍只有元数据，直到打开或恢复操作附加其日志。`session.rename` 接受用户显式标题（冷会话先恢复），委托给 `ctx.sessionTitle.rename`——被接受的 `session/title` 事件将标题钉住、不再被自动生成覆盖——并返回规范化后的标题及其事件 seq，让 client 在推送帧到达前就结算自己的 `title` 投影格；规范化后为空的标题返回 `title-invalid`。

会话模型路由属于会话领域契约。`session.models` 返回选中的提供方／模型／推理（reasoning）目标，以及按提供方分组的建议性模型、精确路由推理元数据和逐提供方查询失败记录。`session.selectModel` 校验由适配器持有的可选推理强度，并替换将在下一提示词组装边界使用的完整目标。目录成员关系不构成校验：适配器可以解析未列出的模型，而不可用路由或不受支持的推理强度会返回 `model-unavailable`。

Workspace 列表与 Session 列表是相互独立的重连基线。`workspace.create` 会创建唯一名称或接纳现有目录，`workspace.delete` 只移除 Workspace 注册记录，`session.create` 接受可选的预分配 Session id，`host/workspace-changed`、`host/workspace-removed` 与 `host/session-added` 则以任意到达顺序携带已提交的增量。删除注册记录会保留目录和会话日志；相关 Session 仍留在 `session.list` 中，并进入 Ungrouped。`SessionSummary.blank` 与 `host/session-added` 帧携带派生的零事件位：客户端隐藏空白会话并按 workspace 复用它们，在首个 `host/session-status(running:true)` 时翻转 blank，并以 `session.list` 作为重连权威；冷会话摘要永远不是空白：惰性持久化让从未追加过事件的会话根本不出现在 `list()` 中。

目录选择委托给组合的 `ctx.directoryPicker` 后端（[目录选择 seam](../directory-picker/README.md)）；调用组合能力 kind 之外的方法会以 `directory-picker-unavailable` 失败（客户端不需要广播——组合的选择器包自己的 client half 渲染匹配的交互）。在 `native` 下，`host.pickDirectory` 打开一个原生选择器并返回选中路径（取消为 `null`）；该方法需等待用户完成操作，是唯一不受默认 30 秒超时限制的一元调用，调用方与连接的中止仍会传播至原生进程。在 `browse` 下，`host.listDirectory` 返回一个按名称排序的目录层级，携带面包屑祖先链、`home` 锚点与宿主判定的 `hidden` 标志（不带路径即家目录），`host.createDirectory` 创建一个经校验的子段；后端的类型化失败 1:1 映射为 `directory-unreadable`／`directory-exists`／`directory-create-failed` 错误码。浏览器载体的前缀级信任栅栏（dsh-client-connection）像覆盖其他所有 `/api` 请求一样覆盖上述全部方法。

`host.openPath` 会用操作系统的默认应用打开一个文件系统路径（macOS 为 `open`，Windows 为 `Invoke-Item`，Linux 为 `xdg-open`）。打开器可在测试中注入。浏览器载体对其施加与 `host.pickDirectory` 相同的回环、同源限制。

`command.*` 与 `skill.*` 领域向客户端暴露宿主命令注册表和技能目录。每个方法都通过 `sessionId` 寻址一个会话的 Agent（被服务的会话必有 Agent；`command.*` 经由与 `session.*` 相同的路径恢复冷会话，而 `skill.list` 从会话头解析项目根目录，不触碰 Agent 注册表）。`skill.list` 服务于浏览器中由用户选择的模型引用路径，因此仅返回模型和用户均可调用的 skill；该领域没有直接加载 skill 的 RPC。`command.execute` 在宿主侧运行一条斜杠命令行，语义为纯准入：响应报告该行是否解析到处理器，并在解析到时回带铸造的生命周期 `commandId`（将本次确认与流节点关联）；结局经由持久落账并在 mux 流广播的 `command/run`/`command/done` 生命周期事件对承载；载体的请求信号可取消正在运行的处理器。`host/commands-changed` 是目录失效帧：客户端重新拉取 `command.list` 而不是做差分。

## 载体层（`/client` + 根路径）

`AbstractApiClient` 持有全部协议不变量：签发 rpcId、包装／解包信封、Zod 解析、SSE 帧解码、一元请求超时，以及按微任务批处理的信封观测（`subscribeEnvelopes`）；平台子类只提供 `doFetch` 传输环节。`InProcessApiClient` 以 `toFetchHandler(api)` 为基础，是同构接点：它运行完整的协议序列化与校验路径而不经过网络，供 `dsh -p` headless 模式使用。

## 模型体验

无。该包定义客户端与宿主间的协议契约和载体，其中没有任何内容会进入模型请求。

#### KV 缓存影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

- **`respond` 路由已经发布，但待处理交互状态仍属宿主侧工作**：协议形状（POST `/api/respond`、`RpcReceipt`）已经定型；使延迟或重复回答具有明确语义的待处理表位于 `src/api-proxy.ts`，目前仍很精简（只支持问题，不支持审批）。
- **预留 seam 不进入 `RpcMethodMap`**：`session.fork`、`prompt.mode: 'inject'`、`task.list`、`host.listModels` 和描述字段 `hostInstanceId` 都是已记录的预留项；未知方法会在信封解析时直接失败，而不会返回「尚未实现」错误码。
- **没有协议版本字段**：客户端与宿主一同发布；只有出现独立发布的客户端后，`host.describe` 才会增加版本协商字段。
- **Linux 原生选择器依赖桌面工具**：在 `native` 能力下，Zenity 和 KDialog 均未安装时，`host.pickDirectory` 会给出包含解决建议的错误提示；组合层面的回退是 browse 后端（见 [native 后端 README](../directory-picker-native/README.md)）。
