# Agent Note: Web subagent 目录与用户继续交互

Status: implemented

[English](2026-07-27-web-subagent-conversations.md) | 中文

## 问题

由会话支撑的 subagent 具有持久化身份、持久化 transcript（文本记录）与直接 child 目录，但 Web 客户端除此之外只能看到普通会话谱系。它无法区分 subagent 与 fork、获知描述符 mode，或在不使用会恢复 agent（智能体）的普通历史路径的情况下查看冷态 child。

浏览器必须遵守[可继续 subagent 契约](../../implemented/feature/2026-07-28-continuable-subagent-conversations.md)：一个可继续 child 在进程内最多只能有一项 Activation，只能通过确切的存活直接 parent 接受后续工作，并将 agent inbox 用作唯一的 FIFO。查看历史不得创建 Activation。inbox 消息一经接受，HTTP 调用方既不拥有其执行过程，也不会获得取消句柄。

UI 还必须遵守[持久化目录](../../implemented/feature/2026-07-22-durable-subagent-catalog-and-list-agents.md)。目录同时包含 one-shot 与可继续 child，保留每个 child 的 diagnostic，并且只报告采用实时优先规则的 `running` 或 `inactive` 活动快照。活动状态既不是持久化结果，也不承诺继续执行会成功。

## 决策

Web 产品通过页头操作公开选中会话中由会话支撑的直接 subagent。用户可以懒加载展开后代目录，并在现有对话区域中打开任一 mode。one-shot child 永久只读。可继续 child 只有在其确切直接 parent agent 存活时才接受用户后续消息；否则，其持久化 transcript 仍然可读，并附带恢复说明。

每个打开的 child 都携带目录派生地址 `{ parentSessionId, childSessionId, mode }`。选择专用历史与提示词传输的是包含 mode 的地址，而不是谱系或粗粒度 origin 标记。历史操作会从持久化存储读取会话，而不触发激活。可继续提示词操作会调用 `ctx.subagents.followup()`，并在 inbox 接受消息时以 `{ messageId }` 成功返回；它不会 steer 打开的轮次、公开 Activation、等待完成或返回结果。

已寻址 child 对话不提供普通 Stop 操作。`SubagentService.followup()` 只负责消息被 inbox 接受前的准入，并有意不公开任何 child 取消操作。后续取消设计需要显式的授权与生命周期契约，而不能回退到 `session.cancel`。

本决策涵盖 Web 端发现、transcript 查看与经 parent 授权的用户继续交互。它不会让 subagent 成为用户独立所有的对象；这类产品仍然属于[交互式 side session](../../proposed/feature/2026-07-08-interactive-side-sessions.md)。

## 设计上下文

Figma 中的 [subagent 列表](https://www.figma.com/design/jRBBK7zBgcszdVWQ0Fh5J8/Harness?node-id=383-14602&p=f)、[层级展开](https://www.figma.com/design/jRBBK7zBgcszdVWQ0Fh5J8/Harness?node-id=383-15917&p=f)与 [child 对话](https://www.figma.com/design/jRBBK7zBgcszdVWQ0Fh5J8/Harness?node-id=388-18584&p=f)画框是非规范性的交互与视觉参考。本记录负责生命周期、协议与失败语义。

| 设计意图 | 已交付契约 |
| --- | --- |
| 会话页头可打开紧凑的 child 列表。 | 该操作按服务顺序显示每个直接目录条目，包括已禁用的 diagnostic。 |
| 选择一行会复用对话 UI。 | 已寻址历史绝不激活 child；只有 parent 存活的可继续行才保留普通输入框。 |
| 嵌套 agent 会逐层展开。 | 每次展开只加载该行的直接目录，并保留其自身的 parent 地址。 |
| 条目显示 label、状态与相对时间，同时避免侧边栏条目重复。 | mode 与 `running`／`inactive` 活动状态会同时以文字和视觉呈现；可选 title 与时间来自摘要。`SessionHeader.origin` 会移除重复的导航条目，但不授予任何功能权限。 |

## 产品契约

页头操作的计数包含健康的 `kind: 'child'` 条目，不包含 diagnostic。只有在完整响应为空后，才不显示该操作。树会呈现可继续与 one-shot 行；one-shot 的可选 label 缺失时，回退到其会话 id。损坏、不受支持或不可用的候选仍以禁用的 diagnostic 行显示。

`running` 表示逻辑 child 记录存活于会话语料库中；`inactive` 表示它只存在于持久化存储中。UI 不会把任一值解释为成功、失败、取消、完成状态或可恢复性。`host/session-status` 会就地更新已知活动状态。受影响分支打开期间，成员、label、mode 与 diagnostic 仍需要通过去抖动的 `subagent.list` 刷新来更新。消息投递时仍以提示词响应为权威依据。

选择一行后，系统会先记录其确切地址，再打开常驻客户端 `Session`。历史分页、事件 fold、工具渲染意图、title、面包屑导航与实时 mux 归并都会复用普通对话机制。目录是一棵 ARIA 树，支持懒加载式 ArrowRight／ArrowLeft 展开与折叠、线性 ArrowUp／ArrowDown 导航、Home／End、Escape 以及焦点恢复。

one-shot 行始终会用文案替代输入框，说明执行记录为只读。可继续行仅在 `parentAvailable` 为 false 时如此。启用后，即使 child 正在运行，其 Send 操作也会准入另一个 FIFO 轮次，绝不会变成 Stop。提示词失败会通过普通错误行为保留草稿。

已寻址 child 视图不提供绑定到 agent 的辅助控件。具体而言，模型选择器与 `/model` contribution 不会调用普通 `session.models` 或 `session.selectModel`，因为任一路径都会在直接 parent 继续执行 seam 之外激活持久化 child 历史。

## 宿主适配器与协议契约

`@deepseek-ai/dsh-host-apiproxy` 拥有浏览器安全的 `subagents` 域：

- `subagent.list` 接受 `parentSessionId`，调用 `ctx.subagents.listChildren(parentSessionId, signal)`，返回完整有序的条目，并说明当前能否从 `ctx.agents` 解析出确切 parent。
- `subagent.history` 接受包含 mode 的完整地址与普通页参数。它对照直接目录校验 child 与 mode，通过 `ctx.sessionQuery.readSession()` 读取，再次检查直接谱系，并在不发布 agent 的情况下返回普通原始事件、渲染意图、分页与由 Host 计算的会话投影基线。
- `subagent.prompt` 只接受 `mode: 'continuable'` 地址与 `ContentBlock[]`。它要求确切的存活 parent，重新校验目录地址，调用 `ctx.subagents.followup(parent, childId, content, { source, signal })`，并返回已接受的 `MessageId`。

网关会将 parent 缺失、目录条目缺失或为 diagnostic、child 不可恢复或未授权、请求取消以及继续执行准入暂时不可用等失败映射为类型化 RPC 错误。它不会公开描述符或提供方细节。list／prompt 竞态属于正常情况：权威依据是提示词操作的结果，而不是更早的可用性或活动快照。

查看持久化历史本身不会创建 mux 订阅。当后续消息物化冷态 child Activation 时，现有 Host 与 mux 流会发布其生命周期与事件。重新连接时，系统通过 `subagent.history` 重建已寻址窗口。

适配器仍位于 `dsh-host-apiproxy`；`dsh-host-webserver` 仍作为载体。浏览器代码通过现有连接包（package）导入契约，绝不直接访问宿主 `ctx`，从而保持 [GUI RPC 分层](../../implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)。

## 客户端对象层与呈现

不依赖 React 的运行时负责目录、单次并发刷新、保留的地址、可用性提示与传输选择。再次选择已知 child 时会保留其地址，避免导航静默切换到普通会话 API。恢复的导航会持久化包含 mode 的完整地址。

目录通过标准 `useSessions` 快照传递。组件局部状态负责菜单可见性、已展开分支与焦点。`ui-conversation` 声明通用页头操作列表 slot，并通过其编辑器链分发当前对话快照；其中没有 subagent 专用的接管标记。`@deepseek-ai/dsh-client-ui-subagent` 注册目录操作，并根据普通 owner props 选择按原因区分的只读编辑器。组件只接收派生 props 与回调，绝不接收 `ctx`。

每个进程内 subagent child 都会在发布前写入 `SessionHeader.origin: 'subagent'`。会话列表摘要与增量 Host 帧会投影该字段，使分组和扁平侧边栏省略重复的 child 行，同时保留普通 fork。描述符 mode 与目录校验仍然是导航、继续执行和授权的权威依据。

该包现有的 `@label` source 仍然是独立的面向模型纯文本输入。它不会将 label 解析为地址，也不会获得继续执行语义。

## 默认 Web 组合

已交付的 Web 组合会在 JSONL 持久化旁挂载 SQLite 会话查询，并将 spawn 与 fork 后台委派配置为可继续模式。它还会挂载面向模型的 `send_message` 与 `list_agents` 适配器，以保持 coordinator 对等性，但 GUI 会通过宿主 RPC 域调用共享的 `SubagentService`，而不是调用模型工具。one-shot child 仍在目录中可见且只读。

## 备选方案

**复用普通会话 API。** 不予采纳，因为普通历史可能恢复 child，而普通提示词会在缺少直接 parent 继续执行授权的情况下驱动它。

**将适配器放入 webserver。** 不予采纳，因为目录与继续执行是通道无关的客户端功能；webserver 只承载已校验的消息。

**新建 UI 包。** 不予采纳，因为 `ui-subagent` 已经负责 Web subagent 引用，也是目录与已寻址 child 呈现的统一 owner。

**自动恢复缺失的 parent。** 不予采纳，因为继续执行要求确切的存活直接 parent。child 导航不得改变 parent 生命周期。

**公开普通取消操作。** 不予采纳，因为已获 inbox 接受的轮次会比其准入请求存续更久，而继续执行 seam 不会公开具备安全授权的取消句柄。

**只显示可继续 child。** 不予采纳，因为持久化目录有意描述由会话支撑的两种 mode。one-shot transcript 即使绝不接受后续消息，仍然有用。

**根据谱系推断 mode 或侧边栏过滤。** 不予采纳，因为普通 fork 共享 `parentSession`。由描述符支撑的目录负责提供 mode；单独的 `origin` 标记只是低成本的导航分类器。

**构建预先加载的递归树或专用目录流。** 就当前规模而言不予采纳。懒加载式直接 child 读取会保留排序与 diagnostic；现有 Host 帧会更新活动状态，并触发有界的成员刷新。

**让 child 在 parent 消失后仍能独立交互。** 不予采纳，因为独立生命周期与用户所有权需要 side session 语义。

## 测试

- 宿主协议测试固定 schema、id 回显、mode 校验、非激活式历史、确切 parent 强制要求、FIFO 准入回执、取消与脱敏后的失败映射。
- 客户端对象测试固定已保留与已恢复的地址、one-shot 只读拒绝、历史路由、可继续提示词路由、已寻址对话不提供取消、屏蔽绑定到 agent 的模型控件、实时活动状态翻转与成员刷新。
- jsdom 测试固定混合 mode 行、diagnostic、后代懒加载展开、直接 parent 地址、键盘行为与两种只读原因。
- 无密钥的组装 Web 快照包含一个 inactive 的可继续 child、一个 inactive 的 one-shot sibling 和一个持久化 grandchild；它会在不激活的情况下展开、打开持久化历史、准入一条用户 FIFO 后续消息、归并 child mux 事件，并证明 one-shot 历史仍然只读。
- 侧边栏测试固定 `origin: 'subagent'` 过滤，同时不隐藏普通 fork。

## 后果

- 目录读取可能重新扫描持久化谱系与描述符日志，因此活动状态使用现有实时帧，而成员刷新保持去抖动和单次并发。
- parent 可用性与 child 活动状态都是进程局部快照。列出之后，发布、dispose、其他发送方或其他进程都可能抢先改变状态；类型化提示词失败仍属预期行为。
- child 可能在历史获取与 mux 订阅之间发布，因此现有序号归并也涵盖从冷态转为存活的已寻址路径。
- 持久化 origin 会为 child header 与列表投影添加一个有意保持弱约束的产品分类字段；它不能变成授权捷径。
- UI 不提供 child 取消、持久化结果、激活耗时、删除或可独立交互的离线 mode，其文案不得暗示这些功能已经存在。
