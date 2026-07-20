# Web UI 业务分层与插件清单（依据 Figma 定稿重写）

> 业务层拆解：页面分层、slot 全量留位（含本次不实现的）、插件清单、互操作契约（props/actions）、全局配置、开工子集圈选。架构机制在 [architecture.md](architecture.md)/[modules.md](modules.md)；视觉依据在 [figma-analysis/](figma-analysis/)（sidebar / conversation / flows-future 三份，节点 id 可回查 Figma）。
> 「维度」= 组件数据语境：**global**（与会话无关）/ **session**（绑定当前会话）/ **toolcall**（绑定单次工具调用）/ **step**（绑定 turn/step 定位，details 联动用）。

## 0. 页面总布局（Figma 定稿）

**三栏**，不再是两栏——details 是第一公民：

```
┌ Sidebar 300px ┐┌ Conversation（弹性）───────────────┐┌ Details 360px ┐
│ Logo+HARNESS  ││ Header: 面包屑(workspace/父session/ ││ (默认收起，    │
│ [New Session] ││   当前session) + Fork|Session log|  ││  打开时挤压     │
│ [Search]      ││   I/O Details 按钮排                ││  conversation) │
│ WorkSpace 区头 ││ Tab_Group: Chat|Trajectory|Waterfall││ 头: Turn·Step  │
│ ┌project 54h ┐││ ┌─ 视图区（当前激活一个）──────────┐ ││   定位+See in  │
│ │└session 34h│││ │ Chat: 消息流(user气泡右对齐/     │ ││   trajectory   │
│ │  └子session│││ │   assistant通栏/tool摘要行/统计行)│ ││ Switch: Input| │
│ └────────────┘││ └──────────────────────────────────┘ ││  Output|Meta   │
│ (session多级树,││ [回到底部浮钮]                       ││ Code-block 正文│
│  状态点4色)    ││ Composer 堆叠区: Goal pill/审批接管/  ││ ‹Prev|Next›    │
│ Handle(折叠把手)││   追问队列/附件条                    ││ [Add Feedback] │
│ Foot: Settings ││ 输入框: textarea + [+|Plan|Read-only]││                │
└───────────────┘│   + [模型 effort ▾][发送]            │└────────────────┘
                 └──────────────────────────────────────┘
```

关键定稿事实（详见三份解析报告）：
- **details=360px 右栏、挤压式**（非浮层）；打开后进入**联动选择模式**——左侧每条消息/step 可点击切换右侧内容（选中项蓝描边），另有 Prev/Next 步进。
- **审批不是消息卡，是 composer 换面板**（琥珀状态条+意图行+命令行+三按钮）；Ask question 与审批合并同形态（注记 43:40435）。
- **tool call 是单行摘要行**（5 变体：Think/Search/Read/Bash/Others），无行内输出——输出走 details；状态色/spinner 设计未给，用 State 四色原语自补。
- **State 四色状态原语全局复用**（侧栏 cell/composer 状态条/hover 菜单/通知）：绿 #22C55E=new task completed、琥珀 #F59E0B=need approval、蓝渐变环 #5686FE=agent working、红 #EC1313=error。
- session 列表是**多级树**（session 下挂子 session，fork 粒度=user message，默认折叠逐级展开）。

### 0.1 布局动态规则（用户拍板 2026-07-21）

| # | 规则 |
|---|---|
| 1 | **两侧栏都可拖宽+可开合**：sidebar 左右拖拽（Handle=拖拽把手，折叠按钮在 Logo 行的 panel_left）+开合；details 同样可拖宽+开合；conversation 纯弹性 |
| 2 | **窗口过小的让步顺序**：自动缩小左右两侧，**优先缩 details**（details→sidebar→中栏兜底）；宽度是数值观看态（persist），不是布尔 |
| 3 | **输入框随中栏对等缩小**，维持固定 padding（736/776 是上限不是定值） |
| 4 | 滚动铆钉（挤压重排时保持阅读位置）**不做**——留 future work，等无限滚动组件一起 |
| 5 | 切 session 时 details 开合态**暂时维持全局不动**（不随 session 走）；架构上预留 per-session keyed 的升级位 |
| 6 | Chat 之外的视图（Trajectory/Waterfall）打开 details 布局同样挤压——details 行为与视图无关 |
| 7 | composer banner 堆叠**不设上限就堆着**（实际不会太多）；**审批态=composer 整体换新面板**（当前面板内容完全被审批提问+执行详情替换），不是"常态输入框顶上加条" |
| 8 | 空态→有内容的转场：输入框是**同一个组件的位置移动**（居中大输入框→底部 composer），不是两个组件切换 |
| 9 | 树深层截断：标题 `...` 省略号截断，不限深不横滚 |

## 1. slot 全量留位表

「实装」=本次波次做；「预留」=接口/注册表现在留位，实现后置；「不留」=将来加插件即可，不动接口。层级即所有权链（架构 §5）。

### L 层（layout 拥有）

| slot | kind/scope | 状态 | 内容 |
|---|---|---|---|
| `sidebar` | single/root | 实装 | sidebar 插件整栏占用（含折叠态——Handle+panel_left 双入口，折叠是 layout 观看态） |
| `conversation` | single/session | 实装 | conversation 骨架占用 |
| `details` | single/session | **实装（壳先行）** | 第三栏宿主：开合/挤压归 layout，内容归 details 插件——figma 完成度最高的区，网格第一天就留三栏 |
| 全局 toast 区 | list/root | 预留 | 右上角通知（New Task completed·1h ago，34:12110）；通知源=session 状态事件 |

### S 层（sidebar 插件拥有）

| slot | kind/scope | 状态 | 内容 |
|---|---|---|---|
| sidebar 区块注册 | list/root | 实装 | projects 列表区块、（将来任意区块） |
| 行级「…」菜单项 | list（菜单条目） | 预留 | session:Rename/Fork/删除;workspace:Rename/New Workspace——菜单已画、条目将来随功能加 |
| 分组策略 | 内部枚举（非 slot） | 实装 by-workspace | Group by WorkSpace✓/Update/Status 菜单已画；Update/Status 无稿后补 |

### C 层（conversation 骨架拥有）

| slot | kind/scope | 状态 | 内容 |
|---|---|---|---|
| `conversation.views` | list/session | 实装 | Chat（实装）/Trajectory（tab 留位零内容）/Waterfall（同）——tab 只在会话有内容时显示 |
| **视图 chrome 附件** | 视图注册项声明字段 | **预留（接口）** | 统计条 Chat 挂消息流尾、Traj/Waterfall 挂顶（修改List 明确）——视图声明自己的 header/footer 附件 |
| 视图激活锚点 | activate(anchor?) 参数 | **预留（签名）** | "See in trajectory" 跨视图深链定位 turn/step——实现后置,签名现在定 |
| `conversation.composer.banner` | list/session | 实装 | 输入框上方堆叠区：审批接管/Review Plan/Goal pill/追问队列共用（多来源按优先级堆叠） |
| `conversation.composer.command` | keyed/session | **预留（注册表）** | slash 命令：/Goal、Side Question、Fork from here、Skills??——命令来自不同插件,注册表必须开放 |
| `conversation.composer.accessory` | list/session | 预留 | 输入框下沿件：模式选择(Plan/Read-only)/模型+effort 选择器（实装为内置件）;context 进度指示（注记点名未画,留挂点） |
| 附件条 | 内置件 | 预留 | 文件 chips（解析中/上传中/类型图标族,FILES 区稿）——依赖上传后端 |
| Header 按钮排 | list/session | 预留 | Fork/Session log/I/O Details 已画；做成小注册表,将来可加 |
| `conversation.detail`（旧） | — | **裁撤** | 被 L 层 `details` 第三栏取代（原"conversation 内侧板"设计已被 figma 推翻） |

### D 层（details 插件拥有）

| slot | kind/scope | 状态 | 内容 |
|---|---|---|---|
| details 子 tab | list（Switch） | 实装 Input/Output/Metadata | 将来按 step 类型加子 tab（diff/terminal）——注册表化 |
| 内容渲染格式 | 内置（PLAIN▾ 下拉） | 不留 | 面板内部功能 |
| Add Feedback | 内置+事件占名 | 预留（事件） | 反馈上报通道,事件类型先占名 |

### T 层（chat 视图拥有）

| slot | kind/scope | 状态 | 内容 |
|---|---|---|---|
| **toolview 具名注册表** | 独立 service（非匿名 slot key,见下） | 实装 | 5 形态：think/search/read/bash + others 兜底——figma 直接给出"注册表+fallback"结构；Code Mode/Cordis 专属渲染将来注册进来 |
| assistant footer 扩展位 | list/session | 预留 | IconActions（copy/retry/like/dislike/share/分页）+ 统计行（cache hit/tokens/时长/turns/steps）为内置两件;将来可加 |
| user 气泡 actions | 内置 | 不留 | copy/fork/edit + 分支分页器,内置实现 |

**toolview 注册表升格为明确具名 service（用户拍板）**：不走通用 slots 的 `'conversation.chat.toolview'` 字符串 key，chat-view 插件 provide 一个具名注册表 `ctx.toolviews`：

```ts
declare module 'cordis' { interface Context { toolviews: ToolViewRegistry } }
interface ToolViewRegistry {
  /** filter 缺省=全局注册;带 filter 则只对匹配的 agent scope 生效——
   *  同一 tool 名在不同 scope 可有不同渲染(如子 agent 的 bash 卡与主 agent 不同形态)。
   *  解析顺序: scope 精确匹配 > 全局注册 > others 兜底。 */
  register(tool: ToolName, component: FC<ToolViewProps>, filter?: { scope?: ScopeMatcher }): () => void
  resolve(tool: ToolName, scopeKey: ScopeKey): FC<ToolViewProps>   // chat/trajectory 渲染时查
}
```

理由：① toolview 是被 chat/trajectory/waterfall **多个视图共同消费**的注册表（同一 tool 的行渲染+span 装饰将来同源），不是某一个坑的私产——具名 service 比挂在 chat 名下的 slot key 更诚实；② **面向 agent scope 的差异化注册**（filter.scope）给 Code Mode/Cordis/subagent 场景留位：v1 大家都不带 filter（=全局），机制先立。SlotMap 通用表继续管布局类坑位；toolview 这类"按业务数据分发的组件注册表"从此走具名 service 模式（先例）。

## 2. 插件清单（业务）

### 2.1 sidebar（合并原 projects+sessions 两条：一个插件管整栏）

| 项 | 内容 |
|---|---|
| 负责 | 整栏：Logo 行/New Session 按钮/搜索框/WorkSpace 区头(分组菜单+新建 workspace)/**session 多级树列表**/Settings foot/折叠把手联动 |
| 树与状态 | project 行 54h(标题+N sessions)/session 行 34h(标题+相对时间)；缩进步长 22px 多级；状态点 State 四色；hover:project 出…/+、session 时间换… |
| 维度 | 全部 **global**（列表数据+树展开态+搜索 query+分组策略都是 root 域） |
| actions | `router.open(id)`;`sessions.create({cwd})`(New Session/project 行 +/区头新建 workspace 三入口);树开合/搜索/分组切换（观看态） |
| 后端缺口 | 树结构需要 parentId 链（现 lineage 已有）;「新完成未读」=完成时间>last-seen,**本地观看态**不上 host |

### 2.2 conversation（骨架 owner）

| 项 | 内容 |
|---|---|
| 负责 | Header（面包屑三级+按钮排+Tab_Group）/视图区/composer（输入框+banner 堆叠+队列）/回到底部/与 details 的 selection 联动发起端 |
| 维度 | session（面包屑含父 session 链=session 嵌套展示） |
| actions | `send(text,mode)`/`cancel()`;`openDetails(target)`（见 §3 selection 契约——**从 toolcall 扩为 step 级**）;视图切换;banner 堆叠管理 |
| 输入框细节 | 发送钮空文本 op0.4;运行中停止钮形态**设计未给需自定**;追问队列（edit/trash/send-now per item）;slash 触发命令菜单 |

### 2.3 chat-view（默认视图）

| 项 | 内容 |
|---|---|
| 负责 | 消息流：user 气泡（右对齐 #EDF3FE r22,失败重发态）/assistant 通栏 markdown/tool 摘要行分组（连续 tool 聚成 gap10 组,与叙述交替）/引用角标/source-item/footer(IconActions+统计行)/中断冻结 |
| chrome | 统计条挂消息流尾（视图 chrome 契约首例） |
| 维度 | session;MessageItem=session 切片;tool 行=toolcall |
| actions | loadOlder;点击 tool 行/消息 → 经注入 actions 转交 conversation 的 selection（openDetails） |

### 2.4 工具行插件（toolview 注册项）

| 项 | 内容 |
|---|---|
| 形态 | **单行摘要行**：16px 图标槽(收起=工具图标/展开=chevron)+标题+·+摘要(FILL 截断)；展开体=缩进灰文本；**无行内输出** |
| 首批 | think/search/read/bash 四形态+others 兜底（figma 5 变体 1:1）;fs 写/edit 暂走 others,diff 形态进 details 子 tab（后置） |
| 状态 | 行级状态色设计未给——用 State 原语自补（running=蓝环/error=红,进契约） |
| 维度 | toolcall |
| actions | 展开/收起（观看态）;点击行=selection 转交（详情在 details） |

### 2.5 details（第三栏插件）

| 项 | 内容 |
|---|---|
| 负责 | 头部（Turn·Step 定位+See in trajectory+收起钮）/Input\|Output\|Metadata 三段/Code-block 正文（PLAIN▾）/Prev-Next 步进/Add Feedback |
| 维度 | **step**（当前 selection 指向的 turn/step;toolcall 是 step 的一种） |
| actions | selection 步进（Prev/Next）;跳 Trajectory（带锚点激活,签名预留）;关闭 |
| 联动 | 打开时 chat 流每条目可点击切换+选中蓝描边——selection 是 **conversation 级共享状态**,不是 details 私有（见 §3） |

### 2.6 approvals（composer 接管，非消息卡）

| 项 | 内容 |
|---|---|
| 形态 | **输入框整体接管**：琥珀状态条(#FEF5E7+Waiting for approval)+意图行+命令行+［Refuse/Allow once/**Always allow this type**］;Ask question 同形态不同按钮组;Review Plan 同族变体（单 Build 钮,注记"maybe no"存疑） |
| 挂点 | `conversation.composer.banner`（不是 timeline） |
| 维度 | session |
| actions | respond(approvalId, outcome, **scope**)——Always-allow-this-type 说明决策带持久化范围,接口要有 scope 字段;answer(rpcId, answers) |
| 联动 | 审批态三处同步：composer 条+面包屑文案+侧栏状态点（同一状态源,各自订阅） |

### 2.7 gantt-view → 改名 **trajectory/waterfall 视图（占位）**

Tab 留位零内容（TRACE WIP 零设计）。将来实现时：统计条挂顶（chrome 契约）、接收锚点激活、span 点击=selection 转交。

### 2.8 goal（slash 命令首个客户,P-III）

/Goal 命令+Ongoing Goal 常驻 pill（banner 堆叠区）;Side Question、Fork from here、Skills 同菜单后续。

### 2.9 empty-state（NEW SESSION/ONBOARDING）

无会话选中/新会话时 conversation 坑显示"Let's start building"居中输入框（Plan/Read-only/模型选择齐全）——归 conversation 骨架内置,不单独成插件。

### 2.10 zh/en 语言包、默认主题（含暗色）

纯注册。**暗色是完整第二套 token**（figma 双主题成对,注记点名输入框边框差异）——theme 插件第一天就带 light/dark 两字典。

## 3. 互操作契约（跨插件的三条通道）

1. **selection 通道（新增,details 联动的核心）**：conversation 骨架持有 `selection: { turn, step } | null` 观看态。写入方=chat 视图（点消息/tool 行）、details（Prev/Next）、将来 trajectory（点 span）；订阅方=details（切内容）、chat 视图（画蓝描边）。转交纪律照旧：组件调自己坑 owner 注入的 action,owner inject conversation 转调。`openDetails(target)` 契约从 toolcall 扩为 `{turn, step}`（toolcall 是特例）。
2. **状态原语（State 四色）**：session 状态字典（done/warning/ongoing/error + 文案）是 conversation 级单一 source（host 状态+审批 pending 推导）,sidebar cell/composer 条/toast/面包屑各自订阅渲染——不各算各的。
3. **actions 收敛**：router 导航、sessions.create、conversation.send/cancel/openDetails、approvals.respond/answer(带 scope)、视图 activate(anchor?)。新插件先复用,不新增全局面。

## 4. 全局配置

| 项 | 内容 |
|---|---|
| theme token 空间 | figma 已给全量双主题（两份报告 §5/§7 的 token 表直接进 theme 插件字典）：表面/文字四级/边框两档/品牌蓝/状态四色/hover-选中(#263148 6%/10%)/圆角族/字号族——**禁 hardcode,组件只用 token** |
| i18n | 稿内中英混排未统一（figma 备注）;UI 文案首发中文,英文包结构同置 |
| 用户偏好（Zustand persist） | 主题选择/语言/sidebar 折叠+宽度/分组策略/树展开态/details 开合 |
| 后端能力开关 | 模式(Plan/Read-only)与模型/effort 选项由 host describe 供数;附件上传、remote session（"目前只有 local"）等能力位留字段 |

## 5. 分期（P-I 已圈定开工;P-II/III 仅架构预留,不排开发）

### P-I 开工范围（用户圈定 2026-07-21：基本等同现有功能略微超出,面向新布局架构重设）

- layout 三栏骨架（拖宽/开合/让步规则 §0.1;**details 栏=壳+极简内容**——开合+选中 toolcall 的 args/result 原样展示即可,三段 Switch/Prev-Next/See-in-trajectory 全后置）
- sidebar（树列表/搜索/by-workspace 分组/状态点四色/新建三入口/拖宽折叠）
- conversation 骨架（Header 面包屑+tabs+composer 常态+空态同组件转场）
- **chat-view**（消息流:user 气泡/assistant markdown/tool 摘要行 5 形态/统计行/回到底部）
- **theme 双主题**（深色本来就有,light/dark 全量 token 两字典）
- selection 通道（机制入契约,P-I 只用到"点 tool 行→details 显示该 call"这一档）
- **toolview 自定义组件验收样例**：挑一个真实工具（bash 或 todo）以第三方姿势经 ctx.toolviews.register 实现专属行渲染——证明注册表全链可用（这就是"略微超出"的部分之一）

### P-II / P-III（**只讨论架构,不讨论开发**——所有接口/注册表/事件占名已在 §1 留位,兑现时机另议）

P-II 位:approvals composer 换面板（含 Ask question 合并、Always-allow scope）/追问队列/slash 注册表与 Goal/toast/气泡失败与编辑分支/source-item。
P-III 位:Trajectory-Waterfall 视图/锚点深链/details 三段与子 tab/附件/context 指示/compact UI/行级菜单扩展/Update-Status 分组/Skills/remote 徽标。

### 明确不做（设计侧存疑/无稿）

Review Plan 卡（"maybe no"）等拍板;CODE MODE/CORDIS/PLUGIN 三区（零设计,toolviews 注册表已覆盖其唯一线索）;归档区（不存在）。
