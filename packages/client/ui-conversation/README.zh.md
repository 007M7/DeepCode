# @deepseek-ai/dsh-client-ui-conversation

[English](README.md) | 中文

会话领域：骨架（标题栏／标签页／编辑器／空状态）、聊天视图（分组步骤摘要流、流式尾部隔离、统计行、逐工具行 slot 及一个 bash 示例注册方与 todo 行）、输入区 dock（队列行加 todo 计划条）、最小详情面板、按 scope 寻址的 ConversationService。契约：api-contracts v3 §7 加 slot 终端设计（store seat／props share）。

常驻会话壳会跨无会话与会话状态切换而保留。没有当前会话时，它会渲染禁用输入栏；其根作用域的 `conversation.hero.workspace` slot 承载 Workspace 选择器。选择 Workspace 会连接或复用由 Host 拥有的空白会话，并在不替换会话壳的情况下打开该会话。空白会话与活跃会话渲染相同的输入区主体；InputHub 则在 Workspace 切换间携带草稿，并将草稿镜像到会话 store。

视图环本身就是 slot：会话注册声明 `'conversation.view'` 列表 slot（Session scope），并将其列在 `children` 表中；ConversationRoot 通过 renderSlot share 渲染活跃配置项（`only: <active id>`）；视图标签页从环账本的注册选项（`id`／`order`／`label`）投影而来。聊天视图是该包自身的环配置项；其他插件（ui-trajectory）通过普通的 `ctx.slots.register` 贡献标签页。先前包内的视图注册表（`registerView`／`ViewEntry`／`ConversationViewMap` 及 chrome 附加表）已退役，逐视图 chrome 则被拆入视图组件自身。

通用工具行把内置的 bash、read、search、write、edit 和 run_code 名称归入专用视觉变体。文件系统变体会渲染 edit 图标和路径摘要；该路径是悬停下划线链接，点击后通过宿主操作系统的默认应用打开文件（`host.openPath`，相对路径相对会话 cwd 解析）。工具行不再是整行点击目标，也不会打开 details 面板。code 变体以模型撰写的 `description` 作摘要，展开后显示程序本身；其已记录的子调用经由同一个键控 toolview 空位渲染为始终可见的嵌套行（自定义注册和 GenericToolCard fallback 原样适用于子行）。Cordis 生命周期工具复用这些通用变体，同时以统一的 Cordis 强调色呈现 `Inspect`、`Mount temporary Plugin` 和 `Unmount temporary Plugin`；mount 行保留 code 变体的可展开源码渲染。

工具行同样是 slot：独立工具环（`ToolViewRegistry`／`ctx.toolviews`／outlet）已经退役。聊天配置项声明键控的 `'conversation.chat.toolview'` 空位（Session scope；key 空间在运行时开放）；其渲染点逐行通过 `entryKey: toolName` 分发，并以 `GenericToolCard` 作为调用点 `fallback`。owner 载荷是统一的 `ToolRowOwnerProps`（`callId`／`toolName`／`block`／`openFile`），`ToolRowProps` 则预先将其与 Session 标准工具包组合。注册方只是普通插件：`ctx.slots.register({ name: 'conversation.chat.toolview', key: '<tool>', inject? }, Row)`，以 `inject: ['slots', 'conversation']` 作为加载顺序 seam（apply 在聊天注册后挂载 ConversationService，因此服务存在即可保证 slot 已声明）；Session 区分在组件内部完成（`useSessions` 读取 `parentId`，bash 示例是第三方姿态的范例）。Trajectory/waterfall 工具视图 slot 共享此形状，并随各自的渲染点落地（RendersCheck 会拒绝没有任何渲染方的声明）。

todo 两个面就是在该形状上的两个注册项，都是普通注册方插件，`inject: ['slots', 'conversation']`。`TodoRow` 占用 `'conversation.chat.toolview'` 的 `todo_write` key，摘要该次调用「试图写入」的内容（从其 args 解析出 `<已完成>/<总数> 已完成 · <进行中条目>`；模型 JSON 残缺或形状不对时回落到通用摘要；非 ok 执行状态保留通用状态点，使被取消的调用绝不读成一次已完成的更新）。`TodoDock` 以 `order: -1` 占用 `'conversation.input.dock'` 列表 slot（位于队列行之上），是常驻的计划条：它从会话快照中选取 `todos` 并渲染 `TodoPanel`，后者接收纯列表，在列表为空时自我隐藏，折叠时收成标题加 `"<已完成>/<总数> tasks · <n> in progress"` 的表头（状态图标为 figma 的勾选／进行中／虚线未开始一组）。选取由 dock 适配器负责，因此面板保持为其 props 的纯函数；常驻列表放在此处而非行内，行才能保持单行。输入区 composer 链隐藏的一切（例如 ui-question 对 `conversation.composer` 的接管）也会隐藏整个 dock，包括这条计划条。

逐 Session UI 状态中的选择与活跃视图位于已声明的聊天 store（`stores.ts` `createChatStore`）中；InputHub 拥有输入区状态机，并将草稿镜像到该 store 以便持久化。apply 将同一个 store handle 传给严格限定于会话的子树、聊天视图和详情注册，因此每个会话内共享一个实例，框架拥有其生命周期。组件保持纯粹：框架标准工具包提供 `useSession`／`sessionId`、全局 `useSessions`／`useWorkspaces`，以及输入状态机的 `useInput`／`inputActions`；store 表层与 inject factory 提供其余状态和回调。

输入栏为 `'conversation.input.plan'` 和 `'conversation.input.model'` 声明会话作用域的单实例 seat，并为 overlay、dock、left 和 right 输入扩展声明列表 slot。InputBar 将模型 seat 渲染在 pending 指示器与发送／停止按钮之前。各功能包拥有相应控件及其状态；ui-conversation 提供放置位置、`locked` owner prop 和标准 slot share。常驻无会话壳使用 `DisabledInputBar`，因此不会分发任何会话作用域的控件 seat。

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
- **TodoPanel 将过长条目截成单行省略号**：figma 条没有换行或展开入口，完整文本无法在行内读完。
