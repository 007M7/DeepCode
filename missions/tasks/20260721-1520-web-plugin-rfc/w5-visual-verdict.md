# W5 逐屏 figma 对比判定（figma-flows）

> **复判（04:47 批次，修缮后）见文末「复判」段**：H1/H2/M1/M2/M3 全部修复确认；主判定表基于 03:33 批次，历史结论保留不改。

判定人：figma-flows（视觉顾问）。对照物：figma-analysis/{sidebar,conversation,flows-future}.md 三份定稿解析 + cssdesign 变量体系；测量方法：PIL 像素采样（背景取区域众数、文字取最暗像素、尺寸取色块边界扫描）。
范围纪律：只比已定稿要做的功能。**豁免项（P-I 台账）**：details 三段 Switch/步进、行级菜单、状态点 done/error 数据源、Trajectory/Waterfall 内容效果——涉及处标「豁免」不计偏差。
截图为 1680×1000（03:33 终轮）与 1280×720（03:21 批次的 w5-03b/07b/08b 三张，viewport 不同仅作补充证据）。figma 基准屏 1440×1000。

## 总判定

| 严重度 | 数量 | 摘要 |
|---|---|---|
| 高 | 2 | 消息列无 736px 定宽；tab 选中色黑/白 vs 定稿蓝 |
| 中 | 4 | 暗色选中行高亮缺失；暗色输入框 fill 错 token；暗色 details 代码块与底同色；新建屏缺 Plan/Read-only/模型选择器 |
| 低 | 6 | 气泡竖 padding 偏小；搜索框亮色底；禁用发送钮灰色；缺鱼 logo×2；统计行缺耗时；Handle 不可见 |
| 合格 | 14 项核心检查 | 详见逐屏表 |

---

## 偏差清单（按严重度）

### 高

**H1 消息列未按 736px 定宽居中，通栏拉满**
- 证据：w5-08 assistant 段落 ink 从 x=330 延伸到 x=1648（宽约 1326px）；w5-09 开 details 后同样拉满剩余区（325→1287）。
- 定稿：conversation.md §0——消息列 Frame 768 宽固定居中（内容 736，pad 16），输入框 776 与其中轴对齐。figma 节点 `Frame 1912057098`（34:10985 内）。
- 影响：宽屏下行长超可读上限，与输入框（实测 776 居中 ✓ 合格）不同轴，整个骨架观感偏离。
- 备注：输入框已经做对了定宽居中，消息列补一个 max-width 即可对齐。

**H2 视图 tab 选中态颜色错误**
- 证据：w5-04 Chat 选中文字最暗像素 #0F1115、底条 3px #0F1115（y=76..78）；w5-11 暗色下选中条为白色。
- 定稿：conversation.md §5——选中 `#4176E6` 文字 + 3px 同色底条；未选中 #81858C（未选中项实测 #81858C ✓）。figma 节点 Tab_Group `34:11441`，.Tab comp `22:2787/22:2790`。
- 底条厚度 3px ✓、位置 ✓、未选中灰 ✓，只有选中色错。

### 中

**M1 暗色选中工具行高亮缺失**
- 证据：w5-10（亮色）选中 bash 行有 1px `#3964FE` 描边矩形 ✓（定稿 1.5px，1px 渲染差异可接受）；w5-11（暗色，details 同样开着）全区扫描无任何蓝色描边。
- 定稿：flows-future.md §1.3——选中项高亮描边，暗色屏对应 `54:42085` stroke **#679EFE**。
- 若暗色下选中态被清空是交互 bug 而非样式缺失，也应记：截图状态下应有高亮。

**M2 暗色 composer 输入框 fill 用错 token**
- 证据：w5-11 输入框内部 #151517（与页面底同色），仅靠描边分辨。
- 定稿：conversation.md §4.4——dark Input fill **#2C2C2E**（`--dsw-specific-input-major` 暗值）。
- 对照：同屏 sidebar 搜索框实测 #2C2C2E（用对了），composer 与 search 用了不同 token，属不一致实现。

**M3 暗色 details 面板代码块与面板底同色**
- 证据：w5-11 details Input/Output 代码块内部 #151517 = 面板底色，色块不可辨（文字悬空）。
- 定稿：亮色代码块 #F9FAFB（w5-09 实测 #F9FAFB ✓ 精确合格）；暗色应切 `--dsw-alias-markdown-code-block` 暗值 **#1B1B1C**（neutral-bluish-900）。
- 疑似亮色写了具体值/暗色映射缺失。

**M4 新建会话屏缺 Plan / Read-only / 模型+effort 选择器**
- 证据：w5-01/02 输入框下沿只有「默认目录 ▾」（cwd 选择）+ 发送钮。
- 定稿：conversation.md §4.1——按钮行左 [+][Plan ▾][Read-only ▾]、右 [DeepSeek-V4-Pro High ▾][发送]；每屏都有（34:10432/34:9506）。
- 「默认目录」下拉不在定稿中（属 NewSessionButton『可带 cwd 选择』的合理延伸，摆位无稿可依，不计偏差）；缺失的三个选择器不在豁免清单，计偏差。**若 P-I 台账已把 composer C5 划出本期，请 main 降级为豁免。**

### 低

**L1 user 气泡垂直 padding 偏小**：w5-04 气泡实高 37px（单行 16px 文字），定稿 pad 16/10 + 行高 24 → 应 44px。实测竖 pad ≈6.5px vs 10px。色 #EDF3FE ✓ 精确、右对齐 ✓、圆角饱满（全圆头）与 r22 观感一致 ✓。figma `1:866`。
**L2 sidebar 搜索框亮色底 #FFFFFF**：定稿 `#F1F3F5` 底 + 黑@10% 描边（133:7649）。暗色底 #2C2C2E vs 定稿 #1B1B1C+白@12%——暗色也偏一档，但暗色搜索框仅 42:28823 一屏有稿，从宽记 L 级合并在此。
**L3 禁用/空文本发送钮为灰色**：w5-01 实测 #9E9FA0 圆钮、w5-11 暗 #43454A。定稿：发送钮恒 #3964FE，空文本 op=0.40（≈#B0C1FE over white）；暗 #679EFE。运行中的「停止」方块形态设计未画，自定合理不计；仅禁用色计低档偏差。
**L4 缺鱼形 logo**：sidebar logo 行只有「deepseek」黑字 + HARNESS 徽章（徽章 ✓ 黑底白字合格）；hero 标题旁也无鱼图标。修改 List（75:5996）第一条就是「加鱼 logo」，hero 稿（34:10412）鱼 34×25。
**L5 统计行缺耗时字段**：w5-08 "cache hit 99% · 9,030 tokens · 2 turns · 2 steps"，定稿样例含 45.2s 槽（122:11212）。位置（消息列尾）✓、字号 12px 灰 ✓、分隔符 · ✓。
**L6 sidebar Handle 无可见把手**：拖宽功能存在（w5-10 拖到 366px 生效 ✓），但右缘无 12×32 白底胶囊把手（128:7160）。

### 观察项（不计偏差）

- **Bash 行为自定 toolview 样例**（`$ Run echo w5marker` 终端绿 $ 风格）：与定稿 Bash 变体（api 图标 + "Bash" 标题 + 摘要，122:9479）完全不同，但这是 P-I 有意注册的 bash 样例 toolview（任务台账 #12），属坑位机制验证，不按 1:1 判。后续如要贴稿可切回标准行。
- **Think 行结构合格**（icon+标题+·+摘要 单行 24px 节律 ✓，标题 #151517/摘要 #81858C 观感一致），但 leading 图标字形是「圆圈叉」而非 ic_ds_think 字形，待 ui-primitives 图标族接入后复核。
- **placeholder 文案自定**：w5-01 英文 "Message to run task, plan and build"（比定稿少 ", enter for / commands"）；会话内中文「输入消息，Enter 发送…」「回复生成中，可停止后再输入」。运行中禁输的交互定稿本就没画（追问队列未实现），文案属 i18n 未决（flows-future §5 已记），留待统一。
- **session 树行未入镜**：全部截图中 project 行均未展开，session 行 34px 高/22px 缩进/State 点/hover 无从判定。建议下轮补一张展开树截图。
- **details 空态自定**（w5-12「详情/点击消息流中的工具行查看详情」）：定稿无空态稿，自定合理。
- **w5-05 Trajectory「1 turns · 0 steps」单复数**：cosmetic。

---

## 逐屏判定表

约定：结论列 ✓=合格；△=偏差（引用上表编号）；◐=豁免/自定/无法判定。检查项覆盖：布局结构 / 间距节律 / 圆角 / token 色 / 字号行高 / 组件形态。

### w5-01 cold-start（亮，1680×1000）
| 检查项 | 实测 | 定稿 | 结论 | 节点 |
|---|---|---|---|---|
| sidebar 宽/底/右描边 | 300px / #F9FAFB / 过渡带 #F5F5F5（黑@4% over 白） | 300 / #F9FAFB / rgba(0,0,0,.04) | ✓ | 133:7629 |
| logo 行 | 「deepseek」黑字+HARNESS 黑徽章；无鱼 | 鱼+wordmark #3964FE+徽章 | △L4（徽章 ✓） | 133:7631 |
| 收起钮 panel_left | 右上 16px 图标 ✓ | .Icon_container 28 圆 | ✓ | 133:7633 |
| New Session 钮 | 白底胶囊+黑@10% 描边(#E6E6E6)+⊕+黑字 | 白底 r24 h38 ic_ds_new_chat+14/510 | ✓ | 133:7634 |
| WorkSpace 区头 | 灰标题+Personalization+project_add 两钮 | 同 | ✓ | 133:7641 |
| 搜索框 | fill #FFFFFF+描边；占位文案逐字符一致 | fill #F1F3F5 | △L2（文案 ✓） | 133:7648 |
| 空列表态 | "No sessions yet" 灰字 | 无稿（onboarding 稿是 5 行收起 project） | ◐ 自定合理 | 43:31859 |
| Foot Settings | 齿轮+Settings 左下 ✓ | .Section_Profile | ✓ | 133:7668 |
| hero 标题 | 居中，ink 高约 20px（≈26px/600）；无鱼 | Inter 26/600 #0F1115+鱼 34×25 | △L4（字号 ✓） | 34:10414 |
| 输入框 | 定宽居中、大圆角、发送钮右下圆钮 | 776×118 r24 | ✓（结构） | 34:10432 |
| 选择器行 | 仅「默认目录 ▾」 | +、Plan、Read-only、模型+effort | △M4 | 34:10433 |
| 发送钮（空文本） | 灰 #9E9FA0 | #3964FE op.40 | △L3 | 34:10465 |
| tab 组 | 无（空会话）✓ 符合「仅有内容时出现」 | — | ✓ | flows-future §2.2 |

### w5-02 empty-state（与 w5-01 同帧内容）
同 w5-01 全部结论，无新增。

### w5-03 after-first-send（亮）+ w5-03b after-send（1280×720 批）
| 检查项 | 实测 | 结论 |
|---|---|---|
| 输入中文字色 | #81858C | △ 观察：输入态文字应为主文字 #0F1115，#81858C 是占位色——若截图瞬间仍是 placeholder 渲染则 ✓；从「请简单介绍…」为已敲入文本看，输入文字用了占位 token，记低档观察（不入偏差表，证据不足以排除截帧时序） |
| w5-03b：会话内消息流出现（user 气泡右对齐 + Think 行 + 正文） | 结构 ✓ | ✓ |
| w5-03b：sidebar 出现 Ungrouped/1 session project 行 | folder 图标 #81858C+标题+计数副行 | ✓（54px 双行形态） |

### w5-04 round-complete（亮，重点屏）
| 检查项 | 实测 | 定稿 | 结论 | 节点 |
|---|---|---|---|---|
| Header 面包屑+meta | session 名 13px 截断+「· 1 turns」12px 灰 | 当前级 13/500 + meta 12 #81858C | ✓ | 75:7899 |
| Header 右钮组 | 无 Fork/Session log/I-O Details | 三胶囊钮 | ◐ 本期无 details 按钮入口（点工具行开板替代，见 w5-09）；如台账未豁免请 main 归档 | 43:34526 等 |
| tab 组形态 | Chat/Trajectory/Waterfall 三 tab、间距均匀、13px | 同、gap36、13/510 | ✓ | 34:11441 |
| tab 选中色 | 文字 #0F1115+3px 黑条 | #4176E6+3px 蓝条 | △**H2** | 22:2787 |
| user 气泡 | #EDF3FE 精确、右对齐、右缘距边 25px、宽 383<max | #EDF3FE r22 右对齐 max≈525 | ✓（色/对齐/宽） | 1:866 |
| user 气泡高度 | 37px（竖 pad≈6.5） | 44px（竖 pad10） | △L1 | 同上 |
| 消息列宽 | 通栏（见 H1 证据） | 736 定宽居中 | △**H1** | Frame 1912057098 |
| 输入框宽/居中 | 778px、中轴 989≈主区中心 990 | 776 居中 | ✓ | 34:11445 |
| 运行中发送钮 | 灰圆+黑方块（停止） | 未画 | ◐ 自定合理 | conversation §4.1 缺口 |
| Think 行 | 单行 icon+Think+·+摘要，摘要 #81858C | 24px 单行结构 | ✓（图标字形观察项） | 122:9479 |
| sidebar project 行 | folder+Ungrouped+1 session 双行 | 54px Type=project | ✓ | 14:3079 |

### w5-05 trajectory-tab / w5-06 waterfall-tab
| 检查项 | 实测 | 结论 |
|---|---|---|
| tab 切换生效、选中态移动 | Trajectory/Waterfall 下划线+加重 | ✓（选中色仍 △H2） |
| 统计条在视图顶部 | "1 turns · 0 steps · 0 tool calls" 位于 tab 下、内容上 | ✓ 符合修改 List「统计信息在 traj/waterfall 面板上方」（75:5996） |
| 视图内容（turn 0 行/灰块） | 骨架占位 | ◐ 豁免（Trace/瀑布未设计，TRACE WIP 空区） |

### w5-07 back-to-chat（=w5-04 同帧）+ w5-07b sidebar-session（1280×720）
切回 Chat 无状态丢失 ✓；其余同 w5-04。w5-07b 同 w5-03b。

### w5-08 bash-round（亮，重点屏）+ w5-08b reload-recovery（1280×720）
| 检查项 | 实测 | 定稿 | 结论 |
|---|---|---|---|
| 多轮消息流节律 | user 气泡→Think→正文→user 气泡→Think→bash 行，块间距目视 16 级、无粘连 | gap16 / tool 组 gap10 | ✓（像素级因行框留白无法精测，节律无异常） |
| CJK 正文行高 | 单行 ink 11px、行框≈28 | 16/28 | ✓ |
| bash 工具行 | `$ Run echo w5marker command` 终端风格 | Bash 变体（api 图标+标题+摘要） | ◐ 自定 toolview 样例（有意注册，见观察项） |
| 统计行 | "cache hit 99% · 9,030 tokens · 2 turns · 2 steps" 12px 灰、列尾 | 122:11212 含耗时 | △L5（位置/字号/分隔 ✓） |
| w5-08b 刷新恢复 | 消息流/统计行/侧栏 project 完整还原 | — | ✓ |

### w5-09 details-open（亮，重点屏）
| 检查项 | 实测 | 定稿 | 结论 | 节点 |
|---|---|---|---|---|
| 面板宽/形态 | 分隔线 x=1320（#F5F5F5=黑@4%），面板 1321→1680 = 360px，挤压式（消息区收窄） | 360px 挤压非浮层 | ✓ | 54:42735 |
| 面板底色 | #FFFFFF | 白 | ✓ | 同上 |
| 头部 | 「bash」标题+右上 ✕ | 标题+收起钮 | ✓（简化形态可接受；Switch/副标题/See in trajectory 豁免） | 43:41479 |
| Input/Output 分区+代码块 | 代码块 #F9FAFB 圆角块、Roboto Mono 风格 JSON | Code-block #F9FAFB | ✓ 精确 | 43:41429 |
| 选中行联动高亮 | bash 行全宽 1px #3964FE 描边矩形 | 1.5px #3964FE | ✓（1px 渲染档差可接受） | 54:42675 |
| 点击工具行开板交互 | 成立 | 注记 122:11240 | ✓ | — |

### w5-10 sidebar-dragged（亮）
| 检查项 | 实测 | 结论 |
|---|---|---|
| 拖宽生效 | sidebar 300→366px，右描边随移 | ✓（拖宽是 Handle 推断功能，无定稿宽度约束） |
| 把手可见性 | 无 12×32 白胶囊 | △L6 |
| 选中行描边保持 | #3964FE 1812px 蓝像素仍在 | ✓ |

### w5-11 dark-mode（暗，重点屏）
| 检查项 | 实测 | 定稿（conversation §4.4/§7、sidebar §5） | 结论 |
|---|---|---|---|
| 页面底 | #151517 | #151517 | ✓ 精确 |
| sidebar 底 | #1B1B1C | #1B1B1C | ✓ 精确 |
| user 气泡 | #2C2C2E、文字 #F9FAFB | #2C2C2E / #F9FAFB | ✓ 精确 |
| New Session 钮 | #43454A | #43454A+白@12% | ✓ 精确 |
| 搜索框 | #2C2C2E | #1B1B1C+白@12% | △L2 合并 |
| composer 输入框 fill | #151517 | #2C2C2E | △**M2** |
| details 代码块 | #151517（与面板同色不可辨） | 暗切 #1B1B1C 级 | △**M3** |
| 选中工具行高亮 | 无蓝描边 | #679EFE | △**M1** |
| tab 选中 | 白字白条 | #4176E6（暗未单独定义，最少应保蓝系） | △H2 合并 |
| 暗色切换完整性 | 无残留亮色块（全屏扫描无白底残留） | — | ✓ |

### w5-12 reload-recovery（亮）
| 检查项 | 实测 | 结论 |
|---|---|---|
| 刷新后恢复 | 消息流全量、worktree-web2 project 行、统计行、tab 组均在 | ✓ |
| details 空态 | 「详情」+引导文案 | ◐ 无稿自定合理 |
| 输入框回 idle 态 | placeholder 中文自定 | ◐ 观察项（i18n） |

---

## 合格项汇总（14 项核心）

sidebar 300px/底色/右描边（亮暗四值全精确）；user 气泡 #EDF3FE/#2C2C2E+右对齐+最大宽；输入框 776 定宽居中；details 360px 挤压式+亮色选中蓝描边+代码块 #F9FAFB；统计行位置/字号/分隔符；traj/waterfall 统计条置顶（修改 List 要求）；tab 组仅会话有内容时出现；暗色 New Session 钮 #43454A；WorkSpace 区头双钮；搜索占位文案逐字一致；Foot Settings 行；面包屑+meta 字级；刷新恢复完整；暗色无亮色残留。

## 复核建议（给 main 排期参考）

1. H1/H2 是一行 CSS 级修复（max-width + token 换色），建议本轮就修。
2. M1/M2/M3 集中在暗色——建议 dark 走查单开一轮，把「组件引用 static 值而非 alias」的点一次清完（M2 的 composer/search 不一致就是典型）。
3. M4 等 main 对台账后定性：豁免则移观察项，否则列 P-II 首项。
4. L 系列可攒批处理；L1（气泡 padding）与 L4（鱼 logo）最显眼，优先。
5. 下轮截图请补：展开的 session 树（验 34px 行/22 缩进/State 点）、hover 态（行 hover #263148@6%）、审批态输入框（琥珀条三钮）。

---

## 复判（04:47 批次，修缮刀落库后；判定人 figma-flows，同一像素实测方法）

基准裁定同步：tab 选中色基准=business-primary **#3964FE**（主会话已裁定不追 #4176E6）。

| # | 原偏差 | 复测实据 | 结论 |
|---|---|---|---|
| ① | H1 消息列无 736 定宽 | w5-08 assistant 段落 ink x 623→1354（**宽 731**，含文字端差≈736 列），居中（中轴 989≈主区中心）；user 气泡右缘 1356 与列右对齐 | **修复 ✓** |
| ② | H2 tab 选中色 | Chat 选中文字最暗像素 **#3964FE**、底条 3px #3964FE（y76..78）+ 1px #E5E5E5 分隔线 | **合格 ✓**（按新基准） |
| ③ | M1 暗色选中描边丢失 | w5-11 选中 bash 行描边 **#679EFE** 完整矩形：上下边 y=369/396 各 724px 长、左右边 2px 竖线，x 473→1212 | **修复 ✓**（色值与定稿 54:42085 精确一致；convo-a 的 P0 尾巴不复现） |
| ④ | M2 暗色 composer fill | 输入框内部众数 **#2C2C2E**（8000/8000 采样点），与 sidebar 搜索框同 token 一致 | **修复 ✓** |
| ⑤ | M3 暗色 details 代码块 | 面板底 #151517，代码块 **#1B1B1C**（22700 采样点主色），可辨；面板分隔线 #222224/#313133 过渡带也出现了 | **修复 ✓**（新暗屏 details 有内容，非幻影） |
| ⑥a | L2 搜索框亮色底 | w5-01 仍 #FFFFFF（定稿 #F1F3F5） | **未修，维持 L2** |
| ⑥b | L3 禁用发送钮 | w5-01 仍 #9E9FA0 灰（定稿 #3964FE op.40；发送区无蓝像素） | **未修，维持 L3** |

复判后余量：高 0、中 1（M4 待 main 定性豁免）、低 6（L1~L6 原样，⑥ 两项复测确认未动）。W5 视觉线可收口。

---

## 终判（09:27 批次 14 张，精调波次收口；基准=style-spec.md 三批底册+§1.9b 更正）

前置：**§1.9b 两处转录更正认可**——Logo 行 pad(l,t,r,b)=(4,8,4,8) 即水平 4 垂直 8、区头 (12,4,0,4)+r12，均与节点原始值一致，ui-side 纠得对；底册语序笔误，以 §1.9b 为准。

### ① 上轮修复维持确认（全部 ✓）

| 项 | 终轮实测 | 结论 |
|---|---|---|
| H1 消息列 736 | w5-08 段落 ink 宽 731、居中 | 维持 ✓ |
| H2 tab 选中色 | w5-04/13 选中文字+3px 底条 #3964FE（新基准） | 维持 ✓ |
| M1 暗色选中描边 | w5-11 #679EFE 1472px 完整矩形 | 维持 ✓ |
| M2 暗色 composer fill | w5-11 #2C2C2E 8000/8000 | 维持 ✓ |
| M3 暗色 details 代码块 | w5-11 #1B1B1C vs 面板 #151517 可辨（亮 #F9FAFB ✓） | 维持 ✓ |

### ② 低×6 复核

| 项 | 终轮实测 | 结论 |
|---|---|---|
| L2 搜索框底 | 亮 **#F1F3F5** / 暗 **#1B1B1C** 双端精确（`--dsh-search-input-fill` 落地） | **修复 ✓** |
| L3 禁用发送钮 | w5-13 **#AFC0FE** = #3964FE op.40 over white（逐通道验算吻合） | **修复 ✓** |
| L6 Handle 把手 | w5-13 sidebar 右缘白胶囊可见（#FFFFFF+描边），details 左缘同样有 | **修复 ✓** |
| L4 鱼 logo | sidebar Logo 行 **有**（#0F1115 墨色 ✓ 174px ink）；**hero 屏仍无**（w5-02 标题左侧扫描 0 鱼形像素；定稿 34:10412 fish 34×25+gap10） | **半修复**——hero 位待补 |
| L1 气泡竖 pad | 气泡高 41px（上轮 37），距定稿 44（10+24+10）仍差 3px（实测竖 pad≈8.5） | **改善未达值** |
| L5 统计行耗时 | w5-13 "cache hit 99% · 13,520 tokens · 2 turns · 3 steps"，仍无时长字段（定稿样例 45.2s 槽，122:11212） | **未修**（若后端无时长供数请 main 归为数据依赖而非视觉项） |

### ③ 新镜头首判：w5-13 树展开 / w5-14 行 hover

| 检查项 | 实测 | 定稿 | 结论 |
|---|---|---|---|
| project 行高 | ≈54px（hover 底色带 229..283） | 54 | ✓ |
| session 行高 | 34px 精确（288..321） | 34 | ✓ |
| 缩进步长 | project 标题 x46 → session 标题 x68，**Δ22** | 22（16 槽+6 gap） | ✓ |
| 槽保位模型 | session 行前导区（twist+state 两槽）无可见字形但保位、标题基线不漂移 | §1.9b 常驻槽模型 | ✓ |
| 「└」连接符 | 未出现 | **正确缺席**——└ 仅标记 session 下的子 session（二级），本镜头树只有 project>session 一级 | ✓（二级树镜头 P-II 补验） |
| 展开 chevron | w5-13 project 行 hover：前导换**下向** chevron（展开态） | Folder arrow-open 下向=展开 | ✓（行内换向裁定落地） |
| project hover 钮组 | 「…」+「+」浮现于行右 | 27:4668 | ✓ |
| session hover 时间换面 | w5-14 "now" 隐去 → ellipsis 字形（#81858C px 出现于右缘） | 27:4656 | ✓ |
| open-active 蓝 folder | w5-14 project 行（未 hover）蓝色打开文件夹 #3964FE 79px | 27:3276 open-active | ✓ |
| 行底色 token | 选中 **#EBEEF2**=bluish-100、hover **#F1F3F5**=bluish-75 ⇒ 用的是 `--dsw-specific-sidebar-nav-item-active/-hover` 静态 token；figma 绑定是 `interactive-bg-active/hover`（#263148 α10%/6%，合成 ≈#E3E6E9/#ECEEF0） | 见左 | **N1 新低档**：视觉差 Δ4~8 肉眼难辨，但暗色下两族 token 语义分叉（nav-item-active 暗=bluish-750 vs alpha 暗=白 α14%）——建议切 alpha 族与 figma 绑定一致，或 main 拍板从宽 |
| 20px 批尾 spacing / 渐隐遮罩 | 列表仅 1 project+1 session，**不可判定**（无第二 project、列表未满屏） | — | ◐ P-II 长列表镜头补验 |

### ④ 全屏回归

w5-01（fish ✓/搜索 ✓/禁用钮 ✓/M4 现状同前——新建屏仍仅 cwd 下拉，无 Plan/Read-only/模型选择器，维持待 main 定性）、w5-04（tab 蓝 ✓）、w5-08（列宽 731 ✓）、w5-09（选中蓝描边 1584px ✓/代码块 #F9FAFB ✓）、w5-11（暗色四件套 ✓）、w5-12（恢复 ✓）；其余屏与复判轮同构无回归。

### 终判结论

**波次收口通过**。高 0、中 0 新增（M4 维持待定性）、低余量 4：L1 残差 3px、L4 hero 鱼、L5 耗时字段、N1 行底色 token 择一——均不阻收口。P-II 复核清单：二级 session 树（└ 出镜）、长列表（20px spacing+渐隐遮罩）、暗色树展开/hover（N1 暗端分叉验证）、审批琥珀条。
