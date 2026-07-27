# @deepseek-ai/dsh-client-runtime

[English](README.md) | 中文

客户端 cordis 启动与不依赖 React 的对象服务：SlotsService 包装 SlotCore 并提供 renderer 数据源；SessionsService 拥有 Session 对象、列表／scope／history 状态；WorkspacesService 依赖 SessionsService，拥有 Workspace 对象、列表／操作、默认目标派生，以及 New Session 空会话复用入口（`connectWorkspace`）。运行时把共享 Host 流分发给两个 manager。客户端 Session 一律由 Host 出生（一次 `session.create` 同瞬产出 Session+Agent+cwd）；客户端不持有任何实体化之前的会话状态——Agent scope（host dsh-scope 的客户端镜像，以 agent/session 共用 id 为键）在会话行进入列表镜像时出生，随 prune 死亡。契约：api-contracts v3 §4。

## Workspace 与 Session 列表

Workspace 和 Session 列表各自具有单调的 `pending` → `ready` 基线阶段，也有各自的刷新活动／错误状态。列表请求期间到达的增量帧会在其响应之上回放。第一次成功的基线建立 Host 顺序；后续刷新更新行和成员关系，但不改变已经显示的标识之间的相对顺序。Workspace 新近程度只在两条基线都 ready 后派生，且绝不改变 Workspace 列表顺序。

SlotsService 分别为 renderer 提供 `useSessions` 与 `useWorkspaces` 的裸 observable；web-react 创建 hook。Workspace 业务状态不会进入 `SessionListState` 或配置项 store。

## New Session 与 blank 镜像

`WorkspacesService.connectWorkspace(workspaceId)` 解析 New Session 流程最终落入的会话：先在列表镜像中复用该 workspace 的既有空会话（`blank && cwd == workspace.path`），未命中则调用 `session.create({workspaceId})`，返回会话 id 由调用方 open。`SessionSummary.blank` 镜像主机派生的空日志位，在客户端只降不升：由 `session.list`／`host/session-added` 帧播种，本地首次**受理成功**的 `prompt()`（RPC 成功响应时——受理即证明用户消息已入主机日志；首讯被拒则会话保持 blank、保持可复用）与任何 `running: true` 状态帧翻为 false，每次列表重拉重新对齐。列表表面隐藏 blank 行；store 保留全部行。`SessionsService.create` 接受可选的、由调用方预先分配的 SessionId，失败时抛出 `SessionCreateError`（携带 `requestedSessionId`）。

## Code Mode 子调用索引

`ConversationSnapshot.codeDispatches` 按父调用的 callId 和启动顺序，用原生调用块形状组织一个 `run_code` 调用的子调用：`tool/code-dispatch-start` 事件落成 `RunningToolCall` 形状（行组件从该形状推导运行中的转圈状态），其 `tool/code-dispatch` 完结事件原位替换为 `ToolResultNode` 形状，`callTime` 携带成对 start 事件的时间。start 落在回放窗口之外的完结事件则直接追加，`callTime: null`（耗时未知——绝不伪造零耗时）。live mux 帧与历史回放构建相同的索引；子调用永不进入 surface `nodes` 流；无关快照交换不会改变每个父调用对应的数组引用和映射引用，两者均保持 memo 稳定。

## Session 标题投影

`SessionManager` 独立于列表和 Session 实例到达情况，保留最近一次通过验证的 `session/title` 控制快照。seq 更新的事件会替换旧快照，标题时间戳计入列表新近程度；订阅基线会先丢弃 seq 超过其 `lastSeq` 的任何已保留标题，再接收可选的折叠标题。显式移除 Session 也会清除已保留标题。因此，面向客户端的 `SessionSummary.title` 只包含真实的持久标题；`displayTitle` 始终存在，并依次回退到 cwd basename 和 Session id。冷启动的持久会话会保持该回退值，直到打开或恢复会话，促使主机折叠并投影日志支持的标题。

## 模型体验

无。客户端运行时承载浏览器侧服务与 Session 对象层；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **`loader.unload` 是 stub（抛出 not-implemented）**：完整链路（fiber 释放 → 注册级联 → 样式移除）随 HMR 项目落地。
- **scope 拆卸由阶段驱动，目前只能有一个占用者**：已 staged 的 Session 精确跟随 `list.current`（staging 就是打开信号：事件窗口打开 ⟺ Session 位于 stage）；在 staged 状态下被移除的 Session，其 scope 会冻结保留，直到 stage 转向其他 Session，而非直到真实观察者数量降为零。解析（`provideInfo()`／`binding()`／`scope()`）只是纯寻址，可安全用于渲染。并发 pane 落地时，staged 状态可以扩展为多 pane 列表。
- **插件组合包从该包执行值导入时必须使用 `/client` 子路径**：裸包名不在 loader external 表中，会内联第二个模块实例；其私有 scope-tag Symbol 永远无法匹配（空状态 P0 事故复盘）。
