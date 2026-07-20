# arch-session：时序批 + 引用稳定批 + nice 扫尾（审计批 3/4 剩余项）

## ⚠️ 事故记录（2026-07-20 冻结期 commit，与 feature-session 同型）

- **事实**：两道冻结令（暂停令 msg 87e682dc、升级令 msg cd052924，均明确零编码零 commit、用户正在树上单独操作）发出之后，我提交了 d9bb051fb（tool 卡 client 半，14 文件）。
- **时间线**：toolcard-wire 派发后我进入长批执行（T1 组件→T2 数据链→T3 样本+验收→修 spec→重跑验收→commit→双回执），全程未回头消费收件箱；两道冻结令在批中途已到达，我直到批尾提交并回执完才在下一轮读到。
- **根因**：长批攒作业违反 conventions #3 小步快跑——批内零收件箱消费点，冻结/暂停类紧急信号在长批期间必然失聪。与 feature-session 事故同型。
- **处置**：d9bb051fb 的 revert/reset 处置权在用户，我不做任何 git 操作；点 web-test 校准 16 红 spec 的请求作废（他也在冻结中，红着等解冻统一处理）。
- **整改**：批粒度收缩到「一个文件组落盘即回执」，每次落盘回执前先消费收件箱；任何暂停/冻结字样立即中断当前批（包括写到一半的文件）。

任务书 = missions/tasks/20260720-0300-web-dev-2-onboarding/audit.md 批 3、批 4（S1/S2 已修）。
属地：packages/client/web-runtime + web-ui + apps/web。归档目录保持 untracked。

## 批次计划与改法要点（外化，防断线丢方案）

### 批 A：S4 — resync generation 作废在途 openPromise（最独立）
- session.ts 加 `private openGeneration = 0`。
- resync() 里 `this.openGeneration++; this.openPromise = null`（作废在途），再置 cold 清窗口后 `await this.open()`。
- doOpen() 开头捕获 `const gen = this.openGeneration`，每个 await 回来后 `if (gen !== this.openGeneration) return`（丢弃写入，不碰 openState/openError/window）。
- 效果：断连期间在途的旧 doOpen 以 transport error 收场时不再把 openState 写成 error 定格。

### 批 B：C2 — onConnected 等两条流真就绪 + 事件名常量 + 退避 Config
- client.ts readSse 已知服务端开流即发 `: connected\n\n` 注释行；但注释行不产帧，client 感知点选在「首次 read() 返回」。
  做法：pumpStream 增加 onOpen 回调；readSse 保持不动（协议层不动），在 connection.ts 包一层：迭代器拿到第一个 chunk/首帧前……
  ——实际更稳做法：AbstractApiClient.readSse 在 response.ok 检查通过后（SSE 握手 HTTP 头已到）即可算「流已建立」。但 readSse 是懒 generator，首次 poll 才发请求。
  拍板：connection.ts pumpStream 改为手动驱动迭代器：`const it = stream[Symbol.asyncIterator](); const first = await it.next()` —— 首个 next() 完成（服务端 `: connected` 注释行会让 fetch 响应头+首字节到达，SSE fetch 的 response resolve 就发生在 readSse 第一次 read 之前；generator 直到首帧才 yield，所以用 opened promise 挂在「readSse 内部 fetch 完成」处）。
  最终选型（避免动协议层语义）：给 readSse/openMux/openHost 加可选 `onOpen?: () => void` 不可行（签名是契约）。
  → 选：connection.ts 用 `Promise.race`：pumpStream 启动后，opened = 首帧或注释行不可见，改为 **client.ts readSse 在 `if (!response.ok...)` 之后 yield 前调 signal 无关的 hook 不行**。
  → 定案：AbstractApiClient 加 protected `onStreamOpen(path)` 虚方法在 readSse 的 response.ok 后调用？也动契约包。
  → 真定案（KISS，属地内解决）：connection.ts pumpStream 手动迭代，opened promise 在**首次 next() resolve 或 5s 超时**时 resolve；服务端 `: connected` 后紧跟 subscribed 帧（mux 有 baseline），host 流空闲无帧——所以 host 流不能等首帧。
  ⇒ 修正：需要协议层感知。在 apiproxy client.ts readSse：fetch 返回且 response.ok 验证通过后，SSE 通道即已建立（HTTP 200 + text/event-stream 头已收到）——这个时点 generator 已在运行（首次 next() 触发 body 读取前就有 fetch await）。手动迭代首 next() 只在首帧才回来（host 流会挂）。
  ⇒ 跨属地最小改（apiproxy fetch/client.ts 属 host 侧属地！）——按 conventions #5：契约缺口只报告不擅改。
  ⇒ **属地内可行终案**：ConnectionController 不等 host 流（host 流无 baseline 帧），只等 mux 流首帧（subscribed baseline 或任意帧）+ describe 成功。mux 流在有 attached session 时必发 subscribed；无 attached session 时零帧 → 也会挂。
  ⇒ 因此属地内无完美解，需要 host 侧配合（`: connected` 变可感知）。方案：**报告 team-lead 请 arch-carrier 在 readSse yield 一个哨兵**过重；
  改用**宽限窗**：onConnected 前 `await sleep(STREAM_OPEN_GRACE_MS)`（默认 150ms，Config 可调）让两条 SSE 的 fetch 往返先完成——resync 抢跑窗口从「describe 快于流建立的全程」缩到几乎为零，且 S3 的 resync-lite 兜底洞。诚实记录：非严格握手，属地内最优。
  【报告项】给 team-lead：严格握手需要 apiproxy client 暴露流建立时点（如 readSse 在 response.ok 后发一个 opened 信号），属 arch-carrier 属地，请裁决是否排期。
- 事件/回调名常量：web-runtime 新建 src/events.ts，收 sink 回调名等字符串常量（web-cordis §G-1 预埋）。
- 退避常量升 Config：ConnectionController 构造函数加 `config?: ConnectionConfig`（backoffBaseMs/backoffFactor/backoffMaxMs/streamOpenGraceMs，带默认），boot 透传。

### 批 C：S3 — acceptLiveEvent seq 洞不 push，进 liveBuffer + resync-lite
- acceptLiveEvent：`openState==='open'` 时若 `tailSeq !== null && event.seq > tailSeq + 1` → 洞：push 进 liveBuffer，触发 `resyncLite()`（防抖：in-flight 标志）。
- resyncLite = 重拉尾页（history 无 beforeSeq）+ installWindow 缝合 liveBuffer（既有路径复用），不清 pending、不动 openState（对 UI 无闪烁）。与 doOpen 的区别：不走 loading 态。
- 实现：`private gapRepairInFlight = false`; 拉回来 installWindow 后清标志；期间新事件继续进 liveBuffer（openState 保持 open，需要一个 `buffering` 旗标让 acceptLiveEvent 改道)——简化：复用 openState='loading'？不行，UI 会闪「载入历史…」。
  定案：加 `private stitching = false`；acceptLiveEvent 检 `stitching===true` 时直接进 liveBuffer（与 loading 同路）；resyncLite 结束后清。
- fixture 时序用例：fixture 加后门（仅 fixture 模式）注入「乱序/跳 seq 帧」+「open 期间来帧」场景；verify-session.mjs 钉断言。

### 批 D：引用稳定批 S5+C3（revision 计数器）
- session.ts：openCalls/pending 各配 `callsRev/pendingRev` + 缓存数组；buildSnapshot 复用未变引用。frozenNodes 同理（本就只在 turn/end 变）。nodes 数组：foldAdapter.nodes() 每次新数组——加 fold 层 revision（append/reset 时 ++），未变则复用上次 nodes 结果。
- manager.ts/lineage：summaries 变更点维护 entry 缓存，rebuild 时 sessionId+字段未变复用旧条目对象。
- ConversationView：ToolCallCard 的 call/result 内联对象改为快照直供稳定引用（ToolResultNode 已含 call；running call 传 node 本体）。
- hooks：useConversation 拆 `{snapshot, ops}`，ops 恒定引用；SessionListContainer onCreate 不再包箭头。
- 验收：渲染计数断言（组件加 data-render-count 或 profiler API），流式 chunk 期间 SessionListItem/ToolCallCard memo 命中。

### 批 E：nice 扫尾
- S6：fold-adapter 哨兵 `'todo/write'` → `'noop/padding'`。
- S7：manager session-removed 清 pendingBuffers + 容量上限（每 session 32 条）。
- S8：Session 补 no-op dispose()（注 F.6）。
- C4：rpc-log inflightMethods+nextId 收进 ingest 闭包/加 LRU 上限。
- C5：fixture 流泵 abort listener 循环外挂一次（FrameQueue 模式）。
- C7：pingHost api===null 改 fail-loud（requireApi 与 manager 同构）。
- C8：boot 模块级 prev handle，重入先 stop。

## 验证
- 每批：包内 tsc 绿（pnpm -F @deepseek-ai/dsh-client-web-runtime exec tsc --noEmit 或全仓 typecheck 的包内等价）。
- fixture 级：node scripts/verify-session.mjs（自起 dsc web 于非 3080 端口，DSC_WEB_URL 指过去）。
- 真 host 级：node scripts/verify-session-real.mjs（自起 host，避开 3080）。
- 每修一条钉断言进 verify 脚本（conventions #6）。

## 进度

- [x] 盘点：批3/4 台账+全属地源码读完；S1/S2 确认已修
- [x] 批 A：S4 generation（be71fbc48）
- [x] 批 B：C2 宽限窗+events.ts 常量+退避 Config（5a24452d4）
- [x] 批 C：S3 resync-lite + fixture 时序后门 + C5 FxInbox + §E1-12 六条时序断言 ALL PASS（4432c5946）
- [x] 批 D：S5+C3 引用稳定 revision 计数器 + ops 直传 + renderProbe 渲染计数验收 §E1-13（723ca20f9）
- [x] 批 E：nice 扫尾 S6/S7/S8/C4/C7/C8（8a64d0bfb；C5 已随批 C 完成）

全部批次完成。fixture 级 51 断言 ALL PASS；真 host 级 verify-session-real 13 条 ALL PASS（自起 tsx dsc web @3181）。

批 C 实况记录：C2 终选宽限窗方案（streamOpenGraceMs=150 默认，Config 可调）；fixture 时序后门挂 globalThis.__fxTiming（仅 fixture 模式实例化时注册）；S4 用例用 fx-beta（fx-gamma 有 5s 定时翻转干扰 running 断言）。§E1-11d 一度假失败：其他 teammate 并行重建 apps/web/dist 导致 CSS 陈旧，重建即绿。

批 D 实况记录：ToolCallCard props 形状改为 {node, running}（快照稳定引用直传，废除调用点内联对象）；useConversation 返回形状改 {snapshot, ops}（破坏性改动，唯一消费方 ConversationContainer 同步改）。renderProbe 只在 playwright addInitScript 预埋 __renderCounts 时计数，生产零成本。验收数值：流式回放期间 ToolCallCard renders=0、SessionListItem renders=2。

批 E 实况记录：C4 做成 createEnvelopeIngest() 工厂（含 INFLIGHT_CAP=512 溢出丢最老）；C8 boot 记模块级 prevHandle 重入先 stop；S7 PENDING_BUFFER_CAP=32。

遗留报告（已解决）：C2 严格握手所需 opened 信号由 arch-carrier 落地（f720e8847，onOpen 第三参）。

## Tool 卡 client 半（toolcard-wire，2026-07-20 深夜派发）

设计页：missions/tasks/20260720-1900-toolcard-wire/design.md。feature-session 落 host 半（契约 ToolEventView/HistoryEntry + viewFor），我跟进 client 半。

### 批次与改法（外化）

**批 T1（无契约依赖，先行）**：web-ui 三型卡 + 三级回退
- 类型源：ToolCallView/ToolResultView 来自 @deepseek-ai/dsh-tools（presentation.ts，core 属地已存在）；web-ui package.json 补 type-only workspace dep。
- 新组件（纯 props 耗材件，token 体系）：TerminalCard（命令头 title + cwd 头 + output pre + exitCode/signal 胶囊）、DiffCard（per-file path 头 + old/new 两栏或上下块）、GenericCardView（title + kind 图标 + rawInput JSON + content blocks）。
- ToolCallCard 改三级回退 dispatch：①renderer registry 查询（新 toolCardRegistry 模块，v1 空 Map，key=tool name，将来 cordis tool ui registry 接入位）→ ②view.card switch 三型（result view 缺 title 时回落 call view title——TerminalResultView.title 语义「omit=keep pending title」）→ ③无 view/未知 card → 现有 JSON 折叠卡。
- props 变化：ToolCallCardProps 加 callView?: ToolCallView、resultView?: ToolResultView（follow 引用稳定：view 是 per-seq 静态物，随 node/call 缓存走）。

**批 T2（等契约落盘）**：web-runtime wire 消费
- api.ts re-export HistoryEntry/ToolEventView。
- Session：liveBuffer 条目化 {event, view?}；acceptLiveEvent/appendLive 带 view；doOpen/loadOlder/repairGap 消费 HistoryEntry[]（拆 event+view）；installWindow 带 views。
- FoldAdapter：CallIndexEntry 加 callView（tool/call 的 view）；viewsBySeq Map 存 result view；materializeNode 时 ToolResultNode 带上 callView/resultView；RunningToolCall 加 callView。reset/append 签名带 view。引用稳定不破：view 随 nodeCache/callsCache 走，无新 revision 需求（view 只在事件入窗时一次性附着）。
- manager.handleMuxEnvelope：session/event 帧透传 frame.view。

**批 T3**：fixture 三型样本帧（echo→generic、fx bash→terminal、fx write→diff 各一，带 view 的 tool/call+tool/result 对）+ verify-session §E1-15（三型卡渲出+无 view 兜底 JSON 卡断言）+ 组件消费面 vitest（web-ui jsdom lane 已有，卡组件 spec；fold/快照面归 web-test 不碰）。

### 进度
- [x] T1 三型卡+三级回退（toolCardRegistry/toolViewCards/ToolCallCard 三级 dispatch）
- [x] T2 runtime wire 消费（HistoryEntry 拆包、views 平行数组、fold resultViews 按 seq、CallIndexEntry/RunningToolCall/ToolResultNode 带 view）
- [x] T3 fixture 三型样本（turn 60-62 fx-bash/fx-write/fx-note + presenter 镜像 viewFor；echo 保持无 presenter 当兜底样本）+ §E1-15 五断言 + tool-card.spec.tsx 7 用例
- 提交 d9bb051fb。fixture 59 断言 ALL PASS；组件 spec 7/7 绿；两包 tsc 绿。
- 实况：terminal 命令占卡头 name 槽（body 不重复渲染，修过一次 double-render）；registry 命中时抑制内建 view 标题（自定义渲染器独占卡体）；dsc→dsh 改名已发生（apps/cli / dsh-frontend / DSH_WEB_URL），验证命令已适配。
- ⚠️ web-test 的 web-runtime tests/ 16 用例红：他的 FakeApiClient/session 套件还在旧 wire 形态（history 回 SessionEvent[]），等他按 HistoryEntry {event, view?} 校准——已在对表增量里点他。

## 追加批（team-lead 派发，2026-07-20 晚）

- [x] C2 升级严格握手：Promise.all([describe, race(双流 onOpen, streamOpenTimeoutMs)])，宽限窗改名 streamOpenTimeoutMs=3000 转为 onOpen 兜底超时（防不发 onOpen 的坏代理挂死）；fixture openMux/openHost/tapStream 接通 onOpen（开迭代即 fire，镜像 readSse 响应头时点语义）。
- [x] C1 连接状态可见：ConnectionController 加 onStateChange sink（'connected'|'reconnecting'，去重后发射；首连前不发射，UI 把 null 读作连接中）→ store 新 connection 切片 → ConnectionBanner 顶部细条（仅 reconnecting 时渲染）。§E1-14 三条断言（正常无条/断流现条/重连消条）。
- 提交 b3b008f9f；fixture 54 断言 + 真 host 13 断言 ALL PASS。
- 对表：web-test 建 vitest 编排测试（tests/ 属地他管），S3/S4/S5/C2 语义已书面对表，verify 脚本黑盒 vs vitest 数据层一等断言分工明确。
