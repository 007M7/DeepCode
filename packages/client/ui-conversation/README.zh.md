# @deepseek-ai/dsh-client-ui-conversation

[English](README.md) | 中文

会话领域：骨架（标题栏／标签页／编辑器／空状态）、聊天视图（分组步骤摘要流、流式尾部隔离、统计行、逐工具行 slot 及一个 bash 示例注册方与 todo 行）、输入区 dock（队列行加 todo 计划条）、最小详情面板、按 scope 寻址的 ConversationService。契约：api-contracts v3 §7 加 slot 终端设计（store seat／props share）。

无会话主视觉区会渲染来自 Session 列表投影的前端 Session Intent；没有真实 Workspace 时，还会包含其前端 Workspace Intent。它声明 `conversation.empty.workspace`，ui-workspace 会在此注册侧边栏所用的同一选择器。WorkspacesService 启动跨对象流程；每个 Workspace 或 Session 对象拥有自身的物化。Session 在发布期间保持身份，并保留任何仍需连接或交付的提示词；ConversationRoot 读取该 `pendingPrompt`，其来源是 `useSession`，再通过 scope 内的 ConversationService 编辑或重试。

视图环本身就是 slot：会话注册声明 `'conversation.view'` 列表 slot（Session scope），并将其列在 `children` 表中；ConversationRoot 通过 renderSlot share 渲染活跃配置项（`only: <active id>`）；视图标签页从环账本的注册选项（`id`／`order`／`label`）投影而来。聊天视图是该包自身的环配置项；其他插件（ui-trajectory）通过普通的 `ctx.slots.register` 贡献标签页。先前包内的视图注册表（`registerView`／`ViewEntry`／`ConversationViewMap` 及 chrome 附加表）已退役，逐视图 chrome 则被拆入视图组件自身。

通用工具行把内置的 bash、read、search、write、edit 和 run_code 名称归入专用视觉变体。文件系统变体会渲染 edit 图标和 `Write · <path>` 或 `Edit · <path>` 摘要，同时保留共享的行到详情交互。code 变体以模型撰写的 `description` 作摘要，展开后显示程序本身；其已记录的子调用经由同一个键控 toolview 空位渲染为始终可见的嵌套行（自定义注册和 GenericToolCard fallback 原样适用于子行），details 面板则会根据选中的子调用 id 解析出其完整记录的参数与完整输出。

工具行同样是 slot：独立工具环（`ToolViewRegistry`／`ctx.toolviews`／outlet）已经退役。聊天配置项声明键控的 `'conversation.chat.toolview'` 空位（Session scope；key 空间在运行时开放）；其渲染点逐行通过 `entryKey: toolName` 分发，并以 `GenericToolCard` 作为调用点 `fallback`。owner 载荷是统一的 `ToolRowOwnerProps`（`callId`／`toolName`／`block`／`openDetails`），`ToolRowProps` 则预先将其与 Session 标准工具包组合。注册方只是普通插件：`ctx.slots.register({ name: 'conversation.chat.toolview', key: '<tool>', inject? }, Row)`，以 `inject: ['slots', 'conversation']` 作为加载顺序 seam（apply 在聊天注册后挂载 ConversationService，因此服务存在即可保证 slot 已声明）；Session 区分在组件内部完成（`useSessions` 读取 `parentId`，bash 示例是第三方姿态的范例）。Trajectory/waterfall 工具视图 slot 共享此形状，并随各自的渲染点落地（RendersCheck 会拒绝没有任何渲染方的声明）。

todo 两个面就是在该形状上的两个注册项，都是普通注册方插件，`inject: ['slots', 'conversation']`。`TodoRow` 占用 `'conversation.chat.toolview'` 的 `todo_write` key，摘要该次调用「试图写入」的内容（从其 args 解析出 `<已完成>/<总数> 已完成 · <进行中条目>`；模型 JSON 残缺或形状不对时回落到通用摘要；非 ok 执行状态保留通用状态点，使被取消的调用绝不读成一次已完成的更新）。`TodoDock` 以 `order: -1` 占用 `'conversation.input.dock'` 列表 slot（位于队列行之上），是常驻的计划条：它从会话快照中选取 `todos` 并渲染 `TodoPanel`，后者接收纯列表，在列表为空时自我隐藏，折叠时收成携带进行中条目的单行表头。选取由 dock 适配器负责，因此面板保持为其 props 的纯函数；常驻列表放在此处而非行内，行才能保持单行。输入区 composer 链隐藏的一切（例如 ui-question 对 `conversation.composer` 的接管）也会隐藏整个 dock，包括这条计划条。

逐 Session UI 状态（选择、普通编辑器草稿、活跃视图）位于已声明的聊天 store（`stores.ts` `createChatStore`）中：apply 构造一个 handle，并将其传给会话、聊天视图和详情注册，因此 Session slot 每个 Session 共享一个实例（选择由聊天视图写入、详情读取），框架拥有实例生命周期与草稿持久化。前端 Session Intent 来自 Session 列表投影；发布后，任何保留的提示词都来自该 Session 的会话快照。组件保持纯粹：框架标准工具包（Session scope 下的 `useSession`／`sessionId`，以及全局 `useSessions`／`useWorkspaces`）和 store 表层（`useStore`／`actions`）会从注册声明自动到达；inject factory 为运行时 Session 操作、发送／停止、标签页、详情和分页贡献普通数据与回调。

`src/client/` 按未来的包拆分组织：`contract/` 是唯一的跨领域共享表层（`slots.ts` slot 声明 + 组合后的 slot props，包括工具行契约、`views.ts` 共享原语、`tool-call-model.ts`）；`skeleton/`、`chat/` 和 `toolviews/`（示例注册方）领域目录只导入 contract 文件，彼此绝不导入；`apply.ts` 是唯一允许导入全部三个领域的组装点。`/client` 导出表层只包含契约：`apply`／`inject`、两个服务类和 `contract/` 类型家族；实现组件（骨架、聊天行）与 store factory 保持内部状态，只能通过 apply 的 slot 注册到达页面（测试通过 `./src/*` 子路径获取它们）。

## 模型体验

无。会话 UI 在浏览器中渲染会话历史与流；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **统计行没有耗时区段**：assistant `usage` 只携带 token 计数；耗时需要主机数据源。
- **详情面板是最小形态**：以原始形式显示已选择调用的参数／结果；Input/Output/Metadata 切换、Prev/Next 步进与 See-in-trajectory 深链接暂缓实现。
- **assistant footer 扩展（IconActions 行、逐消息分页）是预留 slot**：设计中已有图稿，尚未实现。
- **others 工具行的闪光图标是手绘近似版本**：无法在本地导出设计字形的矢量几何；等到存在精确导出后再将其提升到 ui-primitives。
- **审批卡片只是只读占位符**：问题请求通过编辑器链回答（ui-question），Web 侧审批回答属于 P-II 审批项目。
