# UI 参考仓提炼 — 三仓 × DSH 桌面壳分发

> 只读参考：`~/harness/ui-refs/{frontend-demo-autodream, work-memory-engine, next-action-ui-lab}`。产出对象：`~/harness/dsh-desktop-demo/`（Electron + vanilla JS）当前并行的多条 UI 线。作者：recon-refs agent，2026-07-16。

三仓的共同底色都是「local-first、单文件或近单文件前端、agent 生成内容 → UI 消费」，非常适合我们的桌面壳。它们各解决一段我们已经在做、或正要开始做的问题，把它们的做法拆成「直接抄／改造／仅理念」三档，再按我们在建的 UI 线（Mission Control / 上下文卡 #49 / 自适应布局 / widget 通道 / 后台任务面板 / playground / devtools / 插件市场）分发。

---

## 1. `frontend-demo-autodream` — 「梦、异步整理的前端」

**架构一句话。** FastAPI 后端 + vanilla JS 前端（`frontend/{index.html,app.js,diary.js,claw-pet.js,styles.css}`），后端跑 `Orient→Gather→Consolidate→Prune` 四相 mock 引擎（可换 LLM 引擎），SSE `/api/dream/stream` 推四相进度，前端两页：`index.html`（claw 的梦境日记 feed）+ `memory.html`（六分类记忆库 + 划线纠正）。整个产品心智是：「把你的对话变成 dream，dream 用第一人称汇报做了什么改动，你划线纠正 → 下次 dream 生效」。

### 值得抄的具体模式

**A. 四相 SSE 覆盖层（`frontend/diary.js:373-392`）。** `#dreamBtn.onclick` → `new EventSource('/api/dream/stream?force=true')`，监听 `phase / done / error`。前端有一份诗化对照：

```js
const DREAM_LINES = { orient:'翻开你的记忆本…', gather:'重读这些日子的对话…',
  consolidate:'把零碎的你，收拢起来…', prune:'归整好，轻轻合上本子。' };
```

每一相到达时，覆盖层文字先 `opacity=0`（150ms）再切换，`done` 时收尾成 `'醒了。'`。**这个「长过程用诗化阶段 + 平滑淡入淡出」的形态直接可以移植到我们的 compact 覆盖层、fleet 长跑 (workflow/subagent 舰队)、mission 长任务**——比转圈更能表达「这不是卡住，是在做事」。

**B. 变化播报芯片（`frontend/diary.js:45-53`, `reportRow`）。** 每张 dream 卡片头部一行 chip：`+3 新增` / `–2 归档` / `✎5 按你纠正` / `↑「偏好」+4`。没有任何数字就渲染 `这一夜很平静`。这是「dream 后的 diff 报告」的最小可用形态，**mission control 任务完结、compact 卡「压缩前后的对比」都该长这个样子**——不是列出所有改动，是压成 3-5 个可读 chip，把「dream 做了什么」翻译成人能一眼看到的动词。

**C. 「lens 颗粒度」切换（`diary.js:241-321`, `renderDreamLab`）。** 顶部一行 `[今天|本周]` 分段按钮，切换时同时重排：概念图 / 日历 / 主线看板。**这是「按颗粒度重排整块布局」的直白版本**——比我们的 `layout-heuristics.js` 更 UI 驱动、更便宜（不看事件流，只看用户切了哪档），可以作为我们自适应布局的一个补档：一个「时间尺度」下拉，切「本轮 / 本会话 / 全库」。

**D. 主线看板 = 三态列（`diary.js:288-299`, `arc-board`）。** `正在升温 | 反复横跳 | 已稳定` 三列 kanban，每列最多 3 张 arc-card。分类规则简单（`arcLabel/arcState`：正文正则）——但**「三态命名把动态语义前置」这个做法直接可以抄进 Mission Control 的看板视图**。我们现在的 kanban 是通用 `pending/in_progress/completed`，换成三态命名（如「刚起来 / 反复 / 稳了」）语义更贴 dream 场景。

**E. 划线→纠正→pending→applied 循环（`app.js:150-194`）。** `mouseup` 检查是否在 `#dContent` 内 + 有选区 → 弹 `#hlBar`（划线小工具条）→ 点「纠正」弹 `#composer`（输入框 + 定位在选中处下方）→ `POST /api/corrections {kind:'correct', quote, comment}` → toast `claw 收到了。下次做梦时，它会照你说的改`。**这是「用户反馈会在下一轮真正生效」这个心智契约的最小实现**——比 up/down 反馈按钮强得多，因为它承诺「你说的话被 dream 消费」。可以直接改造进我们的 Mission Control 长任务反馈通道，或 recall 卡的「这条召回不对，下次别用」。

**F. 「office 小舞台」（`diary.js:198-239`, `renderRailOffice`）。** 左栏一张 mockup 卡：`项目 / 主线 / 下一步` 三条状态 + 一只小宠物图标，作为整块 UI 的「今日心情」。人格化的地方是宠物 pet 头像 + `office-bubble` 悄悄话；技术上就是一张固定布局卡片。**我们大概率不会抄人格化本身**（品牌上要保持中立、面向开发者），但**「首屏中央一个非交互 status 卡，把今天最要紧的三件事说给你听」是 Mission Control 的天然首屏形态**——去掉宠物，换成 `当前 turn / 长期任务 / 未处理审批` 三格。

### 不值得抄的

- **claw pet 人格化 + 内心 OS + Lv.X 对齐率**：产品定位差异——DSH 是开发者工具的桌面壳，加进这类情感层会让审批卡、fork 树都变尴尬。仅在**未来 memory capability 面向 C 端用户**时值得回头借。
- **概念图 SVG poster**（`diary.js:99-125`, `conceptSvg`）：4 关键词正则抽 + 手绘轨迹装饰。看起来很美，但每一张都要人工调色、正则维护；**放到我们的多种任务里必然崩形**。学它「首屏放一张能一眼读懂的抽象」的思路，别抄它的具体渲染方式。
- **`claw-pet.js` 眨眼/张嘴状态机**：同上，人格化装饰。

---

## 2. `work-memory-engine` — 「学习一下」

**架构一句话。** 零重量依赖的 TS 单机记忆引擎：raw（四源 append-only）→ 10 分钟合流窗 → Event → Thread → 每日 04:00 舰队 Dream，全部 agent 会话产出、代码机械装配、观测留底可回放；前端 `web/index.html` 是一张 138 行的暗色/亮色自适应单文件 UI，4 个 tab：`待办 / 提问 / 晨报 / 观测`；后端 `src/server.ts` 60 行 `node:http`，6 个 API。**核心心智：模型解释，代码校验；分层节律，权限跟着节律走。**

### 值得抄的具体模式

**A. contracts/types.ts 的「少字段厚语义」纪律。** `contracts/types.ts:1-68` 只有 8 个 interface，每个字段一行注释「谁写、谁读、为什么存在」。举个例子：`ThreadState.eventCursor.includedEventIds` 后面写「吸收账：只增不覆（历史）；条目级 refs 才按本轮正文洗（现场）」——这一行是从 `DECISIONS.md #1` 提炼的踩坑教训，直接钉在契约上。**这是我们 RFC / 协议文档应该抄的写法**——我们现在的 `RUNTIME_EVENTS.md` 类文档字段密度已经够了，但缺「为什么这么定」的一句短理由。**直接改造进 DSH 的 SessionEventMap / 协议扩展文档**：每个字段补一行「取舍理由 / 曾经的错法」。

**B. `DECISIONS.md` 的 14 条实战教训格式。** 每条都是「症状 → 曾经的错法 → 定案 → 为什么」的一段话，字数控制在 100-150 字。举 `#7 检索截断必须新鲜优先`：「症状漂移（今天还搜得到前天，明天就搜不到昨天），极难被发现。定案：超上限按 mtime 新鲜优先截断」。**我们的 memory `dsh-design-doc-2026-07-15.md` 应该长这样，而不是章节化 spec**——章节化写法很难在踩到同一坑时被搜到，短故事化写法可以。**建议把它作为我们后续 RFC 写作的模板附在 `CONTRIBUTING.md`**。

**C. `[event/<id>]` `[thread/<id>]` 内联引用 chip（`web/index.html:69`）。** 一行正则：`s.replace(/\[(event|thread)\/([A-Za-z0-9_.:-]+)\]/g, '<a class="cite" title="$1/$2">[$1]</a>')`。所有 markdown 里的引用都变成可 hover / 可点击的蓝色 chip。**任务 #49 的 recall 卡直接抄**：让 recall 卡的每个事实句都带一个 `[msg/<id>]` `[tool/<callId>]` chip，点击跳到原始事件。这是「可溯源」从口号变成产品功能的最小实现。

**D. 待办 tab = 甘特点阵（`web/index.html:80-95` + `modules/07-todo-panel.md`）。** 每条线一张卡，卡里一条水平轴（当天 0-24h），横轴上放圆点（今天已发生的里程碑），`title` 属性 hover 显示节点名；下面 `nextActions.slice(0,3)` 是下一步。**关键取舍**：画的**不是原始事件流**（那是噪声墙），是**整理后带真实时间戳的里程碑节点**。「整理管线断供时甘特会空白」被明确当作特性——空白 = 报警。**Mission Control 应该抄这条哲学**：mission-tree/topo/kanban 三视图之外，添一个「时间轴甘特」投影，画整理过的里程碑而不是原始 turn/step 事件。

**E. 观测留底 tab = 每次整理会话可回放（`web/index.html:107-119`）。** `/api/observe` 返回近 80 次整理会话的 `{dir, meta:{label, ok, durationMs}}`，前端把它做成一列表 + 状态 + 时长。**这直接对应我们 devtools 的 `hooks/request-header/审计事件` 面板**（任务 #54 已完成）——但 wme 的做法有一层教诲：把「每次 agent 会话完整输入 + 输出 + 元数据」当**产品功能**存档，不是当调试手段。我们的 devtools 应该往这个方向再推一层：让**用户**能回放某次工具调用的完整入参 / 出参，不只是 hook 触发线。

**F. 召回答案的固定形状（`modules/06-recall-agent.md`）。** 「一句话结论 / 现在到哪 / 怎么走到 / 关键上下文 / 缺口（missing 不编）/ 下次接哪」——6 个固定小节。**这是 #49 recall 卡内容模板的标准答案**：不是自由发挥的一段话，而是 6 个短标题的定式，任何一段没内容就写 `—` 而不是空过。

**G. 权限随节律分层（`ARCHITECTURE.md`「权限随节律分层」段）。** 30 分钟一轮的白天写手只能「更新已有线或新建线」，禁止合并/拆分/重命名；结构手术只属于每日 04:00 的 dream。**这是纯粹的设计哲学，但对我们的 compact / fork 策略是一条镜子**：user-触发的 compact（高频）只能做「摘要 + 归档」，深度合并 / 概念重构应该只留给低频的自动整理（或显式用户命令）。**我们 #49 的 compact 卡策略配置应该内置这个二分**：默认档「压缩 + 摘要」；专家档「允许结构手术」。

**H. 看门狗（`modules/08-self-healing.md`）：15 分钟自检三类沉默故障。** 「整理会话连败 / 机器活跃但事件停产 / 管线滞后过大」，命中直接发系统通知（同类 2h 限流）。**Devtools 面板应该有这一格**：DSH 长任务、daemon、subagent 舰队都有沉默故障风险；一个「链路健康」小灯（`web/index.html:130-134` 就是这个灯的最简形态）比什么都强——绿点 `● 链路健康`，黄字 `⚠ <告警文本>`。

### 不值得抄的

- **`mermaid` 全链路架构图**：文档友好但不进 UI；理念可以吸收。
- **`node:http` 零依赖服务器**：我们已经在 daemon 里做完了同等抽象。
- **整个 dream/thread/event 数据流**：这是他们的领域模型，不是我们的（我们不需要「工作记忆引擎」）；只学分层节律 + 契约纪律。

---

## 3. `next-action-ui-lab` — 「个性化 UI 参考」

**架构一句话。** ⌘⇧J → Swift host 截屏 + 抓活跃 app + 抓浏览器 tab → 起一个 warm `codex exec` session（加载 `skills/next-action/SKILL.md`）→ 输出一个 `NextActionEnvelope`（9 种 kind × 一段 `widget_code` 片段）→ trace-viewer 在浮层 WebView 渲染一个 iframe 组件，组件里的按钮通过 postMessage 桥回到 Swift host 做真实副作用（贴文本 / 开链接 / 起新 Codex 会话）。**核心心智：模型看着你的屏幕，直接生成一个能干活的 widget；4 个桥梁 verb 严格分「REAL / RECORD-ONLY」。**

### 值得抄的具体模式（这是三仓里给我们**信号最强**的一个）

**A. 4-verb 桥梁的 REAL vs RECORD-ONLY 二分（`skills/next-action/SKILL.md` Part 1，`src/widget-renderer.mjs:24-38`）。**

```
sendPrompt(text)       → REAL: 粘到当前 app（clipboard + Cmd+V）
openLink(url)          → REAL: NSWorkspace 打开 URL
handoffToCodex(prompt) → REAL: 起一个新的 codex 交互 session
widgetBridge.send/commit({state, summary}) → RECORD-ONLY: 只写 trace，用户世界零变化
```

**HARD RULE**：任何「意图是让某件事发生」的按钮，**必须**接一个 REAL verb；只调 `commit` 就当「完成了」→ **broken widget**。SKILL 里明确列了「插入」「打开」「Handoff」三种意图对应的正确 wiring。

**这是我们 widget 通道设计缺的最大一块**。我们的 `docs/widget-channel-design.md` 有反向 prompt（`sendPrompt(sessionId, action.prompt)`），但没有把「真实副作用 vs 仅记录」这个二分刻进契约。**建议动作**：在 widget-channel-design.md 里加一节 "REAL vs RECORD" verb 表，并在 widgets.js 的 `renderActions` 里把只调 `commit` 的按钮标为「⚠ display-only（不产生任何 session 操作）」——让 widget 作者一眼看出 broken 情况。

**B. iframe 自动 state 采集（`widget-renderer.mjs:29-31`）。** iframe 里 host 注入两个 document-level listener：`input` 事件 200ms debounced → `state_update`；`change` 事件 → `state_commit`。**model 作者几乎不需要手写 `widgetBridge.send`**——每个 `<input> <select> <textarea>` 的值变化都自动进 trace，`source:"auto"` 标记。这解决了「用户开发者忘 wire 状态回传」的常见错误。**我们的 widget 通道原型应该抄这个**：只要作者按 HTML 惯用法写控件，就自动进事件流。

**C. Blob-URL 两次加载模式（`widget-renderer.mjs:79-89`）。** iframe 首次 `onload` 触发时才 `URL.createObjectURL` 出真正的 widget doc，替换 src；第二次 `onload` 才淡入 `opacity:1`。这个双阶段方案避免了 iframe 加载中间态的白屏 / 抖动。**我们的 widgets.js 目前应该没有这层，值得直接抄**——尤其是 widget 里可能带异步初始化脚本时。

**D. 严格的 envelope validator（`src/action-schema.mjs:33-67`）。** 9 个 kind 白名单、`confidence ∈ [0,1]`、`traceId` 必填、`widget_code` **必须是 fragment（不能有 `<html>/<head>/<body>/<!doctype>`）**——违反直接 `throw`，harness 渲染空白。**我们的 widget spec 应该有等价的静态 validator**（`packages/core/tools/src/presentation.ts` 的 `WidgetSpec`），并在 renderer.js 收到时把 validate 失败的 widget 降级成一张红色错误卡（现在的 `renderUnsupported` 是灰色，看不出严重程度）。任务 #37「插件配置错误提示」的 A1 静态校验层应把这个 validator 补上。

**E. Form variety 表 + "same-card 失败" 自检（`SKILL.md` Part 4）。** 显式列举一张表：「场景 → 该用的 form」

| 场景 | Bespoke form |
|---|---|
| 续写 / 改写 | Editable draft (`<textarea>` + `sendPrompt` 按钮) |
| 沿一个轴调（语气/长度/正式度） | Control panel / sliders + 实时 DOM 重算 |
| 在多版本间选一个 | Comparison / diff 两三版并排 |
| 提交承诺 | Action/owner/due/risk 矩阵表 |
| 只有一个 obvious next move | 一个决断按钮 |
| 短流程 / pre-flight | Checklist |
| 关系 / 时间轴 | 小 SVG |
| 一句提示真的够 | 1-3 条 `insert_prompt` （**兜底而非默认**）|

外加一条强制自检：「Is this just summary + draft + numbered list?」→ 如果 yes，你失败了，去表里选一个别的形态。**这是我们 playground / 卡片家族（P0 渲染批 A 已完成的 diff/terminal 卡）的下一步**：把这张表移植成 DSH 卡片家族的形态清单，让每个 tool 结果都对号入座。

**F. Mock widget bank 作为 fixture（`src/mock-widgets/*.html`）。** 10 个成品 widget（`doc_continue.html` / `schedule_slots.html` / `email_reply.html` / `error_diagnose.html` / `failing_tests.html` / `meeting_notes.html` / `cmd_args_form.html` / `prompt_rewrite.html` / `resource_export.html` / `trip_route_map.html`），每个 200-300 行手写、Kimi 黑白极简风、sendPrompt/widgetBridge 都接好。**Playground（#38）应该有一个 "mock widget picker"**：从这 10 个里挑一个塞进当前会话，让「不启动 daemon 也能看到 widget 交互」——这也是我们目前 stdio-echo 无法演示 widget 的最省事补丁。

**G. Trace viewer 作为独立服务（`scripts/trace-viewer.mjs`, `http://127.0.0.1:6178/traces`）。** 每次 hotkey 触发都存一个 trace（screen.png + 注入 context + evidence + widget_code），viewer 有 `/float /action /trace/<id> /traces` 4 个路由，`/traces` 是索引页。**这就是我们 devtools 该长的样子的完整版**——不只是当前 session 的 hook/header 面板，而是「所有 widget 生成 + 所有 tool 调用」的可回放归档站，跨 session。任务 #54 devtools 已完成，但覆盖度可以往「跨 session 归档 + widget trace」延伸。

### 不值得抄的

- **Kimi 单色黑白美学的强绑定（SKILL.md Part 8）**：这是 next-action 的品牌选择；DSH 应该尊重 host 主题（VS Code / IntelliJ / 独立 Electron 皆有），不强绑单一美学。理念可借用：「typography over decoration」、「hairline borders」值得吸收进 dsv4 主题。
- **Email safety hard rule（SKILL.md Part 7）**：next-action 是给个人用户跑截屏 → 直接改用户屏幕的工具，需要这层护栏。DSH 工具已经有正规的 `approval/asked`+`approval/decided`+`permission/preset` 事件族，护栏走那条路，不需要重复。
- **⌘⇧J 全局 hotkey + Swift host + 截屏**：定位差异——DSH 不做屏幕理解，我们在 IDE / 独立壳内工作，输入已经在手边。

---

## 4. 定向分发表

粗颗粒到细颗粒，每行 = 「模式 → 分发到哪条线 → 建议动作」。

| # | 模式（来源 § / 文件） | 分发线 | 建议动作 |
|---|---|---|---|
| 1 | 四相 SSE 覆盖层（autodream §1-A, `diary.js:373`） | 上下文卡 #49 (compact) / Mission Control / P1 渲染批 C #53 (workflow) | **改造抄**：把 compact 从「一个 divider」升级为「四相进度 overlay」，phase 文案由 compact plugin 元数据提供。workflow 长任务同款。 |
| 2 | 变化播报 chip 行（autodream §1-B, `reportRow`） | Mission Control / 上下文卡 (compact 结果) | **直接抄形态**：任务完结 / compact 完成时渲染一行 3-5 chip，替代当前的纯文本 system line。 |
| 3 | Lens 颗粒度切换（autodream §1-C） | 自适应布局 | **改造**：加一个「时间尺度」下拉（本轮 / 本会话 / 全库），和 layout-heuristics 的「内容类型」维度正交。 |
| 4 | 主线看板三态列（autodream §1-D, `arc-board`） | Mission Control (kanban) | **改造名字**：kanban 列从 `pending/in_progress/completed` 改到语义化三态（如「刚起来 / 反复 / 稳了」）——需要 mission-model 提供 hot 度信号；先在 mock 里试。 |
| 5 | 划线→纠正→pending→applied 循环（autodream §1-E） | recall 卡 #49 / mission control 反馈 | **改造抄**：recall 卡加「这条不对，下次别用」按钮 → `POST /correction`，claim「下次 compact 会照你说的改」。心智契约比 up/down 更强。 |
| 6 | Office 状态小舞台（autodream §1-F） | Mission Control 首屏 | **仅理念**：抄「首屏一张三格 status 卡」，去掉宠物人格；填 `当前 turn / 长期任务 / 未处理审批`。 |
| 7 | Contracts.ts 少字段厚语义（wme §2-A） | 所有 RFC 写作 | **仅理念**（改流程）：每个协议字段补一行「取舍理由 / 曾经的错法」注释。 |
| 8 | `DECISIONS.md` 14 条格式（wme §2-B） | RFC / 设计文档 | **仅理念**（改流程）：`CONTRIBUTING.md` 加一节「决策日志格式」，抄这个 100-150 字 / 条的模板。 |
| 9 | `[event/id]` inline chip 正则（wme §2-C, `index.html:69`） | 上下文卡 #49 / recall 卡 / devtools | **直接抄一行代码**：`cite()` 函数进 renderer.js；session/tool ID 有 chip，点击跳事件。 |
| 10 | 待办甘特点阵（wme §2-D） | Mission Control（新增第 4 投影） | **改造抄**：现有 tree/topo/kanban 之外，加一个「时间轴」投影，横轴当天 0-24h，每条线一行点，只画整理后的里程碑（不画 raw turn/step）。 |
| 11 | 观测留底可回放（wme §2-E） | Devtools #54 | **改造抄**：现在 devtools 主要看 hook/header，扩到「跨 session 的 tool call 归档」，可回放某次调用的完整入参 / 出参。 |
| 12 | 召回答案 6 段固定形状（wme §2-F） | recall 卡 #49 | **直接抄结构**：卡片渲染成 6 个短标题定式，空段写 `—`。 |
| 13 | 权限随节律分层（wme §2-G） | 上下文卡 #49 (compact 策略) | **仅理念**：compact 策略默认「压缩 + 摘要」；专家档「允许结构手术」——避免用户触发的高频 compact 做草率结构改动。 |
| 14 | 15 分钟看门狗 + `● 链路健康` 灯（wme §2-H） | Devtools / 状态栏 | **改造抄**：状态栏加一颗小灯（daemon/subagent/workflow 三链路 rolling 健康），点开进 devtools 看告警历史。 |
| 15 | 4-verb 桥的 REAL vs RECORD-ONLY 二分（next-action §3-A） | Widget 通道 #27 | **抄进契约**：widget-channel-design.md 加一节 verb 表；`widgets.js` 里给 display-only 按钮加视觉标记。**这是最缺的一块。** |
| 16 | iframe 自动 state 采集（next-action §3-B） | Widget 通道 #27 | **直接抄实现**：`renderGeneratedWidgetHost` 里的 200ms debounced auto-collect。 |
| 17 | Blob-URL 两次加载淡入（next-action §3-C） | Widget 通道 #27 | **直接抄实现**：避免 widget 加载中间态白屏。 |
| 18 | Envelope validator（next-action §3-D） | 插件配置错误 #37 / Widget 通道 | **抄结构**：给 `WidgetSpec` / 卡 payload 加静态 validator；失败降级红色错误卡（非灰色 unsupported）。 |
| 19 | Form variety 表 + same-card 自检（next-action §3-E） | 卡片家族 P0 批 A / Playground | **改造抄**：把表移植成 DSH 卡片家族形态清单，每个 tool 结果对号入座；playground 里加「换一种 form」按钮。 |
| 20 | Mock widget bank 10 个成品（next-action §3-F） | Playground #38 | **直接借文件**：把 10 个 mock widget copy 进 `dsh-desktop-demo/mocks/widgets/`，playground 加 picker，stdio-echo profile 也能演示 widget。 |
| 21 | 跨 session trace viewer（next-action §3-G） | Devtools #54 延伸 | **改造抄**：扩「跨 session widget/tool 归档 + 可回放」路由。 |

---

## 5. 明显更好的形态 — 单独标出给团队 lead 裁决

**只有一个：next-action-ui-lab 的「4-verb REAL vs RECORD-ONLY 二分」比我们的 widget 通道设计明显更完整。**

我们 `docs/widget-channel-design.md` 定义了 `WidgetSpec.actions[]` → 按钮点击 → `sendPrompt(sessionId, action.prompt)`，形态是「按钮 = 触发 prompt」。next-action 走得更远：把「按钮能做的事」分成 4 个原语（`sendPrompt` / `openLink` / `handoffToCodex` / `widgetBridge.commit`），前 3 个是真实副作用，最后一个只写 trace。**关键洞察**：不显式区分时，widget 作者会写出「按钮只调 `commit`」的 broken widget（"看起来交互了、其实什么也没发生"），这是他们数次实战失败中总结的头号 bug。

我们目前的路径只有 `sendPrompt`（等价于 next-action 的 `sendPrompt`），没有 `openLink` / `handoffToCodex`，也没有 record-only 通道。**建议提上议程**：

- 短期（不改 wire）：widget-channel-design.md 加一节 "Verb catalog"，明确 `sendPrompt` 是当前唯一 real verb；`widgets.js` 检测 action.kind 是 `record` 时视觉降级（灰色 + 图标）。
- 中期（协议扩展）：在 `session/*` 或新 `widget/*` 命名空间加 `openLink` / `openArtifact`（借用 artifact server）/ `session/new_from_widget`（等价 handoffToCodex，但按 DSH 惯用法起新 session）——这些都是自然扩展，跟现有 fork/artifact 已有基建对齐。

这条不紧急，但**在 widget 通道走出 demo 之前应该定下来**——否则我们会重演他们踩过的坑。

其他两仓的对照上，autodream 的 lens 切换和 wme 的甘特投影**没有比我们的 layout-heuristics 或 Mission Control 三投影更好**，它们是**正交补充**（时间尺度维度 / 时间轴投影）而不是替代。可以吸收进现有实现，不需要推翻重来。

---

## 6. 出仓外的 open questions

- **Mock widget bank 版权归属：** next-action-ui-lab 是私人仓（AlexZWANG1），10 个 mock HTML 直接抄需要问一下用户是否同意/需要保留 attribution。**建议 SendMessage 到 team-lead 时问一下**。
- **`[event/id]` chip 的 event id 命名：** wme 的 chip 是稳定 event id；DSH 的 session event 有 `type` 但没有稳定 id。要么升协议加 `eventId`，要么用 `(sessionId, seq)` 组合——需要协议线（recon-infra / ui-jsonrpc）拍板。
- **Recall 卡的 6 段模板 vs 现有 P1 渲染批 C：** #53 里的 workflow/tasks/web/skill/resume 卡族有各自的形态；6 段模板是给 recall 卡的，不冲突，但要和 ui-context lane 对齐现有 recall 卡草案。
