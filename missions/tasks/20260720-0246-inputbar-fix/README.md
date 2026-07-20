# InputBar 修缮（2026-07-20）

对照 deepseekchat（deepsuite-frontend apps/chat，只读）系统修缮 GUI 对话输入框。产物：bugs.md（清单）→ compare.md（对照表）→ 修复 → verify-session.mjs §E1-11 防回归断言。

## 进展

| 批次 | 内容 | 状态 |
|---|---|---|
| 1 | playwright 探针（probe.mjs）过 13 项交互，bugs.md 落盘：6 实锤 + 3 潜伏 + 1 提升项 | ✅ |
| 2 | deepseekchat 对照表 compare.md（11 交互点，采纳/不采纳含理由） | ✅ |
| 3 | 修复：InputBar.tsx/module.css 重写 + Session.sendDraft/setDraft + Notifier.notifyNow | ✅ 探针 13/13 绿 |
| 4 | 防回归：verify-session.mjs 新增 §E1-11a–g 7 断言；三验收脚本全绿；截图 .artifacts/inputbar-{multiline,running}.png | ✅ |
| 5 | 样式对齐（第二阶段派发）：布局尺寸照 deepseekchat 基线重排——居中卡片 840px（<1024 降 712）、圆角 24、textarea 上/按钮行下两段、16px/24px、min 2 行 max 14 行（336px）、34px 胶囊钮靠右 gap 10；新 token `--radius-xl`/`--shadow-card` 入 global.css+web-styling.md §1；§2 基线补输入卡片行 | ✅ 三脚本绿+新截图 |
| 6 | 按钮区拍板改版（2026-07-20 用户令）：单 34px 圆形主按钮嵌右下——空闲实底三角「发送」、运行中原地变软底方块「停止」（同色系非红）；hover 上拉 flyout（零指针间隙+150ms 延时收起）出「插话」（空闲置灰）+运行中「排队发送」；键盘 Alt+Enter=运行中插话。verify-session 新增 §E1-7d/7e，重写 §E1-6a/7c/11g | ✅ 41 断言绿，commit b729d8b64 |
| 7 | 停止后再发消息「插错位置」bug：真 host 复现（早停在 reasoning 期）——中止 turn 永不 finalize，残留 partial（含 running 工具卡）一直渲染在后续消息下方=视觉上「新消息插到旧回复前」。修法：turn/end 副作用清扫同 turn 的 partial+openCalls（session.ts applyEventSideEffects）。防回归 E2-4a/4b 入 verify-session-real。（web-dev-2 审计 S2 同根因独立发现，互相印证；S2 提出的「verify-session-real 缺 stop 用例」正由 E2-4 补上） | ✅ 真 host 复现→修复→断言绿 |
| 8 | 按钮语义定稿+Codex 视觉：idle=单发送圆钮**无菜单**（空闲 queue/steer 无差别）；running=停止圆钮+有草稿时 hover 上拉【排队｜插话】（空草稿不出菜单，preconditions 中途变化菜单跟随开合）。视觉照 Codex App：32px 实心正圆+内联 SVG 图标（↑箭头/■方块），菜单改圆角卡（--radius-m+--shadow-panel）。§E1-6a/6c/7c 断言随语义重写 | ✅ 42 断言绿+real 9 断言绿 |
| 9 | 批 7 修正（用户实测「停止后整条消息消失」——清扫过头）：turn/end 清扫改**定格**——partial 有可见内容时冻结为 interrupted 终态节点（正文保留+「已停止」标记+脉冲停，AssistantMessageNode 加 `interrupted?: true`，分数 seq 保持流内顺序），running 工具卡转「已中断」终态卡（灰点非红）而非消失；空内容 partial 才整删。live 定格与 history 重放同走 applyEventSideEffects → 刷新重建一致（E2-4c 断言钉死）。E2-4a 改「定格保留」语义 | ✅ real 10 断言绿 |
| 10 | 发送后强制置底（用户新单）：ConversationView 两规则并存——「用户发言=强制置底」（send 时 arm 一次性 forceBottom，跨草稿清空 re-render 保持 armed 直到气泡入 DOM）与「流式=离底不跟随」；跟随判定从「更新后量距底」改为 scroll 监听维护的 **更新前 atBottom 标志**（修根因：追加高块瞬间超阈值导致跟随链断裂）。§E1-11h 断言钉死 | ✅ fixture 44 断言绿 |
| 11 | 深色模式切换（插单）：侧栏左下角月亮/太阳图标钮；html data-theme 翻转+localStorage `dsc.theme`+mount 首绘前应用；机制住 utils/theme.ts 纯本地模块（将来迁 Settings 零逻辑变化）。暗色四面过检无不可读项 | ✅ commit 6ca6574ce |
| 12 | 运行中锁输入（拍板 3，取代批 8 的 hover 菜单方案；起因=用户实测「running 时 Enter 发出但不回显」）：running 态 textarea disabled（灰、草稿保留显示）、排队/插话菜单整体取消、停止唯一可用；turn 结束解禁+refocus。InputBar 大幅简化（flyout 状态机全删）。§E1-6a-c/7c/7f/11e 按新行为重写；probe P4/P5 改锁定语义 | ✅ fixture 44+real 10+probe 13 全绿 |

## 修复清单（bug → 修法）

| bug | 修法 |
|---|---|
| B1 IME 组合期 Enter 误发送 | composition ref + end 延时 10ms（Safari keydown 晚于 compositionend）+ nativeEvent.isComposing/keyCode 229 双保险 |
| B2 中段编辑光标跳末尾 | Notifier 新增 `notifyNow()` 同步通知，`setDraft` 走它（受控输入必须同拍刷新；其余路径仍微任务批量） |
| B3 软换行不增高 | 镜像 div 自增高（textarea absolute 铺满 wrapper，mirror 渲 draft+'\n' 撑高，max-height 135px≈6 行封顶） |
| B4 按钮发送后焦点丢失 | 三按钮 `onMouseDown preventDefault + refocus` |
| B5 停止钮布局跳动 | 停止钮常驻占位，`visibility` 切换（data-hidden） |
| B6 Enter autorepeat 连发 | keydown 忽略 `e.repeat` |
| B7 在途重复发送 | Session.sendDraft 在途锁（settled 后释放——此后再发是合法排队） |
| B8 在途打字被清稿吞 | 乐观清稿：发送时清、失败回填 `sent+新输入`；在途新输入不受 ok 影响 |
| B9 停止失败错标「发送失败」 | snapshot.promptError 类型 RpcError→`PromptError{op:'send'\|'stop',error}`，错误条按 op 出文案 |
| B10 切会话不聚焦 | InputBar 挂载/enable 时 autofocus（容器 key=sessionId 重挂载即切会话） |

附加（对照表采纳）：Ctrl/Meta+Enter 插入换行走 `document.execCommand('insertText')` 保 undo 栈（批次 6 改版后 Alt+Enter 让位给「运行中插话」快捷键）。

## 契约偏差（设计稿 §C.6/§A.2 相对）

1. `promptError: RpcError|null` → `PromptError|null`（新增 op 判别；InputBarProps 同步）。
2. sendDraft 清稿时机：「ok 后清」→「发送时乐观清 + 失败回填」；新增在途锁。

## 留档

- probe.mjs：13 项探针（可重跑）；shot.mjs：截图脚本。
- 防回归：scripts/verify-session.mjs §E1-11a–g（IME/repeat/光标/自增高/焦点/清稿/布局）。
