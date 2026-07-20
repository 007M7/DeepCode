# Figma 解析：details 面板 / 多视图 tabs / 未来功能区盘点（figma-flows）

数据源：`.artifacts/figma/harness-full.json`（页 `0:1 Harness` + 页 `43:37430 draft`）。解析脚本 `.artifacts/figma/dump_tree.py` / `summarize_frames.py`（不进 git）。所有节点 id 可直接在 Figma 中定位。

画布组织方式：大号 TEXT 标签（`GOAL WIP` 等）是区域标题，标注其下方/右侧的一排 `home` Frame（1440x1000，个别 1600x1000）；小号中文 TEXT 是设计者思考注记，本文全部原文抄录。

---

## 1. DETAILS 面板（42:30218 `DETAILS`）——专深

### 1.1 屏幕与形态

| 屏 | 尺寸 | 主题 | 结构 |
|---|---|---|---|
| `54:42633 home` | **1600**x1000 | 亮色 | Sidebar 300 + Header/会话 940 + **RightSidebar 360**（details 展开态） |
| `54:42043 home` | 1440x1000 | **暗色** | Sidebar 300 + Header/会话 **780** + RightSidebar 360 |

两屏对比给出挤压规则：details 面板固定 **360px**，打开后**挤压会话区**（Header 从常规 1140 收窄到 940/780；会话正文列从常规 768 收窄到 690，内容 658）——不是浮层覆盖。1600 宽屏是为了展示"窗口够宽时会话区少受挤压"，1440 暗色屏是最小宽度下的挤压形态。

### 1.2 RightSidebar（`54:42735`，即 details 面板本体）内容结构

自上而下：

1. **头部**（`I54:42735;43:36451`，高 114）：
   - 左上 `ic_ds_panel_left_outline_16` 图标按钮（收起面板）；
   - 标题 `Response`（`I54:42735;43:41479`）+ 右侧按钮 **"See in trajectory"**（`I54:42735;54:41722`，带 enhance 图标）——从 details 跳转到 Trajectory 视图的交叉链接；
   - 副标题 **`Turn 8 · Step 6 · Response`**（`I54:42735;43:41472`）——定位到具体 turn/step；
   - **三段 Switch**（`I54:42735;43:41590 SwitchContainer`）：**`Input` | `Output` | `Metadata`**，当前选中 Input（白底 token）。这是 details 的内部子视图切换。
2. **正文**（`I54:42735;43:41346` → `Code-block` `I54:42735;43:41429`，336 宽，#F9FAFB 圆角块）：
   - Code-block 头：类型下拉 **`PLAIN` ▾**（`I54:42735;43:41432`，可切换渲染格式），隐藏态还有 复制/下载/运行 按钮组；
   - 内容：原始模型输出全文（示例是一段 markdown 源码 "Now I have a comprehensive picture… ## Deep Analysis of Harness SDK…"，Roboto Mono 13px）——**details 展示的是某一步的原始 I/O 报文**。
3. **底部**：**`Add Feedback`** 黑底按钮（`I54:42735;43:41668`）。配套的悬浮反馈组件 `43:41325`（300x112，TextArea placeholder "Write a feedback"，内嵌文案 "我们想知道你对此回答不满意的原因，你认为更好的回答是什么？"）。
4. 面板内另有两个 **HIDDEN** 的 UI-kit 模板块（Activities/Contacts，`I54:42735;43:36457`/`43:36465`）——是素材库残留，非设计意图。

### 1.3 与会话区的联动（注记 `122:11240` 的含义）

> 注记原文（`122:11240`，位于 54:42633 顶部旁）：**"预期是，打开 details\n左侧可以点击切换"**

配套证据：54:42633 会话列中最后一个回答 Bubble 被蓝色描边矩形圈选（`54:42675 Rectangle 1`，stroke #3964FE 1.5px，暗色屏对应 `54:42085` stroke #679EFE）。

含义明确：**details 打开时，左侧会话流里的每条消息/每个 step 都可点击，点击即切换右侧 details 面板显示该条目的 I/O**；当前选中项在会话流里有高亮描边。副标题 "Turn 8 · Step 6" 与选中项同步。

另有游离小组件 `43:41486`（280x68，位于 details 屏右下角外侧）：**`‹ Previous | Next ›`** 分页条——按步序在 details 内前进/后退（不必回左侧点击）。

### 1.4 入口

Header 组件（`39:27730`）右侧按钮组：`Session log` + **`I/O Details`**（`43:35132`，ic_ds_browse 图标）。draft 页早版 Header（`75:7896`）对应位置是 `Fork` + `Session log`——即 **I/O Details 按钮是后来加的 details 入口**。

### 1.5 成熟度

高。有亮/暗双主题完整屏、选中态、子视图切换、分页、反馈组件，是"未来区"里最接近可实现的一块。

---

## 2. Tab_Group 多视图切换——专深

### 2.1 结构与样式

`Tab_Group`（主件 `34:11441`，draft 版 `75:7928`）挂在 Header 组件（`39:27730`）内、面包屑下方。三个 `.Tab`：

| Tab | 选中态 | 样式 |
|---|---|---|
| **Chat** | Selected | 文字 #4176E6 + 底部 3px 蓝条（`Rectangle 246`） |
| **Trajectory** | Unselected | 文字 #81858C，底条 opacity 0 |
| **Waterfall** | Unselected | 文字 #81858C，底条 opacity 0 |

`.Tab` 组件有 `Status: Selected/Unselected` 变体属性。13px SF Pro 510 字重，tab 间距 36。

### 2.2 各屏对比

扫了全部 18 个 `home` 屏：**12 个含 Tab_Group 的屏全部是 `Chat` 选中、三 tab 恒定不变**——设计稿没有画出 Trajectory/Waterfall 选中后的内容（对应 TRACE WIP 区为空、TODO List 里"Trace 部分/瀑布"待办，见 §4.1）。6 个无 Tab_Group 的屏都是空会话/新会话态（`34:9506`/`43:31855`/`39:22638`/`34:10628`/`122:10273`/`39:22754`）——**tab 组只在"会话已有内容"时出现**。

### 2.3 与我们 conversation.views 的对应

- Tab_Group = conversation 级视图切换器：同一 session 数据的三种投影（Chat 流 / Trajectory 轨迹 / Waterfall 瀑布甘特）。与我们 `conversation.views` 注册表设计一一对应，Chat 是默认视图。
- Header 面包屑（draft `75:7896`：`Code base… / Session with… / Session is waiting for approval`）表明视图切换器的作用域是**单个 session**（面包屑定位 workspace→父 session→当前 session）。
- 修改 List（`75:5996`，§6.1）要求"session 统计信息在 traj 面板和 waterfall 面板的上方"——即**每个视图可带自己的头部附件区**，统计条在 Chat 视图挂消息列表尾部、在 Traj/Waterfall 挂顶部。视图注册接口要允许视图声明自己的 chrome。
- details 面板的 "See in trajectory" 按钮 = 跨视图深链（从 Chat/details 定位到 Trajectory 中同一 step）。**视图需要支持"带锚点激活"**。

---

## 3. 逐区域盘点

### 3.1 TRACE WIP（`63:5925`）

区域内**只有标题**，无任何屏（坐标区 4593..5698, y7303+ 扫描为空）。Trajectory/Waterfall 视图（我们的 gantt/Traj 对应物）**尚未设计**，仅在 Tab_Group 里占了 tab 位、在 TODO List 里挂了待办（"Trace 部分 / 瀑布/项目"）。成熟度：零（纯占位）。

### 3.2 GOAL WIP（`39:27210`）——slash 命令 + 持久目标

三屏递进（全部 1440 亮色，成熟度高）：

1. `39:25483`：输入框敲 `/` 弹出 **slash 命令菜单**（`39:26572 MenuDropdown`，537 宽），可见菜单项：
   - **Goal** — "Set up a goal for better performance and result"（`39:26632/26633`）
   - **Side Question(btw)** — "Ask a side question without interrupting current work"（`39:26648/26649`）
   - **Fork from here** — "Create a session branch"（注记 `122:11203/11204`）
   - 注记（`75:6014/6015`）：**"Skills？？"** / **"可以调用 + 创建 skills？"** ——设计者在考虑把 skills 调用/创建也放进 slash 菜单。
2. `39:26767`：已输入 `/Goal`，后跟内联参数 "I want a"（`39:26851`/`39:27205`）。
3. `39:27211`：目标已生效——输入框上方出现 **`Ongoing Goal`** 常驻 pill（`39:27958`），内容 "I want a nice translation"（`39:28082`）。其 Input_Bottom（`39:27947`）还含隐藏的文件上传 chips 模板（FileInfo 卡：文件名/类型/大小/`解析中...`/`上传中...` 状态）。

### 3.3 FILES WIP（`39:28094`）——消息内文件引用

`39:12833`（1440 亮色）：多轮追问会话，用户消息内**内联文件 chip**：`AmericanworkReport.pdf`、`AmericanworkReport.docx`、`American.csv`、`239879545.png`（`39:24737`~`39:24795`），文字与 chip 混排（"based on this file. Can you analyse the …"）。屏外浮着 5 个 `iconFile` 实例（`39:24830` 等）= 按文件类型的图标族。Input_Bottom 840x228 含附件栏。成熟度：中高（单屏 + 组件族，无交互态）。

### 3.4 ACTIONS（`39:28095`）——列表操作 + 通知

`34:11948`（1440 亮色）三个叠加交互：

- **session 右键菜单**（`34:12015`）：`Rename` / `Fork session` / （隐藏模板行 `删除`）；
- **sidebar 排序菜单**（`34:12016`）：`Group by` → `WorkSpace` / `Update` / `Status`（Group by 是父项，WorkSpace/Update/Status 是选项）；
- **通知 toast**（`34:12110`，右上角 244x120 + 指针 `34:12131`）："This is a session name which is pretty long / 1h ago / **New Task completed**"——完成事件通知卡。

配套：`State` 组件集（`14:3304`）5 变体 = Done 绿 / warning 琥珀 / 红(Variant5) / Active / Ongoing；旁边图例注记（`122:9191`~`122:9194`）：**"new task completed" / "need approval" / "agent working" / "error"**——session 状态点的语义表。

### 3.5 NEW SESSION（`39:28096`）——空会话态

- `34:9506`（亮）/`39:22638`（暗，`Dashboard fill #151517`）：居中 "**Let's start building**" + 输入框（placeholder "Message to run task, plan and build, enter for / commands"）+ 选择器 `Plan` / `Read-only` / `DeepSeek-V4-Pro` / `High`。
- 注记 `122:9195`：**"Darkmode 的输入框边框有一些颜色区别"**。

### 3.6 ONBOARDING WIP（`43:31851`）

`43:31855`（1440 亮）：与 NEW SESSION 几乎相同，但 sidebar 只有 workspace 折叠列表、无展开 session 树——**首次进入/空工作区形态**。成熟度：中（只是 NEW SESSION 的变体，没有引导流程）。

### 3.7 TREE WIP（`133:7628`）——sidebar 会话树

独立 `Sidebar` Frame `133:7629`（300x920）：Cell 带 `arrow-tree` 展开箭头（`I133:7657;133:8789`）+ 缩进 spacing 占位——**session 下的 fork 树逐级展开结构**。配套 `Cell` 组件集（`14:3080`：Type=project/sub × State=Default/hover）。修改 List 注记（§6.1）明确："session 下面的 tree 结构很大很复杂，所以想**默认关闭逐级打开**，要不然屏幕可能被单个 session 的 tree 占满（tree 可能很长、很多层）"。成熟度：中（结构有了，交互态靠注记）。

### 3.8 APPROVE / TOOL（`39:28097`）——批准与工具调用（邻区，简记）

四屏：`34:10985`（审批条：`Waiting for approval` + 工具意图说明 + `ls -lt ~/Downloads` 命令展示 + **Refuse / Allow once / Always allow this type**）、`43:33762`（同上 + Think 展开文本）、`43:35200`（**Review Plan** 卡：计划标题+摘要 + `Build ⌘ ↵`，但旁边注记 `43:36060`：**"maybe no"**——Review Plan 形态存疑）、`43:36577`（悬停消息出现 IconActions + 指针）。游离件 `54:41773`/`54:41901` 是审批条组件两份拷贝。`Tool calls` 组件集（`122:9479`，注记 `122:9480` "几种不同 tool calls"）变体：`.Read`/`.Search`/`.Others`/`Bash`，行样例 "Think / Search read 4 web pages / Read / Tool call details / Bash List all files…"。**回到底部按钮** `SpecialButton`（`128:6106`/`128:6118`，chevron_down + `⌘ N`），注记 `128:7619`：**"回到底部\n\n和 chat 一致"**。

### 3.9 INFO / COMPACT WIP（`122:11189`）

- `43:32166`（1440 亮，完整会话）：回答尾部 hover 行有耗时 **`2m, 47s`**（`128:7625`），消息列表底部**统计行**（`122:11212`）：**`cache hit 92% · 1,284 tokens · 45.2s · 5 turns · 32 steps`**。
- 游离行 `43:36570`：**`Auto Compact`** · 注记 **"xxx maybe 常驻 context 进度？"**（`43:36575`）。
- 注记全文（`122:11239`）：**"context 比例和 cache hit 感觉都可以有，context 比例更适合放在输入框（和用户输入行为强相关）；compact 的 UI 感觉可以设计下，codex 那种"压缩上下文"然后一直卡在那里的体验不太好，这里也看后端能提供什么信息放出来"**。
- `122:11194`：一张外部截图（参考图）。

成熟度：低-中（统计行已定，compact 交互只有文字思路）。

### 3.10 CODE MODE / CORDIS / PLUGIN WIP（`122:11241`/`122:11242`/`122:11243`）

三个区域**均只有标题**，无任何屏或组件（区域扫描为空）。仅 TODO List 提到："**Code Mode 和 Cordis Tool 开启时的相应工具调用的视觉设计**"待做。成熟度：零。对应我们的 code-runtime 工具、cordis 自指工具集、plugin 管理界面——设计侧只留了坑。

### 3.11 Group by Workspace（`122:9529`）/ Group by Status（`122:10151`）

- Workspace 分组有屏：`34:10628`（workspace 右键菜单 `122:9481`：`Rename` / `New Workspace` + workspace 列表项）+ `122:10273`（亮）/`39:22754`（暗，完整 session 状态列表）。
- **Status 分组只有标题**，其下方区域为空——按状态聚合的 sidebar 形态未设计。

### 3.12 两个大组（75:5995 / 75:6000）——设计者自留清单

**`75:5995` "修改 List"**（`75:5996` 原文全抄）：

> 加鱼 logo
> local 去掉，目前只有 local
> fork session 维度可以去掉，只留 user message
> session下面的 tree 结构很大很复杂，所以想默认关闭逐级打开的，要不然屏幕可能被单个session的tree占满了（tree的打开和关闭，因为有的tree会很长，可能还有很多层）
> session 统计信息放在 chat 面板的消息列表最后
> auto & 手动 compact
> context
> session 统计信息在 traj 面板和 waterfall 面板的上方
> 输入框样式圆角等

**`75:6000` "TODO List"**（`75:6003` 原文全抄）：

> sessions 部分 states 状态
> Trace 部分
> 瀑布/项目
> Code Mode 和 Cordis Tool 开启时的相应工具调用的视觉设计
> 。。。。

信息量最大的两条推论：① **fork 树粒度收敛到 user message**（fork session 维度去掉）；② Header 上的 `Local` 徽标（draft `75:7913` "Local · 5 turns · 10 tool calls"）要去掉，但"目前只有 local"暗示**将来有 remote session 维度**。

### 3.13 draft 页（43:37430）扫描

- `43:38291 Chat`：DeepSeek 官网 chat 的完整还原（土耳其行程/AI 遗言等示例内容）——**样式参照物**，markdown 组件族（List/Divider/引用角标 1/2/3/代码块 复制/下载/运行/全屏）来源。
- `43:38292 IDE PIC`：MarsCode IDE 截图重绘——IDE/代码面板参照物。
- `75:7896 Header`：Header 早版（面包屑 3 级 + `Local · 5 turns · 10 tool calls` + Fork + Session log + Tab_Group）。
- `43:40399`：session cell 样例 "Analyzing the Code base / **5 turns · 1 hour ago**"——cell 副行含 turn 数与时间。
- `43:40406`（Dashboards/Overview/eCommerce/Projects）、`43:40411`（Views/Visits/New Users/Active Users 统计卡）：UI-kit 素材，非本产品设计。
- 注记（任务书已知 6 条之外无新增文字注记；其余全是截图 image 27~47）：
  - `43:40435`："Ask question\nWaiting for approval\n\n可能不用区分了"
  - `43:40436`："怎么创建 workspace\n或在 workspace 中创建\nworkspace 创建后是什么？"
  - `43:40437`："可能可以这些 sessions 数量\n不这样展示"
  - `43:40438`："filter 和聚合"
  - `43:40439`："时间怎么办\nhover 出来的 more"
  - `43:40440`："hover 之后 有 + 按钮？"

---

## 4. 未来 slot 需求清单（给 plugins.md）

按挂载层分组。"预留"= 现在就要在接口/注册表上留位；"不留"= 将来加插件即可，无需现在动接口。

### 4.1 conversation 视图层

| # | slot | 挂载层 | 现在预留? | 理由 |
|---|---|---|---|---|
| V1 | **视图注册表**（Chat/Trajectory/Waterfall） | Header Tab_Group ↔ conversation.views | **是（已是核心设计）** | Tab_Group 三 tab 已定稿；Trace/瀑布视图未设计但 tab 位已占，注册表必须允许后加视图 |
| V2 | **视图级 chrome 附件**（统计条位置随视图变化） | 视图声明自己的头部/尾部附件 | **是** | 修改 List 明确：统计信息 Chat 挂消息列表尾、Traj/Waterfall 挂顶部——同一数据不同挂点，需要视图自带 slot |
| V3 | **跨视图锚点深链**（See in trajectory） | 视图激活 API 带锚点参数（turn/step） | **是（接口留参数）** | details 面板已画出该按钮；实现可后补，但 view.activate(anchor) 签名现在定 |
| V4 | **回到底部按钮** | 每个滚动视图统一行为 | 否（组件层面统一即可） | 注记"和 chat 一致"，是组件复用不是扩展点 |

### 4.2 details（I/O）面板层

| # | slot | 挂载层 | 现在预留? | 理由 |
|---|---|---|---|---|
| D1 | **details 面板宿主**（360px 右侧栏，挤压式） | 全局布局第三栏 | **是** | 完成度最高的未来区；布局网格现在就要给第三栏留位（打开时会话列 768→690） |
| D2 | **details 子 tab 注册表**（Input/Output/Metadata） | details 面板内 Switch | **是** | 三段已定稿；将来按 step 类型可能加子 tab（如 diff、terminal），注册表化 |
| D3 | **选中联动通道**（左侧点击消息/step ↔ 右侧切换 + 高亮描边） | conversation ↔ details 的 selection 状态 | **是** | 注记 122:11240 的直接含义；selection 是会话级共享状态，不是 details 私有 |
| D4 | **step 分页**（Previous/Next） | details 面板底部 | 否 | 纯面板内部交互，selection 通道具备即可实现 |
| D5 | **内容渲染格式切换**（PLAIN ▾ 下拉） | details 正文 code-block | 否 | 面板内部功能 |
| D6 | **Add Feedback** | details 底部按钮 + 反馈浮层（43:41325） | 否（但留事件） | 反馈要落 session 事件/上报通道，事件类型可先占名 |

### 4.3 输入区（composer）层

| # | slot | 挂载层 | 现在预留? | 理由 |
|---|---|---|---|---|
| C1 | **slash 命令注册表**（/Goal、Side Question、Fork from here、Skills…） | 输入框 `/` 菜单 | **是** | 已画三项 + "Skills？？"注记明示还会加；命令来自不同 plugin（goal/subagent/skill），注册表必须开放 |
| C2 | **常驻状态 pill**（Ongoing Goal） | 输入框上方堆叠区 | **是** | Goal 已画；审批条（Waiting for approval / Review Plan）占同一堆叠区，本质是"composer 上方 banner slot"，多来源共用 |
| C3 | **审批交互条**（Refuse/Allow once/Always allow this type；Review Plan+Build） | 同 C2 堆叠区 | **是（与 C2 合一）** | 主线功能；Review Plan 形态标了 "maybe no"，slot 要容忍形态改动 |
| C4 | **附件区**（文件 chips：解析中/上传中/类型图标族） | 输入框上沿 | 半留（结构留，暂不实现） | FILES 区完成度中高，但依赖文件上传后端 |
| C5 | **模式/模型选择器**（Plan、Read-only、模型、effort） | 输入框下沿按钮排 | **是** | 每屏都有，选项由后端能力决定，需可配置 |
| C6 | **context 进度指示** | 输入框内常驻 | 半留 | 注记 122:11239/43:36575："context 比例更适合放在输入框""maybe 常驻 context 进度"——方向明确形态未定，输入框下沿留一个 status 挂点即可 |

### 4.4 sidebar 层

| # | slot | 挂载层 | 现在预留? | 理由 |
|---|---|---|---|---|
| S1 | **分组模式**（Group by WorkSpace/Update/Status） | sidebar 列表头排序菜单 | **是（枚举可扩）** | 菜单已画；Status 分组形态未设计，实现可后补 |
| S2 | **session fork 树**（默认折叠、逐级展开、fork 粒度=user message） | session cell 树结构 | **是** | TREE WIP + 修改 List 注记；树节点渲染与状态点是核心数据结构 |
| S3 | **状态点taxonomy**（done/warning/error/active/ongoing ↔ new task completed/need approval/agent working/error） | session cell 前缀 | **是** | 状态语义要与后端 session 状态机对齐，先定映射 |
| S4 | **右键菜单注册表**（workspace：Rename/New Workspace…；session：Rename/Fork session/删除） | cell context menu | 半留 | 菜单项将来随功能增长（如 skills、导出），做成列表即可 |
| S5 | **filter 和聚合 / hover more / hover +** | 列表头与 cell hover | 否 | 注记阶段（43:40438~40440），形态全未定 |

### 4.5 全局层

| # | slot | 挂载层 | 现在预留? | 理由 |
|---|---|---|---|---|
| G1 | **通知 toast**（New Task completed · 1h ago） | 全局右上角 | **是** | ACTIONS 区已画；通知源=session 状态机事件（同 S3 taxonomy） |
| G2 | **暗色主题** | 全局 token | **是** | 多屏成对出现（#151517/#1B1B1C/#2C2C2E），注记提醒暗色输入框边框有别 |
| G3 | **session 统计信息**（cache hit/tokens/时长/turns/steps） | 视图 chrome（见 V2） | **是（数据通道）** | 统计行内容已定稿，需要后端持续供数 |
| G4 | **compact UI**（Auto Compact，避免 codex 式卡死体验） | 会话流内事件渲染 + C6 | 半留 | 只有文字思路："看后端能提供什么信息"——先保证 compact 过程有流式事件可渲染 |
| G5 | **Local/remote 徽标** | Header 面包屑旁 | 半留 | 修改 List："local 去掉，目前只有 local"——字段留着，UI 先不显示 |
| G6 | **Code Mode / Cordis / Plugin 三区** | 未知（可能是模式开关+专属工具调用渲染） | 否（等 RFC 自己定义） | 设计侧零产出；唯一线索是 TODO"开启时的相应工具调用的视觉设计"→ 落到 4.6 的工具渲染注册表即可覆盖 |

### 4.6 工具调用渲染层

| # | slot | 挂载层 | 现在预留? | 理由 |
|---|---|---|---|---|
| T1 | **tool-call 渲染变体注册表**（.Read/.Search/Bash/.Others + Think） | 会话流内 tool-call 行 | **是** | 组件集 122:9479 已定 4+1 变体，`.Others` 就是 fallback——注册表+默认 fallback 的结构设计侧已经给出；Code Mode/Cordis 的专属渲染将来注册进来 |
| T2 | **tool-call 展开 details** | 行内 "details" 链接 ↔ D3 selection | **是（与 D3 合一）** | `.Others` 变体带 "details" 后缀，点击应联动 details 面板 |

---

## 5. 遗漏补充

- **Header 按钮排**：`Session log`（跳原始日志）、`I/O Details`（开 details）、`Fork`（draft 版）——Header 右侧按钮排本身可视为一个小注册表（G 系列之外的第 7 个挂点），session log 查看器我们尚无对应设计稿屏。
- **`14:3080 Cell` / `27:3260 Folder` / `14:3304 State`** 三个组件集是 sidebar 的全部原子件；Folder 有开/合两态。
- **面包屑层级**（workspace / 父 session / 当前 session）编码了"**session 可嵌套于 session**"（fork 出的子 session），与 S2 的树一致；面包屑中间层可点击返回父级。
- 反馈浮层（43:41325）中文文案与英文 placeholder 混排，双语文案尚未统一——实现时需要 i18n 决策。
- 设计稿中所有会话示例的模型名为 `DeepSeek-V4-Pro`、effort 档 `High`——选择器语义=模型+推理档双下拉（C5）。

## 6. 成熟度总表

| 区域 | 成熟度 |
|---|---|
| DETAILS 面板 | ★★★★（双主题完整屏+联动+分页+反馈） |
| Tab_Group 三视图 | ★★★（切换器定稿；仅 Chat 视图有内容） |
| GOAL/slash 菜单 | ★★★★（三屏递进） |
| APPROVE/TOOL | ★★★★（含存疑的 Review Plan） |
| FILES | ★★★（单屏+组件族） |
| ACTIONS/通知 | ★★★ |
| NEW SESSION/ONBOARDING | ★★★ |
| TREE（fork 树） | ★★（结构+注记） |
| INFO/COMPACT | ★★（统计行定稿，compact 只有思路） |
| Group by Status | ★（仅标题） |
| TRACE | ☆（仅标题） |
| CODE MODE / CORDIS / PLUGIN | ☆（仅标题） |
