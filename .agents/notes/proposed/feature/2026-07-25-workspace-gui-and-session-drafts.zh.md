# Agent Note: Workspace GUI and session drafts

[English](2026-07-25-workspace-gui-and-session-drafts.md) | 中文

Status: proposed

## Problem

[Domain KV storage 与 Workspace entity](../architecture/2026-07-24-domain-kv-storage-and-workspace.md)定义了 Workspace 的持久实体、路径规范和有序 session 账本，但没有定义 Host 接线、历史数据初始化或 GUI 动线。GUI 同时显示 Workspace 和 Session，并且用户进入 New Session 页面后必须立即输入，即使此时还没有真实 Session，甚至没有真实 Workspace。

若用一个 intent 同时表示待创建 Workspace 和待创建 Session，显式 Create Workspace、自动零态、sidebar draft 行和首发失败会共享一组含混状态。若为了解决零态而提前创建 Host Session，又会产生没有用户输入、首个事件前不落盘且重启即消失的空 Session。现有历史 Session 还只有 `SessionHeader.cwd`，需要在不读取事件正文的前提下建立一次初始 Workspace 视图。

## Proposal

### 状态与所有权

Workspace 与 Session 是两个真实 Host 对象；WorkspaceDraft 与 SessionDraft 是两个 page-local Client 状态：

- `Workspace` 可以为空，持久存在并始终显示在 sidebar；
- `Session` 是已经由 Host 创建的真实对象；
- `WorkspaceDraft` 只用于“系统完全没有 Workspace”的自动零态，不显示在 sidebar；
- `SessionDraft` 表示一个待创建 Session，持有目标 Workspace 或 WorkspaceDraft、预分配 SessionId、composer 内容和发送 phase。

页面至多存在一个 SessionDraft。真实 Workspace 下的 draft 在 sidebar 显示为 “New session”；WorkspaceDraft 及其 SessionDraft 都不显示。新 draft 替换旧 draft；选择真实 Session 或刷新页面会丢弃未物化 draft 和未提交输入。真实 Workspace、真实 Session 和已经接受的消息不受影响。

Client 用判别联合 `ConversationStage = Session | SessionDraft` 表达当前页面，不再用“清空 current 再另存 intent”模拟草稿。Workspace、Session 和 ConversationStage 各有独立对象层；只有真实 Session selection 可以持久化。

### Host 与 wire 全链路

Host 在现有 Workspace entity 上提供以下 GUI 接线：

| RPC | 行为 |
| --- | --- |
| `workspace.list` | 返回稳定有序的真实 Workspace，并过滤未通过 header 校验的 session id |
| `workspace.create({ name })` | 名称未被占用时在 `workspaceRoot/name` 建目录并创建 Workspace；重名请求失败 |
| `workspace.create({ path })` | 收编已经存在的目录，不为任意输入路径建目录 |
| `session.create({ workspaceId, sessionId? })` | 从 Workspace 解析 cwd，以可选预分配 id 幂等创建真实 Session 并 attach |
| `session.create({ cwd })` | 保留给非 GUI 调用方，创建 Ungrouped Session |

`workspaceRoot` 是独立 Host 配置，未配置时回退到 Host cwd；它与保存 Workspace domain 数据的 `storageRoot` 无关。Host stream 推送 Workspace 和 Session 增量，重连以 `workspace.list` 与 `session.list` 两份基线为准。

GUI 在 SessionDraft 中预分配 SessionId，但首次发送前不创建任何 Host intent。首次发送时，Client 才把该 id 传给 `session.create`；Host 用同一 id 创建真实 Session 和 persistence create-intent。相同 id、相同 cwd 的重试幂等；id 已存在但 cwd 不同则 fail loud。这样响应丢失和 attach 部分失败都能对账到同一个 Session，而不是重复创建。

Workspace 的 `sessionIds` 是有序候选索引。读取成员必须同时满足 id 在索引中且 `SessionHeader.cwd` canonical 后等于 Workspace path；SessionHeader 不增加 `workspaceId`。cwd 匹配但未入索引的 Session 仍是 Ungrouped，索引命中但 header 缺失或 cwd 不匹配的 id 不进入投影。同一 Session 出现在两个 Workspace 索引中属于损坏状态并 fail loud。

### 一次性历史初始化

Workspace domain 用 durable marker 区分“从未初始化”和“已初始化但为空”。marker 未设置时，WorkspaceRegistry 执行一次可重入 bootstrap：

1. 只调用一次 `SessionPersistence.list()`；JSONL 只读 header 首行，SQLite 只读 session 元数据行，禁止调用 `load`、`inspect`、history 或解析事件正文。
2. 忽略无 cwd、目录不存在、非目录或 realpath 失败的 header；这些 Session 留在 Ungrouped。
3. 按 canonical cwd 分组，组内按 header `createdAt` 降序写入 `sessionIds`，Workspace 组按各组最大 `createdAt` 降序写入稳定顺序。
4. 崩溃重入时按 canonical path 复用已经写入的 Workspace 并合并缺失 id；全部记录 durable 后最后写 marker。

marker 写入后不再按 cwd 自动建 Workspace 或补账。后续绕过 `workspaceId` 的调用链保持 Ungrouped；这是一条兼容路径，不是持续派生 Workspace 的第二写源。

### 用户动线

应用首次进入时，Client 等待 Workspace 与 Session 两份基线都 ready；仍存在的真实 Session selection 可以恢复，否则进入 New Session 流程。用户显式进入 New Session 时不恢复旧 selection，而是选择最近 Workspace 并创建 SessionDraft。最近 Workspace 取其已验证成员 Session 的最大 `updatedAt`；空 Workspace 回退到 `createdAt`。该值只决定 New Session 的默认目标，不改变 sidebar 的 Workspace 顺序，也不会在 Session list 到达后触发二次选择。

完全没有 Workspace 时，页面创建名为 `workspace` 的 WorkspaceDraft 和其 SessionDraft。它们不写 Host，但 composer 始终可输入。顶部 New Session 重新进入该零态选择流程，不立即调用 `session.create`。

Sidebar Workspace 区头加号和 composer 的 Workspace 创建入口复用同一个 picker 与 modal：

- 选择已有 Workspace：只创建指向该 Workspace 的 SessionDraft；
- Use an existing folder：调用 `workspace.create({ path })`，成功后创建其下的 SessionDraft；
- Create new：用一个输入同时作为目录名和 title；UI 对已有 Workspace title 禁止确认，Host 拒绝绕过 UI 或并发产生的重名请求；成功后创建其下的 SessionDraft。

显式 Create Workspace 在用户确认时立即产生真实 Workspace，并立即显示在 sidebar；即使用户不发送消息，也会留下空 Workspace。Workspace 行内加号只创建该组下的 SessionDraft，不创建另一个 Workspace，也不立即创建 Host Session。

发送首条消息时依次执行：必要时创建 Workspace、以预分配 id 创建 Session、把 stage 和 composer buffer 转交给真实 Session、调用 `session.prompt`。只有 Host 接受 prompt 后才清空输入。Workspace 已创建后失败则保留 Workspace；Session 已发布后失败则保留并聚焦真实 Session；prompt 失败则保留原输入并重试同一 Session。

### Sidebar 与排序

Workspace 组使用 Host 返回的持久稳定顺序。Bootstrap 一次性确定历史顺序，显式创建的新 Workspace 放到首位；Session 活跃不会移动 Workspace 组。

组内严格按 `Workspace.sessionIds` 渲染。历史 Session 以 header `createdAt` 初始化，新 Session 放到首位；此后某个 Session 的 `updatedAt` 前进时，Host 只把该 id 移到所属 Workspace 的首位并持久化。Client 不在 Session list hydration 后按 `updatedAt` 批量排序，因此页面不会先显示 bootstrap 顺序再整体跳动。

SessionDraft 是渲染层附加行，不写入 `sessionIds`。真实 Workspace 下存在 SessionDraft 时，sidebar 的页面派生 session 数量临时加一；同 id 的真实 Session 出现后不能重复计数，刷新后 draft 与临时计数一起消失。`host/session-added` 与 `host/workspace-changed` 可能以任意顺序到达；Client 按预分配 SessionId 合并，并在真实行可定位后移除 draft，不能短暂显示两个同 id 行。

### Client 与 UI 边界

独立 WorkspacesService 管理 Workspace list phase、增量 upsert、重连 refresh、create 和最近 Workspace 派生；SessionsService 只管理真实 Session list、Session scope、history、running 状态与真实 selection；page-local conversation coordinator 管理 ConversationStage、SessionDraft、物化 phase、错误和 composer buffer 转交。

现有 sidebar 布局、行样式、EmptyHero、composer 样式、Menu/Modal/Tooltip、portal、slot 基建和 `ui-workspace` 组件骨架可以保留。需要重写的是 Workspace/Session 状态边界、零态、创建动作、首发状态机、历史初始化和组件 props。Sidebar 与 conversation empty 两个入口必须使用同一 Workspace 数据和创建动作，只允许锚点方向、开关状态与选中回调不同。

本期 UI 使用英文，不提供 Workspace rename/delete、Session delete、跨 Workspace 移动、拖拽排序、Ungrouped 手动收编、多 SessionDraft、draft 刷新恢复或显示名与目录名的双输入。

## Alternatives considered

**继续按 cwd 动态派生 Workspace。** 该方案无法表示空 Workspace、稳定显示名或显式顺序，也会把非 GUI Session 自动收编；只允许一次历史 bootstrap，之后归属必须显式写入索引。

**用一个 WorkspaceIntent 同时表示 WorkspaceDraft 与 SessionDraft。** 两者的显示、持久化和物化时点不同；合并后显式 Create Workspace 无法立即生效，sidebar 也无法区分隐藏 WorkspaceDraft 与真实 Workspace 下的 draft 行。

**零态立即创建 Host Session 或 Host persistence intent。** 未输入的 Session 会进入 Host 生命周期，刷新语义与 page-local 草稿冲突；首次发送前只保留 Client SessionDraft。

**显式 Create Workspace 延迟到首次发送。** 用户确认后 sidebar 仍没有真实空 Workspace，“Create Workspace”与“准备 Session”语义混合；只有自动无 Workspace 零态允许延迟。

**Client 在 Session list 到达后按 updatedAt 批量重排。** 页面会先展示 bootstrap 的 `createdAt` 顺序再整体跳动，重连也无法恢复同一顺序；Host 只在单个 Session 活跃时前移对应 id。

**在 SessionHeader 中增加 workspaceId。** 它会与 Workspace 索引形成两个持久归属字段并要求双写；header 保留 session 自身的 cwd 事实，Workspace 索引负责显式归属，读取时双向校验。

## Acceptance criteria

- 显式 Create Workspace 立即创建并显示空 Workspace；完全无 Workspace 的自动零态不写 Host 且允许输入。
- New Session、选择已有 Workspace、两种 Workspace 创建方式和 Workspace 行内加号都产生唯一的 SessionDraft，并遵守 sidebar 可见性规则。
- 首发按 Workspace、Session、prompt 顺序物化；各已成功阶段不回滚，输入在 prompt 接受前不丢失，重复创建使用同一 SessionId。
- Workspace list 只用 header 完成一次可重入 bootstrap；测试证明不读取事件正文，initialized 的空 registry 重启也不重复执行。
- 归属读取同时校验索引与 header cwd；cwd-only Session、无效历史 cwd 和 attach 失败进入 Ungrouped。
- 首次渲染等待两份基线 ready；Workspace 组不因 Session 活跃移动，Session list 到达不触发整体重排，单个活跃 Session 只前移自身并在重连后保持顺序。
- Workspace 与 Session 增量以任意顺序到达都不会产生重复 Session 行；首发各失败阶段都能恢复到同一个预分配 id。
- Create new 在 UI 与 Host 两层拒绝重名 Workspace；真实 Workspace 下的 SessionDraft 临时计入 sidebar 数量，物化与刷新都不会留下重复计数。
- 真实 runnable keyless snapshot 覆盖零态、显式创建、首发成功、首发失败、刷新和 Ungrouped；包级测试覆盖 bootstrap、双向归属、排序与幂等。

## Risks

- Header-only bootstrap 没有历史活跃时间，只能用 `createdAt` 初始化顺序；初始化后不按 Session list 批量修正，只有新的单项活跃逐步改变组内顺序。
- 历史 cwd 缺失或无法 realpath 的 Session 会留在 Ungrouped；本期没有手动收编入口。
- 页面刷新会丢弃 WorkspaceDraft、SessionDraft 和尚未接受的输入；这是 page-local 契约。
- Host Session 在首个事件前仍只有 live 对象和 persistence create-intent，Host 重启会丢失该空 Session；本设计不通过持久化页面 draft 改变现有懒持久化语义。
- 显式 Create Workspace 立即落盘，因此用户不发送就离开也会留下空 Workspace；这是该操作真实生效的代价。
