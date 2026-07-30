# Agent Note: Web subagent 目录与用户继续交互

Status: implemented

[English](2026-07-27-web-subagent-conversations.md) | 中文

## 问题

可继续的后台 subagent 具有持久化身份、持久化 transcript（文本记录）、由 inbox 驱动的 Activation 以及直接 child 目录。模型可以通过 `list_agents` 与 `send_message` 发现并继续这些 subagent，但 Web 客户端没有对应的产品路径。它的会话树只知道谱系，因此无法区分可继续的 subagent 与普通 fork；通过普通历史路径打开 inactive 会话时，还会仅为展示而恢复 Agent。

将 child 当作普通 Web 会话会违反[可继续 subagent 契约](../../implemented/feature/2026-07-28-continuable-subagent-conversations.md)。普通 `session.history` 与 `session.prompt` 会直接寻址 Agent；可继续的 child 必须从持久化存储中展示且不物化 Activation，并通过 `SubagentService.followup()` 接收用户输入，使 Agent inbox 负责排序，继续执行 manager 负责授权、cold resume、持久性与清理。

UI 还需要保留[持久化目录](../../implemented/feature/2026-07-22-durable-subagent-catalog-and-list-agents.md)的语义。`running` 与 `inactive` 是采用实时优先规则的会话活动快照，不代表成功结果或投递承诺；损坏、不受支持及不可用的 child 仍以显式 diagnostic 呈现；一次目录响应只包含直接可继续 child。

## 决策

Web 产品将在选中会话的标题栏公开直接可继续 child，并允许用户打开其持久化对话。child 对话会复用现有的事件 fold、消息渲染、流式输出路径、标题与输入区 chrome，但历史和提示词操作将使用专用的 subagent 地址 `{ parentSessionId, childSessionId }`，而非普通会话 RPC。

用户输入将调用 `ctx.subagents.followup(parent, childSessionId, content, { source: { kind: 'user', rpcId }, signal })`。驻留的 Activation 会把消息准入其 Agent inbox；没有 Activation 时，则先对同一个持久化 Session 执行 cold resume，再完成 inbox 准入。宿主绝不会仅为启用交互而恢复 parent：确切的直接 parent Agent 必须已存活才能授权投递。如果它不存在，child 会保持只读 transcript。

本提案涵盖 Web 端发现、transcript 查看与用户继续交互。它不会把 subagent 变成脱离 parent 后仍可独立存续的用户自有对话；这类产品属于[交互式 side session](../../proposed/feature/2026-07-08-interactive-side-sessions.md)。

## 设计上下文

Figma 中的 [subagent 列表](https://www.figma.com/design/jRBBK7zBgcszdVWQ0Fh5J8/Harness?node-id=383-14602&p=f)、[层级展开](https://www.figma.com/design/jRBBK7zBgcszdVWQ0Fh5J8/Harness?node-id=383-15917&p=f)与 [child 对话](https://www.figma.com/design/jRBBK7zBgcszdVWQ0Fh5J8/Harness?node-id=388-18584&p=f)画框是本提案的交互与视觉参考。它们只是非规范性的呈现上下文：生命周期、协议、失败与验收契约以本记录为准；后续只修改设计文件而不相应更新本记录，不会改变这些契约。

| 设计意图 | 本提案中的契约 |
| --- | --- |
| 会话页头显示 subagent 数量，并可打开紧凑列表。 | 页头操作显示直接持久化目录，其中包括健康条目和显式 diagnostic 行。 |
| 选择条目后，系统会使用普通对话 chrome、标题、transcript 与输入框打开 child。 | child 复用对话 UI，但历史和输入通过已寻址的 subagent RPC 路由。只有确切的 parent Agent 存活时，输入框才发送用户后续消息；否则会说明当前为只读状态。 |
| 用户可以逐层浏览嵌套 agent。 | 展开某一行时，只加载该 child 的直接目录，并将其插入为下一层树节点。客户端绝不会物化预先加载的递归目录。 |
| 条目显示 label、活动状态点与相对时间，侧边栏则省略重复的 subagent 行。 | label 与粗粒度的 `running` 或 `inactive` 活动状态来自目录。由日志支撑的可选 title 与相对最近活动时间来自普通会话摘要；它们不是 Activation 结果或耗时。持久化的粗粒度 `SessionHeader.origin` 分类会移除重复的 subagent 行，同时不会隐藏普通 fork。 |

## 产品契约

每个选中会话都可以显示标为 `<N> subagents` 的页头操作，其中 `N` 只计算健康的 `kind: 'child'` 条目，这些条目由 `listChildren()` 返回，且计数不包含 diagnostic。完整响应既无 child 也无 diagnostic 时，不显示该操作。打开后，界面按服务顺序显示直接 child，每行包含持久化创建 label 与活动指示；每个损坏、不受支持或不可用的候选则显示为禁用的 diagnostic 行。

`running` 表示 child Session 存活于宿主的逻辑会话语料库中。`inactive` 表示 child 仅存在于持久化存储中，后续消息可以将其恢复。UI 分别将二者呈现为「正在处理」与「已完成」，但后者只是在呈现 inactive，而非成功、失败或已取消结果。条目可以把普通会话摘要中的 `updatedAt` 显示为相对时间，用作最近活动提示，但不会把该值呈现为 Activation 耗时。已列出 child 的 `running`／`inactive` 值会实时更新：目录消费方从驱动普通会话 `running` 的同一条 `host/session-status` 帧就地翻转它，因此 child 从 `running` 结算为 `inactive` 无需导航或重新拉取。该帧只携带存活状态，因此 child 的 `label`、diagnostic 原因、健康状态迁移或成员变化都不在其中，仍需通过 `subagent.list` 重新拉取解析；跨进程结算以及重新拉取落地前的窗口仍为快照陈旧状态，投递时权威依据是 `subagent.prompt` 的结果，而非活动文案。

选择健康条目后，现有对话区域会打开对应 child，常驻标题栏显示该 child 的标题。页头下拉菜单是一棵 ARIA 树：展开某一行会懒加载该 child 的直接目录，继续展开则可在任意深度重复同一操作。每个可见分支都保留自身的直接 parent 地址和目录生命周期；折叠分支或关闭树时，会停止消费该分支及其已展开后代的成员关系。

只有在目录适配器报告确切的 parent Agent 已存活时，输入框才会启用。提交时，界面先乐观清空草稿；收到明确的未送达响应后再恢复草稿，与普通输入框的失败行为一致。成功响应携带已接纳的 inbox `messageId`；它不暴露 Activation 原本驻留还是经 cold resume 物化，也不承诺相应轮次已成功完成。

parent 不存活时，transcript 仍可阅读，输入框则显示只读说明。适配器不会自动恢复 parent，因为替代 Agent 并不是现有 Activation 保留的 owner。通过普通会话路径访问 parent，可能使一个 parent Agent 存活，以便后续创建新 Activation；但 child 导航本身不会产生这种副作用。

这一版本会在 subagent 对话中隐藏普通 Stop 操作。`session.cancel` 会绕过继续执行 manager 的所有权与 child-first 清理，而 subagent 服务在 inbox 接受后不公开逐消息或逐 Activation 取消操作。正确的取消控件需要另行设计 Activation 观测与授权表层。

## 宿主适配器与协议契约

`@deepseek-ai/dsh-host-apiproxy` 将拥有浏览器安全的 `subagents` 域，与 `sessions` 并列，并通过现有 `RpcMethodMap` 与 fetch 载体注册由 zod 校验的一元方法：

- `subagent.list` 接受 `parentSessionId`，调用 `ctx.subagents.listChildren(parentSessionId, signal)`，返回完整有序的条目数组，并说明 `ctx.agents.get(parentSessionId)` 当前能否解析出所需的存活 parent。parent 可用性只是 UI 提示；消息投递时仍以 `subagent.prompt` 为准。
- `subagent.history` 接受直接 parent id、child id 与普通历史页参数。它首先确认 child 是该 parent 持久化目录中的健康条目，再通过 `ctx.sessionQuery` 读取 child，且不发布或恢复 agent。它返回与普通历史相同的原始事件加渲染意图形态，以及按消息对齐的分页契约，使浏览器只使用一套 fold。
- `subagent.prompt` 接受直接 parent id、child id 与 `ContentBlock[]`。它要求 `ctx.agents` 中存在确切的存活 parent，使用用户来源信息、请求的 rpcId 与操作 signal 调用 `ctx.subagents.followup()`，并返回 `{ messageId }`。适配器绝不会绕过该服务而直接调用 `agent.followup()`、`agent.steer()` 或通用 `ctx.agents.resume()`。

网关会将 parent 缺失、目录 diagnostic、不可恢复、未授权、所有权冲突、已取消及未送达等失败映射为类型化 RPC 错误，且不会泄露对模型隐藏的描述符。`subagent.list` 之后的竞态仍可能导致 `subagent.prompt` 失败；权威依据是提示词操作的结果，而非更早的可用性位或 `running` 活动状态。

mux 仍然是实时事件路径。仅查看持久化 child 的历史不会产生实时订阅。`subagent.prompt` 启动 cold resume Activation 时，发布操作会让现有 mux 订阅该 child，浏览器则按序号归并后续事件。重新连接时，系统通过 `subagent.history` 重建已寻址的 child，而不是调用普通 `session.history`。

适配器属于 `dsh-host-apiproxy`，由它负责通道无关的契约与宿主实现。`dsh-host-webserver` 仍然只作为 HTTP／SSE 载体，不增加任何 subagent 行为。浏览器通过现有连接客户端导入协议，绝不直接访问宿主 `ctx`，从而保持 [GUI RPC 分层](../../implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)。

## 客户端对象层与呈现

不依赖 React 的客户端运行时将负责持久化目录快照、进行中的刷新、subagent 地址及提示词／历史路由。打开目录中的 child 时，系统会先记录其 `{ parentSessionId, childSessionId }` 地址，再打开常驻的 `Session`；该 Session 使用 `subagent.history` 与 `subagent.prompt`，普通会话则保持现有传输路径。通过普通选择路径再次选择同一 child 时，会保留已知地址，避免导航操作静默切换传输。只有从目录中发现的 child 地址，才能作为浏览器选择这条路由的事实；单凭 `parentId` 或 `origin` 都不足以判断，因为普通 fork 也使用同一个谱系字段，而 origin 只是呈现分类器。

目录数据通过 `useSessions` 消费的现有会话快照投影，而不会放入组件 store，也不会通过功能自定义钩子公开。树还从同一份快照读取普通会话摘要，用于显示可选 title 与最近活动时间。根目录或某个已展开后代的目录打开期间，其消费方会像 workspaces manager 那样挂到现有的宿主帧分发上：命中某个已列出 child 的 `host/session-status` 帧会通过与普通会话 `running` 相同的乐观 mutation 路径就地翻转该 child 的 `running`／`inactive` 活动状态，且不重新拉取 `subagent.list`。parent 与某个已打开分支匹配的 `host/session-added` 帧会触发一次去抖动、单次并发（single-flight）的 `subagent.list` 重新拉取，以纳入新成员及其 label 与描述符。组件局部状态负责下拉菜单可见性、已展开分支 id 与键盘焦点。

`ui-conversation` 会在标题旁声明并渲染会话作用域的 `conversation.session.header.actions` 列表 slot。现有 `@deepseek-ai/dsh-client-ui-subagent` 插件会在该处注册目录触发器与下拉菜单，并通过对话现有的组合点提供 subagent 专用的只读输入框呈现。扩展该包可以让 Web subagent 功能只有一个 owner；当前的 `@label` 引用 source 仍然只是面向模型的纯文本输入，本提案不会赋予它继续执行语义。

界面呈现遵循现有样式和无障碍规则：产品文案使用中文、亮色与暗色只使用 token、采用 tree 与 treeitem 语义、ArrowRight／ArrowLeft 控制分支展开、ArrowUp／ArrowDown 进行线性导航、关闭后焦点返回触发器、活动状态同时通过文字和颜色表达、禁用的 diagnostic 行仍然可读。组件只接收派生 props 与注入的回调；绝不接收 `ctx` 或宿主服务。

## 默认 Web 组合

`dsh web` 组合会在 JSONL 持久化旁挂载 SQLite 会话查询提供方，其数据库位于已配置的会话持久化根目录下。进程内 spawn 与 fork 委派工具都会选择 `backgroundMode: continuable`；该路由使用继续执行 manager 与 Agent inbox，而非 Task。宿主目录投影会排除 one-shot 条目，远程 ACP 运行则因为不发布本地 child Session 而不进入目录。

默认 Web 组合会挂载面向模型的 `send_message` 与 `list_agents` 适配器，以保持 coordinator 对等性，但 GUI 不会调用这些工具；它会通过宿主 RPC 适配器调用共享的 `SubagentService`。这些工具面向模型的 schema 与快照将独立于 GUI transcript 进行验证。

## 备选方案

**复用普通 `session.history` 与 `session.prompt`。** 不予采纳，因为这两条路径都会直接恢复或驱动 child Agent，绕过继续执行 manager 的授权与 inbox 准入。展示不得触发 Activation，用户输入必须与 parent 输入共用同一项 follow-up 或 cold resume 操作。

**将适配器放入 `dsh-host-webserver`。** 不予采纳，因为 subagent 列表与继续交互是通道无关的客户端功能。webserver 只承载已校验的 RPC 调用与 SSE 帧，不负责 harness 服务或业务路由。

**新建另一个 UI 包（package）。** 不予采纳，因为 `ui-subagent` 已经负责 Web subagent 引用，也是目录、导航与用户继续交互的自然功能边界。对话包只负责页头 slot 与通用对话 chrome。

**用户提交时自动恢复缺失的 parent。** 不予采纳，因为用户继续交互必须通过确切的存活 parent Agent 完成授权。静默激活 parent 还会让 child 页面上的操作意外改变 parent 生命周期。

**立即公开普通取消操作。** 不予采纳，因为取消 Agent 会绕过继续执行 manager 的所有权与 child-first 清理。正确的取消控件需要当前 Activation 身份，以及能够界定取消一条 inbox 消息、一个轮次还是整个驻留 epoch 的 owner 授权操作，其中也包括 GUI 未启动的 Activation。

**向持久化目录添加 Activation 结果与时间字段。** 暂缓，因为目录有意只描述持久化 child 身份与粗粒度的存活状态。持久化 Activation 记录属于独立的后端契约，不应根据会话存在状态或最后一次 `turn/end` 推断。

**构建预先加载的递归树。** 不予采纳，因为 `listChildren()` 只查询直接 child，而且可能扫描每份候选日志。界面通过懒加载的直接 child 查询组合出递归树，既保留每份目录的排序与 diagnostic 语义，又不会在用户看不到的层级中成倍增加工作量。

**从谱系推断侧边栏过滤，或扫描全局目录。** 不予采纳，因为普通 fork 共享 `parentSession`，而全局目录扫描按 parent 寻址，用作导航分类器成本过高。每个由进程内 subagent 支撑的会话会在发布前写入 `SessionHeader.origin: 'subagent'`；`session.list` 与 `host/session-added` 将其投影到客户端，共享侧边栏过滤器只省略这些行。页头目录仍然是导航入口与描述符权威来源；`origin` 绝不证明生命周期 mode、可恢复性或授权。

**将目录变化作为专用服务端流推送。** 暂缓，转而复用现有的 `host/session-status` 与 `host/session-added` 分发。`subagent.catalog` 增量帧能让成员与 diagnostic 完全实时而无需任何重新拉取，但它是一项新的宿主协议契约，也是在持久化目录之上的实时投影——恰恰是[持久化目录](../../implemented/feature/2026-07-22-durable-subagent-catalog-and-list-agents.md)留待规模验证的派生索引。第一版从现有存活帧翻转活动状态，只在成员变化时重新拉取。

**让 child 在 parent 消失后仍能独立交互。** 不予采纳，因为这会重新解释可继续后台工作的含义。独立生命周期、用户所有权与回并语义属于交互式 side session。

## 测试

- 默认 Web 组合会创建可继续的 spawn 与 fork child，并挂载持久化枚举及用户 follow-up 所需的会话查询与继续执行接口。
- 选中的 parent 会按稳定服务顺序显示完整的直接 child 目录，其中包含健康条目的 label／活动状态与明确禁用的 diagnostic；目录完全为空时，不提供页头操作。展开 child 时会获取其直接目录，以树语义和直接 parent 地址显示下一层，并在分支关闭时递归关闭后代消费方。
- 打开持久化 child 后，系统会渲染其事件 transcript 与标题栏，且不发布或恢复 child 与 parent。
- parent 存活时，child 会通过 `SubagentService.followup()` 提交带用户来源信息的输入；UI 会收到已接纳的 inbox `messageId`，并通过现有 mux 与 fold 接收由此产生的 child 事件。
- 已列出的 `running` child 结算为 `inactive` 时，其活动状态会从实时帧流就地更新，而不重新拉取 `subagent.list`；新创建的直接 child 会在一次去抖动的重新拉取后出现。
- parent 缺失时，child 仍然可读并拒绝输入，且不会自动恢复 parent。任何 child 历史、提示词或停止操作都不会调用普通 agent API。
- 刷新和重新连接会通过 subagent 历史路径重建已寻址的 child，不重复事件，也不会丢失 cold resume 发布前后产生的事件。
- 分组与扁平侧边栏都会省略 `origin: 'subagent'` 行，包括当前 child；普通 fork 行仍然可见。同一 child 的普通选择路径会保留目录派生地址，因此继续使用 subagent 历史／提示词路由。
- 宿主协议测试固定 schema、id 回显、直接 parent 校验、非激活式历史、存活 parent 强制要求、错误映射以及 inbox 消息确认。客户端对象测试固定目录／地址状态与传输选择；jsdom 测试固定页头树、懒加载式嵌套展开、diagnostic、启用／只读输入框状态、键盘行为与草稿恢复。
- 一项无密钥的组装 Web 快照展示已结算的可继续 child 与带描述符的已持久化 grandchild、在不物化 Activation 的情况下逐层展开目录、从持久化存储打开，以及让 cold-resume Activation 的 inbox 接受一次用户后续消息。

## 后果

- 该功能建立在继续执行与持久化目录契约之上；在本提案可以交付前，其堆叠实现的变更可能要求宿主适配器与 fixture（测试前置数据）一同调整。
- `listChildren()` 可能重新扫描持久化存储与 child 日志（按持久化目录为 O(D×C + ΣLᵢ)）。因此活动状态变化通过 `host/session-status` 实时应用而不重新拉取；只有成员变化才触发一次去抖动、单次并发的 `subagent.list` 重新加载，所以该扫描不会在每次渲染或每个状态帧上运行。
- parent 可用性与 child 活动状态都是进程局部快照。列出之后，发布、Activation dispose、其他发送方或其他进程都可能抢先改变状态；明确的提示词失败属于正常行为，不是违反不变量。
- child Activation 可能在历史获取与 mux 订阅之间发布。现有序号归并必须针对这条从冷态转为存活的 subagent 专用打开路径得到验证。
- 将默认 Web 委派工具切换为可继续后台模式，会改变 `run_in_background` 面向模型的确认消息与持久性要求；快照覆盖必须与组合变更一同落地。
- 持久化 subagent origin 会给每个本地 child header 及其列表／增量投影增加一个粗粒度产品分类字段。它刻意弱于描述符与已寻址继续执行契约，因此导航去重不能变成授权捷径。
- 该功能没有正确的取消按钮、持久化结果、Activation 耗时、删除、目录分页或可独立交互的离线 child。UI 不得暗示这些功能已经存在；其中的相对时间仅表示会话摘要给出的最近活动提示。
