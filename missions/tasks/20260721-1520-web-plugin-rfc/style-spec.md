# P-I 组件规格底册（figma 节点直读，非截图）

维护人：figma-flows。数据源：`.artifacts/figma/harness-full.json` 节点原始值（dump_tree/convo_dump 直读），**每个值都可用节点 id 回查**。色值同时给 cssdesign 变量映射（映射惯例见 figma-analysis 三份解析）；「暗」列为暗色屏对照值，— 表示暗屏无该件单独稿（跟 alias 变量走）。
用途：前端逐包对账的唯一规格基准。P-I 未实装件（审批条/附件/goal pill 等）不在册。

## Batch 1 — Sidebar 全套

基准稿：`133:7629 Sidebar`（300×920）；暗色对照 `42:28823`。

### 1.1 栏容器

| 属性 | figma 值 | 暗 | 节点 |
|---|---|---|---|
| 宽×高 | 300×920，内容区宽 268 | 同 | 133:7629 |
| 布局 | VERTICAL gap=8, pad L16/T6/R16/B6 | 同 | 133:7629 |
| 底色 | #F9FAFB（`--dsw-specific-sidebar-fill` 亮值=neutral-bluish-50） | #1B1B1C（暗值=bluish-900） | 133:7629 / 42:28823 |
| 右描边 | #000000@0.04 w1（`--dsw-alias-border-l1`） | #FFFFFF@0.06 w1 | 同上 |

### 1.2 头部块（Logo 行 + New Session）

| 组件 | 属性 | figma 值 | 暗 | 节点 |
|---|---|---|---|---|
| 头部容器 | 布局 | 268×126, VERTICAL gap=16, padBottom=12 | 同 | 133:7630 |
| Logo 行 | 尺寸/布局 | 268×60, HORIZONTAL gap=8, pad 4/8/4/8, r=8, 纵向居中 | 同 | 133:7631 |
| logo 组 | 结构 | fish 23.16×17.04 + wordmark 94.56×17.02（整组 124.3×20）, gap=7 | 同 | I133:7632;88:8932 |
| HARNESS 徽章 | 全值 | 54×14, pad 3/0, fill #0F1115, r=2；文字 11px/500 Intel One Mono lh14 #FFFFFF | 同 | I133:7632;34:10358/10359 |
| 收起钮 | 全值 | .Icon_container 28×28 r=28, pad 6；内 ic_ds_panel_left 16×16 fill #61666B（`label-secondary`） | — | 133:7633 |
| New Session 钮 | 容器 | 268×38, HORIZONTAL gap=6, pad 16/8, 内容居中, fill #FFFFFF, stroke #000000@0.10 w1, r=24 | fill #43454A, stroke #FFFFFF@0.12 | 133:7634 / 42:28828 |
| ├ 图标 | | ic_ds_new_chat 14×14 fill #0F1115 | #F9FAFB | 133:7636 |
| ├ 文字 | | "New Session" 14px/510 SF Pro lh22 #0F1115（`label-primary`） | #F9FAFB | 133:7637 |
| ├ 隐藏件 | | loading 前缀 16×16；下拉箭头 10×6 #A3A3A3 | — | 133:7635/7638 |
| Handle 把手 | 全值 | 12×32, fill #FFFFFF, stroke #000000@0.10 w1, r=10；绝对定位骑右缘垂直居中（x=右缘−6） | fill #2C2C2E, stroke #FFFFFF@0.06 | 133:7639 / 42:28833 |

### 1.3 列表区（区头 + 搜索 + Cell + 渐隐）

| 组件 | 属性 | figma 值 | 暗 | 节点 |
|---|---|---|---|---|
| 列表容器 | 布局 | 268×717, VERTICAL gap=4, padBottom=12 | 718 高 | 133:7640 / 42:28834 |
| 区头 | 容器 | 268×36, HORIZONTAL, pad L12/T4/B4, r=12, 纵向居中 | 同 | 133:7641 |
| ├ 标题 | | "WorkSpace" 14px/400 Inter lh20 #81858C（`label-tertiary`），弹性占满 | 同 | 133:7642 |
| ├ 钮组 | | 两个 .Icon_container 28×28 r28 pad6, gap=4；内 16×16 图标（Personalization / project_add） | — | 133:7643~7647 |
| 搜索框 | 外容器 | 268×54, pad T4/B12（⇒ 内框 38 高） | 同 | 133:7648 |
| ├ 内框 | | 268×38, HORIZONTAL pad 14/9, SPACE_BETWEEN, fill #F1F3F5（bluish-75）, stroke #000000@0.10 w1, r=24 | fill #1B1B1C, stroke #FFFFFF@0.12 | 133:7649 / 42:28853 |
| ├ 放大镜 | | 14×14 fill #ADB2B8（`label-caption`） | 同 | 133:7652 |
| ├ 占位文字 | | "Search name, keywords..." 14px/400 SF Pro lh20 #81858C | #ADB2B8 | 133:7654 / 42:28858 |
| ├ 隐藏清除钮 | | .Icon_container 28×28 内 close 14×14 #61666B | — | 133:7655 |
| 渐隐遮罩 | | 268×72 绝对定位列表底, GRADIENT_LINEAR #F9FAFB 透明→不透明 | 底色替换暗值 | 133:7666 |

### 1.4 Cell — project 行（Type=project）

| 属性 | Default | hover 差分 | 节点 |
|---|---|---|---|
| 尺寸/布局 | 228(实例内容宽; 挂载后 268)×54, HORIZONTAL gap=6, pad L8/T6/R8/B6, r=8 | fill #263148@0.06（`interactive-bg-hover`） | 14:3079 / 25:2671 |
| 前导槽 | 16×20 居中；Folder 16×16（close 态=13×11.16 描边矢量 #81858C w1.3 round） | Folder→右向 chevron（14×14 #ADB2B8） | 14:3062 / 25:2676 |
| IconText | VERTICAL gap=2 | 内层 HORIZONTAL gap 6→8 | 14:3064 / 25:2679 |
| ├ 标题 | 14px/400 Inter lh20 #0F1115，单行截断 | 同 | 14:3066 |
| ├ 计数副行 | 12px/400 Inter lh20 #81858C（"5 sessions"，单复数） | 同 | 14:3067 |
| 尾部 State 点 | 10×10 双圆，默认 HIDDEN | hover 时换 44×16 钮组（ellipsis+plus 各 16×16, gap=12, #81858C） | 16:2611 / 27:4668 |
| 暗色 | 标题 #F9FAFB、副行/时间 #ADB2B8、hover/选中同 token | | 42:28860 系 |

### 1.5 Cell — session 行（Type=sub）

| 属性 | Default | hover 差分 | 节点 |
|---|---|---|---|
| 尺寸/布局 | 228×34, HORIZONTAL gap=6, pad L8/T7/R8/B7, r=8 | fill #263148@0.06 | 14:3078 / 16:2570 |
| 可开关插槽序列 | 每槽 16×20（16 宽+gap6 ⇒ **缩进步长 22**）：arrow-tree(chevron 右向 14×14 #ADB2B8, 可见) → spacing(op0, 内含 State) → State(op0) → 2×spacing(HIDDEN, 内含 chevron) → arrow(「└」8×10 stroke #ADB2B8 w1 r3) | 同结构 | 133:8789/8325/14:3069/14:3170/14:3198/14:3071 |
| 树展开态画法 | arrow-tree 内隐藏一枚**下向** chevron 悬于 cell 左沟槽（x=cell−11） | — | 133:8790 |
| IconText | HORIZONTAL gap=6：标题 14px/400 Inter lh20 #0F1115 截断 + 时间 12px/400 Inter lh20 #81858C | 时间 HIDDEN → ellipsis 16×16（pad3 内 10×2 点阵 #81858C） | 14:3073~3075 / 27:4656 |
| 选中态 | 实例覆写 fill #263148@0.10（`interactive-bg-active`） | — | 34:11386（选中屏实例） |

### 1.6 State 状态点（组件集 14:3304，四处复用）

| 变体 | 结构 | 色 | 节点 |
|---|---|---|---|
| Done | 10×10 外圆 op=0.10 + 6×6 实心（offset 2,2） | #22C55E（`state-success-primary`） | 14:3303 |
| warning | 同 | #F59E0B（`state-warn-primary`） | 14:3305 |
| error | 同 | #EC1313（`state-error-primary`） | 122:9182 |
| Ongoing | 10×10 ELLIPSE 无 fill；stroke w1 INSIDE，GRADIENT_LINEAR #5686FE α1→α0（handle (0.1,0)→(0.85,1)），几何全圆 | #5686FE=deepseek-450（无 alias，自定 token） | 14:3311/3312 |
| Active | 全部隐藏（占位） | — | 14:3308 |

### 1.7 Foot

| 组件 | 属性 | figma 值 | 节点 |
|---|---|---|---|
| Foot 容器 | | 268×49, VERTICAL pad T10/B10, fill #F9FAFB | 133:7667 |
| Settings 行 | | 268×29, HORIZONTAL gap=8, pad L6/T6/R2/B6, r=12 | 133:7668 |
| ├ 图标 | | ic_ds_settings 14×14 fill #0F1115 | 133:7669 |
| ├ 文字 | | "Settings" 14px/400 SF Pro lh16.7 #0F1115 | 133:7671 |
| ├ 隐藏徽章 | | 48×18, pad 4/2, fill #E4EDFD（deepseek-100）, r=4；文字 10px/400 #5686FE | 133:7672/7673 |

### 1.8 Group by 菜单（区头 Personalization 弹出）

| 属性 | figma 值 | 节点 |
|---|---|---|
| 容器 | 白底 r=12，双层投影 0/12/32 #000@8% + 0/0/4 #000@2%，弹出对齐 Personalization 钮下方 | 122:10096 |
| 菜单项 | .Menu_cell 130×40 r=10（hover 变体走库 27:5171）；「Group by」灰分节标签 + WorkSpace(✓)/Update/Status | 122:10096 内 |

### 1.9 ui-side 对账结论（2026-07-22，修缮刀 5cd627003）

逐值核对 §1.1~1.8 vs ui-sidebar 两份模块 CSS。**符合项**（无改动）：栏容器 gap8/pad 16-6/fill+右描边（描边归 layout 列）、Logo 行 60h pad4-8 gap8、收起钮 28 圆、New Session 38h r24 gap6 pad16-8 elevated-fill+border-l2、区头 36h padL12、搜索框 38h r24 pad14 border-l2、渐隐遮罩不做（P-I 台账）、project/session 行 54/34h r8 gap6 pad8、缩进步长 22、标题 14/400 截断、hover 6% 选中 10% token、State 四态结构色、菜单 r12 双层影 130 宽 r10 项。

**偏差修正**（figma 值|原实现|修法）：

| # | 项 | figma | 原实现 | 修 |
|---|---|---|---|---|
| 1 | 头部块结构 | 容器 gap16+padB12（1.2） | 扁平摊在根 gap8 下 | 加 .headerBlock 包裹 |
| 2 | 列表区结构 | 区头+搜索+cell 同容器 gap4（1.3） | 根 gap8 直排 | 加 .listArea 包裹；搜索框 margin-b8（+gap4=padB12 等效） |
| 3 | 徽章 | 11/500 mono lh14 pad3-0 r2 | 无 mono、pad1-4 | font-family code var+lh14+pad0-3 |
| 4 | 行高族 | 标题/占位/时间全 lh20 | 18/15/无 | 统一 lh20 |
| 5 | 计数副行/时间色 | #81858C=tertiary | secondary（#61666B，深一档） | 降 tertiary |
| 6 | 搜索占位色 | #81858C tertiary；放大镜 #ADB2B8 caption | secondary/tertiary | 各降一档 |
| 7 | 搜索框 fill | bluish-75（暗 bluish-900） | input-major（=白，暗 850） | 换 specific-login-input（暗侧精确 900；亮侧 bluish-50 距规格 75 一档，无 exact alias——token 缺口①） |
| 8 | hover 钮组 | 裸 16×16 glyph gap12 | 20px 底板钮 gap4 | 裸 16 gap12，hover 变色不加底 |
| 9 | Foot 行 | gap8 pad L6/R2 r12 | gap6 pad0-8 | 照改 |
| 10 | 前导槽高 | 16×20 | 16×16 | 槽/twist 高 20 |
| 11 | chevron/twist 色 | #ADB2B8 caption | tertiary | 降 caption（folder 保持 tertiary） |
| 12 | 状态点位置 | 前导轨标题左 | 标题后 | 已修（0f8793eee） |

**token 缺口**（报 figma-flows/主题侧）：①搜索框亮值 bluish-75 无 exact alias（login-input 亮=50）；②New Session 暗 fill 规格 #43454A=bluish-750，elevated-fill 暗=750 恰合——已核。**待办**：鱼 logo 已随 1dc719078 落 primitives，Logo 行随后换装；「└」连线/展开 chevron 悬沟槽/渐隐遮罩三项待 figma-flows 答复（问询在途）。

### 1.9b 亲验轮（2026-07-22 二刀 2f7d25c3e+收尾；口径=图层原始数据为准）

**亲验节点 11 个**（dump_tree 直读）：133:7631（Logo 行）、133:7634（New Session）、133:7641（区头）、133:7649（搜索内框）、133:7668（Foot 行）、14:3079（project cell）、14:3078（session cell 组件）、34:11383/11385/11386（一二级实例+选中）、14:3071（arrow 槽）。

**底册转录更正**（原始数据 vs §1 底册）：

| 项 | 底册 | 图层实值 | 判定 |
|---|---|---|---|
| Logo 行 pad | "pad 4/8/4/8" 语序易读作水平 8 | pad(l,t,r,b)=(4,8,4,8)——**水平 4 垂直 8** | CSS 改 padding 8px 4px |
| 区头 pad | pad L12/T4/B4 | (12,4,0,4)，**R=0**；r=12 圆角实有 | CSS 补 r12（padR 0 与实现一致） |
| arrow 槽（└） | 「占 16×16 槽」 | 16×16 align=MAX/CENTER，glyph 8×10 贴右缘 | 与 figma-flows 裁定一致，照落 |
| session 槽序 | 底册正确 | arrow-tree→spacing(op0)→State(op0/亮)→2×spacing(HIDDEN)→arrow(└)→IconText；**op0 槽保位占宽**（34:11383 一级行 State 槽点亮不加宽，标题 x 不变） | 实现改为 state 槽常驻（缩进语义=槽显隐非 padding 叠加，见下） |
| New Session pad | pad 16/8 | (16,8,16,8) 居中布局 | CSS 补显式 padding |

**缩进模型修正**（亲验驱动）：原实现 paddingLeft=8+depth×22 且 state 点只在 running 时插入——与 figma「op0 槽保位」结构不符（点亮会挤走标题）。改为：twist 槽+state 槽两槽常驻（22×2），「└」槽仅子行（depth>0），额外深度=（depth−1）×22 padding。一级行标题基线与 34:11383 实测槽序对齐。

**figma-flows 三问裁定落地**（2f7d25c3e）：①展开 chevron 行内换向（悬沟槽 133:8790 为 WIP 备选，主画法=行内 133:8793）——维持现状；②「└」IconTreeCorner8x10（15d2790e0 注册版）已挂子行；③20px 批尾分隔（session 批尾→下一 project 前，非全局 gap 改动）+72px 底部渐隐（transparent→sidebar-fill，pointer-events none）已做。**搜索框 token 定案落地**：自定 `--dsh-search-input-fill`（亮 bluish-75/暗 bluish-900，body[data-ds-dark-theme] 域覆写）——上游设计系统专用变量对等物；:global 仅包 body 属性选择器（主题切换协议面，非样式越界）。FishLogo 墨色跟文字（figma-flows 裁定：主屏实例黑墨，蓝为品牌强调专用）。

## Batch 2 — Conversation 全套

基准屏：`34:10985 home`；组件 Header `39:27730`、Tool calls 集 `122:9479`、Input_Bottom `34:11445`（会话态）/`75:8117`（新建态）。暗色对照 `43:36577`/`43:37199` 屏（见 conversation.md §4.4 表，此处只列亮色实值 + 有实测暗值的项）。

### 2.1 Header

| 组件 | 属性 | figma 值 | 节点 |
|---|---|---|---|
| Header 容器 | | 1140×83, HORIZONTAL, pad L20/T12/R28/B0, fill #FFFFFF, 底描边 #000000@0.10 w1 | 39:27730 |
| 内容列 | | 1092×71, VERTICAL gap=4 | 34:11423 |
| 面包屑行 | | 1092×32, HORIZONTAL gap=16, 纵向居中 | 34:11424 |
| 面包屑组 | | HORIZONTAL gap=4, r=8；级间分隔 "/" 14px/400 #ADB2B8 | 75:7899 |
| ├ 祖先级钮 | | pad 8/4, r=12；Folder 14×14 #81858C + 文字 **13px/400 Inter lh16 #81858C** | 75:7900~7905 |
| ├ 当前级钮 | | pad 8/4, r=12；文字 **13px/500 Inter lh16 #0F1115** | 75:7907/7908 |
| ├ meta 后缀 | | "Local"+"· 5 turns · 10 tool calls" 12px/400 Inter lh20 #81858C（Local 徽标按修改 List 去掉，meta 保留） | 75:7913/7914 |
| 右钮组 | | gap=8；胶囊钮 h32 r=18 描边 #000000@0.10（Fork/Session log/I-O Details） | 43:34590 |
| Tab_Group | | 231×35, HORIZONTAL gap=36, padL8, 底对齐 | 34:11441 |
| ├ .Tab 选中 | | VERTICAL gap=8：文字 **13px/510 SF Pro lh15.5 #4176E6**† + 底条 30×3 #4176E6 | 34:11442 |
| ├ .Tab 未选中 | | 文字同字级 #81858C，底条 op=0 | 34:11443/11444 |

† 主会话已裁定选中色基准=business-primary #3964FE（不追 #4176E6）；figma 原始值照录备查。

### 2.2 消息列与 user 气泡

| 组件 | 属性 | figma 值 | 暗 | 节点 |
|---|---|---|---|---|
| 消息列 | | 768 宽固定居中（内容 736, pad 16）；x=486 起（300+186） | 同 | Frame 1912057098（34:10985 内） |
| user 容器 | | VERTICAL, align MAX（右对齐）, padBottom=16, gap=6；**最大宽 525** | 同 | 43:32116 |
| user 气泡 | | HORIZONTAL pad L16/T10/R16/B10, gap=10, fill #EDF3FE, r=22 | fill #2C2C2E | 43:32117 |
| ├ 文字 | | 16px/400 Inter lh24 #0F1115 | #F9FAFB | I43:32117;594:23062 |
| 失败态（隐藏件） | | warning 圆钮 24×24 fill #F59E0B r=100 + 错误文案 14px #81858C | — | 43:32118/32122 |
| user IconActions | | 右对齐, gap=10；.Icon_container 28×28 r28 pad6, 内 16×16 图标（copy/branch/edit）；隐藏分支分页 ‹1/2› 15px/510 #81858C | — | 43:32145~32161 |
| assistant Bubble | | **无底无描边**, 736 宽, VERTICAL gap=16；正文 16px/400 lh28 #0F1115 | 文字 #F9FAFB | 39:22250 |
| ├ markdown 字级 | | H2 20/590 lh30；H3 16/590 lh28；Divider 1px #000000@0.10 上下 pad16 | — | I39:22250;272:7190/7191/7482 |
| assistant IconActions | | 左对齐, 28×28 r28 图标钮 ×5（copy/refresh/like/dislike/share）, 相邻间距 10（38px 步进） | — | 39:22252 |
| 统计行 | | "cache hit 92% · 1,284 tokens · 45.2s · 5 turns · 32 steps" **12px/400 Inter lh20 #81858C** | — | 122:11212 |
| 回到底部钮 | | 34×34, fill #FFFFFF, stroke #000000@0.10, r=100, pad9；内 chevron-down 14×14 #0F1115；位置：列右缘, Input 上方 50px | — | 128:6106 |

### 2.3 Tool calls（组件集 122:9479，5 变体统一 24px 单行）

统一结构：`[16×16 leading] gap6 [内容行 HORIZONTAL gap8]`；标题 **14px/400 SF Pro lh24 #151517**；分隔点 2×2 ELLIPSE #ADB2B8；摘要 **14px/400 SF Pro lh24 #81858C**（FILL 宽截断）；隐藏域名文本 #61666B。

| 变体 | leading | 标题字面 | 节点 |
|---|---|---|---|
| Think | ic_ds_think 14×14（槽内 pad3） | Think | 39:28304 |
| Search | .icon_fragment 16×16（search 字形） | Search | 43:31825 |
| Read | .icon_fragment 16×16（browse 字形） | Read | 43:33122 |
| Others | 􀆿 sparkle 矢量 13.4×13.6 #61666B | Tool call | 43:31850 |
| Bash | ic_ds_api 14×14 | Bash | 39:28312 |

展开机制：leading 槽内图标 ⇄ chevron-down（Arrow 16×16, 默认 HIDDEN）互换；展开体=组容器 VERTICAL gap=4 padBottom=4 下追加缩进块 **padL22**, 正文 14px/400 SF Pro lh24 #81858C 多行（43:34327/43:34326）。行无状态色/spinner（设计未给，自定层）。

### 2.4 Composer（Input_Bottom）

| 组件 | 属性 | figma 值 | 暗 | 节点 |
|---|---|---|---|---|
| Input_Bottom | | 840×196（会话态）, VERTICAL gap=6, pad L32/R32/B12；底部渐变遮罩 840×126 | — | 34:11445/11457 |
| Input 卡（会话态） | | 776 宽, VERTICAL gap=12, fill #FFFFFF, stroke #000000@0.10 w1, **r=20**, 双层投影 | fill #2C2C2E, stroke #FFFFFF@0.06 | 34:11458 |
| Input 卡（新建态） | | 776×118, r=20, pad T10 | 同 | 34:10432 |
| .InputText | | pad L16/T4/R12, placeholder 16px/400 Inter lh24 #ADB2B8（"Message to run task, plan and build, enter for / commands"） | #81858C | 34:10434 |
| 按钮行 Frame 1123 | | 776×44, HORIZONTAL SPACE_BETWEEN, pad L12(新建 L10)/R10/B10, gap=10 | — | 34:11463/34:10437 |
| ├ + 圆钮 | | 28×28, fill #F5F6F7, r≈22(全圆), pad7；内 plus 14×14 #151517 | — | 34:12743 |
| ├ ToggleButton | | 文字 13px/500 Inter lh20 #61666B + chevron 12×12 #ADB2B8, gap=4；外层 pad 8/0 gap=10（"Plan"/"Read-only"） | — | 34:11471/34:10442 |
| ├ 模型选择器 | | "DeepSeek-V4-Pro" 13px/500 #61666B + "High" 13px/500 **#ADB2B8** + chevron 12×12, gap=4 | — | 34:10460~10464 |
| ├ 发送钮 | | IconButton 34×34, fill #3964FE, r=100, pad9, 内 send 16×16 #FFFFFF；**空文本整钮 op=0.40** | fill #679EFE | 34:10465 |
| 次级胶囊钮模板 | | h34, pad 12/6, r=18, stroke #000000@0.10；文字 13px/400 SF Pro lh20 #0F1115 | stroke #FFFFFF@0.12 | 39:13360/34:11491 |
| 主黑钮模板 | | 同尺寸, fill #0F1115, 文字 13px/510 #FFFFFF | fill #F9FAFB 字 #0F1115 | 39:13379 |
| 审批状态条（参考） | | 776×40, HORIZONTAL gap=8, pad 16/8, fill #FEF5E7 | #27241F | 39:13395 |

## Batch 3 — Details 面板 / EmptyState

### 3.1 Details 面板（RightSidebar `54:42735`，亮色屏 54:42633；暗屏 54:42043）

| 组件 | 属性 | figma 值 | 节点 |
|---|---|---|---|
| 面板容器 | | **360×920**, VERTICAL, fill #FFFFFF, 左描边 #000000@0.10 w1；挤压式（会话列 768→690） | 54:42735 |
| 头部块 | | 360×114, VERTICAL gap=4, pad L12/T14/R12/B12 | I…;43:36451 |
| ├ 标题行 | | HORIZONTAL gap=12, padBottom=12：收起钮 .Icon_container 28×28 r28（panel_left 16×16 #61666B）+ 标题列 | I…;43:41485/41609 |
| ├ 标题 | | "Response" **14px/500 Inter lh20 #0F1115**（FILL 宽） | I…;43:41479 |
| ├ See in trajectory 钮 | | h24, pad 8/4, r=18, stroke #000000@0.10；图标 12×12 + 文字 **12px/400 #61666B** | I…;54:41718/41722 |
| ├ 副标题 | | "Turn 8 · Step 6 · Response" **12px/400 Inter lh20 #81858C**，标题下 gap=2 | I…;43:41472 |
| 三段 Switch | | 336×26, 轨道 fill **#E9ECF2** r=8 pad2, stroke #000000@0.10；选中片 fill #FFFFFF r=6 + DROP_SHADOW(8)，文字 **11px/500 lh14 #0F1115**；未选中片透明，11px/400 | I…;43:41590~41599 |
| Code-block | | 336 宽 FILL 高, fill **#F9FAFB**, r=12；Header 42h pad6（类型下拉 "PLAIN" 12px/400 + chevron）；Content pad16, 正文 **Roboto Mono 13px/400 lh22 #0F1115** | I…;43:41429/41449/41450 |
| Add Feedback 钮 | | h32, pad 12/6, fill #0F1115, r=18；文字 **13px/510 SF Pro lh20 #FFFFFF**；面板右下 | I…;43:41668/41673 |
| 选中联动描边 | | 左侧被选消息/行 stroke **#3964FE 1.5px**（暗 **#679EFE**）矩形 | 54:42675 / 54:42085 |
| 分页条（游离稿） | | ‹ Previous / Next › 280×68 | 43:41486 |

### 3.2 EmptyState（NEW SESSION 屏 `34:9506`；暗屏 39:22638）

| 组件 | 属性 | figma 值 | 节点 |
|---|---|---|---|
| hero 组 | | 776×68, VERTICAL, padBottom=36（到输入卡间距），内容水平居中 | 34:10409 |
| ├ 鱼 logo | | fish 34×25，与标题 HORIZONTAL gap=10 | 34:10412 |
| ├ 标题 | | "Let's start building" **Inter 26px/600 lh32 #0F1115** | 34:10414 |
| 输入卡（新建态） | | 776×118, fill #FFFFFF, stroke #000000@0.10 w1, **r=20**, padT10, VERTICAL gap=12 | 34:10432 |
| ├ placeholder | | pad L16/T4/R12；16px/400 Inter lh24 **#ADB2B8**；文案 "Message to run task, plan and build, enter for / commands" | 34:10434 |
| ├ 按钮行 | | 776×44, SPACE_BETWEEN, pad L10/R10/B10（会话态 L12） | 34:10437 |
| ├ + 圆钮 | | 28×28 fill #F5F6F7 全圆 pad7, plus 14×14 #151517 | 34:12743 |
| ├ Plan/Read-only | | ToggleButton：13px/500 Inter lh20 **#61666B** + chevron 12×12 #ADB2B8, gap4；钮间 gap4, 各钮外层 pad 8/0 | 34:10442/10449 |
| ├ 模型选择器 | | "DeepSeek-V4-Pro" 13/500 #61666B + "High" 13/500 **#ADB2B8** + chevron, gap4 | 34:10460 |
| ├ 发送钮 | | 34×34 fill #3964FE r100 pad9, send 16×16 #FFFFFF, **空文本 op=0.40** | 34:10465 |
| 背景光晕 | | ELLIPSE 851×268 fill #6187D8@0.10（输入卡后方装饰） | 34:10343 |
| 暗色 | | 页面 #151517；输入卡 fill #2C2C2E / stroke #FFFFFF@0.06；发送钮 #679EFE | 39:22638 屏 |

## 对账回执 — ui-primitives（fw-slots，2026-07-22）

逐值对照上表+节点直读（figma 值｜实现值｜判定）；修缮 commit 见行尾。

| 件 | figma 值 | 实现值（对账前） | 判定 | 处置 |
|---|---|---|---|---|
| StateDot 实心三态 | 10×10 op.10 外圆+6×6 实心 offset(2,2)；三色=state alias | ::before inset0 op.1 + ::after inset20%（=10px 时 6×6 offset 2,2）；同 alias | ✓ 精确 | 不动 |
| StateDot Ongoing | w1 INSIDE 渐变环 handle(0.1,0)→(0.85,1) α1→0 | SVG r4.5 strokeWidth1 linearGradient (1,0)→(8.5,10) stop 1→0 | ✓ 精确（10 空间等价 handle） | 不动 |
| StateDot Active 变体 | 全隐藏占位 | 未实现 | 占位件不做 | 台账 |
| Menu 容器 | 白底 r12 无描边 双层投影 pad4 | ~~r8+border-l2+min160~~ | ✗ 三处 | **修**：r12/去描边/pad4/min130/shadow-lv2（近似双层投影，token 唯一档） |
| Menu 项 | .Menu_cell 130×40 r10 pad10/8 gap8 14/22 主文 | ~~28px 高 r6 pad0/8 gap6 13/20~~ | ✗ 五处 | **修**：pad8/10+r10+gap8+14/22（40 高=内容撑出） |
| Menu 选中态 | 尾部 check 16×16（无底色差） | ~~bg-active 底色~~ | ✗ 形态错 | **修**：尾部 IconCheckOutline16，.selected 底透明 |
| Button 胶囊 | 1:155 实例 h36 pad14/7 gap4 r18 stroke 黑@10%（wide 形 New Session=h38 r24） | ~~h32 pad0/8 r8~~ | ✗ 几何 | **修**：md=h36 pad0/14 r18；sm=h28 自定（无稿注明）。stroke 归 ghost/elevated 用法层，owner 加 |
| Button 变体色 | primary=白底黑字系（New Session）；info 蓝系另有 alias | primary-fill/ghost/toolbar alias | ✓ token 对 | 不动 |
| Input 原子件 | 无独立 figma 组件（搜索框 133:7649 是 sidebar 自组合 h38 r24 F1F3F5） | h32 r8 bg-layer-1 border-l2 | 无稿可依 | 保持自定；sidebar 搜索框归 ui-side 用法层（已判 L2） |
| Pill | 无对应节点（Tab_Group 34:11441 是 ViewSwitcher 的下划线 tab，非胶囊；convo 属地） | 24px 胶囊 | 无稿可依 | 保持自定，注记 |
| 图标 43+5 | 全 currentColor，native 14/16 | 同 | ✓ | 不动 |

修缮 commit：8fb65bddc（Menu 三处+Button 几何+IconProps exactOptional 放宽）；66 测+包 tsc 绿。

### 附：批注（B/C 件结论同波次交付）

- **B 图片导出**：本地 harness-full.json / harness-node.json 均为 REST 结构数据，无渲染位图；`.artifacts/figma/` 只有查询脚本，无带凭据的 fetch 脚本；env 无 FIGMA_TOKEN/代理变量 ⇒ **images API 不可行**（无外网+无凭据双卡）。overlay diff 需另行路径（如有人在有网机器导出后拷入）。
- **C 鱼 logo**：fish 矢量（I133:7632;88:8943，23.16×17.04 / hero 版 34:10412 34×25）为字形级 VECTOR，本地 JSON 无 geometry（同 sparkle 情形）⇒ 走重绘流程，产物在 `.artifacts/figma/extracted-icons/`（交付 fw-slots）。

## 对账回执 — ui-conversation skeleton 四件（convo-a，2026-07-22）

范围=骨架半（ConversationRoot header/面包屑/tabs、InputBar/composer、EmptyState hero、DetailsPanel 极简）；chat 流/tool 行归 convo-b 另列。修缮两刀：e0208b6d7 / 9c18b079c（dist 已重 bundle）。

| 件 | figma 值（节点） | 实现值（对账前） | 判定 | 处置 |
|---|---|---|---|---|
| 发送钮填色 | #3964FE 亮 / #679EFE 暗（34:10465 / I75:8356） | button-primary-fill=墨黑 | ✗ | 换 info-fill/info-hover pair（500→400 恰为该双值），e0208b6d7 |
| 发送钮尺寸 | 34×34 r100 | 34×34 r999 | ✓ | — |
| 空文本禁用 | 整钮 op=0.40 | opacity 0.4 | ✓ | — |
| 按钮行 pad | 12/0/10/10（34:11463） | 8px 顶多余 | ✗ | 改 0 10px 10px 12px，e0208b6d7 |
| Input 卡 | 776 cap, r20（新建 r24 沿用裁定）, stroke 0.10/0.06, fill input-major | 已对（前刀 f2d9ac91d） | ✓ | — |
| placeholder 色 | #ADB2B8 亮/#81858C 暗（34:10434 + conversation.md §4.4） | label-tertiary=#81858C | ✗ | **改判追平**（初判「不追」有误——token 表核实 caption 对=400/600 亮暗翻转恰为 figma 双端值，非低对比风险）：换 label-caption，2eebdf5dc |
| composer 卡内 gap / 底 pad | 卡 gap12（34:11458）；Input_Bottom 底 pad12（34:11445） | 无 gap；底 pad24 | ✗ | batch2 底册（bd685c247）交叉核对补漏：gap12+B12，2eebdf5dc |
| Tab 选中色 | #4176E6（34:11442） | business-primary #3964FE | △ | 底册 †注已裁定不追 #4176E6 |
| Tab 字级 | 13/510 lh15.5 + 3px 方角底条, gap8 | 13/16 wt510, 底条带圆角, 无 padL | ✗ | 去圆角、tab pad 改 0/0/11、strip padL8，e0208b6d7 |
| 面包屑钮 | pad 8/4 r12, 祖先 13/400 lh16 #81858C, 当前 13/500 #0F1115（75:7899 族） | pad 6/2, lh20 | ✗ | pad 4px 8px+lh16，色/字重原已对，e0208b6d7 |
| 分隔符 "/" | 14/400 #ADB2B8（75:7903） | 13px tertiary | ✗ | 14px + label-caption，e0208b6d7 |
| meta 后缀 | 12/400 lh20 #81858C（75:7914） | 12/18 tertiary | ✓≈ | lh 差 2px 不追（同色同字级） |
| Header 容器 | pad L20/T12/R28（39:27730）底描边 0.10 | 同值+l2 | ✓ | — |
| hero 标题 | Inter 26/600 lh32（34:10414） | 28/36 wt590 | ✗ | 26/32/600，e0208b6d7 |
| hero→卡间距 | 36px（34:10409 padBottom） | 20px | ✗ | gap 36px，9c18b079c |
| 鱼 logo | fish 34×25 + gap10（34:10412） | 无 | △ | 等 fw-slots 重绘产物（style-spec 附 C），届时加进 headline 行 |
| details 头部 | pad 14/12/12 gap8（I…;43:36451）标题 14/500 lh20（43:41479） | 12/16, lh22 | ✗ | 对齐，e0208b6d7 |
| details 收起钮 | .Icon_container 28×28 r28, 图标 16 #61666B | 28×28 r999, 14px 手绘 X | ✓≈ | 尺寸/色对；字形待图标族统一刀（P-I 手绘 X 保留） |
| details Code-block | fill #F9FAFB≈markdown-code-block, r12, pad16, Roboto Mono 13/22（I…;43:41429） | r8, pad 10/12, 12/18 | ✗ | r12/pad16/13/22，9c18b079c；字体走 --ds-font-family-code 栈不追 Roboto Mono 名 |
| details 三段 Switch/副标题/See-in-trajectory/Add Feedback | Batch 3 表 | 未实装 | — | P-I 极简裁定范围外（台账 #2） |
| 面板容器 | 360 宽左描边挤压 | 宽度归 layout；左描边 l2 | ✓ | — |

## 对账回执 — ui-conversation chat 流+tool 行（convo-b，2026-07-22）

范围=消息流半（消息列/user 气泡/tool 行五变体/统计行/回到底部）；亲验节点 9 个（122:9479 集内五变体、43:33791/43:34326 展开态与体、43:31735 组、122:11212、39:22245、43:32116/43:32117、128:6106），与 §2.2/§2.3 底册交叉核对逐值一致。修缮四刀：8e9d40065 / 4a7dab845 / 4eb7773a5 / 1d2ee309d（dist 已重 bundle）。

| 件 | figma 值（节点） | 实现值（对账前） | 判定 | 处置 |
|---|---|---|---|---|
| 消息列 | 768 定宽居中，内容 736 pad16（39:22245） | 通栏 | ✗ | W5 H1 已修（.column max736 居中），132c8d184 |
| user 气泡几何 | pad L16/T10/R16/B10, r22, gap6 容器 padBottom16（43:32116/32117） | pad 8 竖 | ✗ | 竖 pad 10（44px 单行），8e9d40065 |
| user 气泡宽 | max 525（43:32116） | 78% | ✗ | min(525px, 82%)，4a7dab845 |
| user 气泡色/字 | #EDF3FE r22, 文字 16/24 #0F1115 | specific-bubble/16/24 | ✓ | — |
| tool 行结构 | 24px 单行 [16 leading] gap6 [标题 14/24 #151517 gap8 2×2 点 #ADB2B8 摘要 FILL #81858C]（122:9479） | 同构同值 | ✓ | — |
| tool 行图标槽色 | 矢量 #81858C（Think/Bash 实测） | label-secondary #61666B | ✗ | leading 改 label-tertiary，4eb7773a5 |
| others sparkle 色 | #61666B（43:33095） | 随槽色 | ✗ | data-variant=others 覆写 secondary，4eb7773a5 |
| 展开 chevron | #61666B（43:33187） | label-tertiary | ✗ | chevron 改 label-secondary，4eb7773a5 |
| 展开体 | padL22, 14/24 #81858C 多行；组容器 gap4 padBottom4（43:34326/34327） | padL22 14/24 tertiary; body pad 4px 0 4px 22px | ✓≈ | 值全对（上 pad 4 与组 gap4 语义合并，视觉等价） |
| 组 gap / 块间 | 组内 10（43:31735），块间 16（39:22248） | gap10 / gap16 | ✓ | — |
| 双重块间距 | 块间精确 16 | MessageItem/AssistantMarkdown 各带 pad 4px 0 叠加 | ✗ | 删除，4eb7773a5 |
| 统计行 | 12/400 Inter lh20 #81858C（122:11212） | 12/18 | ✗ | 12/20+736 列轴对齐，4eb7773a5 |
| 回到底部钮 | 34×34 圆钮 白底 stroke 0.10 r100 pad9, chevron 14 #0F1115, 列右缘（128:6106） | 居中文字胶囊 | ✗ | 重做圆形图标钮贴列右缘，1d2ee309d |
| 行级状态色 | 设计未给（底册注记：自定层） | StateDot running 蓝环/error 红/stopped 琥珀 | — | 自定层保留（契约已录） |
| 选中描边 | #3964FE 1.5px 暗 #679EFE（54:42675/42085） | button-info-fill 1.5px | ✓ | M1b 已修，9c18b079c 前刀 |
| IconActions 五钮排 / user copy-branch-edit | 28×28 r28 系（39:22252/43:32145） | 未实装 | — | P-I 范围外（plugins §1 T 层预留位） |

## 对账回执 — layout 级（ui-shell，2026-07-22）

对账面=三栏壳/Handle/AppRoot loading 页/base.css（figma 节点直读 vs 实现 CSS 逐值）：

| 项 | figma 基准 | 实现现状 | 判 | 处置 |
|---|---|---|---|---|
| sidebar/details 栏宽 | 300 / 360（133:7629 / 54:42735） | SIDEBAR_DEFAULT=300、DETAILS_DEFAULT=360 | ✓ | columns.ts 契约常量 |
| sidebar 底色 | #F9FAFB（暗 #1B1B1C，1.1） | 原 bg-layer-1=纯白 | ✗ | 改 `--dsw-specific-sidebar-fill`（bluish-50/900），50867d1e6 |
| sidebar 右描边 | #000@0.04（暗 #FFF@0.06） | border-l1 | ✓ | 两侧同值 |
| details 左描边 | #000@0.10 w1（54:42735 stroke 直读） | 原 border-l1=0.04 | ✗ | 改 `--dsw-alias-border-l2`（0.10/0.12），50867d1e6 |
| Handle 把手 | 12×32 r10 fill #FFF stroke #000@0.10；暗 #2C2C2E/#FFF@0.06（133:7639/42:28833 直读） | 原透明 2px 细条 hover 才显 | ✗ | 常显 12×32 r10 药丸：bg-layer-2（白/850=#2C2C2E 恰合）+border-l2-darkmode-thin（0.10/0.06 恰合）；hover/拖拽=描边加深；8px 命中带保留，50867d1e6 |
| AppRoot loading 页 | 无稿（自定层） | 字体变量正名 e3da6fbb6；中性回退=壳 boot 页专有豁免 | — | 维持 |
| base.css 字体 | — | body 走 `--dsw-font-family`；字号成对写惯例归组件 | ✓ | 维持 |
| 让步阈值 | figma 无窄窗稿 | min640 契约值 | — | 维持契约（plugins §0.1-2） |

未入本对账（他人属地）：conversation 列 768/736 与 Header 83h（convo 回执已列）、Cell 行内几何（ui-side）。

**探针扩展**（figma-flows 复判缺口）：w5-full-probe 追加两镜头——13-tree-expanded（project 行点开子树）、14-row-hover（行 hover 态）；置于 reload 步之后（树点击改选中态会毒化 reload 的回显等待，实测踩过）。全 10 步绿，截图 w5-13/14 已产。
