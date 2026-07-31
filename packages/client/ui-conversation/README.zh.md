# @deepseek-ai/dsh-client-ui-conversation

[English](README.md) | 中文

会话领域：骨架（标题栏／标签页／编辑器／空状态）、聊天视图（分组步骤摘要流、流式尾部隔离、带从左到右动态渐变的 `Deep diving...` 轮次状态、逐工具行 slot 及一个 bash 示例注册方与 todo 行）、编辑器 dock（与输入区一同 sticky 的会话统计行）、输入区 dock（带发丝分界线的队列行加 todo 计划条）、最小详情面板、按 scope 寻址的 ConversationService。契约：api-contracts v3 §7 加 slot 终端设计（store seat／props share）。

常驻会话壳会跨无会话与会话状态切换而保留。没有当前会话时，它会渲染禁用输入栏；其根作用域的 `conversation.hero.workspace` slot 承载 Workspace 选择器。选择 Workspace 会连接或复用由 Host 拥有的空白会话，并在不替换会话壳的情况下打开该会话。空白会话与活跃会话渲染相同的输入区主体；InputHub 则在 Workspace 切换间携带草稿，并将草稿镜像到会话 store。活跃阶段会话标题栏以普通列 chrome 占据顶部；其下滚动容器（`data-conversation-scroll`）承载流动排版的各视图与 sticky 编辑器栈（统计 dock＋输入区 dock＋输入栏）。textarea 上的滚轮会链式处理：限高草稿先在本地滚动，到达边缘后再转交给该宿主。

视图环本身就是 slot：会话注册声明 `'conversation.view'` 列表 slot（Session scope），并将其列在 `children` 表中；ConversationRoot 通过 renderSlot share 渲染活跃配置项（`only: <active id>`）；视图标签页从环账本的注册选项（`id`／`order`／`label`）投影而来。聊天视图是该包自身的环配置项；其他插件（ui-trajectory）通过普通的 `ctx.slots.register` 贡献标签页。先前包内的视图注册表（`registerView`／`ViewEntry`／`ConversationViewMap` 及 chrome 附加表）已退役，逐视图 chrome 则被拆入视图组件自身。

已记录的非用户消息渲染为默认折叠的 `上下文注入` 展开项。它通过包内部的 `DisclosureRow` 与 `ToolRow` 共享 Tool calls 标题栏的几何与交互，同时保留上下文语义：展开后的 141px 滚动区会以内联 JSON 的形式有界展示 `content` 和 `source`，且不会合成工具状态、摘要或键控 toolview 分发（[决策](../../../.agents/notes/implemented/feature/2026-07-30-web-context-injection-disclosure.md)）。

通用工具行把内置的 bash、read、search、write、edit 和 run_code 名称归入专用视觉变体。文件系统变体会渲染 edit 图标和路径摘要；该路径是悬停下划线链接，点击后通过宿主操作系统的默认应用打开文件（`host.openPath`，相对路径相对会话 cwd 解析）。工具行不再是整行点击目标，也不会打开 details 面板。code 变体以模型撰写的 `description` 作摘要，展开后显示程序本身；其已记录的子调用经由同一个键控 toolview 空位渲染为始终可见的嵌套行（自定义注册和 GenericToolCard fallback 原样适用于子行）。Cordis 生命周期工具复用这些通用变体，同时以统一的 Cordis 强调色呈现 `Inspect`、`Mount temporary Plugin` 和 `Unmount temporary Plugin`；mount 行保留 code 变体的可展开源码渲染。

声明 `terminal` 渲染意图的工具调用，会在两个对话渲染点上都通过 ui-primitives 的 `TerminalBlock` 内联渲染其命令输出。`contract/terminal-card-model.ts` 是从快照的 `callView`／`resultView` 对推导的唯一位置，因此两个渲染点不可能在命令、cwd 或退出状态上产生分歧；对任何其他 card 标签——包括当前客户端版本不认识的标签——它返回 null，落回通用路径。因此两个渲染点也都显示卡片的运行状态点，它与工具行行首图标承载同一套 `StateDot` 语义，所以一行与其自身的卡片对同一条命令的状态总是一致。多行命令的每一行各占一个提示行，状态点只在第一行为整次调用标记一次——退出状态属于整次调用，因此每行一枚就会声称一个 bash 并不报告的逐行结果。键控的 `BashRow` 把卡片常驻在摘要行下方；由于工具行已不再是详情面板的点击目标，卡片的复制与展开控件就是该行唯一的交互。渲染点兜底行则保持其既有的展开控件。行的上限是 `CHAT_TERMINAL_MAX_LINES`（8），面板为 16，正是这一点让摘要面保持有界——面板仍是单次调用的阅读面。内联输出按渲染意图开放——终端卡片与 web 卡片，各有自己的上限；通用工具的内容仍然只在面板中呈现（[决策](../../../.agents/notes/implemented/feature/2026-07-28-web-terminal-card.md)）。

声明 `web` 渲染意图的工具调用，会在两个对话渲染点上都通过 ui-primitives 的 `WebBlock` 内联渲染其 web 检索。`contract/web-card-model.ts` 是从快照的 `resultView` 推导的唯一位置，镜像终端卡片，因此两个渲染点不可能对一次 web 调用的显示产生分歧；对运行中的调用、非 web 的 result view、generic result view、本客户端版本不认识的 `card` 标签，或本客户端版本不认识 `kind` 的 web 卡片（更新的 host 发来的值，wire 上不可信其为 `search` 或 `fetch`），它返回 null，落回通用路径。键控的 `WebRow` 把一个组件注册在 `web_search` 与 `web_fetch` 两个键下，仅根据工具名判别以选取图标与标题；没有自己键控行的 web 声明工具落到 `GenericToolCard` 兜底，它长出同一张常驻卡片，详情面板则以原语的完整 source 额度渲染它，并在卡片下方渲染摊平的模型可见结果内容——fetch 正文只在此处可读，因为其卡片只携带 URL 和状态。行的上限是 `CHAT_WEB_MAX_SOURCES`（8），面板为 16，与终端卡片所画的摘要面对阅读面的同一划分（[决策](../../../.agents/notes/implemented/feature/2026-07-30-web-result-card-frontend.md)）。

声明 `diff` 渲染意图的工具调用（`write`／`edit` 工具），通过 ui-primitives 的 `DiffBlock` 内联渲染其已应用的改动，采用同一套四层结构。`contract/diff-card-model.ts` 是从 `callView`／`resultView` 对推导的唯一位置；已结算 result 的 hunk 替换 call 时 diff，对任何其他 card 标签或 generic result view（write/edit 的执行错误）它返回 null，落回通用路径。键控的 `FileMutationRow`（在 `write` 与 `edit` 下都注册）把卡片常驻在摘要之下，其路径链接仍经 host 打开文件；渲染点兜底行与详情面板同样感知 diff。行的上限是 `CHAT_DIFF_MAX_LINES`（8），面板为 16（[决策](../../../.agents/notes/implemented/feature/2026-07-30-web-diff-card.md)）。

聊天流会将跨重试轮次连续出现的模型重试节点投影为一个稳定的弱化状态行，并用最新一次尝试更新该行；每个重试事件仍保留在运行时快照与会话日志中。前端倒计时以客户端收到事件的时刻为计划延迟的起点，避免 Host 与浏览器的时钟偏差；剩余时间向上取整到秒，且下限为 1 秒。最近一次尚未完成的重试会显示从左到右的文字渐变动画。后续轮次事实用于区分已开始的尝试与在退避期间取消的尝试，Host 的 running 位只控制实时动画；随后该行会显示静态的已完成或已取消标签。normal 策略行显示有限重试上限；always 策略行显示 `∞`。激活该行会显示最近一次重试的精确延迟和失败消息。客户端运行时会在相应重试节点到达前移除每个失败步骤的流式输出尾部；后续某次尝试成功后，该状态仍保持可见。

工具行同样是 slot：独立工具环（`ToolViewRegistry`／`ctx.toolviews`／outlet）已经退役。聊天配置项声明键控的 `'conversation.chat.toolview'` 空位（Session scope；key 空间在运行时开放）；其渲染点逐行通过 `entryKey: toolName` 分发，并以 `GenericToolCard` 作为调用点 `fallback`。owner 载荷是统一的 `ToolRowOwnerProps`（`callId`／`toolName`／`block`／`openFile`），`ToolRowProps` 则预先将其与 Session 标准工具包组合。注册方只是普通插件：`ctx.slots.register({ name: 'conversation.chat.toolview', key: '<tool>', inject? }, Row)`，以 `inject: ['slots', 'conversation']` 作为加载顺序 seam（apply 在聊天注册后挂载 ConversationService，因此服务存在即可保证 slot 已声明）；Session 区分在组件内部完成（`useSessions` 读取 `parentId`，bash 示例是第三方姿态的范例）。Trajectory/waterfall 工具视图 slot 共享此形状，并随各自的渲染点落地（RendersCheck 会拒绝没有任何渲染方的声明）。

审批经由本包声明的链接管编辑器：`ApprovalPanel` 注册为按选择器路由的 `'conversation.composer'` 配置项（ui-question 模式），在审批等待未决期间取代 InputBar 占据编辑器（琥珀色条、理由标题、来自运行中调用参数的配对命令行、一次性的拒绝／允许）。`contract/slots.ts` 中的 `PendingApproval` 领域面在运行时 `PendingWait` 载体之上拥有 wire 编码——带审计关联的 `ApprovalResponsePayload` 值；广播的 `approval/resolved` 帧使等待落定并恢复编辑器。侧边栏通过 manager 跟踪的 `waitingApproval` 列表位（未实例化会话同样点亮）镜像该阻塞状态，其优先级高于运行中圆环，直至问题解决。未决等待完全离开消息流：问题（ui-question）与审批（ApprovalPanel）都经编辑器接管作答，不再保留只读占位卡。编辑器底行的 Access 席位挂载 `PermissionSelect`，由 host 计算的 `permissions` 投影经标准工具包 `useProjection` 供数（key 缺席即隐藏 chip）；chip 打开 Menu 原语下拉，普通安全预设会立即经输入栏注入的 `command` 回调提交 `/permission <preset>`，而 `danger-full-access` 在界面中显示为 `Full access`，选择后先打开页面内的 Modal 风险确认。用户勾选确认项前启用按钮始终不可用；取消、Escape、关闭按钮与点击遮罩都不会提交命令。

todo 两个面就是在该形状上的两个注册项，都是普通注册方插件，`inject: ['slots', 'conversation']`。`TodoRow` 占用 `'conversation.chat.toolview'` 的 `todo_write` key，摘要该次调用「试图写入」的内容（从其 args 解析出 `<已完成>/<总数> 已完成 · <进行中条目>`；模型 JSON 残缺或形状不对时回落到通用摘要；非 ok 执行状态保留通用状态点，使被取消的调用绝不读成一次已完成的更新）。`TodoDock` 以 `order: -1` 占用 `'conversation.input.dock'` 列表 slot（位于队列行之上），是计划条：它经 `useProjection` 读取 host 计算的 `todos` 投影（站立计划：其后没有更晚 `turn/start` 的最近一次 `todo/write`）并渲染 `TodoPanel`，后者接收纯列表，在列表为空时自我隐藏；列表非空时面板初始折叠，表头显示标题加 `"<已完成>/<总数> tasks · <n> in progress"`（状态图标为 figma 的勾选／进行中／虚线未开始一组）。选取由 dock 适配器负责，因此面板保持为其 props 的纯函数；站立列表放在此处而非行内，行才能保持单行。输入区 composer 链隐藏的一切（例如 ui-question 对 `conversation.composer` 的接管）也会隐藏整个 dock，包括这条计划条。

`QueueDock` 是 `order: 20` 的末端 input-dock 条目。队列为空时隐藏；只有一个待处理项时直接渲染该行；存在两个或更多待处理项时，默认收起为 `"<n> 条排队消息"` 表头，其按钮可展开或收起完整列表。表头暴露 `aria-expanded` 和 `aria-controls`；展开后的列表以 180px 为高度上限，并可滚动。存在进行中的编辑或变更时，列表行会保持可见；队列清空后，下一次出现队列时会恢复默认收起状态。每条可见行仍是单行预览，并提供针对精确单次入队项的编辑和删除操作。

逐 Session UI 状态中的选择与活跃视图位于已声明的聊天 store（`stores.ts` `createChatStore`）中；InputHub 拥有输入区状态机，并将草稿镜像到该 store 以便持久化。apply 将同一个 store handle 传给严格限定于会话的子树、聊天视图和详情注册，因此每个会话内共享一个实例，框架拥有其生命周期。组件保持纯粹：框架标准工具包提供 `useSession`／`sessionId`、全局 `useSessions`／`useWorkspaces`，以及输入状态机的 `useInput`／`inputActions`；store 表层与 inject factory 提供其余状态和回调。

输入栏为 `'conversation.input.plan'`（位于本地 access 模式控件右侧）和 `'conversation.input.model'`（渲染在 pending 指示器与发送／停止按钮之前）声明会话作用域的单实例 seat，并为 overlay、dock、left 和 right 输入扩展声明列表 slot。各功能包拥有相应控件及其状态；ui-conversation 提供放置位置、`locked` owner prop 和标准 slot share。前置加号按钮是 Command launcher，而非附件入口：它要求当前会话的 `SlashController` 基于 textarea 当前 selection，只打开 `/` trigger 的 `command` source，同时 ui-slash 既有的 `MenuView` 仍是唯一的浮层菜单与 pick 路径。不引入 File 行、file input、上传协议或第二套菜单组件。当 `plan` 投影的有效目标为 plan mode 时，InputBar 将文本框 placeholder 切换为 plan 任务措辞，经本包注册的 `conversation` locale 命名空间（`placeholder.plan` / `hint.plan` 键）本地化，并与已认领 `/plan` 命令的提示逐字共用同一份文案（经标准套件 `useProjection` 读取的 host 折叠值；owner 提供的 placeholder 优先）。另一个会话视图活跃时，待处理的 composer 接管仍保持挂载，使被阻塞的 agent（智能体）仍能收到回答；没有待处理交互时，活跃会话的 composer 归 Chat 所有。composer bar slot 本身为 `session-maybe`：没有当前会话时，同一个 bar 以不可交互状态渲染（machine face 均缺席、`disabled` owner prop），而不是换入一棵平行的 disabled 树，因此选择 workspace 时 textarea DOM 不会被销毁；严格会话作用域的控件 seat 在会话存在之前保持为空。

`src/client/` 按未来的包拆分组织：`contract/` 是唯一的跨领域共享表层（`slots.ts` slot 声明 + 组合后的 slot props，包括工具行契约、`views.ts` 共享原语、`tool-call-model.ts`）；`skeleton/`、`chat/` 和 `toolviews/`（示例注册方）领域目录只导入 contract 文件，彼此绝不导入；`apply.ts` 是唯一允许导入全部三个领域的组装点。`/client` 导出表层只包含契约：`apply`／`inject`、两个服务类和 `contract/` 类型家族；实现组件（骨架、聊天行）与 store factory 保持内部状态，只能通过 apply 的 slot 注册到达页面（测试通过 `./src/*` 子路径获取它们）。

## 模型体验

无。会话 UI 在浏览器中渲染会话历史与流；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **统计行的耗时只覆盖窗口内消息流**：LLM（大语言模型）与工具墙钟时间由快照的 assistant `timing` 与工具 call/result 配对折算，落在已加载事件窗口之外的节点（更早的历史）不计入。
- **详情面板是最小形态，且当前没有入口**：以原始形式显示已选择调用的参数／结果；Input/Output/Metadata 切换、Prev/Next 步进与 See-in-trajectory 深链接暂缓实现。工具行已不再是详情面板的点击目标，且没有任何手势接替它，因此 `ChatViewInjected.openDetails` 虽已实现却无人调用，该面板（含其终端卡片）在组装后的应用中不可达；其渲染仍由直接以选中态挂载它来覆盖。
- **assistant 逐消息分页是预留 slot**：设计中已有图稿，尚未实现。已定稿的内容 IconActions 行（复制／分支／时钟）只挂在每个轮次中最后一条带 text 内容的 assistant 下；轮次中间的叙述与纯 Think 节点不带 chrome。分支会 fork 到包含该消息的轮次末尾，在 client 端递增继承标题后打开子会话，而 fork 或改名失败时源会话保持选中。
- **others 工具行的闪光图标是手绘近似版本**：无法在本地导出设计字形的矢量几何；等到存在精确导出后再将其提升到 ui-primitives。
- **审批面板的「始终允许此类」暂缓**：持久授权需要授权存储设计；今天只能回答允许一次／拒绝。
- **TodoPanel 将过长条目截成单行省略号**：figma 条没有换行或展开入口，完整文本无法在行内读完。
- **Queue 编辑仅支持文本**：包含非文本块的行仍显示扁平化预览，但由于内联编辑器无法保留这些块，其编辑控件会被禁用。文本行进入编辑模式后，删除会替换为保存和取消；Enter 保存，Escape 取消。QueueDock 不提供立即发送控件。
- **Web 仅暴露待处理 Queue**：在 steering（中途引导）拥有专用交互之前，Host 不会把待处理 steering 纳入 Queue 快照。已消费的 `steering/message` 仍会渲染到持久 transcript（文本记录）中，因此从外部提交的 steering 在回放时仍能如实呈现。
