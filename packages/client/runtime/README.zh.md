# @deepseek-ai/dsh-client-runtime

[English](README.md) | 中文

客户端 cordis 启动与不依赖 React 的对象服务：SlotsService 包装 SlotCore 并提供 renderer 数据源；SessionsService 拥有 Session 对象以及 Chat 所需的列表、scope 和事件窗口状态；SessionHistoryService 为检查类消费方惰性拥有彼此独立的原始历史账本；WorkspacesService 依赖 SessionsService，拥有 Workspace 对象、列表／操作、默认目标派生，以及 New Session 空会话复用入口（`connectWorkspace`）。运行时把共享 Host 流分发给 Session、Workspace 和已激活的历史数据所有者，不让检查状态经过 Session 或 SessionManager，并把注册表失效帧桥接为类型化 ctx 事件（`commands/changed`、`settings/changed`、`credentials/changed`、`models/changed`），使各表面缓存无需触碰流即可重拉。客户端会话一律由 Host 创建（一次 `session.create` 同时产生 Session、agent（智能体）和 cwd）；客户端不持有任何实体化之前的会话状态——agent scope（host dsh-scope 的客户端镜像，以 agent/session 共用 id 为键）在会话行进入列表镜像时创建，并随 prune 销毁。契约：api-contracts v3 §4。每个 `Session` 持有一个通用的 `ProjectionValueStore`，由历史记录尾部的 `projections` 块播种，并经 `session/projection` 帧按 seq 高者胜更新；领域键（含 `todos`）经 `projections.faceOf`／`useProjection` 读取，不经 `ConversationSnapshot`。

## Workspace 与 Session 列表

Workspace 和 Session 列表各自具有单调的 `pending` → `ready` 基线阶段，也有各自的刷新活动／错误状态。列表请求期间到达的增量插入或更新／移除帧与一元变更回显会在其响应之上回放。第一次成功的基线建立 Host 顺序；后续刷新更新行和成员关系，但不改变已经显示的标识之间的相对顺序。已移除的 Workspace id 会保留进程本地删除标记，避免延迟到达的 changed 帧将其复活；重连仍以 `workspace.list` 作为基线。Workspace 新近程度只在两条基线都 ready 后派生，且绝不改变 Workspace 列表顺序。

`WorkspacesService.delete(workspaceId)` 在一元响应成功后从客户端投影中移除注册记录；对应的 `host/workspace-removed` 帧具有幂等性，并负责同步其他标签页。Session 状态与当前 Session selection 相互独立，因此 Workspace 消失后，其已纳入客户端投影的 Session 会立即投影到 Ungrouped 下。

`WorkspaceListState.archivedSessionIds` 镜像 Host 的注册表级全局归档集合（一个按 Host 顺序的 `readonly SessionId[]`，仅在成员变化时才替换；需要 O(1) 查询的消费方自建临时 Set）。它是全快照状态：`workspace.list` 基线、`archiveSession` 一元回声和 `host/archived-sessions-changed` 帧各自安装完整集合。`WorkspacesService.archiveSession(sessionId)` 通过 wire 归档；投影层在当前 selection 落入归档集合时统一清空为 New Session 视图状态——一条规则同时覆盖本地回声、其他标签页的帧、以及重连基线恢复出一个离线期间被归档的 selection。在 `workspace.list` 请求进行中安装的集合还会取代该过期基线携带的集合。各分组视图在所有位置隐藏集合成员，而会话行本身仍留在列表 store 中。

SlotsService 分别为 renderer 提供 `useSessions` 与 `useWorkspaces` 的裸 observable；web-react 创建钩子。Workspace 业务状态不会进入 `SessionListState` 或配置项 store。

`SessionsService.search(query, signal)` 是基于 `session.search` RPC 的无状态单次操作。它返回经过排序的会话／snippet 对，但不会将查询条件、加载状态或错误状态写入共享 Session 列表，因此每个 UI 所有者都自行负责防抖、取消、抑制陈旧响应和回退呈现。`searchResultLimit` 将 `SESSION_SEARCH_RESULT_LIMIT`——即响应 schema 自身强制执行的上限——作为注入的呈现数据重新公开，使客户端插件无需复制该值。它是协议常量而非逐连接状态，因此连接 handle 不携带它。

## New Session 与 blank 镜像

`WorkspacesService.connectWorkspace(workspaceId)` 解析 New Session 流程最终落入的会话：先在列表镜像中复用该 workspace 的既有空会话（`blank && cwd == workspace.path`），未命中则调用 `session.create({workspaceId})`，返回会话 id 由调用方 open。`SessionSummary.blank` 镜像主机派生的空日志位，在客户端只降不升：由 `session.list`／`host/session-added` 帧播种，本地首次获 Host 接受的 `prompt()`（RPC 成功响应时——受理即证明用户消息已入主机日志；首讯被拒则会话保持 blank、保持可复用）与任何 `running: true` 状态帧翻为 false，每次列表重拉重新对齐。列表界面隐藏 blank 行；store 保留全部行。`SessionsService.create` 接受可选的、由调用方预先分配的 SessionId，失败时抛出 `SessionCreateError`（携带 `requestedSessionId`）。

## 待处理队列投影

`ConversationSnapshot.queue` 是 Host 提供的权威瞬态 Queue 快照；待处理 steering（中途引导）不进入此投影。每行都携带其 `InboxItemId`、所有内容块均为文本时的完整可编辑文本，以及扁平化预览。`session/queue` 会整体替换该投影；重连缓冲只保留最新快照，持久轮次事件和 running 状态变化都不会猜测某个项已被认领。`Session.updateQueue()` 发送编辑／移除操作，不进行乐观更新，因此下一份 Host 快照是唯一可见的提交结果，认领竞态则会返回 `queue-item-not-found`。

## Code Mode 子调用索引

`ConversationSnapshot.codeDispatches` 按父调用的 callId 和启动顺序，用原生调用块形状组织一个 `run_code` 调用的子调用：`tool/code-dispatch-start` 事件落成 `RunningToolCall` 形状（行组件从该形状推导运行中的转圈状态），其 `tool/code-dispatch` 完结事件原位替换为 `ToolResultNode` 形状，`callTime` 携带成对 start 事件的时间。start 落在回放窗口之外的完结事件则直接追加，`callTime: null`（耗时未知——绝不伪造零耗时）。live mux 帧与历史回放构建相同的索引；子调用永不进入 surface `nodes` 流；无关快照交换不会改变每个父调用对应的数组引用和映射引用，两者均保持 memo 稳定。

## Session 标题投影

`SessionManager` 独立于列表和 Session 实例到达情况，保留最近一次通过验证的 `session/title` 控制快照。seq 更高的事件会替换旧快照，标题时间戳计入列表新近程度；订阅基线会先丢弃 seq 超过其 `lastSeq` 的任何已保留标题，再接收可选的折叠标题。显式移除 Session 也会清除已保留标题。因此，面向客户端的 `SessionSummary.title` 只包含实际的持久化标题；`displayTitle` 始终存在，并依次回退到 cwd basename 和 Session id。冷态持久化会话会保持该回退值，直到打开或恢复会话，促使主机折叠并投影由日志支撑的标题。`ISession.rename` 用 unary 响应中的 `{title, seq}` 直接结算 `title` 投影格，遵循同一 seq 高者胜规则——列表行和所有 `useProjection('title')` 读者在推送帧到达前即更新；推送帧随后重放同一 seq 时为无操作。

## 模型重试投影

Session 对象会在事件 wire 边界依据生产方的完整字段契约，验证由插件负责、按提供方路由的 `llm/retry` 载荷，包括计时器、整数、状态、提供方延迟和非空诊断字段的边界。有效事件会移除对应失败步骤的流式输出片段，并在该事件的序列位置插入一条持久的重试提示。该提示在后续重试轮次开始前为 `scheduled`；源轮次中止或释放会将其标记为 `cancelled`，重试轮次则会将其标记为 `started`。normal mode 提示携带其有限上限；always mode 提示则保持显式无界。窗口重建与历史回放应用相同的投影，因此刷新后，来自已丢弃尝试的日志分片绝不会重新显示为中断回复。没有 `llm/retry` 的终止轮次保留现有行为：可见但尚未定稿的输出会冻结为中断的 assistant 节点。

## 会话 fork

`ISessions.fork({sessionId, atSeq?, increaseTitle?})` 只在子会话摘要已能在本地寻址后才完成；该摘要携带源会话的谱系和 cwd，且 `blank: false`，由调用方决定是否打开。`increaseTitle: true` 会在 client 端把源会话的持久化标题改名到子会话：尾部 `(N)` 或 `（N）` 递增并保留括号样式，其余标题追加 ` (1)`；源会话没有持久化标题时跳过改名，改名失败时拒绝 promise 但保留已创建的子会话。该选项不会进入 Host fork 请求。即使响应为 `workspace-attach-failed`，其中仍会标识 Host 已发布的子会话，因此 `SessionManager` 会先将这一部分成功对账，再让 `SessionForkError` 到达调用方，避免重试创建重复的子会话。

## 会话模型选择

每个常驻 `Session` 都拥有一个 `modelSelection` 快照，其中包含当前提供方/模型目标、按提供方分组的目录、逐提供方失败记录，以及 `idle`／`loading`／`ready`／`selecting`／`error` 状态。历史记录会建立或刷新当前目标，打开选择器会刷新目录；选择失败会保留上一个目标和可用分组。目录与选择操作共用单调递增的代次，因此较旧响应无法覆盖较新的选择。重连重建会恢复 Host 报告的目标，同时不替换未变化的选择子结构。

## 模型体验

无，因为会话对象层会选择后续 Host 请求使用的提供方/模型路由，但不添加任何模型可见内容。

#### KV Cache 影响

更改目标可能改变提供方侧的缓存复用，或使其失效；该包（package）本身不会改变提示词前缀。

## 已知限制与暂缓事项

- **`loader.unload` 是 stub（抛出 not-implemented）**：完整链路（fiber dispose（资源释放） → 注册级联 → 样式移除）随 HMR（热模块替换）项目落地。
- **scope 拆卸由阶段驱动，目前只能有一个占用者**：已 staged 的会话精确跟随 `list.current`（staging 就是打开信号：事件窗口打开 ⟺ 会话位于 stage）；在 staged 状态下被移除的会话，其 scope 会冻结保留，直到 stage 转向其他会话，而非直到真实观察者数量降为零。解析（`binding()`／`scope()`）只是纯寻址，可安全用于渲染；渲染层经 `currentProvideInfo` observable 读取当前 bundle。并发 pane 落地时，staged 状态可以扩展为多 pane 列表。
- **插件组合包从该包导入值时必须使用 `/client` 子路径**：裸包名不在 loader externals 表中，会内联第二个模块实例；其私有 scope-tag Symbol 永远无法匹配。这是空状态 P0 的事故复盘（postmortem）所记录的问题。
