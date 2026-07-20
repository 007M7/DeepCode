# P1-5 审批 respond 设计页（设计先行零代码）

**Owner**: feature-session（冷启动重生第二代，2026-07-21 02:09 接续）。
**状态**: **design.md 完稿（02:2x），停等用户 review**。零代码。

## 任务理解

用户亲拍口径（progress.md 〇-pre 第二批亲答 2）：**respond UI = 基础挡**——

- PendingCard 上 allow/deny/选项按钮作答 → 答后变已决态；
- 被别端抢答时收 resolved 帧自动收敛并标「已由其他端处理」；
- 不做倒计时/批量答/快捷键；
- 多 client 先到先赢是既定 wire 语义（host 侧裁决，后到者收 already-resolved / not-pending）。

## design.md 覆盖面（团队下发）

1. **host pending registry 形态**：谁持有、生命周期、与 agent-loop 审批 seam 的衔接（先摸现有审批帧机制：apiproxy 四象限里的审批帧先例、POST /api/respond 路由）。
2. **wire answerer 路径**：rpcId 纪律（发起方 mint、应答方回填）。
3. **subscribed 重放衔接**：重放时 pending 卡怎么恢复/已决卡怎么呈现；conventions 18 纯呈现层原则——呈现物不进 session log。
4. **PendingCard 作答 UI 状态机**：pending → answering → resolved/superseded。
5. **先到先赢并发裁决点**：host 侧裁决，后到者收 already-resolved。

体裁：一页纸密度；不做清单按妥协台账三段式【触发条件→返工点→预埋要求】（conventions 12）。

## 摸底断点（挂了从这接）

已读完：

- `packages/host/apiproxy/src/api/rpc.ts` —— 四象限模型全貌：ClientRequest/ServerResponse/ServerRequest/ClientResponse；**answerable server-request 用 stable rpcId（重放复用）**，纯 push 每次新 mint；RpcReceipt 载体层回执 `{accepted:false, reason:'not-pending'|'bad-response'}` —— 先到先赢的 wire 语义已存在。
- `packages/host/apiproxy/src/api/approvals.ts` + `.schema.ts` —— ApprovalResponsePayload = {sessionId, approvalId, outcome:'allowed-once'|'rejected'}（cancelled/unavailable 是 host 侧 outcome，client 不可发）；approvalId 是 core 审计关联，wire 关联靠 echoed rpcId。
- `packages/host/apiproxy/src/api/questions.schema.ts` —— QuestionResponsePayload = {sessionId, answer:AskUserQuestionAnswer}；question 标识就是 echoed rpcId，payload 不带资源 id。
- `packages/host/apiproxy/src/fetch/handler.ts` —— POST /api/respond 路由已在：clientResponseSchema 解析 → `api.respond(parsed.data)` → RpcReceipt；解析失败回 `{accepted:false, reason:'bad-response'}`。
- `packages/host/apiproxy/src/api/rpc-map.ts` + `api/index.ts` —— respond 不在 RpcMethodMap（它是 client-response 不是 unary method）；ApiProxy 根接口已有 `respond(message): Promise<RpcReceipt>`。

**结论（阶段性）**：wire 契约层（四象限/respond 路由/approval+question payload schema）已齐备，缺的是 host 侧 **pending registry 实现**（api.respond 的真身：pending 表、超时/取消收敛、resolved 帧广播）与 client 侧 **PendingCard 作答 UI**。

批2已摸（host 侧全清）：

- `packages/host/runtime/src/api-proxy.ts` —— **respond 是 stub**（`{accepted:false, reason:'not-pending'}`，行 421-424 TODO(step2) 注明「approval/question pending registry (wire answerer + proxy provider)」）；`frame()` 只 mint 纯 push 的新 rpcId，注释明说 stable id 归 pending registry 管（本版缺席）；mux() 用 FrameQueue+ctx.on 收帧，open 时只发 session/subscribed，**不重放 pending**（events.ts 契约却已承诺重放——契约先行实现缺席）。
- `packages/host/apiproxy/src/api/events.ts` —— MuxFrame 审批四帧型**已定义**：approval/requested{sessionId,approvalId,toolName,callId?,reason?}、approval/resolved{sessionId,approvalId,outcome:ApprovalOutcome}、question/requested{sessionId,questions}、question/resolved{sessionId,questionRpcId,outcome:'answered'|'cancelled'}。EventsApi.mux JSDoc 已承诺：open 时重放 still-pending requested 帧、**rpcId 逐字复用**（refresh-recovery baseline）。question 帧不带资源 id——标识就是 rpcId。
- `packages/ui/user-approval/src/index.ts` —— ApprovalService.request()：mint ApprovalRequestId → append approval/asked → `ctx.waterfall('approval/request', req, next)` 等答 → append approval/decided。**答题者=waterfall 监听器**（scope-filtered，claim 或 next() 放行，fail-closed 'unavailable'）；outcome 四值 allowed-once/rejected/cancelled/unavailable（client 只可发前两个）；signal abort → 'cancelled' 且晚到答案丢弃。要求 open turn（audit 对必须被 turn 包住）。
- `packages/ui/user-interaction/src/index.ts` —— UserInteractionService：registerProvider(单例，effect 化 disposer)+ask()；provider 抛错/无 provider 抛 UserInteractionError。
- `packages/ui/acp/src/index.ts` —— **双先例齐**：`ctx.on('approval/request', (req,next)=>{...})` 只答自己 own 的 agent、无 callId 就 next() 放行；`userInteraction.registerProvider({ask})` 逐题问、cancel 抛 ASK_CANCELLED。

批3已摸（client 侧+装配全清）：

- `events.schema.ts` —— 审批四帧 zod schema 已齐（requested/resolved 双域）。
- `web-runtime/session/session.ts` —— handleMuxEnvelope 已处理四帧：requested 存 `pending` Map（key `a:${rpcId}`/`q:${rpcId}`，PendingInteraction 进 snapshot.pending）；**resolved 现状=直接 delete**（无「已决态」过渡）；resync() 清 pending 等 baseline 重放（注释明说语义）。approval resolved 按 approvalId 匹配、question resolved 按 questionRpcId 匹配。
- `web-runtime/session/manager.ts` —— 未实例化 session 的审批帧进 pendingBuffers（cap 有界），实例化时按 rpcId verbatim 重放；session removed 时清 buffer。
- `web-ui PendingCard.tsx` —— 纯展示占位卡（approval 显 toolName+reason；question 显题数+JSON），**onRespond? 已预留未接**；ConversationView 尾部 `snapshot.pending.map(...)` 渲染。
- `AbstractApiClient`（fetch/client.ts）—— `respond(message, signal?)` **已实现**（POST /api/respond→RpcReceipt）；IApiClient 面已含；web-api-client/fixture 均已 override（fixture=永远 not-pending，注释「v1 UI never answers」）。
- Session 对象持有 `this.api: IApiClient`（prompt/cancel 同路径）——client respond 入口顺理成章挂 Session 方法。
- **装配缺口（关键）**：`bootHost`（host/runtime/src/boot.ts）**没挂 ApprovalService / UserInteractionService**——core tools serviceAsk() 用 `ctx.get('approval')`，缺席即降级 deny('not yet supported')。web host 现在工具 ask 一律自动拒。
- 答题者先例双份：ACP `ctx.on('approval/request',(req,next))`（own-agent 过滤、无 callId next() 放行、cancelled 映射）+ `userInteraction.registerProvider({ask})`（单例 DUPLICATE_PROVIDER fail-loud；TUI 也注册一份——web host 无 TUI 不冲突）。
- ApprovalService.request()：open turn 强制（audit 对 turn 包裹）、signal abort→cancelled 且晚到答案丢弃、waterfall fail-closed unavailable。approval/asked+decided 是 log-only audit 事件（非 surface）——已决历史在 log 里可溯，但 fold 不出卡。

## 产物

- `design.md` —— **完稿**（02:3x 按 team-lead review 增补 §0）。一页纸：**§0 现状警示（3080 web host 工具审批默认全拒——bootHost 缺挂载的既成事实）**/ 总链路图 / host 三件（pending registry 形态+生命周期、答题者+provider、bootHost 挂载=§0 修复刀，行为变化+无超时口径+policy Config 写明）/ wire 面（零新帧型，先到先赢=registry 同步查删）/ client 状态机（pending→answering→settled(self|peer|cancelled)）/ 分刀 0-4（0=已批的契约前置小刀）/ 不做清单六条三段式。
- 设计中发现并按 conventions 5 报审的契约缺口一处：waterfall ApprovalRequest 不带 ApprovalRequestId——**A 案已批**（arch-carrier 以契约 owner 身份批准，评审档 D 节 6d53c9a5e）：ApprovalRequest 加 readonly id，答题者直读 req.id；已入分刀计划第 0 刀（user-approval 属地前置小刀）；B 案 backscan 备胎作废不落地。
- **契约评审全程闭环**（arch-carrier，tasks/20260721-0239-respond-contract-review/review.md；终稿核验 9ce1b0b3a 通过，无遗留意见）：方向放行；R1（裁决顺序=查→校验→删，坏答案不烧先到权）、R2（answering 收 resolved 帧先记 peer、receipt 到翻 self——SSE/HTTP 到达序 client 自持）、N1（ask 双源措辞）、N2（拒绝审批是 ok:true 业务值非 error）四条已全部落进 design.md；实施防漏点（attach dispose 并入 mux disposers）已写进 §2.1。
- **实施窗口交接注记**（owner 批准≠用户放行，分刀全部待用户确认）：第 0 刀落地时叫 arch-carrier 按 conventions 5 复核契约面；host 刀（respond 真身+registry+createApiProxy 升 class）动 arch-carrier 属地，届时对齐。
