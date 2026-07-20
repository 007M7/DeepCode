# Figma 解析报告：左侧 Sidebar（projects / sessions 列表）

> 数据源：`.artifacts/figma/harness-full.json`（Figma 文件树，页面 `0:1 Harness`）。解析脚本在 `.artifacts/figma/`（find_nodes.py / dump_tree.py / dump_texts.py，gitignored）。
> 核心参照物：独立组件稿 `133:7629 Sidebar`（TREE WIP 区，300×920）、组件集 `14:3080 Cell` / `27:3260 Folder` / `14:3304 State`、home 屏内嵌 sidebar（`34:10632` 菜单展开态、`122:10273` 普通态、`42:28823` 暗色态、`34:11333` 选中态、`43:31859` onboarding 态）。

## 1. Sidebar 整体结构

根 Frame `133:7629`：300×920，**VERTICAL 自动布局，gap=8，padding 左右 16 / 上下 6**，背景 `#F9FAFB`，右侧 1px 描边 `rgba(0,0,0,0.04)`。从上到下四块：

| 区块 | 节点 | 尺寸 | 布局 | 内容 |
|---|---|---|---|---|
| 头部 | `133:7630` | 268×126 | VERTICAL gap=16, padBottom=12 | Logo 行 + New Session 按钮 |
| ├ Logo 行 | `133:7631` | 268×60 | HORIZONTAL gap=8, pad 4/8 | 左：logo（鱼形图标+wordmark，`#3964FE`）+ 「HARNESS」黑底白字小徽章（`#0F1115` 底、白字 11px/500 Intel One Mono、r=2）；右：`.Icon_container` 28×28 圆形按钮内 `ic_ds_panel_left_outline_16`（`#61666B`）＝**收起 sidebar 按钮** |
| ├ New Session | `133:7634` | 268×38 | HORIZONTAL gap=6, pad 16/8, 居中 | 白底胶囊（r=24，描边黑@10%）：`ic_ds_new_chat` 14px + 「New Session」14px/510 `#0F1115`。**隐藏元素**：loading 前缀圈（`133:7635`）和右侧下拉小箭头（`133:7638`，10×6 `#A3A3A3`）——预留「创建中」态和下拉选择（选 workspace？）态 |
| 把手 | `133:7639 Handle` | 12×32 | 绝对定位，骑在右边框上、垂直居中（x=右缘-6） | 白底胶囊 r=10、描边黑@10%。实例来自**远程库组件集 `128:7160 Handle`**，当前只用 `Property 1=normal` 变体。所有 19 个 home 屏的 sidebar 都带它、位置一致 ⇒ **确认是 sidebar 折叠/拖宽把手** |
| 列表区 | `133:7640` | 268×717 | VERTICAL gap=4, padBottom=12 | 见下：区头 + 搜索 + Cell 列表 + 底部渐隐 |
| ├ 区头 | `133:7641 Text` | 268×36 | HORIZONTAL, padLeft=12 | 「WorkSpace」14px/400 `#81858C`（弹性占满）+ 右侧两个 28×28 圆形图标钮：`ic_ds_Personalization`（三条带圆点的横线＝**分组/视图设置**，点击弹 Group by 菜单，见 §3）和 `ic_ds_project_add`（**新建 project/workspace**） |
| ├ 搜索框 | `133:7648 Input` | 268×54（内框 38 高） | 内框 `133:7649`：HORIZONTAL pad 14/9, r=24 | 底 `#F1F3F5`、描边黑@10%；放大镜 14px `#ADB2B8` + 占位文字「Search name, keywords...」14px `#81858C`；**隐藏**的清除钮（`133:7655` 圆形 X）输入时出现 |
| ├ Cell 列表 | — | — | 父容器 gap=4 | project 行 54 高、session 行 34 高（见 §2）。展开的 project 后跟其 session 行，再接 `spacing`（268×20 透明矩形 `133:7661`）分隔下一批 project |
| ├ 渐隐遮罩 | `133:7666 Gradient` | 268×72 | 绝对定位在列表底 | `#F9FAFB` 透明→不透明的线性渐变，滚动列表底部渐隐效果 |
| Foot | `133:7667` | 268×49 | VERTICAL pad 上下 10 | `.Section_Profile`（`133:7668`，268×29，r=12）：`ic_ds_settings` 14px + 「Settings」14px `#0F1115`；**隐藏** Notice 徽章（`133:7672`，`#E4EDFD` 底、`#5686FE` 字 10px，文案「企业账号」/组件原文「Topped-up balance ⓘ」）。组件原名 `Yifan_D` ⇒ 这行原是 profile 行，现改作 Settings 入口，徽章预留账号类型提示 |

暗色对照（`42:28823`）：背景 `#1B1B1C`、右描边白@6%；New Session 按钮 `#43454A`+白@12% 描边；搜索框底 `#1B1B1C`+白@12% 描边；标题字 `#F9FAFB`、时间字 `#ADB2B8`。结构完全一致。

## 2. Cell 组件集（`14:3080`）——全部变体

组件集只有 2×2 = 4 个变体，props：`Type = project | sub`，`State = Default | hover`。**没有 selected/running/archived 变体**——选中底色靠实例覆写（见下），running/审批等状态靠内部 State 圆点插槽表达。

### Type=project（54 高，两行）——project/workspace 行

- `14:3079` Default：pad 8/6，r=8，无底色。结构：
  - 前导图标槽 16×20：`Folder` 实例（§2.1）+ 隐藏的 chevron（`16:2673`，hover 时换上）；
  - `IconText`（VERTICAL gap=2）：标题 14px/400 Inter `#0F1115`（如 "Code base analysis"）+ 第二行会话计数 12px/400 Inter `#81858C`（"8 sessions" / "1 session"——有单复数）；
  - 尾部隐藏的 `State` 圆点 10×10（project 行也可带状态点，默认藏）。
- `25:2671` hover：底色 `#263148 @6%`；**前导 folder 换成右向 chevron**（`25:2676`）；尾部出现 44×16 按钮组 `27:4668`：`ic_ds_ellipsis`（… more 菜单）+ `ic_ds_plus`（在该 project 里新建 session），both `#81858C`。

### Type=sub（34 高，单行）——session 行

- `14:3078` Default：pad 8/7，r=8。**一排 16px 宽的可开关插槽从左到右**（每个可见槽位把内容右推 22px＝16+gap6，构成树形缩进）：
  1. `arrow-tree`（`133:8789`，TREE WIP 迭代新加的槽）：右向小 chevron `#ADB2B8`（由 chevron_down 旋转来，`133:8793` 可见）＝子树展开开关；另有一枚**隐藏**的向下 chevron `133:8790` 悬在 cell 左侧沟槽（x=cell-11px）——展开态的画法，默认藏；
  2. `spacing`（`133:8325`，opacity 0，内含 State 实例）：缩进占位，需要时可点亮成状态点；
  3. `State`（`14:3069`）：10×10 状态圆点（§2.2），默认 opacity 0；
  4. 两个隐藏 `spacing`（`14:3170`/`14:3198`，内含 chevron）：更深缩进的备用槽；
  5. `arrow`（`14:3071`）：8×10 的「└」拐角连线（Vector 546，描边 `#ADB2B8`）＝**树的分支连接符**，标记这行是上一行的子 session；
  6. `IconText`（HORIZONTAL）：标题 14px `#0F1115`（超长截断，样例 "This is a session name which is pretty long"）+ 右侧相对时间 12px `#81858C`（样例值 now / 2min / 1h / 2d / 18d / 2mo）。
- `16:2570` hover：底色 `#263148 @6%`；**时间文字隐藏，换成 `ic_ds_ellipsis`**（`27:4656`）… 菜单钮。

### 实例覆写观察（选中态与树缩进）

- **选中行**：会话打开屏 `34:11333` 里当前会话行 `34:11386` 覆写底色 `#263148 @10%`（hover 是 6%）⇒ 选中=同色更深一档。
- **树缩进实例样本**（`34:11333` 列表，session tree）：
  - 一级（project 直属）：`34:11383` "This is a ongoing session"——State 点亮（Ongoing）；
  - 二级：`34:11385` "Session"、`34:11386` "Session is waiting for approval"——`arrow` 拐角可见，State 分别熄灭/amber；
  - 三级：`34:11390`（2mo 行）——多点亮一个 spacing 槽，再缩一级。
  - ⇒ 设计支持 **session 下再挂子 session 的多级树**（对应 fork/subagent 的会话树）。

### 2.1 Folder 组件集（`27:3260`，5 变体）

| 变体 | 视觉 | 用途 |
|---|---|---|
| `close`（`27:3261`） | 灰描边闭合文件夹 `#81858C` | 收起的 project |
| `open`（`27:3274`） | 灰色打开文件夹 | 展开的 project（非活跃） |
| `open-active`（`27:3276`） | **蓝色 `#3964FE`** 打开文件夹 | 展开且含当前会话的 project（TREE 稿 `133:7656` 用的就是它） |
| `arrow`（`27:3282`） | 右向 chevron `#ADB2B8` | hover/树开关（收起） |
| `arrow-open`（`27:3284`） | 下向 chevron | 树开关（展开） |

### 2.2 State 状态点组件集（`14:3304`，5 变体，10×10 双圆结构：外圈同色 @10% 晕 + 6×6 实心）

旁边有图例 TEXT（`122:9191`–`122:9194`），按 y 坐标与变体一一对应：

| 变体 | 颜色 | 图例文案 | 语义 |
|---|---|---|---|
| `Done`（`14:3303`） | `#22C55E` 绿 | "new task completed" | 有新完成结果未读 |
| `warning`（`14:3305`） | `#F59E0B` 琥珀 | "need approval" | 等待审批（样例行 "Session is waiting for approval" 用它） |
| `Ongoing`（`14:3311`） | 蓝色渐变描边圆环（`#5686FE`→透明，无填充） | "agent working" | agent 运行中（缺口环≈spinner，可转动） |
| `Variant5`（`122:9182`） | `#EC1313` 红 | "error" | 出错 |
| `Active`（`14:3308`） | 填充全部 visible=false（绑定绿色变量但隐藏） | （无图例） | 占位/无状态（已读普通行就是点不亮） |

## 3. 分组模式（Group by）

- 「Group by Workspace」标签（`122:9529`）下一列三块屏：`34:10628`（**菜单展开态**）、`122:10273`（普通亮色）、`39:22754`（暗色）。列表结构＝§1：**分组头就是 project 行本身**（54 高 Cell），展开的 project 直属其下的 session 行，之后 20px `spacing` 再列剩余收起的 project。**没有单独的分组标题条组件；`spacing` 后面那批 Cell 不是归档区，就是其余收起的 project**（此前"归档区"猜测不成立——全部设计稿中未发现任何 archive 元素）。
- **Group by 菜单**（`34:10628` 内 `122:10096 MenuDropdown`，白底 r=12，双层投影 0/12/32 黑@8% + 0/0/4 黑@2%，弹出位置正对区头 Personalization 图标下方）：
  - 「Group by」——灰色 14px 分节标签（不可点样式）；
  - 「WorkSpace」——带 `ic_ds_check` ✓（当前选中）；
  - 「Update」——按更新时间分组/排序；
  - 「Status」——按状态分组。
  - 菜单项是 `.Menu_cell` 组件（130 宽、40 高、r=10、hover 变体走库里 `27:5171`），另有 16 个隐藏备用项。
- 「Group by Status」标签（`122:10151`）**下方没有任何屏**（全深度坐标扫描 x∈[10800,13500] 只有标签自己）⇒ Status 分组视图**未设计，WIP**。Update 分组同样无屏。会话打开屏（`34:11948`，ACTIONS 列）里也出现同一菜单实例（`I34:12020/12021`），说明菜单是全局常驻能力。
- 「ONBOARDING WIP」屏（`43:31855`→sidebar `43:31859`）：列表只有 5 个收起的 project 行，无展开、无 spacing、无渐隐遮罩 ⇒ 初始态全收起。
- 「TREE WIP」区（标签 `133:7628`）就是独立稿 `133:7629`，即 §2 的多级树设计的宿主。

## 4. 交互推断

1. **行 hover**（有原型交互佐证：所有 Cell 实例带 `ON_HOVER → CHANGE_TO hover 变体`，SMART_ANIMATE ease-out）：
   - project 行：folder 图标→chevron，右侧浮现「…」+「+」；草稿页注记 `43:40440`「hover 之后 有 + 按钮？」（+＝在该 project 下新建 session）。
   - session 行：时间→「…」；草稿页注记 `43:40439`「时间怎么办 hover 出来的 more」。
   - 「…」的菜单内容设计稿未给（隐藏 `.Menu_cell` 里有「删除」字样残留，`I122:10117;6571:170698`，可推有 删除/重命名 类操作）。
2. **点击**：project 行点击=展开/收起（chevron 语义）；session 行点击=打开会话（`34:11333` 屏当前行深底 @10% 选中态）。
3. **树展开**：session 行前导 `arrow-tree` chevron（右向=收起，隐藏的下向=展开）⇒ 子 session 可折叠。
4. **Handle**：sidebar 右缘中点 12×32 把手，收起/展开整栏（配合 Logo 行的 panel_left 按钮，双入口）。
5. **头部图标钮 hover**：`.Icon_container` 亦带 ON_HOVER 原型跳变（库内置灰底反馈）。
6. 草稿页其他相关注记（`43:37430 draft` 页）：`43:40436`「怎么创建 workspace 或在 workspace 中创建 workspace 创建后是什么？」、`43:40437`「可能可以这些 sessions 数量 不这样展示」、`43:40438`「filter 和聚合」、`43:40435`「Ask question / Waiting for approval 可能不用区分了」⇒ workspace 创建流、计数展示、筛选聚合、状态粒度都还在摇摆，实现时留弹性。

## 5. 视觉 token 小表

| token | 亮色 | 暗色 |
|---|---|---|
| sidebar 背景 | `#F9FAFB` | `#1B1B1C` |
| sidebar 右描边 | `rgba(0,0,0,.04)` | `rgba(255,255,255,.06)` |
| 主文字（标题/条目） | `#0F1115` | `#F9FAFB` |
| 次文字（计数/占位/区头） | `#81858C` | `#ADB2B8`（时间） |
| 三级/图标灰 | `#ADB2B8`、`#61666B` | — |
| 行 hover 底 | `#263148 @6%` | 同 token（变量绑定） |
| 行选中底 | `#263148 @10%` | 同 token |
| 输入框底/描边 | `#F1F3F5` / 黑@10% | `#1B1B1C` / 白@12% |
| 按钮底/描边 | `#FFFFFF` / 黑@10% | `#43454A` / 白@12% |
| 品牌蓝（logo、active folder） | `#3964FE` | 同 |
| 状态色 | 绿 `#22C55E`、琥珀 `#F59E0B`、红 `#EC1313`、运行环 `#5686FE` 渐变 | 同 |
| 圆角 | 行 8；胶囊（按钮/输入框）24；菜单 12；圆形图标钮 28；Handle 10；徽章 2/4 | 同 |
| 字体字号 | 标题 Inter 14/400；元信息 Inter 12/400；UI 控件 SF Pro 14（按钮 510）；HARNESS 徽章 Intel One Mono 11/500 | 同 |
| 关键尺寸 | 栏宽 300（内容 268）；Logo 行 60；按钮 38；区头 36；搜索内框 38；project 行 54；session 行 34；行距 4；缩进步长 22（16 槽+6 gap）；状态点 10；Handle 12×32 | 同 |

## 6. 对 plugins.md（projects / sessions 插件）的映射建议

仅建议，不改文档：

1. **SessionRow 的 props 维度要多一个"树深度/子树"轴**：设计支持 session 多级树（fork/subagent），`SessionRow` 除 `sessionId`+摘要切片外需要 `depth` 与 `hasChildren/expanded`；子树折叠是**本地观看态**（同现有"折叠/展开分组"归属）。
2. **状态点是摘要切片的一等字段**：green(新完成未读)/amber(待审批)/ring(运行中)/red(错误)/无。前两者含"未读"语义 ⇒ 切片里除 host 状态外还要一个**客户端本地的 last-seen 标记**（新完成=完成时间 > 上次打开时间），这块归 projects 插件自己的观看态，不必上 host。
3. **分组模式（WorkSpace/Update/Status）是 ProjectsBlock 的全局观看态**（persist 到本地即可）；但设计只画了 WorkSpace 分组，Update/Status 无稿 ⇒ 插件先实现 by-workspace，把 group-by 做成 ProjectsBlock 内部策略函数而非新 slot，后两种进 backlog。
4. **没有归档 section**：列表=展开块+spacing+其余收起 project，不需要 archive 维度；不要为它预留 slot。
5. **行级 actions 收敛**：hover「…」（session：删除/重命名类；project：管理类）+ project「+」（=`sessions.create({cwd: 该 project})`，正好复用现有 `sessions.create` 面）+ `ic_ds_project_add`（区头新建 workspace——若 host 无 project 概念，本质是"带新 cwd 的 create"入口）。菜单内容未定稿，「…」建议做成插件内 dropdown，条目可后补。
6. **搜索框**（"Search name, keywords..."）是 projects 插件的本地过滤（global 维度，纯前端 filter），配合草稿注记"filter 和聚合"，建议 props 只留 `query` 一根轴。
7. **New Session 按钮的隐藏下拉箭头**提示未来"选 workspace 再创建"；NewSessionButton 的 `可带 cwd 选择` 设计已覆盖，无需改。
8. **sidebar 折叠**（Handle + panel_left 双入口）是 layout/shell 级全局观看态，归 sidebar 容器持有，不进 projects 插件。
9. **视觉 token**（§5）建议进 theme 层变量（亮暗双值都有稿），行 hover/选中用同一颜色 `#263148` 的 6%/10% 两档，实现时做成 token 而非写死两色。

### 关键节点索引（回查用）

独立稿 `133:7629`；Cell 集 `14:3080`（变体 `14:3079`/`25:2671`/`14:3078`/`16:2570`）；Folder 集 `27:3260`；State 集 `14:3304` + 图例 `122:9191~9194`；Handle 集 `128:7160`（远程）；Group by 菜单 `122:10096`；菜单展开屏 `34:10632`；暗色 `42:28823`；选中态屏 `34:11333`（选中行 `34:11386`）；onboarding `43:31859`；hover 按钮组 `27:4668`/`27:4656`；draft 注记 `43:40435~40440`。
