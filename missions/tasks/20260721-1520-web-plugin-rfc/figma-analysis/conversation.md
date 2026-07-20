# Figma 对话主区解析报告（输入框 / 消息流 / tool calls / 审批）

> 数据源：`.artifacts/figma/harness-full.json` + `harness-node.json`（节点 id 均可在 Figma 中直接定位）。
> 基准屏：`34:10985 home`（APPROVE/TOOL 注记 `39:28097` 下方的主对话屏，1440x1000）。同排还有 `43:33762`（审批展开态）、`43:36577`（darkmode 审批）、`43:35200`（Review Plan）、`43:32166`（INFO/COMPACT）。

## 0. 画布总布局（对话屏骨架）

```
home 1440x1000
├─ Browser-Header 1440x80（浏览器 chrome 装饰，非产品）
└─ Dashboard Overview 1440x920
   ├─ Sidebar 300x920（figma-sidebar 属地）
   ├─ Header 1140x83（34:11332 内 39:27730）
   ├─ 消息列 Frame 1912057098 768x*（x=486 起，即 300+186 居中；内容内宽 736，pad 16）
   └─ Input_Bottom 840x196（含左右 32 空白，Input 实宽 776；悬浮在消息列之上，底部渐变遮罩）
```

消息列宽 **736px** 固定居中；输入框 **776px** 比消息列宽 40px，两者中轴对齐。

---

## 1. 消息流结构

### 1.1 user 气泡（`43:32116 User_Bubble/message_container`）

- 容器 `39:22246`：VERTICAL，pad-left 228 + align MAX ⇒ **右对齐，最大宽约 525**（736 − 228 + 内缩），下方 pad-bottom 16。
- 气泡本体 `43:32117 User_Bubble`（comp 1:866）：**fill #EDF3FE，r=22**，pad 16/10，文本 Inter 400 16/24 `#0F1115`。darkmode（`43:37199`）fill **#2C2C2E**，文本 #F9FAFB。
- 隐藏备件：`43:32118 warning_icon`（#F59E0B 圆形重发按钮）+ `43:32122 .Send_ErrorMessage`（"消息未能发送，请稍后重试" #81858C 14px）——发送失败态。
- 气泡下 `43:32145 IconActions`（右对齐，hover 出现）：28x28 圆形 icon 容器（r=28），图标 16px #81858C，从左到右：**copy（ic_ds_copy）、fork（ic_ds_branch）、edit（ic_ds_edit）**；另有隐藏的 branch 分页器（‹ 1/2 ›，SF Pro 510 15 #81858C）——编辑消息产生分支后出现。

### 1.2 assistant 内容（无气泡）

- `39:22250 Bubble`（comp 1:996）：**无背景、无边框，占满 736 列宽**，VERTICAL gap 16。与 user 气泡的视觉差异就是"有底色右对齐 vs 无底色通栏"。
- 内部是 markdown 组件族（来自 chat 设计系统）：正文 TEXT 16/28 `#0F1115`；H2 20/30 wt590；H3 16/28 wt590；`List`/`Markdown`/`.li` 列表组件（有序号 marker #CFD3D6）；`Mardkown/Divider` 1px `#000000/0.10` 上下 pad 16。
- **引用角标** `Frame 41`（I43:33798;594:23067）：18x18 圆形 badge，fill `#EBEEF2` r=12，数字 11px `#61666B`——行内引用编号。
- 消息尾部 `39:22252 IconActions`（comp 128:7260，左对齐）：**‹1/2› 分页器 + copy + refresh(重新生成) + like + dislike + share**，同样 28x28 r28、图标 16px #81858C。INFO 屏变体（`43:32997`）在排尾追加耗时文本 `128:7625` "2m, 47s"（12px #81858C）。
- `39:22251 source-item`（comp 1:511，默认 HIDDEN）：**web 引用来源黑胶囊**——34px 高 r=100 描边 `#000000/0.10` 的 accordion，内含重叠 favicon 堆（16px 圆、-1 间距、mask 裁切）+ "89 个网页" 14/24 #61666B。搜索类回答才显示。

### 1.3 间距节律

- 消息块之间（`Frame 1307` VERTICAL）：**gap 16**。
- tool call 组内行距：**gap 10**；展开组（`43:34327`）row 与展开体 gap 4 + pad-bottom 4。
- 叙述句（"Let me read all the source file"，Inter 400 16/28）与上下 tool 组之间也是 16。
- user 气泡容器自带 pad-bottom 16。

### 1.4 会话统计行（INFO/COMPACT 屏 `43:32166`）

最后一条消息 IconActions 之下有 `122:11212`："cache hit 92% · 1,284 tokens · 45.2s · 5 turns · 32 steps"（Inter 400 12 `#81858C`）。旁边画布注记 `43:36570`："Auto Compact · xxx maybe 常驻 context 进度？"（设计师在考虑 compact 提示与常驻 context 进度显示）。

---

## 2. Tool calls 全部变体（COMPONENT_SET `122:9479`，817x297）

注记 `122:9480`："几种不同 tool calls"。**5 个 variant，全部是 24px 高单行摘要行**，统一结构：

```
[16x16 leading 槽] gap6 [标题 SF Pro 400 14/24 #151517] gap8 [· 2x2 圆点 #ADB2B8] gap8 [摘要 SF Pro 400 14/24 #81858C, FILL 宽]
```

| variant | id | leading 图标 | 标题 | 摘要示例 | 隐藏备件 |
|---|---|---|---|---|---|
| Think | `39:28304`（名 .Read，实为 Think） | ic_ds_think_outline_14 | Think | "Let me explore the package directory…" | Arrow(chevron-down)、域名文本 "news.youth.cn" #61666B |
| Search | `43:31825` | ic_ds_search_outline_16 | Search | "read 4 web pages" | 域名文本 |
| Read | `43:33122` | ic_ds_browse_outline_16 | Read | "read 4 web pages" | 域名文本 |
| Others | `43:31850` | 􀆿 sparkle 矢量 | Tool call | "details" | 域名文本 |
| Bash | `39:28312`（宽 270，HUG） | ic_ds_api_outline_16 | Bash | "List all files in session directory" | Tag 胶囊（#F1F3F5 r6，13px #61666B——chat 遗留的搜索词展示）、后缀文本"中查找…" |

**收起/展开机制**（从实例态反推，`34:10985`/`43:33762` 屏）：

- 收起态（`I43:30854`）：leading 槽显示工具图标，Arrow HIDDEN。
- 展开态（`43:33791`，审批屏 Think 行）：**leading 槽换成 chevron-down（图标 HIDDEN、Arrow visible）**，行内摘要隐藏，下方追加展开体 `43:34326`：pad-left 22 缩进的正文（SF Pro 400 14/24 `#81858C`，多行）。
- 即同一 16px 槽位在 图标 ⇄ chevron 间切换；展开体只有缩进灰文本，无边框无底色。

**设计里没有的东西（实现时要自行补的）**：
- 没有 运行中/成功/失败 的行级状态色或 spinner——所有行同色。
- 没有行内输出区（bash stdout、diff 视图）；输出去处是 I/O Details 侧板（注记 `122:11240`"预期是，打开 details 左侧可以点击切换"，DETAILS 屏归 figma-details）。
- 没有 Edit/Write 专属形态；文件类工具大概率落 Others/Read 形态。

**连续 tool calls 的组织**：多行 tool call 收进一个 VERTICAL gap10 的组（如 `43:31735` 三连：Think+Bash+Bash），组与叙述文本交替出现——它是"步骤摘要流"，不是每个 tool 一张卡。

---

## 3. 审批 / 提问卡：**审批不在消息流里，在输入框里**

APPROVE/TOOL 注记 `39:28097` 下两块屏（`34:10985` 收起、`43:33762` 展开 Think 的变体）证实：pending 审批没有独立卡片，而是**输入框整体变身审批面板**：

```
Input（r20，描边 #000000/0.10，双层投影）
├─ 状态条 39:13395：全宽 40px，fill #FEF5E7，10px 状态点(#F59E0B 双圆) + "Waiting for approval" Inter 500 14 #DD8629
├─ 意图行 39:13374：Inter 500 16/24 #0F1115 —— "Need to read the Downloads folder list so I can confirm…"（模型给的一句话理由）
├─ 命令行 39:13375：Inter 400 16/24 #ADB2B8 —— "ls -lt /Users/hfadmin/Downloads"（待批的实际命令）
└─ 按钮行 Frame 1123（左侧 Plan/Read-only 淡出 op=0，模型选择器/发送键整组消失）
   └─ 右侧 Frame 1284：[Refuse]（描边钮）[Allow once]（描边钮）[Always allow this type]（fill #0F1115 白字主钮，r18 h34）
```

- 按钮样式：次钮 stroke `#000000/0.10` r18，文字 SF Pro 400 13 `#0F1115`；主钮黑底白字（**注意：审批主钮是黑色 #0F1115，不是品牌蓝**）。
- darkmode（`43:36577`/`54:41773`）：状态条 `#27241F`（文字仍 #DD8629）、次钮描边 `#FFFFFF/0.12` 白字 #F9FAFB、主钮 **#F9FAFB 底 + #0F1115 字**（黑白反转）。
- 两个 op=0.10 的半透明备选稿（`54:41901` 光/`54:41773` 暗）展示了"无琥珀底色、状态词灰色"的弱化版——设计师留的 alternate，主稿用琥珀条。
- **Review Plan 是同一套模式的变体**（`43:35200` 屏，`43:35825 Input_Bottom`）：状态条无底色（dot #F59E0B + "Review Plan" Inter 400 14 `#61666B`），内容为 plan 标题（Inter 500 16 #0F1115）+ plan 摘要（#ADB2B8，多行），按钮只有一颗 **[Build ⌘ ↵]**（fill `#3964FE` 蓝，r18）。
- draft 页注记 `43:40435`："Ask question / Waiting for approval **可能不用区分了**"——即模型提问（ask user）与工具审批共用同一输入框接管形态，不再做两种卡。对我们的启示：approvals 与 ask-question 可以走同一条 UI 通道，只是按钮组和文案不同。
- Header 面包屑同步变文案 "Session is waiting for approval"（`54:41739`），侧栏 cell 状态点变琥珀——审批态是全局三处联动（面包屑/侧栏/输入框）。

---

## 4. 输入框 Input_Bottom 全解（`34:11445`）

### 4.1 结构（常态，NEW SESSION 屏 `34:9506`/`34:10432`）

```
Input_Bottom 840（pad 32/32/12，底部 color 渐变遮罩挡住滚动内容）
└─ Input 776，fill #FFFFFF，stroke #000000/0.10，r20（新建态 r24/118 高），DROP_SHADOW(4)+(10)
   ├─ .FileContainerText（HIDDEN 备件）：附件横滚条——FileInfo 卡 240x64（r16 描边）：文件类型渐变图标(PDF 橙红/DOCX 蓝/XLS 绿) + 文件名 14/22 + 状态 12/18 #81858C（"解析中…/上传中…/PDF 22.2M"）；两端 Left/Right-arrow 渐变滚动钮
   ├─ .InputText：placeholder "Message to run task, plan and build, enter for / commands" #ADB2B8 Inter 16/24
   └─ 按钮行 Frame 1123（h44，pad 12/10/10，SPACE_BETWEEN）
      ├─ 左：[+ 圆钮 28x28 #F5F6F7] [Plan ▾] [Read-only ▾]（ToggleButton，Inter 500 13 #61666B，chevron #ADB2B8）
      └─ 右：[DeepSeek-V4-Pro High ▾]（model+effort 选择器，"High" #ADB2B8）[发送 IconButton 34x34 圆，fill #3964FE，白色 ic_ds_send；**空文本时 op=0.40 禁用，有内容 op=1**]
```

- 没有发现独立"停止"按钮形态——运行中态的发送键替换未画出（缺口，需自定）。
- 隐藏备件里还有 paperclip 附件钮（`34:11469`）。
- slash 命令：输入 "/" 触发命令菜单（GOAL 屏 `39:25483`），已选中命令 "/Goal" 以 `#F59E0B` 琥珀高亮显示在输入区（`39:26845`）。
- 追问队列（FILES 屏 `39:12833`，`39:12933`）：**运行中继续输入的消息排队显示在输入框顶部**——`#F5F6F7` 圆角(顶部 r14)容器，每行 36px（文本 Inter 400 13 #151517 + edit/trash/send 三个 28x28 icon 钮），这是"边跑边问"的 queue UI。行内还支持文件 chip（`39:24734 FileInfo` 22px 高 r8 内联胶囊）。

### 4.2 四个状态词（`122:9191~9194`）的归属

这四个 TEXT 摆在 **State 组件集 `14:3304`（COMPONENT_SET，10px 双圆状态点）左侧**，是给状态点 variant 做的标注，不是 statusline 专属：

| 注记 | State variant | 颜色 |
|---|---|---|
| new task completed `122:9191` | Property 1=Done `14:3303` | `#22C55E`（外圈 10% 透明） |
| need approval `122:9192` | Property 1=warning `14:3305` | `#F59E0B` |
| agent working `122:9193` | Property 1=Ongoing `14:3311` | 渐变描边圆环 `#5686FE→透明`（旋转 spinner 意象） |
| error `122:9194` | Property 1=Variant5 `122:9182` | `#EC1313` |

这颗 State 点同时用在三处：**侧栏 session cell、输入框状态行（审批态 dot+文字）、ACTIONS 屏 hover 菜单**（`34:12110 MenuDropdown` 内 "New Task completed" #ADB2B8 + 绿点）。⇒ 它就是 conversation 状态的统一视觉原语，statusline 内置项应覆盖这四态 + 文案。

### 4.3 context 注记（`122:11239`）

原文："context 比例和 cache hit 感觉都可以有，context 比例更适合放在输入框（和用户输入行为强相关）；compact 的 UI 感觉可以设计下，codex 那种'压缩上下文'然后一直卡在那里的体验不太好，这里也看后端能提供什么信息放出来"。
指向：INFO/COMPACT 屏（`43:32166`）——目前只画了消息尾部统计行（cache hit 92% …）和 "Auto Compact" 待定注记，**输入框内 context 比例控件尚未画出**，属意向性需求：context 用量指示器放输入框、compact 过程要有可见进度而非卡死。

### 4.4 darkmode（注记 `122:9195`"Darkmode 的输入框边框有一些颜色区别"）

| token | light | dark |
|---|---|---|
| Input fill | #FFFFFF | **#2C2C2E** |
| Input stroke | #000000/0.10 | **#FFFFFF/0.06**（更弱） |
| 次级按钮 stroke | #000000/0.10 | **#FFFFFF/0.12**（比容器边框强一档） |
| 发送钮 | #3964FE | **#679EFE** |
| 页面背景 | #FFFFFF | #151517 |
| 文本主/次/占位 | #0F1115 / #61666B / #ADB2B8 | #F9FAFB / #CFD3D6 / #81858C |

---

## 5. Header（`39:27730`，1140x83，底边框 #000000/0.10）

两行结构（pad 20/12/28/0）：

1. **Container-Breadcrumb `34:11424`**（32px）
   - 左：Breadcrumb（draft 页完整版 `75:7899`）："**Code base... / Session with... / Session is waiting for approval**"——workspace(带 Folder 图标 `75:7901`) / 父 session / 当前 session 三级；分隔符 "/" #ADB2B8；当前级 Inter 500 13 `#0F1115`，祖先级 Inter 400 13 `#81858C`，每级是 r12 的可点 Button。当前级右侧还有 **Local 徽标 + "· 5 turns · 10 tool calls"**（Inter 400 12 #81858C）的 session 元信息。
   - 右：胶囊按钮组（h32 r18 描边）：**[Fork ⑂] [Session log ↗] [I/O Details]**（`43:34526`/`39:26110`/`43:35128`；34:10985 里 Fork 隐藏、其余屏三颗都有）。Session log 带外链箭头（跳原始日志），I/O Details 开右侧详情板。
2. **Tab_Group `34:11441`**（35px，gap 36）：**Chat / Trajectory / Waterfall** 三个 tab（comp 22:2787/22:2790）：SF Pro 510 13/16，选中 `#4176E6` + 底部 3px 同色条；未选中 `#81858C`、下划条 op=0。
   - 这就是 conversation.views 切换条的视觉：**同一 session 的多视图（对话流/轨迹/瀑布图）平级 tab**，而非多 conversation。注记 `122:11240`"预期是，打开 details 左侧可以点击切换"进一步说明 I/O Details 打开后左侧列表可点击切换条目（详见 figma-details 报告）。

---

## 6. 回到底部按钮（注记 `128:7619`"回到底部 / 和 chat 一致"）

`128:6106 SpecialButton`（comp 128:6159，出现在 `43:33762` 屏）：**34x34 圆形白底钮**，fill #FFFFFF、stroke #000000/0.10、r100、DROP_SHADOW(4)，内含 14px chevron-down `#0F1115`。位置：**消息列右缘对齐（x=列右边界内缩），悬在 Input_Bottom 上方 50px** 处。隐藏备件 "⌘ N" 快捷键文本。行为对标 DeepSeek chat 的回到底部钮。

---

## 7. 视觉 token 小表

**颜色**

| 用途 | 值 |
|---|---|
| 文本主 / 标题 | `#0F1115`（tool 行标题 `#151517`） |
| 文本次 | `#61666B` |
| 文本三级 / tool 摘要 | `#81858C` |
| 占位 / 禁用 / 圆点 | `#ADB2B8` |
| user 气泡底 | `#EDF3FE`（dark `#2C2C2E`） |
| 品牌蓝（发送/Build） | `#3964FE`（dark `#679EFE`） |
| tab 选中蓝 | `#4176E6` |
| 状态绿 / 琥珀 / 红 / 进行中 | `#22C55E` / `#F59E0B`（文字 `#DD8629`）/ `#EC1313` / 渐变 `#5686FE` |
| 审批状态条底 | `#FEF5E7`（dark `#27241F`） |
| 边框 | `#000000/0.10`（dark 容器 `#FFFFFF/0.06`、按钮 `#FFFFFF/0.12`） |
| 浅灰底（+钮/tag/队列） | `#F5F6F7` / `#F1F3F5` / 引用 badge `#EBEEF2` |
| dark 表面 | 背景 `#151517`、输入框/菜单 `#2C2C2E` |

**圆角**：user 气泡 22 / 输入框 20（新建态 24）/ 按钮胶囊 18 / 附件卡 16 / 面包屑钮·队列容器 12·14 / tag·行内文件 chip 6·8 / 圆形 icon 钮·source-item 28~100。

**字号**（design 混用 SF Pro 与 Inter，新组件多为 Inter）：正文/输入 16/24~28；tool 行·状态行 14/24；按钮·toggle·tab 13/20（tab 13/16）；统计行·附件状态 12/18~20；引用 badge 11。

---

## 8. 对插件清单的映射建议（只建议，不改文档）

1. **toolview 坑契约**：设计的最小单元是"**单行摘要行**"而非卡片——props 至少要 `icon`（按工具类别）、`title`（工具名）、`summary`（一句话，FILL 截断）、`expandable`（有无展开体）、`expandedBody`（缩进灰文本块）。收起/展开只是 leading 槽 图标⇄chevron 的切换。**状态色/spinner/输出区设计未给**，toolview 契约里 status→视觉 的映射（running/ok/error）需要我们自行扩展（建议复用 State 四色原语），完整输出走 I/O Details 面板而非行内。variant 归类建议：think/search/read/bash 各一形态 + others 兜底——即 toolview 注册表按 tool kind 提供渲染器、default 渲染器兜底，与坑位模型天然对齐。
2. **approvals 插件**：审批 UI 是**输入框接管**（statusline 条 + 意图行 + 命令行 + Refuse/Allow once/Always allow this type 三钮），不是消息流卡片 ⇒ approvals 插件的挂点应在 composer 区域而非 timeline；"Ask question 与 Waiting for approval 不用区分"（43:40435）⇒ ask-user 与 tool-approval 可共用同一接管形态，仅按钮组/文案参数化（Review Plan 变体证明这是一族：statusline 文案 + 内容行 + 按钮组 都是 slot）。"Always allow this type" 说明审批决策带**持久化范围**（once vs always-this-type），插件接口要有 scope 字段。
3. **conversation statusline 内置项**：State 四态（done `#22C55E`/warning `#F59E0B`/ongoing `#5686FE` 渐变/error `#EC1313`）+ 文案（new task completed / need approval / agent working / error）就是内置状态字典；同一原语在 sidebar cell、composer statusline、hover 菜单三处复用 ⇒ statusline 状态应来自 conversation 级单一 source，视图各自订阅。审批态额外带琥珀底色条（#FEF5E7）,即 statusline 有 normal/emphasis 两档展示。
4. **composer 插件**：模式切换（Plan/Read-only）、model+effort 选择器、slash 命令菜单、附件条、**运行中追问队列**（queue + edit/delete/send-now per item）都是输入框的组成件——若 composer 也做坑位化，这五个是现成的坑。context 比例指示器（122:11239）是设计师点名要加进输入框的未画项。
5. **timeline 消息渲染**：assistant 消息 = 叙述文本与 tool-call 组交替的"步骤流"，块间距 16、组内 10——渲染层建议把连续 tool events 聚合成组（组件树里就是这么组织的）。消息尾部 IconActions（copy/retry/like/dislike/share/fork-页码）与统计行（cache hit/tokens/耗时/turns/steps）是 assistant 消息 footer 的两个内置扩展位。
6. **回到底部**：浮动钮挂在 timeline 视口右下、Input 上方 50px，标准 scroll-to-bottom 行为，无需插件化。
