# 学习笔记（web-dev-2）

## 1. 契约与 client 载体（packages/host/apiproxy/src/）

**四象限消息模型（design.md v2.0 §2）**：通道（HTTP=C→S、SSE=S→C）与逻辑消息解耦。wire 全形 = `ClientRequest`/`ServerResponse`/`ServerRequest`/`ClientResponse` 四具名判别 union（判别子 `type`）；签名窄形 = `RpcRequest<P>{rpcId,payload}` / `RpcResponse<T>{rpcId,result}`。审批/问答 requested 帧是「可应答 server-request」（rpcId 稳定、重放复用），纯推送帧 rpcId 每次新 mint——是否期待应答由 method 静态区分，不设第三 kind。

- **api/ 目录零 Node 依赖**（浏览器可 import）；一域一对文件 `<域>.ts` + `<域>.schema.ts`。加新 unary 方法的固定动作：域接口签名（唯一事实源）→ `rpc-map.ts` RpcMethodMap 加行 → `<域>.schema.ts` 加 Request/Value schema 对 → handler.ts `UNARY_ROUTES` 加行 → client.ts `IApiClient` + `sessions/host` 字面量各加行。签名之外只准引用 `RequestPayload<K>` / `ResponseValue<K>`，禁止复写字面量结构。
- **rpc.ts 关键面**：`RpcId()` 构造函数（谁发起谁 mint；response 只回填绝不 mint）；`RpcError` = RpcErrorDetailsMap 展开的分布式 union（code 判别，details 必填，新码=map 加行+schema 加支）；`RpcResult<T>` 是业务成败位；`RpcReceipt` 是 /api/respond 的**载体回执**（不是 RpcMessage，迟到应答 `not-pending`）。
- **zod 纪律**：锚定写 `satisfies z.ZodType<Wire<T>>`——`Wire<T>` 是深度 `|undefined` 宽化（rpc.schema.ts），因仓库 `exactOptionalPropertyTypes` 与 zod `.optional()` 不兼容。透传宽分支（SessionEvent/ContentBlock/帧 union/RpcError）与 brand id schema 用显式 `as unknown as z.ZodType<T>` cast。brand cast 点每域仅一处（rpcIdSchema/sessionIdSchema/approvalRequestIdSchema）。
- **SessionEvent 透传 =「信封严格 + data 宽」**：type/seq/time 严格校验，data 是 `z.unknown()`；不 passthrough 字段级。ContentBlock 用 `z.looseObject({type})`。
- **handler.ts 两级 parse**：① `clientRequestSchema` 全形（+ path==method 校验）→ ② `UNARY_ROUTES[method].schema` payload parse。HTTP status 只表载体：404 未知路径 / 400 body 非 JSON / 500 impl 自身 throw；业务错误恒 200 + ServerResponse error 位。SSE：`sseResponse` 把窄形帧补全为 ServerRequest 全形（method=帧 type），开流先发 `: connected\n\n` 注释行（防零字节空闲）。流 GET 入口 handler 代 mint 一个 rpcId 传给 `api.events.*`。
- **client.ts 继承体系**：`IApiClient` 是消费面（payload 直传，载体代 mint rpcId + 包信封；与 ApiProxy 窄形签名面是两个面）。`AbstractApiClient implements IApiClient` 持全部协议不变量：`callUnary`（mint→tap→POST→parse→校验 rpcId 回显→tap→吐窄形，virtual 可被 fixture 假载体覆盖）、`readSse`（streaming fetch 非 EventSource，`\n\n` 分帧）、`onEnvelope` tap（微任务批量缓冲，listener throw 隔离）+ `subscribeEnvelopes` 观测。平台差异只走两切面：抽象 `doFetch`（传输）+ 可覆写 `onEnvelope`。`InProcessApiClient(handler)` = 同构点：`new InProcessApiClient(toFetchHandler(api))` 全程不过网络。
- **坑**：unary 默认 30s 超时（`AbortSignal.timeout`），流永不超时；域方法字面量是 arrow property（解构后 this 仍绑定）；`resolveBase()` 浏览器用 location.origin、Node 用假 authority `http://dsh.internal`；`respond()` 的 message 由调用方整体构造（rpcId 回填 server-request 的）。
- **MessageSource 声明合并**：sessions.ts 里 `'user-rpc': {kind:'user'; rpcId}` ——prompt 的 rpcId 经 MessageSource 透传进 `user/message` 事件，为将来 provisional 转正预留（v1 client 侧转正不做）。
- **预留接缝（design.md §8）**：fork/inject/task.list/host.listModels 签名已定稿但**不进 map 不进根接口**——实现时抄签名+map 加行+schema 加对即升格；未知 method 在信封 parse 即 fail loud，不设 not-implemented 兜底码。

## 2. host 侧（packages/host/runtime + webserver + apps/dsc）

**分层宪法（hostruntime-split design.md ⓪）**：host/* 与 client/* 包按「能力支持方」单边分层，混合体一律放 apps/；消费型 client（web/Electron/headless）全走 apiproxy（差异只是 fetch 形函数的伪造方式：HTTP/进程内注入/IPC 桥）；协议桥前门（ACP）是第二类消费——直接挂 core ctx，不套 fetch。包名规则：host/、client/ 目录下 npm 名必含组前缀（`dsh-host-runtime`），目录名不重复前缀 → tsconfig.base.json 的 dsh-* 通配命不中，**这些包每包要显式 paths 条目**（加新包别忘）。

- **dsh-host-runtime 四文件**：`boot.ts` bootHost = core spine 逐个 await ctx.plugin（Timer/Llm/SessionStore/SystemPrompt/Tools/AgentRegistry/Tasks/AgentLoop/LlmDeepSeek/PersistenceJsonl/BashLocal 十一件；逐个 await 是为 load 失败在 boot 处确定性爆），返回 `{ctx, defaults, dispose}`；默认 provider `deepseek` / model `deepseek-v4-flash`。`api-proxy.ts` createApiProxy（见下）。`start.ts` startHost = bootHost→createApiProxy→toFetchHandler 一步收口，返回 `RunningHost{api, handler, defaults, ctx, dispose}`——dispose 用 `??=` 幂等；**ctx 是正式接缝**（前门插件挂载点+headless 事件订阅），纪律：消费型 client 不得经 ctx 绕开 api、壳不得 ctx.plugin 改装配。
- **stdout 纪律**：bootHost 装配零 stdout 写手（acp 前瞻）；打印是壳的事；将来给装配加任何日志输出必须走 StartHostOptions 可关。
- **createApiProxy 实现要点**：① 冷 session 隐式 resume 有在途去重表 `Map<SessionId, Promise<Agent>>`（`agentFor`，jsonrpc sessionCreations 先例）；② prompt 把 `request.rpcId` 塞进 `MessageSource{kind:'user', rpcId}` 透传进 user/message（provisional 转正预埋）；③ history 分页 `paginate`：从尾向前数 surface 消息（user/assistant/steering message 三型），组边界=`min(event.seq, ...sourceEventSeqs)`，绝不切断消息中段；④ 流用 `FrameQueue`（push/end/iterate，abort 即 end+cleanup disposers）；⑤ **纯推送帧每帧新 mint rpcId**（`frame()` helper），可应答帧的稳定 rpcId 属 pending 表（尚未实现）；⑥ **现状 stub**：respond 恒 `not-pending`、审批/问答帧不发、list 不 merge 冷 session（只列 live）、describe.version 占位 '0.0.1'——全有 TODO(step2) 标注，改这些先看 TODO。
- **dsh-host-webserver**：零 workspace 依赖（node:http + 结构 typing 收 `{fetch}`）。`startWebServer(options, onError)`：listen 失败 reject（壳决定退出）、listen 后 error 走 onError；`close()` = server.close + closeAllConnections（不强断 SSE 长连接 close 会挂死）、`??=` 幂等。**坑（bridge）**：客户端断线检测必须挂 `res.on('close')` 而非 req——Node16+ 起 IncomingMessage 'close' 在 body 消费完就触发（无 body 的 GET 立刻发），挂 req 会秒断所有 SSE；用 `res.writableEnded` 区分正常 end 与断线。静态服务 `static.ts`：403 穿越判定（resolve 后必须 distRoot 前缀）、未命中一律 SPA 回退 200 + index.html、MIME 六项外 octet-stream——step1 验收锁定语义，别顺手改。
- **apps/dsc 三文件**：bin.ts 只 loadEnv+粗分发（动态 import，两形态互不加载）；web.ts = startHost + require.resolve('@deepseek-ai/dsc-web/dist/index.html') 定位 dist（dist 知识属 dsc 不属 webserver）+ startWebServer + 打印 + SIGTERM→0/SIGINT→130（shutdown 先 server.close 后 host.dispose，exiting 门闩）；headless.ts = `new InProcessApiClient(host.handler)` 同构直调（协议第二真实消费者，wire/zod/SSE 全真跑），**先开 mux 后 prompt**（帧不丢；同进程无竞态也保持此序，换远程载体代码零改），turn 锚定=第一个 trigger.kind==='message' 的 turn/start（跳过启动注入 turn），completed→0 其余→1。
- **妥协台账要点（改码前查 design.md §⑨）**：-p 无 SIGINT 处理、-p 无 --resume、webserver onError 是回调形、新包零测试（GUI 期豁免）、apiproxy type-only 上游仍在 deps。全仓 rename 教训：一律走冻结窗口。

## 3. web 数据层（packages/client/web-runtime/src/）

**总架构**：`boot.ts bootWebRuntime` 是唯一装配点——选 api（`?fixture` → FixtureApiClient / real → WebApiClient，都是 AbstractApiClient 子类）→ `subscribeEnvelopes(ingestEnvelopeBatch)` 挂 RPC 台账 tap → bindIntents → initSessionManager → ConnectionController(sinks) 开泵。单向数据流：Controller（物理流+重连）→ sinks → Manager（业务分发）→ Session（per-session 状态）→ 快照 → React uSES。

- **api.ts 是契约转口单点**（F.9 台账兑现）：web-runtime 内所有契约 import 必须经它；**绝不 import apiproxy 包根**（会把 bootHost/cordis 拖进浏览器 bundle），只走 `/api`、`/client` 子路径。工具：`transportError()` 把传输异常折成 `{code:'internal'}` RpcResult、`resultOf()` 拆信封。
- **Session（session.ts）方法面**：操作 prompt/sendDraft/cancel/setDraft/open/loadOlder/resync；订阅 subscribe/getSnapshot；manager 专用 handleMuxEnvelope/handleRunning/handleRemoved/handleAgentError。实例**常驻不销毁**（拍板 2），draft 住对象（切 session 不丢稿）。`PAGE_MESSAGES=50`（F.4：转正时升 Config）。open 幂等（openPromise 单飞）；loadOlder 有**连续性断言**（older 尾 seq+1 必须==baseSeq，违反则丢页+hasMore=false fail-soft）；resync=清窗口重跑 open（重连=重建），pending 清空等 subscribed 基线重放。
- **缝合规则（§D.3）**：open 在途 live 事件进 liveBuffer；history 落地后按 seq>窗口尾 过滤合并（**seq 是唯一去重键**）；缝检测=subscribedLastSeq>窗口尾时再拉一次尾页。live append 时 seq≤tail 直接丢（重放重叠）。
- **Notifier（notifier.ts，Session/Manager 共用）**：markDirty 微任务合批；flush **先 rebuild 快照再通知**（uSES 要求 getSnapshot 恒返缓存引用，绝不在 getSnapshot 内计算）；**无 listener 时跳过 rebuild 只留 dirty**（帧风暴成本模型：非选中 session 零构建），读路径 ensureFresh 惰性补。改状态字段必须记得 markDirty，否则 UI 不刷新。
- **FoldAdapter（fold-adapter.ts）**：复用 core SurfaceManager（import 自 `@deepseek-ai/dsh-session/surface` 子路径 export——包根指 lib 需 build，vite 解析不了）。翻页窗口 seq 偏移用 **padding 哨兵**（`todo/write` 型伪事件填 0..baseSeq-1，非 surface-eligible 被安全跳过）；尾 append 复用同数组增量折叠，**prepend 必须 reset 重建**（哨兵数变了游标失效）。fold throw（跨窗 replace）→ degraded 线性扫描分支 + 快照 foldDegraded（F.3：降级收口在此文件一个分支函数）。节点缓存 Map<seq,node>（事件不可变故永不失效），nodes() 每次新数组但节点引用稳定（React.memo 边界）。
- **PartialAccumulator（partial.ts）**：assistant/chunk 六型折成 AssistantBlock[]，块级不可变（delta 只换该块引用）；usage/finish 返回 false 不通知；assistant/message 定稿到达即 partial=null（同批通知无闪烁）。ToolCallBlock 字段名坑：**块内是 `id`/`arguments`，事件是 `callId`/`arguments`**——conversation.ts `toAssistantBlock` 做映射，改物化代码按各自真名取。
- **SessionManager（manager.ts）**：模块单例（initSessionManager boot 专用/getSessionManager hooks 用，未 init throw）。get() 懒建不 auto-open；帧路由：**未实例化 session 的帧丢弃**（F.7，history 补齐），**唯一例外=审批/问答四帧进 pendingBuffers 缓存**（pending 不落 history 无法回填），实例化时原样重放。host 帧维护 summaries（added 就地插占位 updatedAt=Date.now()、removed 删条目但实例只标 removed、status 改 running 并转发）。handleConnected（每代连接含首连）=refreshList+全实例 resync。
- **ConnectionController（connection.ts）**：开两条流+泵；`describe` 成功即 onConnected、attempt 清零；任一流断 → 同代收敛 abort → 指数退避（500ms×2^n 上限 10s，半抖动）重连。**sink 异常隔离**（try/catch console.error，业务层坏不拖垮连接层）；stream/error 帧在泵层 break 触发重连，不下发业务层。
- **store.ts 红线**：zustand 只剩 rpcLog+ui 两切片——**业务对象（sessions/conversation）绝不进 store**；选中态是 SessionsScreen 容器局部 useState、草稿住 Session 对象。rpc-log.ts 是纯订阅者（批量映射台账行，环形 500 条上限；server-response 无 method 靠 inflightMethods 表回查）。
- **intents.ts**：仅剩 rpcLog 开关族 + refreshSessions/createSession 两个业务 intent（**intent 无导航副作用**——新建后选中是容器回调的事）。
- **fixture.ts**：假 server（AbstractApiClient 子类假载体），fx-alpha 60 turn 手造脚本可翻页；prompt 触发 chunk 回放；有常驻 pending approval（稳定 rpcId 重放语义）。改契约形状时 fixture 要同步。
- **改码红线（step-session design §F 台账预埋要求）**：F.1 视图态单一入口；F.2 tool 卡双态分发集中 ConversationView 一处；F.5 Session 不得直接碰 SurfaceManager（fold 只经 FoldAdapter）；F.6 Manager 是 Session 引用唯一持有者；F.7 丢帧分支显式注释可 grep；F.8 draft 读写只经 Session 两方法；F.10 PendingCardProps 预留 onRespond? 可选位；F.11 text 渲染收口 MessageText 单组件。

## 4. web UI 层（packages/client/web-ui/src/）

**三层结构（拍板 9 分界）**：hooks（逻辑面 React 出口）→ 容器（仅有的调 hook 层）→ 展示组件（纯 props 进回调出，可整目录替换）。**将来换 UI 库 = 只重写 components/，hooks 与 runtime 零改**——所以别在展示组件里堆逻辑。

- **hooks 两个**：`useSessionList`（manager.subscribe/getListSnapshot + createSession/refreshSessions intent 透传）、`useConversation(sessionId)`（session.subscribe/getSnapshot + setDraft/send/stop/loadOlder 句柄，useMemo 依赖 [session] 引用稳定）。uSES 合同：subscribe 用 useCallback 固定、getSnapshot 恒返缓存引用（对象层保证）。hook 里**不调 open()**——渲染路径无副作用（StrictMode 双调安全），open 由容器选中回调触发。
- **容器仅两个半**：`SessionsScreen`（选中态 selectedId 是它的**局部 useState**，非全局——多视图前瞻：分屏=多实例各持选中态；select 回调=setState+`manager.get(id).open()` fire-and-forget；两列布局 grid 也归它）+ `SessionListContainer`（create 后 ok 才 onSelect——新建即选中在容器组合，intent 无导航副作用）+ `ConversationContainer`（**key=sessionId 强制重挂载**——切 session 视图态重置，草稿不受影响因为住 Session 对象）。
- **ConversationView（骨架）要点**：纵三段 头行警条/滚动区/InputBar。滚动逻辑全在一个 useLayoutEffect：① open 完成滚底一次（openedRef 门闩）；② **翻页锚定**——点「加载更早」前记 {scrollHeight, scrollTop}，prepend 后（首 seq 变小检测）`scrollTop = t + (新高-旧高)` 补偿一次即清；③ 距底 ≤24px 时贴底跟随。节点分发 switch：assistant→AssistantMessage（key=seq）、tool-result→ToolCallCard（key=seq）、其余→MessageItem；然后 partial（streaming AssistantMessage）→ runningCalls（ToolCallCard key=callId，**与 result 卡 key 不同会 DOM 重建**，F.2 已预埋双态一体 props）→ pending（PendingCard key=rpcId）。
- **展示组件速查**：InputBar（Enter=queue 发送、Shift+Enter 换行；插话钮 idle 置灰是 **UI 教育语义**非 core 限制——core steer idle 时=send；停止钮仅 running 渲染）；AssistantMessage（memo；blocks 按 kind：text→MessageText、reasoning→折叠钮默认收起、tool-call→内联「调用工具 X」行、other→JsonBlock）；MessageItem（user/steering 右气泡+插话徽标、context/unknown 折叠 JsonBlock）；ToolCallCard（双态一体：result null=running 黄点/isError 红/ok 绿；argsRaw try JSON.parse 展示）；PendingCard（纯展示+onRespond? 预留）；JsonBlock（折叠 JSON，20k 字符截断，与 RPC 面板 PayloadJson 刻意独立）；MessageText（F.11 单点，Markdown 化只换它内部）。
- **SessionListView/Item**：View 持 30s tick 的 now state（相对时间基准，纯视图态例外允许）；Item memo 靠 entry 引用稳定；谱系缩进=`paddingLeft: 8 + depth*16`。formatRelative 在 utils/（<10s 刚刚 /<60s Ns 前 /<60min Nmin 前/否则 HH:MM:SS）。
- **接线**：index.tsx `mount(el)`；App = SessionsScreen + RpcLog 浮层（开发观测器保留）；`use-web.ts useWeb(selector)` 是 zustand store 的唯一订阅入口（只剩 RpcLog 用）。
- **改 UI 注意**：展示组件允许的内建 state 仅限纯视图态（折叠开合/滚动 ref/tick）；组件文案中文（产品语言），代码注释英文。

## 5. 验收体系（scripts/verify-*.mjs）

**模式（我将来交码照此自验）**：playwright chromium headless 直连 `DSC_WEB_URL`（默认 `http://127.0.0.1:3080`），逐条 `report(name, pass, detail)` 打 PASS/FAIL，尾行 ALL PASS / N FAILURE(S)，退出码 0/1。**不进任何门禁体系**，手动跑。前置三件：`dsc web` 已起（`pnpm run demo:web`）、`pnpm --filter @deepseek-ai/dsc-web build` 出的 dist 是新的、playwright chromium 已装。

- **verify-session.mjs**（fixture 级，`?fixture` 免 key）：对照 step-session design §E.1 清单——列表 3 条/running 点/谱系缩进 24px、打开渲全节点型、翻页锚定（drift<4px 断言）、发送/草稿清空/partial 脉冲/定稿切换、steer 可用性与 idle 置灰、停止+中断标记、切换即时呈现（<1.5s 断言常驻实例）、新建即选中、RPC 面板见流量互证。
- **verify-session-real.mjs**（真 host 级，需 DEEPSEEK_API_KEY）：E2 浓缩版 + **连接稳定性哨兵**——12s 窗口 /api 请求 ≤10 且零 requestfailed（专抓 2026-07-20 修过的 bridge req'close' 300ms 重连风暴一类 bug；fixture 不走真 SSE 掩盖不了）。真 prompt 要求约 100 字回复（太短会在 waitForSelector 轮询缝隙内完成，pulse 断言假失败——写真模型断言时注意）。
- **verify-rpclog-panel.mjs**：RPC 面板 §D 清单（角标未读、三象限方向符 ↑↓⇟、展开清未读等）。
- **选择器风格**：`[class*="item"]` 模糊匹配 CSS Modules 哈希类名 + hasText 中文文案锚定——改组件类名/文案会连带脚本，交码前跑一遍。

## 6. 家规速记

**三条纪律（主会话点名）**：① 代码注释英文且少写——只留契约/防坑，不narrate控制流（中文只出现在文档与产品文案）；② **store 无业务对象红线**——zustand 只承载跨视图全局展示态（现仅 rpcLog+ui），sessions/conversation 数据走对象层+uSES；③ **逻辑面/展示面分离**——组件将来整体重做，逻辑一律进 hooks/runtime 对象层，展示组件纯 props。

**web-styling.md 要点（docs/web-styling.md，活文档）**：
- token 全住 `web-ui/src/style/global.css`（`:root` 亮色 + `[data-theme='dark']` 覆盖）；**组件 CSS 只引 token，出现字面量色值即打回**；组件禁写 `[data-theme]` 选择器（要用变量桥）。
- 新 token 先进 §1 表（含暗色占位列）再用；偏离 §2 基线常数须记 §5 偏离表。
- 类名 camelCase + clsx；对外组件透传 className；禁 `composes`；`:global` 只穿透第三方。
- 过渡一律 `var(--dur*) var(--ease)`，只过渡 opacity/transform/背景色/阴影；hover 展示型包 `@media (hover: hover)`。
- 滚动容器统一挂 `.scrollable` 工具类，组件内禁写 `::-webkit-scrollbar`。
- 字号不 token 化：px 且**成对写行高**（16/24 气泡、14/22 默认、12/18 辅助）；间距 4 倍数。文字灰阶只用 primary/secondary/tertiary 三级。
- 动态样式 JS 侧只写 CSS 变量（`style={{'--x':v}}`），规则留 CSS。
- 视觉基线：**仅用户侧有气泡**（--bubble-bg 圆角 --radius-bubble），助手侧纯文档流；侧边栏 260px；会话列 max-width 840px（<1024px 降 712px）；`--font-mono` 末位不放 monospace（防 Windows 中文回退宋体）。
- memory 既有纪律：dev 监听 0.0.0.0（远程容器）、GUI 期跳过仓库门禁（测试/覆盖率不做）、截图进 ignore 目录、playwright 自验不留人手验。

## 7. 代码与设计文档不一致处（只报告不改）

1. **契约帧 id 字段名（apiproxy design.md §3.3 vs api/events.ts）**：design §3.3 帧 union 写 `approval/requested.id: ApprovalRequestId`、`question/requested.id: RpcId`、`question/resolved.id: RpcId`；实际代码为 `approvalId`、question/requested **无 payload id**（信封 rpcId 即标识，与 §3.4「payload 不含资源 id」一致）、`question/resolved.questionRpcId`。§3.3 与 §3.4/代码内部不一致，属设计文档未回刷。
2. **createApiClient 旧名残留**：出口已是 `AbstractApiClient`/`InProcessApiClient`/`IApiClient`（2026-07-20 shape-a+abstract-base 裁决，commit 893421d50）。apiproxy design.md 工作树已有在途回刷（新增 §4.1 AbstractApiClient 体系、§5 图改 WebApiClient，未 commit），但其正文仍残留 5 处旧名（§1 布局树 `client.ts ← createApiClient`、依赖图、§0 map 遍历句、§3.4 respond 入口句、§5 超时注记）；hostruntime design §⑥ 代码样例/验收 #4 也仍写 `createApiClient(host.handler.fetch)`（实际 headless.ts 是 `new InProcessApiClient(host.handler)`）。
3. **apiproxy design.md §1 布局仍含 impl/**：树里还画着 `impl/`（boot harness core），已随 hostruntime 拆包迁出（拆包 design §③ 有记录，但 apiproxy design 正文未同步）。
4. **mux/host 流的 request payload 上不了 wire**：契约签名 `events.mux(request: RpcRequest<{since?}>, signal)`，但 fetch 载体是纯 GET——client 侧 openMux 直接忽略 payload（`_payload`），handler 侧自 mint rpcId + `{}` 调 impl。`since` 除「v1 不实现」外，载体层面也无通道；将来实现续传需先给载体定 payload 承载方式（query 或 POST 升级）。
5. **manager 的 pendingBuffers 超出设计**：step-session design §A.3 路由表写「未实例化的 session 丢帧（不懒建）」无例外；实际 manager.ts 给审批/问答四帧加了 pendingBuffers 缓存重放（自注为 F.7 exception，理由充分——pending 不落 history 无法回填），设计文档未回刷此例外。
6. **padding 哨兵类型**：design §A.5 写 `type:'noop/padding'`；实际 fold-adapter.ts 用真实非 surface-eligible 类型 `todo/write`（`data:{todos:[]}`）。语义同（都被 surfaceOpOf 跳过），字面不一致。
7. **impl 仍是 minimal-first stub（与契约有落差、有 TODO 标注，非漂移但改码必知）**：respond 恒 not-pending、审批/问答 requested/resolved 帧不发（pending registry 未建）、list 只列 live session 不 merge 持久化目录、describe.version 占位 '0.0.1'、subscribed 基线重放未实现。web 侧 PendingCard/pendingBuffers 是为它就位的空等。
8. **细节级**：design §C.2 sessionId 截断「头 8 字符」实际 12；选中底色 design 写 `--color-accent-soft` 而 token 表是 `--accent-item`。
