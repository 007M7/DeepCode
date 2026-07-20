# RpcLog 视觉升级点清单（v2，试点模板）

> 格式即模板：每条一句「现状 → 目标」，改前列出、改后逐条勾。token 增补记 web-styling.md §1。

1. [x] 面板抬升感：单薄 lv3 阴影 → 新 `--shadow-float`（近描边 + 中投影 + 大远影三层，lv3 加强档），浮层与页面明显分离。
2. [x] 视觉分区：工具行/列表同底白 → 工具行与暂停条铺 `--bg-sidebar` 浅灰底，列表区留白，形成头/体分区。
3. [x] 行节奏：行 padding 4px 12px 贴边挤 → min-height 32px、padding 5px 14px、列距 10px，列表上下留 4px 呼吸。
4. [x] 方向符徽章化：裸箭头字符四色难辨 → 22px 圆角小色块（象限软底 + 深字），四象限一眼可辨；mux 紫 / host 蓝软底 token 化。
5. [x] 配对高亮加强：accent-soft 太淡 → `--accent-item` 深一档底 + 左缘 2px 品牌蓝 inset 指示条。
6. [x] 工具行按钮质感：裸文字 → 次要色文字按钮（padding 4px 10px、圆角 8、hover 透明底 + 文字变主色；激活态 accent-soft 底）。
7. [x] 角标徽章：平面胶囊 → `--shadow-float` 抬升 + hover 阴影加深上浮 1px、未读红点加 2px 白描边提对比。
8. [x] payload 分区：同白底 → `--bg-sidebar` 底 + 上缘细分隔 + 次要色文字，与行区分层。

token 增补（值取自 deepseekchat 色板，已进 web-styling.md §1 + global.css）：`--ok-soft`（green-100/900）、`--error-soft`（red-100/900）、`--frame-mux-soft` / `--frame-host-soft`（方向色透明软底）、`--shadow-float`（lv3 加强档）。

验收（2026-07-20）：build 绿；verify-rpclog-panel.mjs **9/10**——§D-6b「清空后周期帧继续进入」超时属 fixture 重写副作用（工作区新 fixture.ts 删除了旧版 `setInterval(5000)` 周期帧，CSS 无法影响帧到达；归 runtime/验收脚本侧对齐），其余 9 项含全部交互路径 PASS；截图 [rpclog-v2.png](rpclog-v2.png)。

## v2.1 修订（2026-07-20，用户拍板）：方向符左右 → 上下

- 空间隐喻：上=去 server、下=来自 server；单线=unary、双线=SSE。`↑` client-request / `↓` server-response / `⇟` server-request / `⇞` client-response；徽章配色不变。实测 mono 栈下 `⇟` 渲染清晰（v2.1 截图紫徽章可辨双线），不需 ⇊/⇈ 备选。
- 改动面：LogRow.tsx 四个 symbol 字面量 + 注释；verify-rpclog-panel.mjs 三处符号断言同步（§D-2/§D-3 grep 旧箭头，不改会假红）；shot-rpclog.mjs 壳断言跟进 SessionsScreen 换壳（h1 → aside）。语义表进 web-styling.md §2。
- 验收：build 绿；verify **10/10 ALL PASS**（fixture 周期帧失败项已被 session-design 修复）；截图 [rpclog-v2.1.png](rpclog-v2.1.png)。
