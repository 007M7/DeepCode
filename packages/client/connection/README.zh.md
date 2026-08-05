# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

协议消费层：客户端插件的 apply 会挂载 `ctx.connection`（共享 API 客户端 + 当前页面的 loopback 状态 + 单消费方流循环启动器）；导出表层携带协议约定类型、`AbstractApiClient` 抽象，以及循环的 sink／配置类型。浏览器载体以 HTTP POST 发送 unary／respond，并为 `events.mux` 与 `events.host` 各开一条只下行的 WebSocket；进程内载体满足同一双流抽象。Host half 持有唯一 `/api` route 及其 Fetch bridge；已注册的 TypeRT interceptor 会先认领自己的 Remote endpoint，未认领请求再回退 API Proxy。Loopback hostname 判定逻辑留在包内部：`/api` Host fence 与 WebSocket upgrade 会直接使用它，其他客户端插件则消费派生的 `ctx.connection.isLoopback` 状态。node 半侧的 `/api` 路由让特权方法集（`host.pickDirectory`、`host.openPath`，以及整个配置面——`settings.describe`/`openDocument`/`update`/`replace`/`mutate` 与 `credentials.describe`/`set`/`unset`；读取与原生操作也在内，因为 describe 会返回已暴露的配置、打开操作会作用于 Host 桌面，而探测任意引用会报出某条凭据来自何处）以空信任表过信任 fence，从而钉在回环——已声明的 `trustedHosts` 授权可达其余全部方法，而这些方法在真正的认证层出现之前仍只限回环本机。平台载体与 ConnectionController 循环属于包内部；apply 负责选择并驱动它们。下行边界见 [WebSocket 下行载体 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md)；协议约定见 api-contracts v3 §3。

## /api 浏览器信任栅栏

node 半侧在桥接或 upgrade 前守卫 `/api` 下的每个入口（`src/api-request-trust.ts`）。每个请求——无论是否带浏览器标记——`Host` 都必须是回环地址权威，或与某个 `trustedHosts` 条目匹配：带端口的 `host:port` 条目精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化后比较（DNS rebinding 防御）。刻意不为无浏览器标记的 HTTP 请求开捷径：明文 HTTP 下浏览器的图片与导航读取既不带 `Origin` 也不带 Fetch-Metadata，因此无标记请求仍可能是被重绑页面发起的、响应可被读走的读取，而 Host 是重绑唯一伪造不了的请求头；WebSocket 浏览器握手会带 `Origin` 并通过同一道比较。非浏览器客户端经由回环地址、CLI 推导的 LAN IP 字面量或已声明的权威通过同一道栅栏。当标记存在时，`Origin` 必须与 Host 权威完全一致；显式的 `sec-fetch-site: cross-site` 标记一律拒绝。不是纯的、规范形 `host[:port]` 权威的 `trustedHosts` 条目——即 WHATWG 解析读回后与原文不完全一致的——会让插件加载明确报错：否则解析会悄悄授权 `harness.internal/path` 这类笔误里的 hostname，或把悬空冒号、补零端口放大成任意端口授权。HTTP 失败在任何 RPC 分发之前以纯 403 应答，upgrade 失败在启动任何 event stream 前拒绝握手。因此非回环（`--host 0.0.0.0`）部署需要让自己的服务权威被信任：dsh CLI 会自行推导本机的 LAN IP 字面量，其 `--trusted-host` flag 用于声明具名权威，所以 cordis.yml 中的 `trustedHosts` 面向 CLI 不参与引导的组合。这道栅栏是可达性策略，而不是认证；Web 载体不提供认证层。决策记录：[api 浏览器信任边界 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md)。

## `/api` WebSocket 下行

`/api/events.mux` 与 `/api/events.host` 各接受一条 WebSocket upgrade，并只向浏览器发送对应的 `ServerRequest` text message；客户端不会在这些 socket 上发送业务数据。任一 socket 结束都会使当前 connection generation 失败并重建两条流，连接就绪仍要求两条 socket open 且 `host.describe` HTTP 调用成功。Host teardown 会终止两条 socket、中止各自的 source，并等待 source 清理完成后再返回。普通网络 GET 这些路径会返回 426，不保留 SSE 回退；`toFetchHandler` 的 SSE 编解码只服务进程内同构载体。

`SessionEventView` 是 `session.history` 条目与实时 `session/event` 帧上的可选、非持久 sidecar。工具 view 保持封闭的 call／result 形状；由 Host presentation 的持久事件则携带 `{ for: 'event', view }`，把兼容 JSON 的 payload 开放给领域插件，并由持久事件类型选择 renderer。同一个 Session event 可以再次投递并带有新增或变化的 sidecar，因此消费方会按完全一致的事件身份与 seq 合并，而不会把第二个帧当作另一次日志 append。

## 无密钥 fixture

任何 `fixture` 查询参数都会选择内存载体。`fixture=empty` 启动时不含 Workspace 或 Session；`fixturePrompt=reject` 在接受前拒绝提示词；`fixtureAttach=fail` 发布 Session 但拒绝将其附加到 Workspace；`fixtureSessionCreate=drop-response` 在丢弃创建响应前发布 Session 并为其发出帧；`fixtureFrames=workspace-first` 则反转默认的 Session 优先创建帧顺序。按名称／路径创建 Workspace 以及由调用方预先分配 SessionId，均具有足够的确定性，组装后的 Web 测试可以据此协调列表与帧的到达。fixture 内容搜索会保留面向生产环境的 `unicode61` 式大小写、变音符号和 token／短语行为，并返回以匹配位置为中心、最多包含 120 个 Unicode 码点的 snippet。

## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **History 会恢复未附加的会话**：打开 history 可能创建宿主侧 agent，并增加首次打开的延迟；没有仅从持久化读取的路径。
- **已附加 history 可能省略 commit-aware event view**：当 persistence inspect 不可用、失败或无法证明 identity-matching prefix 时，Host 仍会返回原始 live event，只会省略这些 sidecar。之后的持久 live 重投或 history 读取仍可补上它们。
- **工具专属 view 类型仍是过渡表面**：只要 Host 的工具 `viewFor` presenter 仍存在，`ToolEventView`／`ToolCallView`／`ToolResultView` 就继续导出。通用 presented-event 分支与此独立，并保持为领域插件的扩展形状。
