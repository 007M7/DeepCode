# InputBar × deepseekchat 对照表（2026-07-20）

来源：deepsuite-frontend（只读调研），主输入框 = `apps/chat/src/components/chatInputUi/`（ChatInputUi.tsx 总装 + useInputTextArea.tsx textarea 本体）。学交互逻辑不抄样式。

| 交互点 | deepseekchat 做法（file:line） | 我们现状 | 差距/决策 |
|---|---|---|---|
| IME 组合期 Enter | `useComposing.ts:5-15` ref 记组合态，compositionend 延时清（Safari 10ms，keydown 晚于 compositionend）；keydown 先查 ref return（`useInputTextArea.tsx:92-96`） | 无任何检查，组合期 Enter 直接发送（bugs B1） | **采用**：ref + start/end 监听 + end 延时 10ms 清；再叠 `nativeEvent.isComposing`/`keyCode 229` 双保险 |
| Enter/Shift+Enter | Shift return 走原生换行；Ctrl/Alt+Enter `document.execCommand('insertText','\n')` 保 undo 栈；裸 Enter preventDefault 提交（`useInputTextArea.tsx:102-118`） | Shift 正确；无 Ctrl/Alt+Enter；无 repeat 检查 | **采用** Ctrl/Alt/Meta+Enter=插换行（execCommand 保 undo）；加 `e.repeat` 忽略（B6，他家没管、我们实测有洞） |
| 多行自增高 | 镜像法：textarea absolute 铺满 relative wrapper，旁挂 hidden mirror div 渲 `value+'\n'` 撑高，mirror max-height 336px 封顶（`useInputTextArea.tsx:125-153` + css:101-144） | `rows=split('\n').length` 只数换行符，软换行不增高（B3） | **采用**镜像法（rows 法对软换行无解；scrollHeight 量高法要 reset-measure 抖动），封顶 6 行 |
| 发送中按钮态 | 单主按钮三态翻转（idle 发送/verifying Loading/receiving 停止，`InputMainButton.tsx:40-49`）；streaming 可打字不可发 | 双按钮+停止条件渲染，running 出现停止钮挤跳布局 36px（B5） | 双按钮是设计稿拍板 6（queue/steer 语义），**不改结构**；停止钮改常驻占位（visibility 切换）修跳动 |
| 防重复发送 | 提交瞬间同步 `markSessionAsSending` 翻状态挡二连击（`completionHint.ts:85`）；agent 路径显式 in-flight 守卫（345-348） | sendDraft 无在途守卫（B7，fixture 近同步掩盖） | **采用**：Session.sendDraft 加 draftInFlight 锁（accepted 后释放——排队是合法语义，不学他家整段锁死） |
| 空白输入 | 按钮置灰 + Enter 弹 tooltip「请输入你的问题」（`inputHooks.ts:239-241`）；发送时 `value.trim()` | 置灰+no-op 正确 | 不动（tooltip 提示暂不做） |
| 发送后焦点 | 按钮 `onMouseDown preventDefault + focus`（`InputMainButton.tsx:68-71`）；切会话 useEffect focus（`InputCompose.tsx:25-30`）；focus 光标置尾 | 点按钮焦点丢到 body（B4）；切会话不聚焦（B10） | **采用**：三个按钮 mousedown preventDefault+refocus；InputBar 在 !disabled 时 focus（容器 key=sessionId 重挂载=切会话） |
| 草稿保持 | zustand promptStore 按 sessionId 分桶，纯内存无 persist（`prompt.ts:26-59`）；失败路径保草稿（`completionHint.ts:391-393`） | 草稿挂 Session 对象（设计稿 §A.7），切换保稿实测 OK；但 ok 无条件清稿吞在途输入（B8） | 归属不改（我们的更优：对象常驻）；**采用**「清稿前比对发送时快照」修 B8 |
| 粘贴 | 文件/图片抽取上传 + Word 富文本特判（`useFileHooks.tsx:104-131`）；纯文本只埋点 | 纯文本粘贴原生行为，无附件体系 | 不做（无文件上传体系；长文粘贴由自增高修复承接） |
| 发送失败 | 乐观消息 + hint 错误 + 就地 Resend（`sharedStrategy.ts:230-266`）；不回塞草稿 | promptError 错误条；但 cancel 失败也标「发送失败」（B9） | 错误条形态保留；**修**：PromptError 带 op 标记，停止失败单独文案 |
| 光标/受控 | value 直连 zustand store，同步通知，无光标问题 | Notifier 微任务异步通知 → 中段编辑光标跳末尾（B2） | **修**：setDraft 走同步 notifyNow（uSES 受控输入必须同拍通知） |

不采纳（记录理由）：ArrowUp 召回历史（他家也是空实现骨架）、字数超限拦截/CharCounter（无模型字限配置）、PoW 预取/滚动渐隐 mask/自绘滚动条（样式轮再说）、移动端分支（桌面工具）。

## 布局尺寸实值（第二阶段采集，deepseekchat 桌面端）

| 项 | deepseekchat 实值（file:line） | 我们落地 |
|---|---|---|
| 挂载占位 | sticky bottom 通栏、内容 `--message-list-max-width: 840px`（<lg 712px）居中，左右 margin 32px（InputCompose.module.css:2-12, Session.module.css:2-8） | flex column 居中，card max-width 840/712，root padding 8px 32px 44px（底带兼当 caveat 位+避 RPC 角标） |
| 卡片 | radius 24px、border 1px l2、亮色白底+微影 `0 4px 10px .02 / 0 2px 4px .04`、暗色提亮底无影（ChatInputUi.module.css:7-40） | `--radius-xl: 24px` + `--shadow-card`（暗色 none）新 token；border `--border-l2`、底 `--bg-base` |
| 结构 | column：textarea 上、functionRow 按钮行下（:8-9, :49-65） | 同构：`.grow`（镜像自增高）上、`.row` 下 |
| textarea | 16px/24px、padding 12/16/0、min 60px（2 行）、max 336px（14 行）、rows=2、placeholder 第四级灰、caret 品牌色（:85-143, useInputTextArea.tsx:138） | 同值：16px/24px 继承卡片、padding 12px 16px 0、mirror min 60/max 336、rows=2、placeholder `--text-tertiary`、caret `--accent` |
| 按钮行 | padding 12、34px 高、正圆图标钮、间距 margin 10px、靠右（:58-78, InputMainButton.tsx:73-79） | padding 4px 12px 12px、34px 高胶囊（文字钮，无图标体系）、gap 10px、justify-end；停止/插话/发送序（发送最右=基线主按钮位） |
| focus 态 | 无视觉变化（focused 类无规则；textarea outline none） | 同：卡片无 focus 变化，textarea outline none |

样式偏离基线记录：①按钮为文字胶囊非图标正圆（无图标资产；34px 高度对齐）；②queue/steer 双按钮+停止常驻位是我们的设计（拍板 6），基线单按钮三态不适用；③底部无 caveat 免责行，留白带代偿。
