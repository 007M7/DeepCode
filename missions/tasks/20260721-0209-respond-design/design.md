# P1-5 审批 respond 设计页（feature-session，2026-07-21）

> 口径（用户亲拍）：**基础挡**——PendingCard 上 allow/deny/选项按钮作答→答后变已决态；被别端抢答收 resolved 帧收敛标「已由其他端处理」；无倒计时/批量答/快捷键；多 client 先到先赢是既定 wire 语义。
> 现状一句话：wire 契约全齐（四象限/审批四帧型/ApprovalResponsePayload/QuestionResponsePayload/RpcReceipt/POST /api/respond 路由/AbstractApiClient.respond），client pending Map+重放缓冲全齐；**缺的是 host 三件**——api-proxy.ts 的 respond stub 真身（pending registry）、approval 答题者+question provider、bootHost 挂 ApprovalService/UserInteractionService——**加 client 作答 UI 状态机**。

## 0. 现状警示（先于设计的既成事实，用户第一眼）

**当前 3080 常驻 web host 上，工具审批默认全拒。** bootHost 从未挂载 ApprovalService/UserInteractionService；core tools 的 serviceAsk 用 `ctx.get('approval')` 兜空，缺席即降级 `deny('requires approval (not yet supported)')`——任何被 hook/policy 判为 ask 的工具调用，web 会话里都被静默拒绝（模型收到 deny 理由，用户端无任何提示卡）。ask_user_question 工具同理：无 provider 时抛 NO_PROVIDER，工具报错。这不是本设计引入的行为，是 web host 出生至今的现状；本设计的 §2.3 挂载是对它的修复。

## 1. 总链路（approval 为例；question 同构）

```
core tools serviceAsk ─→ ApprovalService.request()
  ├ append approval/asked（audit，随 session/event 帧自然下发）
  └ waterfall 'approval/request' ─→ 【web 答题者】（新）
       ├ registry.create(kind:'approval')：mint 稳定 rpcId + 建 pending 条目
       ├ 向所有在开 mux 流广播 approval/requested 帧（stable rpcId）
       └ 返回 Promise，等三出口之一：
           ①respond 命中 → outcome        ②req.signal abort → 清条目+广播 resolved(cancelled)
           ③（无第三出口：基础挡无超时）
client 收帧 → session.pending 卡 → 用户点【允许/拒绝】
  → Session.respondApproval(rpcId, outcome) → POST /api/respond（ClientResponse 回填 rpcId）
host respond()：rpcId 查 pending 表（**只查不删**）
  → 二次 parse payload（按条目 kind 选 schema）+ sessionId/approvalId 校验
  → 【先到先赢裁决点】全过后才同步删条目+settle waterfall Promise
    （lookup→delete 间无 await，单线程下无竞态窗口；坏答案在删除前就被拒，不烧先到权）
  → 广播 approval/resolved 帧（全端收敛）→ 回执 {accepted:true}
  晚到者：表无此 rpcId → {accepted:false, reason:'not-pending'}（wire 语义已定义）
ApprovalService 收 outcome → append approval/decided → serviceAsk 放行/拒绝工具
```

## 2. Host 侧

### 2.1 pending registry（respond stub 真身）

- **谁持有**：`createApiProxy` 本里程碑顺势升 class（台账 R7 绑定时机）——`ApiProxyImpl` 持 `PendingInteractionRegistry` 字段（新文件 `host/runtime/src/pending-registry.ts`）。registry 是 host 内存态纯呈现层控制面，**不持久化**（pending 生命周期 ⊆ turn 生命周期，turn 本就不跨 host 重启——非妥协，是边界事实）。
- **条目形态**：`{ rpcId(稳定), sessionId, kind:'approval'|'question', 帧 payload 快照（重放用）, settle(outcome/answer), onAbort disposer }`。approval 另存 approvalId（收敛帧+payload 校验用）；question 的标识就是 rpcId（契约如此，payload 不带资源 id）。
- **生命周期**：create（答题者/provider 进入时）→ settle（respond 命中，先到先赢）或 abort（req.signal：ApprovalService 已定「晚到答案丢弃」，registry 同步清条目+广播 resolved(cancelled)/question/resolved(cancelled)）。settle/abort 后条目即删——**registry 里没有已决态**，已决是 client 呈现概念。
- **resolved 帧由 registry 在 settle/abort 点广播**（不从 approval/decided audit 事件派生）：question 在 session log 里没有 audit 事件可派生，approval 若走派生就两套来源不对称；统一 registry 一个 owner。decided audit 照旧由 ApprovalService append，是持久真相；resolved 帧是瞬时收敛信号（conventions 18：呈现物不进 log）。
- **mux 衔接**：mux() open 时在现有 subscribed 基线后，向该流重放 registry 全部未决条目的 requested 帧（**rpcId 逐字复用**——EventsApi 契约已承诺，fixture 已同语义）；registry 暴露 `attach(push): {replayed, dispose}`，live 广播推给所有已 attach 的流队列。**attach 的 dispose 必须并入 mux() 现有 disposers 数组**（与 ctx.on 三件同清理点），否则断流后 registry 泄漏死 push 目标。

### 2.2 答题者 + provider（ACP/TUI 双先例照抄裁剪）

- `ctx.on('approval/request', (req, next))`：web host 是唯一 UI，**总是 claim 不 next()**（单 UI 立场；与 ACP 共存的排序/scope 问题见不做清单）。无客户端连接也照样挂起等（重放兜底晚连的端）——与 TUI 无人在场同语义。
- `userInteraction.registerProvider({ask})`：单例 fail-loud（DUPLICATE_PROVIDER）；web host 无 TUI 不冲突。多题整卡一次下发（帧契约 questions[] 本就整包）。abort 走 ASK_CANCELLED（ACP 同码）。
- **approvalId 传递（契约缺口④，A 案已批）**：waterfall 的 ApprovalRequest 原不带 ApprovalRequestId（Service mint 后只进 audit 事件）。契约 owner（arch-carrier，评审档 D 节）已批 **A 案**：ApprovalRequest 加 `readonly id: ApprovalRequestId`，派发处透传，答题者直接读 `req.id`。wire 帧的 approvalId 本就在 MuxFrame（帧型零变更）；id 已随 approval/asked 进 log（Model-visible⟺logged 平凡通过）；ACP 无感。新字段 JSDoc 写明「与 approval/asked 事件携带的是同一 id」，指 audit 事件为源（one home）。（备胎 B 案=答题者尾扫 events 按 callId 消歧，已无必要，不落地。）

### 2.3 bootHost 挂载（§0 现状的修复刀）

`ctx.plugin(ApprovalService, {})` + `ctx.plugin(UserInteractionService)`；host/runtime package.json 补两依赖。

- **行为变化**：挂载后被判 ask 的工具调用从「静默 deny」变「挂起出 pending 卡等作答」；ask_user_question 从 NO_PROVIDER 报错变真问。放行/拒绝走用户按钮；turn 被 cancel 时 req.signal abort→cancelled，工具收 deny（既有映射）。
- **approval policy 走 ApprovalService 既有 Config**（`policy: 'ask'|'never'`，schemastery 校验，cordis.yml 可改）：'ask'=真问（web host 默认），'never'=确定性全拒（CI/无人值守立场）——**无人值守部署的「不想挂起」诉求用 policy:'never' 表达，不引入超时值**。
- **无人作答=无限挂起（基础挡无超时，这是拍定口径不是遗漏）**：与 TUI 无人在场同语义；晚连的 client 靠重放接手，唯一出口是作答或 turn 取消。将来若加超时自动决，deadline **必须是验证过的 Config 字段**（仓库规矩：deployment-varying tunable 不许 hardcode，`DEFAULT_*` 常量不算配置化）——预埋见不做清单。

## 3. Wire 面（全部沿用既有契约，零新帧型零新错误码）

- rpcId 纪律：requested 帧=host 发起的 server-request，registry mint 稳定 id（api-proxy `frame()` 注释预留的正是这个位置）；client 应答=ClientResponse **回填**，永不 mint（conventions 15）。
- /api/respond 两级 parse：载体层 clientResponseSchema（已在）→ registry 按 rpcId 路由到条目 → 按条目 kind 选 approvalResponsePayloadSchema / questionResponsePayloadSchema 二次 parse（schema 文件注释预告的正是「after routing via the pending table」）。payload 与条目 sessionId/approvalId 不符或 parse 失败 → `{accepted:false, reason:'bad-response'}` **且不烧条目**——**条目删除推迟到校验全过之后**（先删后 parse 会让坏答案烧掉先到权，见 §1 链路顺序）。`result.ok:false` 的应答同 bad-response 处理（**拒绝审批不是 error**：它是 `ok:true` + outcome:'rejected' 的正常业务值；error 分支只表示应答本身坏掉）。
- **先到先赢裁决点=registry 校验全过后的同步删**（lookup→delete 无 await，Node 单线程无竞态窗口）；裁决后顺序：广播 resolved → settle waterfall → 回执。晚到 respond 收 not-pending（RpcReceipt 既有语义，client 据此转「已由其他端处理」等待/确认 resolved 帧）。

## 4. Client 侧

### 4.1 PendingInteraction 状态机（放 Session 对象，非组件 state——wire 驱动事实进逻辑面，红线 14/16）

```
pending ──点按钮，respond 在途──→ answering
answering ──收 resolved 帧──→ settled(暂记 peer)   ★自答成功的常态路径：SSE 帧先于
   │                            POST receipt 到达（帧不带答题者身份，先按 peer 显示）
   │                            └─随后 receipt accepted 到→ 修正 settledBy='self' 翻正文案
answering ──receipt accepted 先到──→ settled(self, 所选 outcome) 「已允许/已拒绝」
answering ──receipt not-pending──→ 维持/转 settled(peer)（resolved 帧常已在途或已处理）
answering ──transport error──→ 回 pending + 卡上错误条（可重试）
pending ──收 resolved 帧──→ settled(peer)                       「已由其他端处理·<outcome>」
任意态 ──resolved(cancelled) 帧──→ settled(cancelled)            「已取消」
任意态 ──resync──→ 条目清空；baseline 重放只带回仍 pending 的
```

实现：PendingInteraction 加 `state: 'pending'|'answering'|'settled'` + `settledBy: 'self'|'peer'|'cancelled'` + outcome；session.ts 现有「resolved 即删」改为「标 settled 保留显示」（settled 卡随窗口活到 resync——刷新后不复现，见 §4.3）。**到达序自持**：SSE 与 HTTP 的相对到达序本就不可控，host 不为此调整广播顺序——client 状态机自己吸收乱序（answering 收帧先记 peer、receipt 到再翻 self 是唯一需要的修正转移；receipt 与帧两者各自幂等）。已 settled 条目再收帧=只允许 peer→self 的翻正，其余 no-op；再点按钮=no-op。

### 4.2 作答入口与 UI

- Session 新方法 `respondApproval(rpcId, 'allowed-once'|'rejected')`、`respondQuestion(rpcId, answer)`：走 `this.api.respond`（与 prompt/cancel 同路径，AbstractApiClient.respond 已在）。fixture 的 respond 从「永远 not-pending」升级为可脚本化裁决（含抢答剧本），供 jsdom/playwright 验收。
- PendingCard（onRespond 预留位兑现，纯 props 组件）：approval=【允许】【拒绝】两钮；question=逐题渲染 options 按钮（multiSelect 可勾选）+ 无 options 题给文本框 + 整卡一个【提交】（custom 文本=AskUserQuestionAnswerItem.custom 既有槽位）。answering 态禁钮加转圈；settled 态换状态 chip 文案。

### 4.3 重放/已决呈现原则（conventions 18）

pending 卡恢复=靠 subscribed 基线后的 requested 帧重放（rpcId 逐字，client 现有 resync 清 pending 等重放的语义不动，manager pendingBuffers 不动）。**已决卡不恢复**：resolved 是瞬时呈现态，刷新即无；approval 的持久痕迹是 log 里的 asked/decided audit 对（log-only 非 surface，fold 不出卡——历史里看不见是 documented default）。

## 5. 分刀计划（**全部待用户确认放行**——契约 owner 批准只解决④的方案取向，不构成实施放行）

0. 契约前置小刀（user-approval 属地，契约 owner 已批方案）：ApprovalRequest 加 `readonly id` + request() 派发处透传（两行+JSDoc，指 approval/asked 为 id 之源）。落地时叫 arch-carrier 按 conventions 5 复核契约面。
1. host 刀：bootHost 挂载 + pending-registry.ts + 答题者（读 req.id）/provider + respond 真身 + mux 重放 +（顺势）createApiProxy 升 class。
2. client 刀：PendingInteraction 状态机 + Session 两方法 + fixture respond 可脚本化。
3. UI 刀：PendingCard 作答形态 + ConversationView 回调接线。
4. 验收：playwright 真 host 级过「问→答→放行」「双端抢答收敛」「刷新重放恢复 pending」三清单（conventions 6：fixture 全绿不算完）；每 bug 钉防回归断言。

## 6. 不做清单（三段式：触发条件→返工点→预埋要求）

| 不做 | 触发条件 | 返工点 | 预埋要求 |
|---|---|---|---|
| 已决卡进历史/刷新后可见 | 用户提出刷新后要看到审批记录（审计视图诉求） | fold-adapter 加 approval/asked+decided 折卡 case（question 需先补 audit 事件——更大刀） | audit 对已在 log，approval 零 wire 改动；question 留意「无 log 痕迹」这一深坑 |
| allow-always/授权存储 | 用户要求「总是允许」按钮 | ApprovalOutcome closed union 扩词 + grant 存储设计（ACP note 同样 defer） | outcome switch 全部走 assertNever，扩词编译期全暴露 |
| 倒计时/超时自动决 | 无人值守部署里 turn 长期卡在 ask 且 policy:'never' 全拒不满足（要「等一会再拒」） | registry 条目加 deadline timer→走既有 abort 出口 | abort 路径（清条目+resolved(cancelled) 广播）就是超时的复用出口，勿短路；deadline 必须是验证过的 Config 字段（no-hardcoded-tunables），不许 DEFAULT_* 常量 |
| 批量答/快捷键 | 一 turn 多 ask 刷屏、用户抱怨逐个点 | PendingCard 区加批量操作条+键位层 | respond 按 rpcId 幂等逐发，批量=循环调用零 wire 改动 |
| question 分步向导（现=整卡单提交） | 题目间有依赖或单卡题量过大 | PendingCard question 表单改分步组件 | answers[] 本就按题分粒度，wire 不动 |
| 与 ACP/TUI 答题者共存排序 | web host 同进程再挂第二个 UI（如 ACP 桥接） | web 答题者从「总是 claim」改 own-session 过滤+next() 放行（ACP 先例现成） | 单 UI 假设只写在答题者一处注释，不扩散 |
