# respond 设计页契约 owner 评审（apiproxy/host-runtime owner：arch-carrier）

- **时间**：2026-07-21 02:39
- **对象**：missions/tasks/20260721-0209-respond-design/design.md（321db5707）
- **评审面**：A=pending registry 与 createApiProxy 升 class 兼容性；B=wire answerer 四象限/rpcId 纪律与 /api/respond 先例；C=重放衔接与 EventsApi still-pending 承诺。零改码；本评审给用户 review 减负，不替用户拍板实施。
- **总评**：**方向放行**。三评审面全过；提 2 处设计文档要改（R1 自相矛盾、R2 状态机缺一条转移——都是文档级修订，零契约改动），2 nit。改完即可进用户 review 清单。

## 要改（feature-session 修订设计页）

### R1. §1 与 §3 裁决点顺序自相矛盾：「命中即删」vs「parse 失败不烧条目」

§1 链路图写「rpcId 查 pending 表 →【先到先赢裁决点】命中即删条目 → 二次 parse payload → settle」；§3 写「payload 与条目 sessionId/approvalId 不符或 parse 失败 → bad-response **且不烧条目**」。两者冲突：若按 §1 先删后 parse，坏答案已经烧掉了先到权。正确顺序应为 **查（不删）→ 二次 parse + sessionId/approvalId 校验 → 全过后同步删条目+settle**——lookup 到 delete 之间无 await，Node 单线程下仍无竞态窗口，§3 的先到先赢语义不受损。请把 §1 链路图改成这个顺序，并在 §3 点一句「删除推迟到校验全过，同步块内无竞态」。

### R2. §4.1 状态机缺 answering 态收 resolved 帧的转移，且 §3 的广播顺序使该竞态成为**常态路径**

§3 裁决后顺序=「广播 resolved → settle → 回执」：自答成功时，resolved 帧走 SSE、receipt 走 POST 响应，**帧先于回执到达是常态而非边角**。状态机表只定义了 `pending ──收 resolved 帧──→ resolved(peer/superseded)`；answering 态收帧未定义——按现表最近似的落法会把自答误标「已由其他端处理」（帧不携带答题者身份，client 无法即时区分 self/peer）。建议补一条显式转移：`answering ──收 resolved 帧──→ settled(出处暂记 peer)，随后 receipt accepted 到达 → 修正 settledBy='self'（文案从「已由其他端处理」翻正为「已允许/已拒绝」）；receipt not-pending → 维持 peer`。已 settled 幂等条款照旧兜底。（不建议靠调整 host 侧广播顺序解决——SSE 与 HTTP 响应的到达序本就不可控，client 状态机必须自持。）

## Nit（不阻塞，顺手修）

- **N1** §2.2 B 案前提句「现状所有 ask 都出自 serviceAsk」不准：`approval.request()` 调用方有二——core tools serviceAsk（tools/index.ts:1003，`callId: exec.callId` 必带）与 sandbox escalation（escalation.ts:176，同样必带 callId）。**结论不变**（两源都带 callId，backscan 消歧安全；且 gate-ask 与 escalation-ask 虽可同 callId，但时序上前者必已配对 decided 才轮到后者，「最新未配对」不会错配），建议措辞改「现状两处 ask 源均必带 callId」并把这条论证收进答题者函数注释。
- **N2** §3「result.ok:false 的应答同 bad-response 处理」建议补半句理由：client 合法作答（拒绝审批）走 `ok:true + outcome:'rejected'`，`ok:false` 只能是协议异常——防实施者误把「拒绝」实现成 error 分支。

## 三评审面核验（留档）

### A. pending registry ↔ createApiProxy 升 class：**兼容，同刀可落**

- §2.1「ApiProxyImpl 持 PendingInteractionRegistry 字段 + 新文件 host/runtime/src/pending-registry.ts」与 OOP 清查 #1（20260721-0210-oop-debt）的预测形态**逐字吻合**——「respond 落地还要加 pending registry，状态只会更多」正是升 class 的动因，同刀落地互为顺势，无冲突。
- 升 class 时的既定保留项（paginate/viewFor/backscanArgs/summarize* 纯函数、FrameQueue 独立类）与 registry 无交集；registry 的 `attach(push): {replayed, dispose}` 接进 mux() 现有 disposers 数组即可（实施时 dispose 必须并入，否则断流泄漏 push 目标——设计已提 dispose，此处点名防漏）。
- registry 不持久化的边界论证成立：pending ⊆ 开 turn ⊆ running agent ⊆ attached，host 重启即全灭，与「非妥协是边界事实」的说法一致。

### B. wire answerer 四象限纪律：**全守，零新帧型零新错误码属实**

| 项 | 核验 |
|---|---|
| stable rpcId | requested 帧=server-request，registry mint 稳定 id——rpc.ts:87 注释「stable rpcId, reused on replay」与 api-proxy.ts frame() 注释预留位说的正是这个位置 ✓ |
| 回填纪律 | ClientResponse 回填 rpcId 永不 mint（rpc.ts:98「echoed, never minted anew」）；client 侧走 AbstractApiClient.respond 既有路径 ✓ |
| 两级 parse | 载体层 clientResponseSchema（handler.ts /api/respond 已在）→ registry 按 rpcId 路由 → kind 选 approvals/questions payload schema——两个 schema 文件头注释「after routing via the pending table」预告的正是此形态 ✓ |
| receipt 词表 | {accepted:true} / not-pending / bad-response 全部已在 RpcReceipt closed union（rpc.ts:113），零扩词 ✓ |
| 答题者形态 | 「总是 claim 不 next()」=waterfall veto 的正当使用（单 UI 立场入不做清单，触发条件/返工点三段式齐）；provider 单例 DUPLICATE_PROVIDER fail-loud 已核（user-interaction:98）✓ |
| ApprovalService 衔接 | request() 先 append asked 再 dispatch waterfall（user-approval:323→decide），答题者 backscan 时 asked 事件必已在 log ✓；abort 出口「晚到答案丢弃」是 Service 既有语义 ✓；bootHost 挂载的 policy 默认 'ask' 已核（Config schema default）✓ |
| resolved 帧 owner | registry 统一广播（不从 decided audit 派生）论证成立：question 无 audit 事件可派生，两套来源必不对称；decided audit 照旧随 session/event 帧下发但非 surface-eligible，不出卡，无双渲染 ✓ |

### C. 重放衔接：**与 EventsApi still-pending 承诺逐字吻合**

- events.ts mux JSDoc 承诺「replays each session's still-pending approval/question requested frames (rpcId reused verbatim)」——§2.1 的 subscribed 基线后重放 + rpcId 逐字复用 = 承诺的第一个真实现（fixture 已同语义先行）✓
- 「attached session」限定与 registry 一致性成立（pending 必属 attached，见 A 节边界论证）✓
- client 侧衔接零改动成立：session.ts:220 resync 清 pending 等基线重放、manager pendingBuffers（未实例化缓冲+removed 清扫）语义都不动 ✓
- 收敛完备性核过一条关键链：卡片被重放 ⇒ 重放时刻仍 pending ⇒ 此后的裁决必广播到本 attached 流 ⇒ 「answering→not-pending→等 resolved 帧」不会永久悬置；断流则 resync 清卡，无泄漏路径 ✓
- §4.3 已决卡不恢复 = conventions 18（resolved 是瞬时呈现态）；审计诉求入不做清单首行，三段式完整 ✓

### D. 契约缺口④裁决：A 案（ApprovalRequest 加 readonly id）——**批准，且建议提前到 host 刀内落，B 案不必写**

team-lead 指定契约 owner 表态项。逐项核过成本面后结论：**值得，且几乎零成本**。

- **「帧型变更」的顾虑不成立**：wire 帧 `approval/requested` 的 `approvalId: ApprovalRequestId` 字段**本就在**（events.ts MuxFrame 既有行）——A 案不动任何帧型，只给同进程 waterfall 载荷 `ApprovalRequest` 加一个 readonly 字段，wire 零变更。
- **「Model-visible⟺logged」审视通过（平凡满足）**：waterfall 载荷不是 model-visible 输入；id 的持久真相**已经**在 `approval/asked` audit 事件里（Service mint 后即 append，user-approval:322-323）——A 案不产生任何新的 model-visible 输入，也不需要新 session 事件，只是把一个已 logged 的事实顺路递给答题者。字段 JSDoc 应写明「与 approval/asked 事件携带的是同一 id」（one home for the fact，指向 audit 事件为源）。
- **实施量核实**：mint 在 waterfall 派发之前（:322 mint → :323 append asked → decide() 派发），A 案=接口加一行 readonly 字段+派发处 `{...req, id}`，两行量级；ACP 答题者只读 `req.callId`（acp/index.ts:543-547），additive 字段无感；`scoped-events.generated.ts` 载荷形状若入生成物需重跑生成器（核对项，非风险）。
- **B 案的长期负债比设计页写的更实**：ACP 答题者自己就有「callId 缺席则 next() 放行」分支——call-less ask 是这个 seam 明确设想过的形态，「两处 ask 源均必带 callId」只是今天的巧合而非契约保证；backscan 的沉默失效条件（不做清单第 7 行自己都点了名）不值得为省两行改动而背。
- **落地建议**：既然契约 owner 已批，**host 刀直接读 `req.id`，B 案 backscan 不必先写再删**——设计页 §2.2 的 B 案段落降级为「A 案未合入时的备胎」或径直删除，分刀计划第 1 刀把 user-approval 的两行改动列为前置小刀（跨属地改动按 conventions 5 已完成报审，本表态即 apiproxy 消费侧+被指定契约 owner 的批准；dsh-user-approval 包内实施仍报包属地备案）。

### 其余

- §0 现状警示核实为真：bootHost 无 ApprovalService/UserInteractionService，serviceAsk `ctx.get('approval')` 兜空即 deny（tools/index.ts:995）——「默认全拒」不是夸张。
- 分刀计划（host/client/UI/验收四刀）与验收口径（真 host 级三清单+防回归钉子）符合 conventions 6；fixture respond 可脚本化升级是正确的预埋。
