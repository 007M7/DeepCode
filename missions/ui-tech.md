# Harness UI 技术架构

> **【已被取代——历史档案】** 本文是 07-18 世代定稿，描述的 dsh-ui-host/ui-server/web-runtime/web-ui 分层已整体重构：现行=host 三包（apiproxy/runtime/webserver）+ 12 个 packages/client/* 插件包（双入口 host 插件+bundle loader 动态装载）。现行权威=`missions/tasks/20260721-1520-web-plugin-rfc/` 的 architecture.md（架构）+ api-contracts.md v3（接口）；本文引用的 docs/ui-design/ 已删除。wire 四象限消息模型是本文存活演进的设计（现居 architecture.md §3）。本文仅作决策演变考古用。

> 状态：**2026-07-18 定稿，供最终 review**。产品行为见《[UI 产品设计](ui-product.md)》。**wire 字段级权威 = `docs/ui-design/01-protocol.md`**；本稿 §4 只描述协议形状与不变量，冲突处以 01 为准。关键决策的演变过程见文末附表；完整裁决档在 `missions/tasks/20260718-final-review/`。

---

## 0. 范围与硬约束

- **一期只实现 Web localhost launcher**；Electron 为**架构同构预留**（协议/注入接缝/进程模型设计保留，见 §9，一期不写实现）；TUI 只留协议位置。
- **协议跨端一致、一次定全**：不因只做 Web 丢 Electron/TUI 流程；传输是可替换 adapter，语义层不变。
- **连接下限承诺：单 WebView + 刷新恢复绝对可靠**（含进行中消息 partial，见 §3/§4）；多 WebView 并连/读写分离不做、不为其复杂化。
- **一期不改 harness core**：不动任何现有包（唯一已批例外：`dsh-brand` 加 `BrandedNumber`）。凡需 core 的能力：**协议按目标形状冻结（稳定 id + revision + CAS 不变量），实现走 UI 层合成，port 按未来 core 原生能力的形状设计**——core 就位后只换 port 实现、wire 与上层零改（迁移清单 §13）。
- **实现可留空、架构必须完整**：定稿即冻结契约；实现按 §10 工作包地图多 worktree 并发填空。
- 核心原则：**Host 权威，UI 是可重建投影**（关页/刷新/断网 ≠ 停任务；transport 断开、client detach、command cancel、session interrupt、launcher stop 五种动作互相独立）；**显式 id 强关联**（协议与 reducer 出现"按第 N 个/最近一条/按到达顺序对应"即违规）；**模型可见 ⟺ 已日志**。

## 1. 架构总览

```
harness core（session 事件日志 / agent / tools / 审批 / 交互 / persistence，已存在，一期不改）
      │  只读消费（唯一读 ctx 处 = HarnessRuntimeAdapter，root context 订阅）
      ▼
dsh-ui-host（新增，域层 = ui-apiproxy）：窄 port + 投影 P + SessionIndex + 审批/问答 Registry + Provider 事务 + metadata store
      │  UiHostPort = ui-apiproxy 的 API 面：进程内接口、零 HTTP 语义，形式上对等 acp-demo「把数据桥出来」但仍在 node 进程内；
      │  每个方法显式标注 unary（单次调用单次返回）/ stream（持续推送），供各平台传输层按此对接（Web HTTP/SSE、Electron 进程内、TUI worker）
      ▼
dsh-ui-server（新增，传输层 = dsc 的 web 后端包）：HTTP/SSE front door + AuthGate + ClientSlot + HostStream + SessionMux；
      │  承接 `dsc web` 起的 Web 服务器，把 HTTP query/command + Host SSE + SessionMux SSE 转发到 UiHostPort（unary→request/response、stream→SSE）；
      │  由 apps/ 引入启动，真正对等 stdio-demo / acp-demo 的启动形态；传输可替换（TransportAdapter）
      ▼
dsh-web-runtime（新增，浏览器内 React-free 部分）：transport client（对接上述 HTTP/SSE 对等接口）+ Controller + Zustand store（数据状态唯一归属）+ reducer 接线
      ▼
dsh-web-ui（新增，Web 内 React 骨架）：ReactRuntimeBridge + 组件 + slot seam（预留）
      ▲
apps/web · apps/server（一期，`dsc web` 入口）；apps/electron（目录预留）
```

### 关键决策表

| # | 决策 | 结论 |
|---|---|---|
| 1 | 端 | 一期 Web localhost；Electron 架构预留（renderer≡WebUI 约束保留）；TUI 协议位 |
| 2 | 技术栈 | React + Vite；CSS Modules + CSS 变量；Radix 原语；**无 router 库**（一期视图态在 store，URL 深链后置） |
| 3 | 传输 | HTTP query/command + **两条 SSE**（Host SSE root + SessionMux SSE），streaming fetch 非 EventSource |
| 4 | wire 契约 | zod 单一事实源，`z.strictObject` + closed discriminatedUnion，**出入双向 parse**；先 limit 后 parse；不上 codegen |
| 5 | 对话流协议 | 自定义 Web 协议：复用 harness 事件结构 + tool 状态机合并；弃 ACP 线形状 |
| 6 | 历史加载 | 物化树快照（GET 分页）+ 共享 `applyMutation` reducer；**快照含进行中 partial** |
| 7 | 命令语义 | **无 receipt/台账**：普通 HTTP status + typed error；仅 prompt 带 `commandId` 做有界去重；其余 mutation 用 expectedRevision 天然幂等 |
| 8 | 命令↔turn 关联 | **MessageSource 透传 `commandId`**（merge-extensible source，随 turn/start、user/message 落日志），provisional 按 commandId 转正 |
| 9 | 错误模型 | **五 category 两级结构**（transport / client-ownership / domain / control(resync·reset) / plugin-rpc）+ HTTP status 分层；Browser 本地失败不进 wire union |
| 10 | 状态层 | Zustand（slice/selector）+ 纯 TS Controller；Cordis root Context 只承载基础 Service，不进数据态；无 SWR，统一 Controller+store |
| 11 | React 边界 | 组件只经 `ReactRuntimeBridge`（selector + typed intent），**不导出裸 Cordis Context**；写路径唯一（§8） |
| 12 | 单客户端 | Server 级 `ClientSlot`；同 `clientId` 刷新=换 generation 接管；异 clientId 拒 `server-in-use`（不泄露占用者） |
| 13 | 多 session 收流 | SessionMux SSE 内多路复用 N 个 channel；切换只改焦点 |
| 14 | 发送 | **steer / queue / stop**，1:1 映射 agent 现成两条 FIFO；纪律：不假设一发送一 turn、无 cancelling 产品态 |
| 15 | 审批/问答 | 两类独立资源；稳定 id + revision(1→2) + 单一 CAS + anchorSeq；Host 存活期重连可恢复、重启只读 interrupted |
| 16 | Provider | test-before-save 串行事务 + **CommitSlot busy gate** + **操作不随断连死**（202+operationId）+ probe/discovery 失败切分 + generation lease |
| 17 | Markdown | react-markdown + shiki + **KaTeX**；Mermaid 后置；流式三件套后置移植 |
| 18 | 鉴权 | **一期裸免登录**（`dsc web` 监听 0.0.0.0、打印 127.0.0.1）+ OriginPolicy（拒域名 Host 防 rebinding）；`AuthGate` 接缝预留 |
| 19 | 包结构 | **五库包 + apps**，一设计层一包一 worktree（§10）；host 域层不 import 传输层（port 反转） |
| 20 | 插件 | **一期只做：服务端插件列表展示 + Browser Cordis Context 地基**；UI 插件（tool renderer/侧栏页）slot seam 仅预留不实装；PluginPort/双端加载留 future |

## 2. 对 harness core 的消费事实（源码已核，file:line 见 08）

- session 事件日志：每 session 单调唯一 `seq`；`assistant/message.sourceEventSeqs` 提供定稿消息↔chunk 锚点；`StreamChunk` 只有 block index（稳定 part id 由投影层从事件 seq 派生）。
- agent 三原语：`send`（queued FIFO）/ `steer`（steering FIFO）/ `cancel`（清两 FIFO + abort 当前 step）；`whenIdle`/`status` 可观测。Inbox 无按 id 删除——排队项级操作等 core 提供队列项 ID（§13）。
- 审批（`ctx.approval`）：同步 waterfall **答复者链**——UI answerer 对非 UI 发起的请求 `next()` 委让；请求仅限 open turn 内；`'never'` 策略下 UI 收不到 ask。resolve 回调是内存态（跨重启恢复需 core，§13）。
- 问答（`dsh-user-interaction`）：`ask()` 不写 session 日志（跨重启恢复需 core，§13）；一次 ask 可含多题。
- `ctx.tasks.list()` 按 caller session 过滤——活动聚合必须逐 agent 查询或用 `onTaskDone` 计数。
- session/agent 事件是 scope-filtered dispatch——**事件订阅必须在 root context**。
- tool 呈现：`dsh-tools` 提供 `presentCall/presentResult` 原语；callId 合并逻辑由 ui-host 原生实现（acp 包内有同语义实现可参照，共享上提留 future §13）。
- LLM：`registerAdapter` 重名 model 抛 `DUPLICATE_ADAPTER` → 替换唯一合法顺序 = **同步 dispose 旧 → register 新**；`ctx.llm.stream` 开始时解析 adapter、流中不换（generation lease 天然成立）。
- 原子写文件：ui-host 本地 helper（fs-local 的实现未导出且带包内依赖；共享提取留 future）。
- 无现成 HTTP server seam——dsh-ui-server 自带 `node:http`。

## 3. 连接模型与生命周期

### 3.1 建连与防护

- **启动 = `dsc web`**：监听 **`0.0.0.0`**（用户定），控制台打印 `http://127.0.0.1:<port>`。局域网设备因此事实可达，但一期不为 LAN 设计（免登录 + 单 ClientSlot 照旧，不承诺多设备体验）。
- **裸 localhost 免登录**：不设 credential/cookie，浏览器直接访问即用。已知代价：同机任何进程、同网段设备可访问 Host（单用户开发机接受）。
- server 侧保留零体验成本防护：**Host header 必须是 `IP字面量:实际端口`**（拒域名形式 Host——DNS rebinding 攻击必经域名，此检查在 0.0.0.0 监听下依然完整拦截）；mutation 要求 IP 字面量 Origin + JSON content-type + 协议版本 header；无 wildcard CORS。校验顺序：Origin → 协议版本/generation → admission。
- **鉴权层是架构预留**：HTTP 入口有 `AuthGate` 接缝，一期实现 = allow-all；LAN/远程/Electron sidecar 需要时换实现（一次性链接换 HttpOnly cookie 的完整设计已收档），端点集与协议不变。
- `GET /health`：只回 `{ hostInstanceId, protocolVersion, status }`，不回投影。

### 3.2 ClientSlot 与刷新接管

- `clientId` 存 `sessionStorage`（logical 身份，非凭据）。**bootstrap 前先做最小 version-probe**：协商双方最高共同版本，无交集在 claim slot **之前**拒 `protocol-version-unsupported`。
- bootstrap 请求带：`clientId`、支持版本、已知 `hostInstanceId`、已开 session 的 cursor；响应带：`hostInstanceId`、单调 `connectionGeneration`、`ProtocolLimits`（载荷/深度/条数上限的部署生效值）、Host 快照 + revision、`resumedChannels`（各 channel 恢复结果——**刷新后 cursor 事实源**，client 不假设本地留有 cursor）。
- 槽位规则：空 → 原子取得；**异** `clientId` 占用 → `server-in-use`（不泄露 holder）；**同** `clientId` → 刷新接管：**同步 current 指针 swap（唯一 fencing 点）** → 旧代 SSE 与未进域层的迟到请求失效（`RequestLease` 在路由进域层前验 generation）→ 旧对象**异步**释放（对象身份 CAS，迟到 disposer no-op）。
- bootstrap 后设 **root attach deadline**：超时未开 Host SSE 即终止该 generation，防"只 bootstrap 不开流"永久占位。

### 3.3 两条 SSE

| 流 | 承载 | 断开语义 |
|---|---|---|
| **Host SSE**（root） | `host.ready` / `host.mutation`（fromRevision→toRevision 严格相邻）/ `host.resync` / `heartbeat` / `stream-error`；host 投影 = session 摘要变更、Provider、插件状态、待处理计数 | clean EOF / 写失败 / 心跳超时 → 一次 root teardown：拒迟到请求、关同代 mux、**释放 ClientSlot**（Host 已接受任务继续跑） |
| **SessionMux SSE** | N 个 session channel 帧多路复用 | 单独断开**不**释放 slot；按各 channel cursor 重建；连接存活只由 Host SSE 判定 |

- 每条 SSE record 外层信封带 `hostInstanceId / connectionGeneration / streamId`；**streamId 每次物理 open 新发**，旧 reader 迟到帧按 streamId 丢弃（generation 不换但 mux 重连的场景靠它 fence）。
- **Host 投影不内嵌完整 session 列表**：列表数据只由分页查询取得；Host SSE 只推单条摘要变更与计数，client 把变更贴到已加载的页上。
- SSE open 失败用 **content-type 分流**：失败 = 200 json `stream.not-opened`（带 category/code），成功 = `text/event-stream` 首帧 ready；Browser 先看 content-type 再选 decoder。
- 重连恢复起点**只信 Browser 侧 cursor**（server 的 last-sent 不作恢复依据）。
- `hostInstanceId` 变化 = Host 重启：client 丢弃全部 store 与 cursor，完整重 bootstrap。

### 3.4 channel 生命周期与 replay 窗口

- `channel.open`（HTTP）→ server 在**单同步 tick 内**先订阅后读快照（harness 单线程保证快照与订阅之间无空洞）→ 后续帧上 mux。
- 带 cursor 重开（刷新/mux 重建）走显式 replay 窗口：`channel.opened` → `replay.started` → durable `session.event`* → `replay.completed`（**附锚定最终 durable seq 的完整 partial 快照**——进行中消息已生成部分随之恢复）→ live delta。replay 期间**严格隔离** live delta，无交错。
- cursor 过旧/缺口/单 channel 溢出 → 只对该 channel 发 `resync.required`（保留可见内容、暂禁该 session mutation、重取快照），其他 channel 不动；物理失活/协议不兼容才重建整条 mux。
- **mux 重建 = 逐 channel 重走 open**（server 不猜续发起点）：client 带各 channel 自持 cursor 重开；无可信 cursor 的 channel 直接全量基线。**一期实现允许统一降级为"恒全量基线"**（等价于 cursor 恒过旧），wire 不变。
- 显式 `channel.close` 只停该 session 下行投影，不停 HostSession/任务；**切换路由不隐式关 channel**（无 LRU）。

### 3.5 Web 有序停机（SIGINT/SIGTERM）

固定链（Electron 预留共用）：关 mutation/新连接/task admission → 等已进入域层的调用返回 → 各 session 取消交互（审批/问答 abort）+ `agent.cancel` → 分别等 `Agent.whenIdle()` **且** task producer done → **flush 各 session（必须在 agent dispose 之前**——`SessionStore.flush` 只接受 attached session）→ retire adapter → 关连接 → dispose Cordis root。busy 判定含后台任务与 pending 交互；任一来源读不到 → `unknown` → 保守处理，不伪装空闲。

## 4. 协议（形状与不变量；字段级见 01）

### 4.1 三条数据流

| 流 | 方向 | 传输 | 承载 |
|---|---|---|---|
| 快照/历史 | C←S | HTTP GET | session 列表（keyset 分页）、历史树窗口（向上翻页）、设置、catalog |
| 实时增量 | S→C | 两条 SSE | host 投影变更；session channel 帧 |
| 命令 | C→S | HTTP POST/PATCH | prompt、stop、channel、审批/问答回复、session 创建/重命名/model、Provider |

### 4.2 端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/health` | GET | 探活，不占槽 |
| `/bootstrap` | POST | version-probe + claim + 快照 + generation |
| `/stream/host` | GET(SSE) | Host SSE |
| `/stream/sessions` | GET(SSE) | SessionMux SSE |
| `/sessions` | GET / **POST** | keyset 分页列表（cursor 绑 hostInstanceId+index revision+规范化 query，错误三分型 INVALID/QUERY_MISMATCH/STALE）/ **创建 session**（201+DTO） |
| `/sessions/:id` | GET | 历史树窗口分页（cursor 绑 corpus·mode·beforeSeqExclusive，尾部 append 不失效向上翻页） |
| `/sessions/:id/metadata` | PATCH | **重命名等 metadata**（expectedMetadataRevision CAS） |
| `/sessions/:id/model` | POST | per-session model（下一 request 边界生效，随 request header 落日志） |
| `/sessions/:id/prompt` | POST | 发送 `{commandId, mode: steer\|queue, text, …}` ⇒ 204 |
| `/sessions/:id/cancel` | POST | 停止（整体）⇒ 204 |
| `/channels` | POST | channel open/close |
| `/approvals/:id` | POST | 审批回复（expectedRevision）⇒ 204 = CAS 已赢 |
| `/questions/:id` | POST | 问答整批原子回复（expectedRevision + answers 全覆盖必答项）⇒ 204 |
| `/provider` | GET / POST | 读（脱敏投影）/ 保存 ⇒ **202 + operationId**（事务不随断连死，终态走投影） |

HTTP status 分层（纯 transport 语义）：200/201/202/204 成功族；400 解码失败、401/403（AuthGate 预留）、404 未知资源、**409 revision 冲突或 busy**、413/415 limit、422 域校验、500/503。错误体 = strict 脱敏 `{ category, code, message?, details? }`，Browser 只 switch `category/code`（未知 code 按 category 缺省路径 + assertNever 家规）。

### 4.3 SessionMux 帧（kind 闭合集）

控制帧（不进 reducer）：`channel.opened` / `replay.started` / `replay.completed` / `resync.required` / `channel.closed` / `error`；流级 `mux.ready` / `heartbeat`。
可 fold 帧（进 `applyMutation`，**durable**，带源事件 seq 作 cursor）：`message.start`（含 `turnId`、`role`、`source.commandId?`）/ `part.add` / `tool.update` / `message.end` / `approval.requested|resolved` / `question.requested|resolved`。
**live-only** 帧（断线可丢、由 partial 快照收敛）：`text.delta` / `reasoning.delta`。
durable/live 判别 = **kind 闭合分类**（无 boolean 标记）；01 导出 `DurableFrame` / `LiveDeltaFrame` 两个子 union + 分类器函数，其余各层只准 import 分类器、禁止自行按 kind 字符串再分。durable cursor 与 live 无序号耦合（live 靠 TCP 序 + streamId fence）。

### 4.4 幂等与命令关联

- **无 AdmissionReceipt / 无回执台账 / 无 clientToken**。命令一律普通 HTTP status + typed error；response 丢失 = 结果未知 → 重读权威投影。
- **prompt 是唯一需要防重的命令**（副作用不可逆且无 revision 保护）：client 预生成 `commandId`，server 每 session 维护**有界**已受理 commandId 集合去重；HTTP 超时 → **同 id 重试，禁换新 id 盲发**。其余 mutation 全部带 expectedRevision，重放天然失败为 409。
- **命令↔turn 显式关联**：server 调 `agent.send/steer` 时通过 merge-extensible `MessageSource` 携带 `{kind:'host-user', commandId}`；`turn/start`、`user/message` 事件原样记录，投影把 `commandId` 带上 `message.start` 帧——前端 provisional 项按 commandId **原地转正**。（透传路径以 harness 现有 source 机制为据，实现期首个 spike 验证；不通则回退"user message 到达即替换 provisional"，wire 不变。）
- 三层状态即够：本地 draft → provisional（乐观）→ 权威 timeline 项；provisional 不是事实，`hostInstanceId` 变更后标"需用户确认"。

### 4.5 横切不变量（每层 review 对表）

① transport abort / client detach / command cancel / session interrupt / launcher stop 五动作分离；② HTTP 2xx 只表示"已受理/已提交"，领域终态只走投影；③ AbortSignal 默认只取消调用方等待；④ disposer 先 fence 再 await quiescence、重复调用共享 promise；⑤ generation/epoch 只 fence 迟到结果，**不承担业务幂等**；⑥ timeout 是独立观察结果，不覆盖真实 outcome（**谁等待谁拥有 timeout**：Browser 拥有 watchdog、Host 拥有 drain deadline、transport 拥有 attach/heartbeat/write-stall）；⑦ provisional/draft/toast 不是 Host 事实；⑧ mutation 方法禁返回 `Promise<void>`（必须返回 typed 结果）；⑨ 错误体禁止推进 revision（必须走 query/resync）。

## 5. server 侧设计

### 5.1 dsh-ui-host（域层，无 HTTP 依赖）

**唯一读 `ctx` 处 = `HarnessRuntimeAdapter`**（组合期装配，root context 订阅事件），下游只见窄 port：`SessionCorpusPort`（单 tick openChannel：快照+订阅无空洞）/ `SessionLifecyclePort`（open/resume/**openHistory 只读不激活 Agent**，load 可能触发存储 repair 需 per-id 串行）/ `AgentDriverPort`（queue=send、steer、cancel、whenIdle、status）/ `ToolPresentationPort` / `ApprovalPort` / `QuestionPort` / `AdapterRegistryPort` / `TaskActivitySource`（逐 agent 聚合）/ `PluginStatusSource`（插件状态诊断——HostProjector 不绕 port 直取 cordis registry）。每 port 可窄 fake 单测。

- **投影 P**：直接消费原始事件流（不走 `deriveMessages`）；id 派生：消息 id=首条 chunk seq / user·message seq；part id=首个引用该 block index 的 chunk 事件 seq；`turnId`=turn/start seq；wire 不暴露 block index。tool 按 `CallId` 合并 call/result 为单节点（分支完备：result 先到暂存、只 call 无 result 保持 running、unknown tool 走 generic fallback），card 一致性由投影层保证。**system/上下文注入投诊断投影**，不进普通 timeline。物化快照 = fold(P(log))，**天然含进行中 partial**。
  事件覆盖纪律：P 的事件表**必须覆盖 `steering/message`**（用户插话进普通 timeline）；compaction 产生的合成事件（`source:plugin` 的 replace 类 user/message、compact 后的 assistant/message 改写）**documented-ignore 或投诊断**，不投成用户气泡；harness `SessionEventMap` 是 **merge-extensible union——P 用 documented default 落底**（未知事件计数+忽略，不用 assertNever）。
- **审批/问答 Registry**（一期内存实现，port 形状=未来 core 原生形状）：**Host 级单例**（harness 的 answerer/provider 注册只许一次，且审批可在无 channel 时到达；per-channel 只做纯投影读取）。稳定 id + revision（pending=1→terminal=2）+ **单一 CAS**（answer/cancel/timeout/shutdown 竞争，winner 写终态）+ `anchorSeq`（收到 ask 时的 session seq，供时间线插位）+ pending 计数入 Host 投影；channel 重开时 pending 注入基线快照（Host 存活期恢复）；`expiresAt` 的唯一 owner = Registry（到期即 CAS 终态）。UI answerer 对 foreign 请求 `next()` 委让。`UiQuestion` 是多题数组（一次 ask 多 item，整批原子答）。
- **SessionIndex**：内存 materialized view + index revision + keyset 切片（backend 只有全量 list 时的第一版实现；range read 留 `SessionLogReader` seam）。`updatedAt` 只随 durable 边界推进；title 状态机 `default→generated(一次)→manual(永不覆盖)`，metadata CAS per-session 串行。metadata 存 ui-host 自有 sidecar store（`~/.dsc/` 下按 host 数据目录），**不写 session 日志**（title 非模型可见）。
- **`applyMutation` reducer** 在 `dsh-ui-protocol`（纯函数）；`SessionTree = Record<id,node> + order[]`；server fold ≡ client 贴 live（等价律进一致性测试）。

### 5.2 dsh-ui-server（传输层）

`HostEndpoint`（普通 class，非 Cordis service）+ AuthGate + `ClientSlot` + `HostStream` + `SessionMux`（per-channel 有界队列，durable 溢出→该 channel resync，live 溢出→丢弃；round-robin 防单 channel 霸占为实现期附注）+ `NodeSseWriter`（tryWrite→written/backpressured/closed + waitForDrain）。**域层入口二次 generation 检查**（HTTP 入口检查不够，admission commit 的无 await 临界段内复查）。**同 session 写命令串行 lane**（防 rename/model/prompt 交错）。依赖 `dsh-ui-protocol` + 自声明的 `UiHostPort` 接口（依赖反转，apps/server 组装），不 import dsh-ui-host。
**`UiHostPort` 方法逐一标注 `unary` / `stream`**（ui-apiproxy 的 API 面约定，零 HTTP 语义）：unary = 单次调用单次返回（prompt/cancel/审批问答回复/创建重命名/model/provider/列表分页/历史窗口），stream = 持续推送订阅（host 投影流、session channel 帧流）。本层的职责就是把 unary 映射到 HTTP request/response、stream 映射到两条 SSE；Electron 进程内 fetch、TUI worker RPC 是同一 port 的另两种承载（预留）。

## 6. 输入与发送

- steer=`agent.steer`（当前轮插话）、queue=`agent.send`（排后续轮）、stop=`agent.cancel`（清两 FIFO + abort 当前 step）；空闲发送即开轮。1:1 映射，无中间队列。
- 纪律：不假设一发送一 turn（开轮可 drain 多条）；无 `cancelling` 产品态；`agent/queued`→`whenIdle` 之间 server 维护 busy bit（覆盖 send 后 status 未切 running 的短窗）。
- 排队项刷新后不可见（产品 §4 已声明边界）；队列上限由 Host config，超限回 Host 明确拒绝码。

## 7. Provider、模型与 adapter generation

- 单活动 Provider；**`ProviderCommitSlot`**：同时只一个保存事务，第二个立即 409 busy 不排队。保存 = **Host-owned operation**（202+operationId，HTTP 断开继续跑，终态走投影）。
- 事务序：校验 expectedRevision → 候选隔离 → **连接 probe（判据=真实 drain 一次最小 stream 见合法 terminal finish，HTTP 200 不算）** → catalog 准备（discovery 失败 ≠ 事务失败，标 stale）→ stage 临时文件 → rename 前完成全部可失败步 → **原子 rename = 持久线性化点** → 同一同步调用栈内完成 catalog activate + 活动指针 swap + **同步 dispose 旧 generation → register 新 generation**（同 tick 内无解析空窗）→ 发布投影。
- generation lease：`retiring` 拒新用、在飞 stream 持旧代到自然结束、引用清零才 dispose（取 lease 时机 = stream 首次迭代）。Catalog 五级：remote→builtin→last-success+stale→builtin+stale→empty+stale。legacy 精确 `registerAdapter` 与 UI 活动 Provider 撞 model 路由 → fail loud `AMBIGUOUS_ADAPTER_ROUTING`。
- API Key 明文 `~/.dsc/` owner-only（0600）；公开投影只含 `hasApiKey`；settings 读接口可回明文（同 realm 可信）；日志/事件/诊断统一脱敏；不读环境变量。原子写用 ui-host 本地 helper。
- 持久记录 `PersistedProviderRecord` **含 last-good catalog 字段**；表单只改 baseURL 不重输 key 走显式 `keepExistingKey` 分支（空 key ≠ 清除）；`~/.dsc/` 文件布局在 04 给出。

## 8. 前端架构

- **Cordis root Context** 只承载 4 基础 Service（Transport/Config/PlatformCapability/Clock）；数据态在 **Zustand slice**；**Controller**（纯 TS，Context 下发）消费流写 store：Connection / HostProjection / SessionChannel / Submission / Approval / Question / ProviderSettings / Scroll。
- **写路径唯一**：Controller 暴露 typed intent 方法 = 唯一命令面；React 组件只经 `ReactRuntimeBridge` 的 `useSelector`/`useIntent`，不直呼 controller、不拿 Context、不碰 transport。
- **store 纪律**：写入必带 generation/epoch 参数，过期写只记 debug（五层迟到 fence：attempt / hostInstanceId / connectionGeneration / channel / operation）；禁跨 await 持 Immer draft；selector 禁读 wall clock（倒计时走共享 tick store）。
- **刷新恢复主路径**：bootstrap 响应的 `resumedChannels` 是 cursor 事实源；`focusedSessionId` 经 StoragePort 持久恢复；provisional 按 §4.4 commandId 转正或按边界丢弃。
- **ScrollController**：命令式持 DOM ref，只把「贴底/有新内容」写 store，不逐 token setState；向上翻页前插锚定（useLayoutEffect + 稳定 item id）留分页实装时启用。
- 三端注入面（Electron 预留接缝，一期定型）：`mount(el, bindings)`，`HostBindings = { endpoint, platform: PlatformCapability, storage: StoragePort, clock? }`；`PlatformCapability` 必选 `openExternal/notify/getAppVisibility/onVisibilityChange` + 可选桌面能力 + `capabilities` 探测。

## 9. Electron / TUI（架构预留，一期不实现）

设计全量保留在 `07-electron.md`（预留蓝图）：四 realm（main/preload/renderer/sidecar），**Session 业务只走 localhost Client Protocol 不走 IPC**；sidecar 自己 `listen(0)` 回报（拒预占端口 TOCTOU）；main 预置 HttpOnly cookie（AuthGate 的 cookie 实现），renderer 不持长期 token；`QuitCoordinator` single-flight 状态机 + **if-idle 原子退出**（fence admission → 复查权威活动 → busy 则恢复；**活动权威在 Host 侧 control channel，不信 renderer 自报**；unknown ≠ 零活动）；parent channel EOF → sidecar 自行 cancel-active 停机（防孤儿）；updater 仅 graceful completed 后 handoff；强杀 await 真实进程树退出。TUI：换 worker front door（`UiHostPort` 反转就是接入位）。

## 10. 包结构与并行填空工作包地图

### 包（五库 + apps；一设计层 ↔ 一包 ↔ 一 worktree）

| 包 | 对应设计层 | 内容 | 依赖 |
|---|---|---|---|
| `packages/host/dsh-ui-protocol` | 01 | zod wire schema、branded id（分族：identity / 各资源专属 revision / cursor×2 / generation / streamId）、`applyMutation`、帧/端点/错误码 | dsh-brand |
| `packages/host/dsh-ui-host` | 03/04/08 | HarnessRuntimeAdapter + 9 窄 port + 投影 P + SessionIndex + 审批/问答 Registry + Provider 事务 + metadata store | protocol + harness 各包 |
| `packages/host/dsh-ui-server` | 02 | HTTP/SSE front door、AuthGate、ClientSlot、HostStream、SessionMux；自声明 `UiHostPort` 接口 | protocol（**不依赖 ui-host**） |
| `packages/client/dsh-web-runtime` | 05 | transport client、Controller、Zustand store、reducer 接线（React-free，零 react import） | protocol |
| `packages/client/dsh-web-ui` | 06 | ReactRuntimeBridge 消费、组件、slot、markdown、`mount(el, bindings)` | web-runtime |
| `apps/web` / `apps/server` | — | 组装入口（apps/server 把 ui-host 实现接到 ui-server 的 UiHostPort）；`apps/electron` 目录预留 | leaf |

runtime↔ui 的唯一跨包面 = `ReactRuntimeBridge`：runtime 暴露 store 订阅（`subscribe/getSnapshot`，`useSyncExternalStore` 兼容）+ typed intent；ui 只消费 bridge。
开发期只保各包 `build` 过；PR 前跑 CLAUDE.md 全量门禁；前端测试策略另定（不套 per-file 100%）。

### 并行批次

- **B0（唯一串行，定稿后立即做）**：`dsh-ui-protocol` 全量冻结（含一致性测试脚手架：fold≡live 等价律、cursor 重放、乱序容忍、resync、断开语义、刷新接管 fencing 序）+ 五包脚手架/冻结 barrel/tsconfig + MessageSource 透传 spike。
- **B1（全并行 worktree，互不改同文件）**：W1 ui-host 投影+port（fixture 事件流驱动，离线可测）｜W2 ui-host 审批/问答/metadata/SessionIndex｜W3 ui-host Provider 事务｜W4 ui-server 传输+conformance｜W5 web-runtime 连接/store/controller（fixture SSE）｜W6 web-ui 对话流组件（fixture 树，完全离线）｜W7 web-ui 列表+设置页｜W8 markdown 栈｜W9 ui 原语/主题｜W10 apps 组装+e2e 脚手架。
- **B2**：垂直集成（真 harness 起流跑通对话）→ 审批/问答/steer 批次 → 打磨。
- 冲突控制：跨包只经 protocol 与 UiHostPort 两个冻结契约；包内共享 barrel 在 B0 冻结；发现新契约缺口只准报告主线，不准私改。

## 11. 插件

一期只做两件事（产品 §13 口径）：
- **服务端插件列表展示**：`PluginStatusSource` port 读 Node 侧插件加载状态/错误 → Host 投影 → 设置区诊断展示；不提供安装/移除/启停。
- **Browser Cordis Context 能力地基**：前端运行时以 Cordis root Context 组织（§8），为未来 UI 插件提供挂载面；slot seam（tool 卡片 renderer、侧栏功能页）只留架构位与类型约定，**不实装注册机制**。第一方 renderer 与 unknown fallback 始终存在。
Future（设计已收档，直接可用）：slot 注册实装（受限子上下文 + 受限 selector props）；单文件 self-registering CJS factory + SRI + 白名单 external 注入 + 严格 CSP（无 unsafe-eval）+ `PluginPort` 双工 typed RPC（HTTP 只回 frame admission、逻辑响应走反向帧、按 generation fence）。

## 12. 实施节奏与验证

节奏 = §10 B0→B1→B2。验证四层：①协议一致性测试（transport adapter 必过同一套：无空洞基线、乱序、cursor 重放、live 丢失、单 channel reset、断开语义、刷新接管 fencing 序）；②ui-host fixture 单测（port 窄 fake）；③Browser e2e（Playwright：刷新恢复承诺清单逐条、双 SSE 断连矩阵）；④snapshot（transcript 变更走仓库既有 snapshot 机制）。首个 spike = MessageSource 透传验证（§4.4）。

## 13. Future Work 与 core 迁移 seam

| 项 | 一期状态 | core 支持后迁移点 |
|---|---|---|
| 问答/审批跨 Host 重启恢复 | 内存 pending，重启只读 interrupted | Question 落日志（照抄 approval `asked/decided` 事件对模板）；`ApprovalPort/QuestionPort` 换持久实现 |
| 排队项可见/单项取消/撤回 | 不做（产品已声明边界） | harness 队列项 ID + 单项删除 → `AgentDriverPort` 扩展 |
| mutation 幂等重放合同 | 仅 prompt 有界去重 | 领域 owner 提供 operation id + 幂等合同后在 `UiHostPort` 加重放（禁无界台账） |
| adapter 原子 replace | dispose→register 同步编排 | registry 原子 replace（改动量极小）→ `AdapterRegistryPort` 换实现 |
| `after=cursor` 精确续传 | 快照 + partial 收敛 | SQLite `WHERE seq>?` 一条查询；JSONL 跳行扫 |
| tool progress | 无 | harness 新 `tool/progress` 事件 |
| ToolPresenter 共享 | ui-host 原生实现 | 上提 `dsh-tools`（豁免裁决后），ACP 与 UI 共用 |
| writeFileAtomic 共享 | ui-host 本地 helper | 提取 `dsh-util` |
| 消息分支/编辑重生成、虚拟列表、LAN/多 client、双端 PluginPort | 不做 | 各自独立 seam，设计已收档 |

## 14. 小项决议（review 时可翻）

| # | 议题 | 采用 | 备选 |
|---|---|---|---|
| T-2 | MessageSource 透传 commandId | 采用，首 spike 验证；不通回退"user message 到达即替换 provisional"（wire 不变） | 直接用回退方案 |
| T-3 | ToolPresenter | ui-host 原生实现（消费 dsh-tools 原语） | clone 报警时上提 dsh-tools（需豁免） |
| T-5 | 设置页表单 | 手写 | schema→form |

---

## 附 A：关键决策演变（一次看全过程，正文不再重复）

> 本设计经历：本仓两轮（8 层类图 + 接缝对齐 + 合并修正）+ 与平行仓 harness-1（独立设计了同一系统三版）的平权综合 + harness core 源码逐条核实。每行 = 一个决策的走向；完整证据在 `missions/tasks/20260718-final-review/`。

| 决策 | 早期方案 | 最终结论 | 变化原因 |
|---|---|---|---|
| 一期范围 | Electron + Web 同期 | 只 Web；Electron 架构预留 | 用户收窄范围；同构约束保留使后补零改业务 |
| 命令回执 | CommandEnvelope + AdmissionReceipt + Host-lifetime 台账 | 全删；普通 HTTP status；仅 prompt 有界去重 | 两仓独立评审同向：台账换来自身未决的 eviction 复杂度，一期只有 prompt 真需防重 |
| 乐观 UI 缝合 | clientToken echo 进 receipt | MessageSource 透传 commandId（spike 验证） | receipt 已删；透传方案同时解决 command↔turn 显式关联，零改 core |
| durable/live 判别 | 帧上显式 `durable: boolean` | kind 闭合分类 + 01 导出分类器 | boolean 可与 kind 冲突；分类器单点定义防各层漂移 |
| 刷新恢复 partial | 不恢复进行中消息 | 快照/replay.completed 含 partial | 纯 server 内存可实现，直接抬高下限体感 |
| replay 窗口 | 无显式窗口（隐式约定） | replay.started/completed 帧 | 重放与 live 交错需要显式无空洞保证 |
| 错误模型 | 单层 9 个错误码 | 五 category 两级 + HTTP status 分层 | category 决定恢复动作（重连/重 bootstrap/呈现/重同步），比平铺码更严谨 |
| 鉴权 | 随机口令 Basic → 一次性链接换 cookie | 裸 localhost 免登录 + AuthGate 接缝 | 用户拍板体验优先；cookie 设计收档，接缝保留 |
| 审批/问答 Registry 位置 | per-channel 投影内 | Host 级单例 + per-channel 纯读 | harness 注册只许一次；审批可在无 channel 时到达 |
| Registry 排序锚 | 按到达顺序 append | anchorSeq 显式锚 | 显式 id 强关联原则 |
| session 列表 | 全量返回 + 本地筛选 | server keyset 分页；Host 投影不嵌全量列表 | 量大时性能/一致性；两处数据源矛盾消除 |
| ToolPresenter | 上提 dsh-tools 共享 | ui-host 原生实现，上提留 future | 源码核实：并未上提过；一期不动 core 组包 |
| adapter 替换 | 先 register 新再 dispose 旧 | 同步 dispose 旧 → register 新 | 源码核实：重名注册抛 DUPLICATE_ADAPTER |
| 后台任务活动 | `ctx.tasks.list()` 直读 | 逐 agent 聚合 / onTaskDone 计数 | 源码核实：list 按 caller session 过滤 |
| 事件订阅 | 未指定位置 | 必须 root context | 源码核实：scope-filtered dispatch |
| 包结构 | 三组粗切（host/client/apps） | 五库包 + UiHostPort 反转 + bridge 唯一跨包面 | 一层一包一 worktree，最大化并行填空；TUI 接入位 |
| SWR | 列表/设置用 SWR | 不用，统一 Controller+store | 仅剩两个用例不值引入第二数据通路 |
| Submission 队列 | （harness-1 曾设计 SubmissionQueue/durable facts 全家） | 不建第二队列，AgentDriverPort 薄映射 | 两仓独立终裁同向：不复制 core 状态；差距钉成迁移边界 |

## 附 B：术语

| 术语 | 含义 |
|---|---|
| 投影 P | harness 原始事件 → SessionMux 帧 / 物化树（含 partial）的 ui-host 逻辑 |
| `applyMutation` | 可 fold 帧 → UI 树 reducer；server fold ≡ client 贴 live |
| ClientSlot / connectionGeneration / streamId | 单客户端槽位 / 刷新换代 fence / 单次物理流 fence（三层各司其职，均不承担业务幂等） |
| replay 窗口 | `replay.started…completed` 之间的 durable 重放段，completed 附 partial 快照 |
| UiApproval / UiQuestion | 两类独立交互资源 wire DTO：稳定 id + revision(1→2) + 单 CAS + anchorSeq |
| MessageSource commandId | send 时随 merge-extensible source 落日志的命令关联 id，provisional 转正依据 |
| HarnessRuntimeAdapter / UiHostPort | 唯一读 ctx 的组合期装配 / ui-server 消费 ui-host 的反转接口（TUI 接入位） |
| AuthGate | 传输层鉴权接缝；一期 allow-all，Electron/LAN 换实现 |
| ProviderCommitSlot / AdapterGeneration | 保存事务互斥闸 / 不可变 adapter 代（dispose 旧→register 新，lease 到自然结束） |
| steer / queue / stop | agent 两条 FIFO 的 1:1 映射 + 整体取消 |
| partial 恢复 | 快照/replay.completed 携带进行中消息已生成部分 |
