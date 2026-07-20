# P0-1 App 壳骨架 impl-log（arch-shell，2026-07-21）

> 恢复指南：API 瞬断频繁，每个文件落盘即记一行。断线重启后从「当前位置」继续。
> design 依据：同目录 design.md（已获用户确认）。三刀计划照 design §6。

## 三刀切分

- **刀 1 布局容器**：shell/ 五件（AppShell/LeftNav/DetailSidebar + 三注册表 leftMenuRegistry/sessionTabRegistry/detailRegistry + builtins）+ sessions/conversation git mv 迁目录（leftmenu/sessions/、sessiontabs/conversation/）+ App.tsx 换 AppShell。验证：tsc 绿 + test:gui 296 全绿 + verify-session.mjs 全绿（aside/main 语义标签保留）。
- **刀 2 RpcLog 迁移**：components/panels/RpcLog → leftmenu/rpclog 改容器形；删 RpcLogBadge；LeftNav 未读角标（读 store unread）；bar 切换调 openRpcLog/closeRpcLog 保 unread 清零语义。验证：verify-rpclog-panel.mjs 选择器同步改+全绿；verify-session §E1-10 同步改。
- **刀 3 坑位+detail**：gantt 占位 tab + tool-call detail 块（点卡展开/再点收起/内容=callId+argsRaw 原始 JSON）+ ConversationView onToolCardClick props 回调链 + verify-session §E1-16 断言。验证：verify-session 新 §E1-16 + tool-card spec 补 onToolCardClick 一例。

顺手刀（属地处置）：index.tsx vs mount.tsx 死重复候删——处置后记录于此。

## 约束提醒（并行环境）

- web-test 注的 v8-ignore 注释在被迁文件里必须保留（git mv 自动保留，改造时别删）。
- 新增壳文件：要么带 jsdom 用例，要么单文件挂 coverage exclude 行注明 "shell v1 skeleton, spec to follow"。
- commit：只 add 自己的文件（coverage-fixer2 在改 packages/host 三文件）；--no-verify；严禁 push。

## 当前位置

- [x] 第 0 步：impl-log.md 落盘
- [x] 刀 1：done（shell-exec）——commit 694cecc53，tsc 绿 + test:gui 301 全绿 + verify-session ALL PASS + apps/web dist 重建后浏览器实测
- [x] 刀 2：done（shell-exec）——commit 31c4bb827，tsc 绿 + test:gui 304 全绿 + verify-rpclog-panel ALL PASS + verify-session ALL PASS
- [x] 刀 3：done（shell-exec）——commit 见流水末行，tsc 绿 + test:gui 305 全绿 + verify-session ALL PASS（新 §E1-16a-e）+ verify-rpclog-panel ALL PASS

## 三刀终态（今晚收工清单）

- 刀 1 `694cecc53`：shell/ 五件 + 两级目录迁移 + App 挂壳 + index.tsx 删。
- 刀 2 `f8fb77b95`：RpcLog 迁 leftmenu/rpclog 改容器形 + rail 未读角标 + Badge/onShow/onHide 口径 + verify 两脚本选择器同步。
- 刀 3（本 commit）：gantt 占位 tab + tool-call detail 块（点开/同卡收/×收，callId+argsRaw）+ onToolCardClick props 回调链 + §E1-16 五断言 + tool-card spec head 点击例。
- 备案项：①单 tab 不渲染 tabs 条（刀 3 双 tab 后自然出现，§E1-16a 实证）；②detail/选中态全部 AppShell 局部 useState（红线 14）；③新壳文件走 coverage exclude 单文件行（"shell v1 skeleton, spec to follow"，共 11 行），spec 补齐后应逐行摘除；④store.ui.rpcLogOpen 语义变更为 unread 门闩信号（ingest 零改动）；⑤GanttPlaceholder 是 placeholder:true 契约件，壳渲占位页不挂载它。

## 文件落盘流水（断线恢复用）

（每落盘一个文件记一行：时间 文件 动作 状态）
- 00:xx impl-log.md 新建 done
- shell-exec 接手刀 1
- 03:0x shell/leftMenuRegistry.ts 新建 done
- 03:0x shell/sessionTabRegistry.ts 新建 done
- 03:0x shell/detailRegistry.ts 新建 done
- 03:1x shell/leftMenuRegistry.ts 补 LeftPanelProps + 过渡 onActivate（rpclog 刀 1 保浮动开关）done
- 03:1x shell/LeftNav.tsx 新建 done
- 03:1x shell/DetailSidebar.tsx 新建 done
- 03:1x shell/AppShell.module.css 新建 done
- 03:1x shell/AppShell.tsx 新建 done（三栏 grid，aside/main 语义标签保留；tabs 条单 tab 时不渲——现 UI 观感不变）
- 03:2x git mv：sessions 7 件 → leftmenu/sessions/、conversation 11 件 → sessiontabs/conversation/（MessageText/JsonBlock/ToolCallCard/toolViewCards/toolCardRegistry/PendingCard? 共享叶子留 components/conversation/）done
- 03:2x sessiontabs 内共享叶子 import 改指 ../../components/conversation/ done
- 03:2x SessionsScreen.tsx → git mv → leftmenu/sessions/SessionsPanel.tsx 改写为面板件（拆掉两栏，壳接管）；SessionsScreen.module.css git rm done
- 03:2x shell/builtins.ts 新建 done（sessions bar + rpclog bar 过渡 onActivate=toggleRpcLog + conversation tab；shell/ 五件齐）
- 03:2x App.tsx 改挂 AppShell done
- 03:2x index.tsx git rm done（处置理由：mount.tsx 的字节级死重复，grep 全仓无引用——仅 vitest.config.ts coverage exclude 提到，已一并清）
- 03:2x vitest.config.ts coverage exclude：删 index.tsx 行，加 shell 七件+SessionsPanel 单文件行（各注 "shell v1 skeleton, spec to follow"）done
- 03:2x tests 三 spec（view-states/conversation-pieces/branch-tails）import 路径改指新目录 done
- 03:30 验证①② tsc -b web-ui 绿；test:gui 26 文件 301 用例全绿（基线 296+host 侧新增，无红）
- 03:3x 验证③ apps/web dist 重建 + 自起 fixture server(3080) + verify-session.mjs ALL PASS（§E1-1~15 含 aside/main 锚点全过）
- 03:3x commit 694cecc53（--no-verify，未 push；host 三文件未混入，留给 coverage-fixer2）——刀 1 完
- 03:4x 刀 2 开工：RpcLogBody/LogRow/PayloadJson/RpcLog.module.css git mv → leftmenu/rpclog/（相对 import 深度改 ../../）；RpcLog.tsx（开合分发器）+ RpcLogBadge.tsx git rm done
- 03:4x RpcLogBody 改容器形：删 × 关闭钮与 closeRpcLog import done
- 03:4x RpcLog.module.css：badge/overlay 段删，.panel 改 flex:1 填充面板区 done
- 03:4x leftmenu/rpclog/RpcLogRailBadge.tsx 新建（unread 角标挂 rail 钮，样式在 AppShell.module.css .unread）done
- 03:4x 注册表口径：LeftMenuBar 删过渡 onActivate，加 Badge?/onShow?/onHide?；AppShell activateBar 切 bar 时调 onHide(旧)+onShow(新)（updater 外，保 updater 纯）；builtins rpclog bar 挂 RpcLogBody/RailBadge/openRpcLog/closeRpcLog done
- 03:4x App.tsx 删 <RpcLog /> 浮动挂载 done
- 03:5x tests/rpclog-panel.spec.tsx 对齐新形态 done（8 例保留：badge 例改走 AppShell rail 断言 unread 清零/重臂+99+ 上限并进；开合断言删（无开合了）；其余 7 例 render(<RpcLogBody/>) 直渲，断言语义不变）
- 04:0x branch-tails.spec：RpcLog→RpcLogBody 引用改、99+ 例删（并入 rpclog-panel badge 例）、rpcLogOpen 前置清理 done
- 04:0x vitest exclude 补 RpcLogRailBadge.tsx 行 done
- 04:0x scripts/verify-session.mjs §E1-10 改 rail 钮选择器+切回 sessions；scripts/verify-rpclog-panel.mjs §D-1/D-2 改 rail 钮+unread 角标选择器 done
- 04:0x 验证：tsc 绿；test:gui 27 文件 304 全绿；verify-rpclog-panel ALL PASS；verify-session ALL PASS（dist 重建后实测）
- 04:1x 刀 3 开工：ToolCallCard 加 onClick?(callId)（head 行点击，headClickable cursor）done
- 04:1x 回调链：ConversationView onToolCardClick? → ConversationContainer（改用 SessionTabProps）→ sessionTabRegistry 增 SessionTabProps{sessionId,onToolCardClick?} done
- 04:1x shell/ToolCallDetail.tsx 新建（callId+argsRaw 原始 JSON，找不到时兜底文案）done
- 04:1x sessiontabs/gantt/GanttPlaceholder.tsx 新建（placeholder:true 契约件，壳渲占位页不挂载它）done
- 04:1x AppShell：onToolCardClick 点开/同卡再点收起（keyed [selectedId] 稳引用）；select 时 setDetail(null) 防跨会话陈旧 payload；builtins 注册 gantt tab + tool-call detail 块 done
- 04:2x vitest exclude 补 ToolCallDetail/GanttPlaceholder 两行；tool-card.spec 补 head 点击例（onClick 收 callId、body JSON 钮不触发）done
- 04:2x exactOptionalPropertyTypes 两处修正（onClick?/onToolCardClick? 显式 |undefined）；ToolCallDetail 改 type-guard find done
- 04:2x verify-session 新增 §E1-16a-e（tabs 条/占位页/点卡展开/同卡收起/关闭钮）done
- 04:2x 验证四件套：tsc 绿；test:gui 305 全绿；verify-session ALL PASS（含 §E1-16 五断言）；verify-rpclog-panel ALL PASS
