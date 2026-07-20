# core 能力面 × 契约 v1.3 覆盖度盘点

> 2026-07-19 起盘（分批落盘中）。方法：逐包读 core 源码 types/service 面（file:line 为证），对照 design.md v1.3 标注四态：**已覆盖** / **有意不做**（引拍板）/ **接缝已留**（说在哪）/ **漏判**（需新裁决，汇总见文末清单）。
> 背景：rpc-compare 发现契约漏 subagent 谱系，根因是当初只按 UI 需求反查 core、未做系统盘点；本文件补这道工序。

## 1. session 域（packages/core/session）

### 1.1 SessionEventMap 全类型表（types.ts:180-252）

| 事件 | core 事实 | 契约状态 |
|---|---|---|
| `turn/start` / `turn/end` | types.ts:187/193，turn 边界 + TurnTrigger/TurnEndReason（merge-extensible，types.ts:79-124） | **已覆盖**——mux `session/event` + history 纯透传（design §3.3 透传纪律） |
| `step/start` / `step/end` | types.ts:195/197 | **已覆盖**（同上透传） |
| `user/message` | types.ts:199 | **已覆盖**（透传；client fold 消费） |
| `prompt/blocked` | types.ts:204，veto 的 durable 记录 | **已覆盖**（透传）。UI 是否渲染是 client fold 决策，不是契约缺口 |
| `context/message` | types.ts:212-217，含 `meta`（模型不可见 durable JSON） | **已覆盖**（透传） |
| `assistant/chunk` | types.ts:219，token 级 | **已覆盖**——「token 流即事件流」（design §3.3） |
| `assistant/message` | types.ts:226，含 `usage?: TokenUsage` | **已覆盖**（透传）。**usage/token 统计随之免费到达 client**，无需独立统计接口（§7 LLM 层回引此行） |
| `tool/call` / `tool/result` | types.ts:232/242；result 带 `meta?: unknown`（tool 私有 presentation 载荷） | **已覆盖**（透传）；render intent（presentCall/presentResult）**有意不做**——design §3.3 tool presentation 拍板「先透传，additive 附件帧留座」 |
| `steering/message` | types.ts:244 | **已覆盖**（透传） |
| `todo/write` | types.ts:246，全量快照、last-write-wins、log-only | **已覆盖**（透传）；client fold 照 last-write-wins 折即可，无需独立 todo 接口（§6 回引此行） |
| `request/header` | types.ts:251，EpochHeader 快照（config/system/tools/messagePrefix） | **已覆盖**（透传）。UI 可从中读 provider/model 现值变化 |
| merge-extensible 扩展键 | types.ts:180 map 声明 | **已覆盖**——design §3.3：client fold 对未知 type documented-default，schema 留「合法信封+未知类型」分支 |

### 1.2 Session/SessionStore 服务面（index.ts）

| 能力 | core 事实 | 契约状态 |
|---|---|---|
| `session/created` / `session/disposed` 事件 | index.ts:47/57 | **已覆盖**——HostFrame `host/session-added`/`removed`（design §3.3） |
| `session/event` 追加流 | index.ts:69 | **已覆盖**——mux 的源 |
| `session/flush` 检查点 | index.ts:79 | **有意不做**（不对客暴露）——durability 是 host 内部事务，client 只见已落地事件 |
| `store.get/list` | index.ts:818/826（live only） | **已覆盖**——sessions.list（live+冷合并的持久化清单，v1 mtime 三字段拍板） |
| `SessionHeader.parentSession` + `seedLength` | types.ts:47/52；fork 时写入 index.ts:854-855 | **漏判 →【L1】**——谱系在 core 持久化面存在，契约 SessionSummary/HostFrame 均未携带 |
| `SessionHeader.cwd` / `createdAt` | types.ts:43/45 | **漏判 →【L2】**——create 收 cwd 入参但 list/describe 均不回吐；createdAt 被 v1「mtime 即 updatedAt」拍板部分覆盖但非同一语义 |
| `SessionStore.fork()` | index.ts:843-857；SessionForkSource index.ts:546；错误码 SessionForkErrorCode index.ts:556-562（turn/end 边界约束 :890-895） | **漏判 →【L3】**——core 有完整 fork 原语（opencode 也有 POST /session/:id/fork 对照），契约无 session.fork 方法 |
| repair（`interruptedTurnClosers`） | index.ts:25 导出；repair.ts；persistence 加载时闭合 crash 孤儿 turn（TurnEndReason `interrupted`，types.ts:120） | **已覆盖**（间接）——修复产物就是 `turn/end interrupted` 事件，随 history 透传到达；修复动作本身是 host 内部行为，无需接口 |
| surface（`foldSurface`/`SurfaceOp`/replace） | index.ts:26-27 导出；types.ts:262-309（SurfaceOp append/replace，compaction 用） | **已覆盖**——design §5「优先复用 core foldSurface」；replace 语义随事件透传，client fold 天然处理 compaction |
| `deriveMessages`/`requestHeader` 折叠 | index.ts:469/432 | **有意不做**（server 不代折）——「历史=事件重放，client 单一 fold」拍板（README 拍板表） |

## 2. agent 域（packages/core/agent）

| 能力 | core 事实 | 契约状态 |
|---|---|---|
| `agent/created` / `agent/disposed` | types.ts:147/156（注册/注销时 emit） | **已覆盖**——HostFrame added/removed 的 agent 侧对应（HostFrame 语义=「session 出现/消失」，v1 agent 与 session 同生命周期） |
| `agent/status`（idle⇄running→disposed） | types.ts:165；AgentStatus types.ts:47 | **已覆盖**——HostFrame `host/session-status` running 布尔。三态压两态是拍板（冷 session 拍板：attach 不暴露，disposed 即 removed） |
| `agent/queued`（入箱通知） | types.ts:175 | **有意不做**——prompt() 返回 accepted 即达意；入箱细节属 host 内部（CQRS：渲染靠 session 事件） |
| send/steer/cancel 原语 | types.ts:103/110/127 | **已覆盖**——prompt(mode: queue/steer)、cancel 1:1 映射（design §3.1） |
| `inject`（注入上下文不跑模型） | types.ts:119 | **漏判 →【L4】**——core 第三条输入原语，契约只映射了 send/steer；UI 场景（如「贴文件给 agent 但不触发回复」）v1 是否需要待裁决 |
| `whenIdle()` | types.ts:130 | **有意不做**——client 由 `host/session-status` 事件驱动，不需要 promise 面 |
| `AgentRegistry.create/resume`（CreateAgentOptions：sessionId/meta{cwd,parentSession,seedLength}/seed/agentOptions/setup） | index.ts:44-90、:352/:371 | **已覆盖**（部分）——sessions.create 走此路（cwd 已在契约入参）；**meta.parentSession/seed 是 fork/spawn 用的**，与【L3】同源，client 侧 v1 不透出 |
| `AgentRegistry.get/list/roots/isOwnedBy` | index.ts:530/550/560+/543 | list/get **已覆盖**（sessions.list + running）；`roots()`/`isOwnedBy`（运行时归属树）**漏判 →【L1】共同体**——UI 要画 subagent 树需要谱系，见 L1 处置提案 |
| initiator scope（`withInitiator`/`initiator()`） | index.ts:288/:258；RFC 2026-07-15-agent-initiator-scope | **有意不做**——进程内 AsyncLocalStorage 机制，本质不可序列化，不属 wire 契约；UI 需要的「谁创建了谁」由持久谱系（L1）承担 |
| 扩展 seam 事件（pre-step/prompt-submit/request/session-prefix/step-result/post-step/request-error/turn-continuation/turn-stop、agent/error） | types.ts:204-311 | **有意不做**（对客）——插件扩展 seam，是 host 进程内 waterfall/serial 钩子；durable 后果已进 session log 透传（如 prompt/blocked、turn/end error）。`agent/error` 的无 turn 位置失败 →【L5】边缘：live-only 诊断无 session 事件时 client 不可见，待裁决是否要 stream/error 级 host 通知 |

## 3. subagent 包组（packages/subagent/*：spawn/fork/inprocess/subprocess/acp + tool-subagent）

| 能力 | core 事实 | 契约状态 |
|---|---|---|
| 子 agent 创建（spawn=白纸 / fork=继承 turn 前缀） | subagent/src/types.ts:52-101（StartRequest：parent 必填、读 parent.session.header 拿 cwd+stamp parentSession，:56-61）；SubagentRun.id=子 session id、`parentSession` 记录 parent（:148-154） | **对 UI 的可观测面 = 普通 session**：子 agent 就是 registry 里一个 live agent + store 里一个 session，mux/hostEvents 天然看得见。**缺的只是谱系标注 →【L1】**（host/session-added 无 parentSessionId，UI 无法区分「用户开的」和「agent spawn 的」） |
| 运行时 run 面（result promise/dispose/sendMessage?/resume?） | types.ts:148-185 | **有意不做**——run 生命周期属 parent agent 的工具调用（tool/call `task` → tool/result），已随事件透传；client 不直接操纵子 run |
| stopReason / structured output | types.ts:109-141 | **已覆盖**（间接）——结果进 parent 的 tool/result 透传 |
| ACP/subprocess 远程子 agent | subagent-acp、subagent-subprocess | **同上**——远程 run 无本地 session；parent 侧 tool 事件已覆盖其可观测面；v1 不做远程子会话浏览（不做清单精神，未明文 → 盘点顺手补进 §6 不做清单措辞即可，不算漏判） |

## 4. ctx.tasks 后台任务（packages/tasks/tasks）

| 能力 | core 事实 | 契约状态 |
|---|---|---|
| `tasks.list/get/wait`（TaskSnapshot：kind/label/status/detail/output/startedAt/finishedAt） | index.ts:153/167/226/326 | **漏判 →【L6】**——运行时全局后台任务注册表（bash 后台、subagent run 等挂在这），UI「后台任务列表」是常见诉求；但 v1 UI 范围未含此面板，处置建议偏「留接缝」 |
| `onTaskDone` 完成通知 | index.ts:283 | 同【L6】——若做任务面板需 HostFrame 或独立流；不做面板则无需 |
| 任务归属（owner: Agent、session-scoped 授权） | index.ts:44-48（TrackedTask.owner）、list(caller) 过滤 | 同【L6】附注：core 已有按 agent 过滤语义，接口若做可直接映射 |

## 5. 审批与问答（packages/ui/user-approval、user-interaction）

| 能力 | core 事实 | 契约状态 |
|---|---|---|
| `approval/request` waterfall（待决问题推给 answerer 链） | user-approval/src/index.ts:23-32；ApprovalOutcome :91（allowed-once/rejected/cancelled/unavailable，fail-closed） | **有意不做（v1）**——design §6 不做清单明文「审批/问答域」。**结构性事实需记录**：这是 client→server 反向要答案的面，纯 mux 单向流装不下，将来要么复用 unary（poll/answer 方法对）要么加双向帧——接缝形态建议在拍板时一并定 |
| `approval/asked` / `approval/decided` session 审计事件 | index.ts:35-60（log-only，merge into SessionEventMap） | **已覆盖**——merge-extensible 事件随 mux 透传（design §3.3 未知类型分支），UI 已可"看到"审批发生过；缺的只是"参与决定"（上行） |
| `approval/policy`（ask/never，session 内覆写） | index.ts:108 + SessionEventMap merge | **已覆盖**（事件透传）；改 policy 的命令面归审批域一并 v2 |
| `ctx.userInteraction.ask`（AskUserQuestionRequest/Answer，单 provider 注册制） | user-interaction/src/index.ts:43-71（registerProvider 单占 :96-107） | **有意不做（v1）**——同上不做清单。附注：单 provider 语义 ⇒ Web client 接管问答时要经 host 侧代理 provider 中转（provider 在 host 进程注册、答案从 wire 上取），这决定将来接缝在 impl 不在契约新增语义 |

## 6. workflow / todo / skill / compact 可观测面速查

| 包 | core 事实 | 契约状态 |
|---|---|---|
| todo（packages/todo） | 唯一持久面 = `todo/write` session 事件（types.ts:246） | **已覆盖**——透传 + client fold last-write-wins（§1.1 已列） |
| compact（packages/compact） | 产物 = surface `replace` 事件 + `context/message`（SurfaceOp types.ts:292-294） | **已覆盖**——透传；client fold 处理 replace 即正确渲染压缩后视图（design §5 foldSurface 复用） |
| skill（packages/skill） | 装载产物 = `context/message`（skill 内容注入）+ tool/call 事件 | **已覆盖**（透传）；skill 目录浏览/管理面 v1 无 UI 诉求，**有意不做**（catalog 工具是模型面不是 client 面） |
| workflow（packages/workflow） | worker-thread 引擎；对 session 的可观测面 = 其 tool/call、tool/result + 子 agent session（同 §3） | **已覆盖**（间接）；workflow 进度独立流 v1 不做，与 L6 任务面板同性质 |
| guard（packages/guard） | loop-hygiene 插件，干预结果落 session 事件（steering/turn-stop） | **已覆盖**（透传，无独立面） |

## 7. LLM 层（packages/llm）

| 能力 | core 事实 | 契约状态 |
|---|---|---|
| usage/token 统计 | `assistant/message.usage?: TokenUsage`（session types.ts:226，与消息同travel）；request/header 里 config | **已覆盖**——透传即达（§1.1 已列）；聚合统计（session 累计 token）是 client fold 的算术，不需要 server 接口 |
| adapter 注册面（provider 现值） | LlmService 注册表；AgentOptions.provider/model（agent types.ts:21-26） | **已覆盖**——host.describe 的 provider/model 现值（20:02 拍板）；**adapter 列表枚举**（UI 下拉「可用 provider 有哪些」）**漏判 →【L7】**：describe 只给现值不给候选集，「模型切换」在不做清单但「枚举可选项」是它的读前提，处置建议留接缝 |
| 模型切换（运行中改 provider/model） | agent/request waterfall 可换 config | **有意不做**——design §6 不做清单明文 |

## 漏判清单（已裁决，2026-07-19 21:13：L1/L2/L5 合入 design.md v1.5；L3/L4/L6/L7 类型预留 design §8；审批/问答提案整体采纳并入 §3.4）

| # | 缺口 | core 事实（file:line） | 建议处置 | 一句话理由 |
|---|---|---|---|---|
| **L1** | **subagent/fork 谱系不可见**（已知条目）：host/session-added 与 SessionSummary 均无 parent 信息，UI 无法画子 agent 树、无法区分用户开的还是 agent spawn 的 | SessionHeader.parentSession/seedLength（session types.ts:47/52）；fork 时写入（session index.ts:854）；spawn 时 stamp（subagent types.ts:56-61 REQUIRED parent） | **进 v1 契约**。补法：① `host/session-added` 帧加可选 `parentSessionId?: SessionId`（从 `session.header.parentSession` 读，无谱系时缺省）；② SessionSummary 同补 `parentSessionId?`（冷 session 列表也要能画树；jsonl 后端从持久化 header 读）。运行时归属（registry owner/roots，agent index.ts:543/560）**不透出**——durable 谱系已够 UI 用，运行时树是进程内概念 | 字段 core 已持久化、读取零成本；缺它 UI 树状视图无法做，且 additive 可选字段不破坏现契约 |
| **L2** | session 元数据有入无出：create 收 `cwd` 但 list/history 均不回吐；createdAt 同 | SessionHeader.cwd/createdAt（session types.ts:43/45） | **进 v1 契约**（顺手）：SessionSummary 加 `cwd?: string`。createdAt **不加**——v1「mtime=updatedAt」拍板已覆盖排序诉求，再加是第二时间语义 | 多 session 不同 cwd 时列表页无法标注工作目录；一字段事，与 L1 同一次 SessionSummary 改动 |
| **L3** | fork 无契约方法：core 有完整原语+类型化错误码，opencode 有同款端点 | SessionStore.fork（session index.ts:843-857）；SessionForkErrorCode :556-562；turn/end 边界 :890-895 | **留接缝**：v1 不加 `session.fork`（UI 无 fork 按钮诉求）；接缝=将来 RpcMethodMap 加 `'session.fork'` 一行 + SessionForkErrorCode 并入 RpcErrorCode 按域扩展，零结构变化 | 形态 B 下加方法是纯 additive；现在加则要陪审 UI 交互（fork 点选择、边界约束提示）不值 v1 |
| **L4** | `agent.inject` 第三输入原语无映射：prompt 只有 queue/steer | Agent.inject（agent types.ts:119）；idle 时一次性 turn 语义 types.ts:84-89 | **留接缝**：prompt 的 `mode` union 将来加 `'inject'` 即可（merge 进闭合 union + impl 分发）。v1 Web UI 无「注入不触发回复」交互 | 三原语中 inject 是插件/自动化面（文件变更通知等 host 内部已在用）；人机 UI 场景未出现，union 扩展零迁移 |
| **L5** | 无 turn 位置的 live 失败 client 不可见：`agent/error` 在 session log 无对应事件时（如 flush 失败、驱动崩溃）UI 只能看到 session 卡死 | agent/error emit（agent types.ts:311，"even when the error has no in-turn position"） | **进 v1 契约**（轻量）：HostFrame 加 `{ type: 'host/agent-error'; sessionId; message: string }`——只做诊断展示不做恢复语义 | 不加则「agent 停了但 UI 永远转圈」无解释渠道；一帧类型，Frame union additive |
| **L6** | 后台任务注册表无接口：bash 后台/长任务在 ctx.tasks，UI 任务面板无数据源 | tasks.list/get/wait/onTaskDone（tasks index.ts:153/167/226/283）；TaskSnapshot :326 | **留接缝**：任务面板不在 v1 UI 范围；接缝=将来新 `tasks` 域（一域一文件 + RpcMethodMap 数行 + 完成通知并入 hostEvents 或独立流）。设计已天然支持新域（design §1「新域=新文件对+根接口一字段」） | v1 UI 无此面板；域级 additive 是本契约的标准扩展路径，无需预留字段 |
| **L7** | provider 候选集不可枚举：describe 给现值，UI「切换模型」下拉无数据源 | LlmService adapter 注册表；AgentOptions.provider/model（agent types.ts:21-26） | **留接缝**：模型切换整域在不做清单，枚举是其读前提，一起进将来的 provider 域；不单独提前 | 只读枚举脱离切换动作无用户价值；避免半个域 |
| — | 审批/问答：形态已拍板（2026-07-19 21:0x，mux 下行帧 + HTTP unary 上行），协议提案见下节，随本清单一并裁决 | 见下节逐条 file:line | 本轮定契约形状，实现可排后 | — |

## 审批/问答域协议提案（已采纳并入 design.md §3.4；**21:19 修订**：QuestionAskId 取消、问题标识复用 RpcId——下文为原提案存档，以 design.md 为准）

**已定**：请求下行 = mux 控制帧（稳定 id + session 锚点）；回答上行 = 普通 unary（respond 带 id 回传）。不做双向帧/双工通道——SSE 本就是 server→client，回送有 HTTP。

### A. 方法与帧

```ts
// RpcMethodMap 增两行（key 按域单数 convention）
'approval.respond': ApprovalApi['respond']
'question.respond': QuestionApi['respond']

export interface ApprovalApi {
  /** 回答一个待决审批。outcome 只收 client 可给的子集（cancelled/unavailable 是 host 侧结局）。 */
  respond(input: { sessionId: SessionId; id: ApprovalRequestId; outcome: 'allowed-once' | 'rejected' }):
    Promise<RpcResponse<{ accepted: true }>>
}
export interface QuestionApi {
  /** 整批回答一次 ask（core 事实：一次 ask 多题一个 answer，user-interaction index.ts:63-67）。 */
  respond(input: { sessionId: SessionId; id: QuestionAskId; answer: AskUserQuestionAnswer }):
    Promise<RpcResponse<{ accepted: true }>>
}

// MuxFrame 增四帧（Frame 族，session 锚点）
| { type: 'approval/requested'; sessionId: SessionId; id: ApprovalRequestId; toolName: string; callId?: CallId; reason?: string }
| { type: 'approval/resolved';  sessionId: SessionId; id: ApprovalRequestId; outcome: ApprovalOutcome }
| { type: 'question/requested'; sessionId: SessionId; id: QuestionAskId; questions: AskUserQuestionItem[] }
| { type: 'question/resolved';  sessionId: SessionId; id: QuestionAskId; outcome: 'answered' | 'cancelled' }
```

- requested 载荷 = core 类型透传：审批帧字段即 ApprovalRequest 去 agent（换 sessionId 锚）去 signal（user-approval index.ts:190-212）；问题帧直接透传 `AskUserQuestionItem[]`（user-interaction index.ts:29-41，model 自带题内 id）。
- **resolved 帧是收敛面**：多 client 同看一 session 时，别人答掉/超时取消/policy 决掉，观察方靠 resolved 撤卡片；自己答成功也等 resolved 帧统一收敛（respond 的 accepted 只表示受理）。

### B. id 纪律（按现行纪律推导）

- **审批：复用 core `ApprovalRequestId`**（已 brand，user-approval index.ts:76）——SessionId 同款先例：type-only import、id 全部源自 server（requested 帧），client 只回传。
- **问答：host 造 `QuestionAskId`**（api 层新 brand：`Branded<'question-ask-id'>`）——core 事实：user-interaction **无 request 级 id**（AskUserQuestionRequest 只有题内 model 自给的 string id，index.ts:29-33），host 代理 provider 受理 ask() 时 mint UUID。与 cursor 占位不同（那是未实现故不 brand），此 id 实装即进签名，按「opaque 跨界 id 必 brand」仓规上 brand。

### C. 竞争语义

- **先到先赢，host 内存 pending 表是唯一裁判**：一个 id 只被 settle 一次。竞争方：client respond vs `signal` abort（tool 取消/step 中止 → cancelled，user-approval index.ts:206-211）vs 另一 client respond。policy `'never'` 在 answerer 链之前解决（index.ts:100-108），**requested 帧根本不发**——天然对齐。core 无审批超时（signal 是唯一撤回通道），不发明。
- **迟到/重复回答**：RpcErrorDetailsMap 增两码——`'approval-not-pending': { id: ApprovalRequestId }`、`'question-not-pending': { id: QuestionAskId }`（分域两码不合一：details 类型不同，且按域扩展是既定纪律）。

### D. 刷新恢复（推荐：subscribed 基线重放）

**推荐**：client 重开 mux 后，host 在每个 session 的 `session/subscribed` 帧之后立即重放该 session 仍 pending 的 `*/requested` 帧（来源=host 内存 pending 表）。理由：单一事实源（全走 mux），与 lastSeq 补缝流程同构，client 无需第二条 bootstrap 路径做 join。**不推荐** host.describe 带 pending 列表：跨 session 聚合 + 与流竞态，两处真相。
不能从 history 推 pending（审批虽有 `approval/asked`/`decided` 审计事件，但 crash 后 asked-without-decided 是永久悬案——pending 真相只在 host 内存，重放帧无此歧义）。

### E. core 事实对齐（盘点批3 + 本批补核）

| core 事实 | file:line | 提案对齐 |
|---|---|---|
| approval 走 policy → answerer waterfall 链，fail-closed unavailable | user-approval index.ts:23-32、:100-108 | host 侧注册一个「wire answerer」进链：收 approval/request → 发 requested 帧 → 等 respond/abort → 返回 outcome。链上仍可有其他 answerer（组合语义不变） |
| `approval/asked`/`decided` 已是 session 审计事件（log-only） | index.ts:35-60 | 保持透传不动；帧是 live 控制面、事件是 durable 审计，职责分离不算重复造 DTO |
| ApprovalOutcome 四值闭合 union | index.ts:91 | resolved 帧透传全集；respond 入参窄化为 client 可给二值 |
| userInteraction 单 provider 注册制 | user-interaction index.ts:96-107 | host 代理 provider 是唯一注册者（盘点 §5 已注），多 web client 竞争在 wire 层由 pending 表裁决，不违单 provider |
| ask() 不落 session 日志 | user-interaction 全文无 SessionEventMap merge（本批 grep 核实） | 问答无审计事件可依赖 → requested/resolved 帧是问答唯一可观测面，D 的内存重放是唯一恢复路径（自洽） |
| 一次 ask 多题、整批回答 | index.ts:43-67 | respond 收整个 AskUserQuestionAnswer，不拆单题方法 |

**汇总（裁决后）**：L1/L2/L5 **已合入 v1.5**（SessionSummary.parentSessionId?/cwd?、session-added 帧 parentSessionId?、host/agent-error 帧）；L3/L4/L6/L7 **类型已预留**（design §8 完整签名，不进 map——fail loud 优于 not-implemented 兜底）；审批/问答提案（下节）**整体采纳**并入 design §3.4。本文件转为盘点存档，后续契约变更以 design.md 为准。
