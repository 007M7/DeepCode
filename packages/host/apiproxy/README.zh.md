# @deepseek-ai/dsh-host-apiproxy

[English](README.md) | 中文

所有客户端形态共用的 API 网关：TS 契约（`src/api/`，不依赖 Node，可从浏览器导入）、fetch 载体对（`src/fetch/`：宿主侧的 `toFetchHandler`，以及客户端侧的 `AbstractApiClient` 与平台子类）和宿主侧实现（`src/api-proxy.ts`：`createApiProxy` 加上默认导出的 `ApiProxyService` 网关插件，其配置为 `{provider, model, workspaceRoot?}`，提供 `ctx.apiProxy`）。该包（package）在设计上与传输方式无关，不注册任何路由；载体（目前为 HTTP，未来可以是 IPC）自行包装 `ctx.apiProxy`。已发布的核心组合位于 [`apps/cli/config/base.cordis.yml`](../../../apps/cli/config/base.cordis.yml)。

## 契约层（`/api`）

协议消息组成一个四象限可辨识联合：发起方 × 请求／响应，与物理通道解耦。四种消息分别是 `ClientRequest`（POST `/api/<method>` 的请求体）、`ServerResponse`（该 POST 的响应体）、`ServerRequest`（SSE 帧）和 `ClientResponse`（POST `/api/respond` 的请求体）。响应始终回显对应请求的 `rpcId`，绝不签发新值。方法的参数与返回值结构只存在于领域接口签名（`SessionsApi`、`HostApi`、`EventsApi`）中；`RpcMethodMap` 注册方法，其他所有位置均通过 `RequestPayload<K>`／`ResponseValue<K>` 派生。Zod schema 以 `satisfies z.ZodType<Wire<T>>` 锚定类型，并分两层解析：先解析信封，再解析业务载荷，随后按方法分发。业务错误由 `RpcResult` 的错误分支承载（`RpcErrorDetailsMap` 封闭错误码集合）；HTTP 状态只表达载体层结果。每个 `/api` POST 都必须声明 `application/json` 媒体类型——否则在分发前即以 415 拒绝，因此跨站"简单请求"（浏览器不经 CORS 预检就会发出）永远无法盲目执行有副作用的方法。

分层与协议决策记录在 [GUI 分层与 RPC 协议 RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)中；浏览器侧消费架构记录在 [Web 客户端架构 RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md)中。

`session.history` 按追加来源的消息边界分页：`maxMessages` 统计以追加方式进入 surface 的 `user/message`、`assistant/message` 和 `steering/message` 事件，因此仅供模型使用的替换副本不占用配额。每一页仍是一段连续的原始事件区间，从而让压缩（compaction）的仅日志溯源信息与引用它的替换留在同一页。

`session.history` 的尾页（不带 `beforeSeq`）额外携带一个可选的 `projections` 块——`ctx.sessionProjections`（`@deepseek-ai/dsh-session-projection`）上每个已注册单元的水位线快照，`asOfSeq` = 这些值共同反映到的最后一个事件 seq（空日志为 `-1`）。网关还订阅注册表的变更流，为每个状态发生变化的单元铸造一个 `session/projection` mux 帧（`{sessionId, key, value, seq}`——实时推送状态，绝不入日志；客户端按 seq 高者胜维护一个按会话的通用值仓）。载体不持有任何领域知识（每个值在注册表内部已过其单元自己的 schema；协议 schema 对 `values`/`value` 保持宽松）；loadOlder 页永不携带该块，未装注册表的组合则两个面都不提供。

会话标题与其他所有领域一样搭乘这对通用投影机制——历史尾页的 `projections` 块外加 `title` 键下的 `session/projection` 帧（专设的 `session/title` 帧已下线）。标题不会加入 `session.list`；冷会话在其中仍只有元数据，直到打开或恢复操作附加其日志。`session.rename` 接受用户显式标题（冷会话先恢复），委托给 `ctx.sessionTitle.rename`——被接受的 `session/title` 事件将标题钉住、不再被自动生成覆盖——并返回规范化后的标题及其事件 seq，让 client 在推送帧到达前就结算自己的 `title` 投影格；规范化后为空的标题返回 `title-invalid`。

`session.fork` 将可选事件锚点映射到该锚点处或其后的首个 `turn/end`，使消息操作可包含该消息所在的完整轮次。锚点省略或超过末尾时，选择最后一个已完成轮次；若锚点已在日志中，而其所在轮次仍开放，则返回 `fork-unavailable`，不会向较早位置裁剪。发布后的子会话会先继承源会话的种子历史、cwd、日志中最新的提供方／模型／推理（reasoning）目标及谱系，再加入源 Workspace。如果附加到 Workspace 失败，`workspace-attach-failed` 会携带已发布的子会话 id，供客户端对账。[SessionStore fork 决策](../../../.agents/notes/implemented/feature/2026-06-30-session-store-fork-api.md)给出边界设计的理由。

会话模型路由属于会话领域契约。`session.models` 返回选中的提供方／模型／推理目标，以及按提供方分组的建议性模型、精确路由推理元数据和逐提供方查询失败记录。`session.selectModel` 校验由适配器持有的可选推理强度，并替换将在下一提示词组装边界使用的完整目标。目录成员关系不构成校验：适配器可以解析未列出的模型，而不可用路由或不受支持的推理强度会返回 `model-unavailable`。

待处理的 queued 输入属于实时控制平面契约，而非会话历史。网关镜像来自 `agent/inbox/*` 的 queued `InboxItem` 入队项，并在每次 queued 变更和重连时广播权威的 `session/queue` 快照；待处理 steering（中途引导）不进入此 Web 投影。`session.updateQueue` 通过 `InboxItemId` 寻址单个项：编辑会替换待处理内容，移除会将其丢弃。驱动器在接纳前退役寻址标识，因此认领会赢得竞态；之后的操作返回 `queue-item-not-found`。该操作只查询当前已挂载的 Agent，绝不恢复冷会话，因为进程本地 inbox 标识无法在重启或资源释放后存活。客户端绝不根据轮次或状态事件推断项已退役。

Workspace 列表与 Session 列表是相互独立的重连基线。`workspace.create({ name })` 会在配置根目录下创建显示标题唯一的目录，而 `workspace.create({ path })` 会接纳已有的规范目录，并允许由 basename 派生的标题重复。`workspace.delete` 只移除 Workspace 注册记录，`session.create` 接受可选的预分配 Session id，`host/workspace-changed`、`host/workspace-removed` 与 `host/session-added` 则以任意到达顺序携带已提交的增量。`workspace.archiveSession` 向注册表级全局归档集合添加一个会话，并应答完整的更新后集合；`workspace.list` 携带该集合作为重连基线，`host/archived-sessions-changed` 在每次持久变更后推送完整快照。归档只把会话从各分组视图中隐藏，不触碰其日志和 workspace 记账；既非实时也未持久化的会话以 `session-not-found` 失败。删除注册记录会保留目录和会话日志；相关 Session 仍留在 `session.list` 中，并进入 Ungrouped。`SessionSummary.blank` 与 `host/session-added` 帧携带派生的零事件位：客户端隐藏空白会话并按 workspace 复用它们，在首个 `host/session-status(running:true)` 时翻转 blank，并以 `session.list` 作为重连权威；冷会话摘要永远不是空白：惰性持久化让从未追加过事件的会话根本不出现在 `list()` 中。

`session.search` 是以 `session.list` 所列会话为范围的有界内容搜索投影。网关向可选的 `ctx.sessionQuery` 服务请求全局排序后的当前 surface user、assistant 和 steering（中途引导）匹配项，并持续消费该结果流，直到获得至多 20 个可见会话／snippet 对及一个前瞻项；返回前仍会依据从列表推导的授权集合重新校验每个命中。提供方分页初始请求 20 个命中；如果第一页请求因这一上限被拒绝，网关会依次探测 10、5、2、1，并在续传和陈旧世代重启中沿用探测所得的页面大小。返回的 snippet 最多包含 240 个 Unicode 码点，响应 schema 则会在每个客户端边界独立强制执行该上限。将授权集合保留在宿主内存中，可在不削弱可见性或排序的前提下避开有效大型语料库的 SQLite 变量上限。

陈旧的续传会丢弃该提供方尝试中的所有部分结果、去重条目和游标，然后依据最初从列表推导的可见性快照从第一页重新开始，但不会丢弃探测所得的提供方页面大小。上限探测与陈旧重试共用最多 100 次提供方调用的限制（因此最多检查 2,000 个命中）；如果某页命中数超过其请求的上限、续传游标重复，或用尽该调用预算后结果流仍未耗尽，都会直接返回 `internal` 业务错误，不返回部分结果。载体请求信号可取消持久化列表枚举、冷会话摘要收集和每一次搜索调用；即使同时收到上限拒绝或陈旧拒绝，也以取消为准。部署若未挂载该服务，或索引／查询故障无法恢复，也会返回 `internal` 业务错误，以便客户端保留仅基于元数据的匹配项。

目录选择委托给组合的 `ctx.directoryPicker` 后端（[目录选择 seam](../directory-picker/README.md)）；调用组合能力 kind 之外的方法会以 `directory-picker-unavailable` 失败（客户端不需要广播——组合的选择器包自己的 client half 渲染匹配的交互）。在 `native` 下，`host.pickDirectory` 打开一个原生选择器并返回选中路径（取消为 `null`）；该方法需等待用户完成操作，不使用默认的 30 秒一元调用超时，而调用方与连接的中止仍会传播至原生进程。在 `browse` 下，`host.listDirectory` 返回一个按名称排序的目录层级，携带面包屑祖先链、`home` 锚点与宿主判定的 `hidden` 标志（不带路径即家目录），`host.createDirectory` 创建一个经校验的子段；后端的类型化失败 1:1 映射为 `directory-unreadable`／`directory-exists`／`directory-create-failed` 错误码。浏览器载体的前缀级信任栅栏（dsh-client-connection）像覆盖其他所有 `/api` 请求一样覆盖上述全部方法。

`host.openPath` 会用操作系统的默认应用打开一个文件系统路径（macOS 为 `open`，Windows 为 `Invoke-Item`，Linux 为 `xdg-open`）。打开器可在测试中注入。浏览器载体对其施加与 `host.pickDirectory` 相同的回环、同源限制。

`command.*` 与 `skill.*` 领域向客户端暴露宿主命令注册表和技能目录。每个方法都通过 `sessionId` 寻址一个会话的 Agent（被服务的会话必有 Agent；`command.*` 经由与 `session.*` 相同的路径恢复冷会话，而 `skill.list` 从会话头解析项目根目录，不触碰 Agent 注册表）。`skill.list` 服务于浏览器中由用户选择的模型引用路径，因此仅返回模型和用户均可调用的 skill；该领域没有直接加载 skill 的 RPC。`command.execute` 在宿主侧运行一条斜杠命令行，语义为纯准入：响应报告该行是否解析到处理器，并在解析到时回带铸造的生命周期 `commandId`（将本次确认与流节点关联）；结局经由持久落账并在 mux 流广播的 `command/run`/`command/done` 生命周期事件对承载。命令处理器运行超过 30 秒的传输健康时限仍属正常，因此 `command.execute` 仅携带调用方／连接取消信号；该信号可取消正在运行的处理器。`host/commands-changed` 是目录失效帧：客户端重新拉取 `command.list` 而不是做差分。

`settings.*`、`credentials.*` 与 `llm.*` 领域是配置页协议。settings 领域服务于已注册可配置提供方所指向的 namespace（`ctx.llm.listConfigurableProviders()`），并额外服务于一份小型、显式的 allowlist——Web 偏好 `permission` 与产品持有的 `ui-onboarding`；仅新增一项 Settings 注册，绝不会使其可被远程读取或写入。其他任何 namespace 都只会得到 `settings-not-exposed`——未注册的 namespace 得到的是同一个答复，因此没有调用方能靠逐个探测把注册表枚举出来。`settings.describe` 为每个已暴露 namespace 提供其序列化 schemastery schema、脱敏后的分层值（resolved/`base`/`user`——字段出现在 `user` 中即标记其被用户覆盖）、`secrets` 槽位列表，以及该分节的 `revision`。`settings.update`/`settings.replace` 写入用户层；`settings.mutate` 则在已存分节上施加路径 op（`set`/`unset`），这是持有脱敏视图的客户端的删除路径——据此重建分节再整体替换，会删掉协议从未回传过的那些机密。任何写入都可携带 `expectedRevision`；过期的期望值会以 `settings-conflict` 连同两个 revision 作答，而不是覆盖先落地的那个写方，其余每种 seam 拒绝则折叠为 `settings-rejected`。secret 角色的值绝不在任何一层搭乘任何响应；secret 只沿一个方向跨越协议——在 `update`/`mutate` 载荷或 `credentials.set` 之内。`credentials.describe` 返回不含值的视图（`configured`/`source`/`writable`），`credentials.set`/`credentials.unset` 则把被遮蔽引用的拒绝映射为 `credential-rejected`。`llm.providers` 把可配置提供方目录与存活路由合并（休眠条目携带 `active: false`；未声明的存活路由追加在后，不带 settings 地址），`llm.models` 则是与会话无关的目录。三个失效帧让每个面无需轮询即保持收敛：`host/settings-changed {ns}`（`settings/document-updated` 透传，因此解析值未变的原始变更同样能到达客户端）、`host/credentials-changed {ref}`（只带引用名，绝不带值），以及 `host/models-changed`——它由 `llm/adapters-updated` 和可配置提供方 namespace 的变更触发，因为该提供方的设置正承载着它的目录与端点；`permission` 或 `ui-onboarding` 变更只会发出自身的 settings 失效通知。浏览器载体把整个配置面（含读取：`settings.describe`/`update`/`replace`/`mutate` 与 `credentials.describe`/`set`/`unset`）限制为仅接受来自回环地址的同源请求——即 `host.pickDirectory` 所在的特权集合。未装 settings 或凭据 provider 的组合会以指名缺失插件、包含解决建议的 `internal` 错误应答这些领域。

## 载体层（`/client` + 根路径）

`AbstractApiClient` 持有全部协议不变量：签发 rpcId、包装／解包信封、Zod 解析、SSE 帧解码、一元请求超时，以及按微任务批处理的信封观测（`subscribeEnvelopes`）；平台子类只提供 `doFetch` 传输环节。`InProcessApiClient` 以 `toFetchHandler(api)` 为基础，是同构接点：它运行完整的协议序列化与校验路径而不经过网络，供 `dsh -p` headless 模式使用。

## 模型体验

无。该包定义客户端与宿主间的协议契约和载体，其中没有任何内容会进入模型请求。

#### KV 缓存影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

- **`respond` 路由已经发布，但待处理交互状态仍属宿主侧工作**：协议形状（POST `/api/respond`、`RpcReceipt`）已经定型；使延迟或重复回答具有明确语义的待处理表位于 `src/api-proxy.ts`，目前仍很精简（只支持问题，不支持审批）。
- **预留 seam 不进入 `RpcMethodMap`**：`prompt.mode: 'inject'`、`task.list` 和描述字段 `hostInstanceId` 都是已记录的预留项（先前预留的 `host.listModels` 已作为 `llm.models` 交付）；未知方法会在信封解析时直接失败，而不会返回「尚未实现」错误码。
- **没有协议版本字段**：客户端与宿主一同发布；只有出现独立发布的客户端后，`host.describe` 才会增加版本协商字段。
- **搜索失败会包含提供方诊断信息**：网关是单用户本地服务。将其暴露给多名用户的载体必须用可安全公开的诊断信息替代内部搜索细节。
- **Linux 原生选择器依赖桌面工具**：在 `native` 能力下，Zenity 和 KDialog 均未安装时，`host.pickDirectory` 会给出包含解决建议的错误提示；组合层面的回退是 browse 后端（见 [native 后端 README](../directory-picker-native/README.md)）。
- **冷会话的 `updatedAt` 会把一次单纯的拾起算作写入（仅逐文件后端）**：已附加投影排除了 `session/end-seed` 边界，因为接手一个会话不算活动；但冷会话的 `updatedAt` 取自其日志文件的 mtime，而每一次持久写入都会刷新它，包括这条边界。`agentFor()` 会在首次触碰时恢复一个冷会话，因此在客户端里仅仅打开一个会话就会写入它。这只适用于 `locate()` 能解析出逐会话产物的场景，即 JSONL；SQLite 返回 `undefined`，因此它的冷会话回退到 `createdAt`，偏差方向相反——偏旧而不是偏新——且与这条边界无关。于是一个被触碰过却没有在里面工作过的会话，在重新附加之前会按晚于其最后一次真实活动的时间排序。要把两者区分开需要读取日志，而这恰恰是 mtime 路径存在的目的；在索引中存储一个最后活动字段可以从源头修好它，范围见[最后活动索引 Agent Note（agent 决策记录）](../../../.agents/notes/proposed/architecture/2026-07-29-durable-last-activity-index.md)。
