# 多 client 并连可行性调研报告

2026-07-20 · owner: multiclient-research · 方法：读码逐段核对 + dsc web 实测（curl 双 SSE / playwright 双浏览器 / 同浏览器多标签连接池探针）。只调研，未改任何产品代码。

**一句话结论：目标场景（双网页同开同一 session，一边发送另一边 token 级实时看流，草稿各自独立）在当前代码上已经完整工作，零改造。** 设计文档口径「多 client 行为未定义」比代码实况保守——代码是天然 fan-out 的。唯一实际边界是 HTTP/1.1 浏览器每源 6 连接上限：同一浏览器开到第 3 个标签页会饿死（实测复现），双标签页/双浏览器均无碍。

---

## §1 逐段分析

### 1.1 server 侧广播（关键段）——每流独立队列 + ctx 事件天然 fan-out ✅

- **每次 GET 都是独立流**：`packages/host/apiproxy/src/fetch/handler.ts:97-98`，每个 `GET /api/events.mux` 调一次 `api.events.mux(...)`，没有任何共享/复用。
- **每次调用新建独立 FrameQueue**：`packages/host/runtime/src/api-proxy.ts:216`（`mux()` 内 `new FrameQueue`）、`:232`（`host()` 同构）。队列是调用局部变量，不存在全局单例队列或「最后写入者胜」。
- **每流一份 ctx 订阅**：`api-proxy.ts:220-227`，每个流自己 `ctx.on('session/event', ...)` / `ctx.on('session/created', ...)`。Cordis 事件是广播语义——core 每 emit 一次 `session/event`，N 个活跃流的 N 个回调各推一帧进各自队列。**fan-out 是结构自然结果，不是特意实现的**。
- **清理是每流的**：`api-proxy.ts:228`（`queue.iterate(signal, () => disposers 逐个 dispose)`），配合 `FrameQueue.iterate` 的 abort 监听（`:75-89`）。一个流断开只拆自己的订阅，不碰别的流。
- **信封 rpcId 每流独立 mint**（`api-proxy.ts:93-95`，`frame()` 在每流回调内调用）——两个流收到同一事件的信封 rpcId 不同，payload 逐字节相同（实测证实，见 §1.7 E1）。
- 唯一发现的「单 client 假设」痕迹：**没有**。没有任何 client 标识、slot、互斥或过滤逻辑。

### 1.2 webserver 桥——每请求独立，无共享状态 ✅

`packages/host/webserver/src/index.ts:45-57` 每个请求进独立 handler 闭包；`:76-102` bridge 每次新建自己的 `AbortController`，断连检测挂在各自 response 的 `close` 上（`:83-85`）。Node http 天然多连接，桥无任何跨请求状态。`close()` 的 `closeAllConnections`（`:60-63`）只在关停时用。

### 1.3 client 侧独立性——每 tab 一份完整 runtime，草稿隔离天然成立 ✅

- 每个 tab 各跑一份 `bootWebRuntime`（`packages/client/web-runtime/src/boot.ts:18-30`）：各自的 WebApiClient、ConnectionController、SessionManager。
- `SessionManager` 是**模块级单例**（`manager.ts:198-210`）——单例作用域是每个 JS realm（每 tab 一个 realm），跨 tab 互不知晓。
- **无跨 tab 共享通道**：全 web-runtime/web-ui 源码 grep 无 `localStorage`/`sessionStorage`/`BroadcastChannel`/`indexedDB`（zustand store 也是纯内存，`store.ts:25`）。
- **草稿挂 Session 实例字段**（`session/session.ts:38` `private draft = ''`；`:115-119` setDraft），实例存活于本 tab 内存——「文本框不共享」**天然成立**，无需任何改造。实测证实（§1.7 E5）。
- ⚠️ 前瞻：step-session design F.8（`missions/tasks/20260719-2247-step-session-design/design.md:845`）预留「draft 加 localStorage 写透（key=sessionId）」——若将来做，同浏览器多 tab 的草稿会被这个 key **耦合**，届时需改 key 含 tab 标识或明确接受共享。

### 1.4 写路径竞争——core FIFO 天然吸收，rpcId 碰撞可忽略 ✅

- `packages/core/agent-loop/src/agent.ts:232-247`：`send()` 进 inbox FIFO（`#inbox.enqueue`），`steer()` 运行中插队、空闲降级为 send。多来源入队本来就是设计语义——**验证成立**：实测双 client 并发 prompt 同一 session，两个都 `accepted:true`，先后成两个轮次（seq 1786 / 1827），无错乱（E2）。
- rpcId 由各 client 自己 mint `crypto.randomUUID()`（`packages/host/apiproxy/src/fetch/client.ts:108-111`）——UUIDv4 碰撞概率可忽略，**不需要 client 标识**。rpcId 只用于单请求应答回执核对（`client.ts:126`）和 `user/message` 的 source 关联（`api-proxy.ts:179`），都不要求全局跨 client 唯一性协调。

### 1.5 一致性边界——路径上没有「只给发起者」的过滤；体验对称（无乐观回显）✅

- 事件路径：core emit → 每流 ctx.on 回调 → 每流队列 → SSE 写出（§1.1），**全程无 initiator 过滤**。client 侧 `manager.ts:123-145` 按 sessionId 派发帧，也无来源判断。
- **当前实现没有乐观回显**：`session.ts:78-95` `sendDraft` 只是清空草稿+发 RPC，不插临时消息；发起方自己的 user 气泡也是等自己 mux 流上的 `user/message` 真帧回来才渲染。所以**两边体验完全对称**，不存在「发起方先看到、对侧后看到」的 provisional 差异（任务书里预设的这个差异实际不存在）。对侧看到 A 的消息里 `source.rpcId` 是 A mint 的 id——B 不认识它，无副作用。
- 实测（E5/E6）：B 页面在 A 发送后 **305ms** 内看到内容出现，且 DOM 在 400ms 采样间隔下连续 4 次增长——token 级流式在对侧实时渲染成立。

### 1.6 设计口径 vs 代码实况——文档比代码保守

| 文档声明 | 位置 | 代码实况 |
|---|---|---|
| 「单客户端互斥（ClientSlot）v1 不实现：第二个页面各自收流，**行为未定义但不崩**」 | apiproxy design.md:362 | 保守了：行为完全定义且正确（fan-out + FIFO） |
| ClientSlot / connectionGeneration / streamId fencing 列入不做清单 | apiproxy design.md:372 | 目标场景不需要它们 |
| 验收表：「第二个浏览器页签打开同 session → 两页签同步收帧（行为未定义但不崩）」 | step-session design.md:826 | 实测两页签同步收帧、双向可发 |
| F.13 排除项：多 client 互斥 / since 续传 / rpcId 幂等 | step-session design.md:850 | 均不阻塞目标场景（断线靠 resync 全量重拉，`session.ts:167-178`） |
| 「resolved 帧是收敛面：多 client 同看一 session 时别人答掉靠 resolved 撤卡片」 | core-coverage.md:142 | 协议**本来就为多 client 设计**了审批收敛；respond 目前是 stub（`api-proxy.ts:257-259`），与单/多 client 无关 |

### 1.7 实测记录（server: `dsc web` @3080，均可复现；脚本在本目录）

| # | 实验 | 结果 |
|---|---|---|
| E1 | 双 curl SSE 挂 mux + 第三连接 prompt | 两流各收 59 个 `assistant/chunk`，去掉信封 rpcId 后**逐字节相同** |
| E2 | 双 client 并发 prompt 同一 session | 双双 accepted，FIFO 成先后两轮，两流一致；`user/message.source.rpcId` 各带发起方 id |
| E3 | 双订阅 events.host | 两边同步收到 `running:true→false` |
| E4 | 一条流 6s 断掉，另一条继续 | 幸存流完整收完 50 chunk + 终帧；server 无恙 |
| E5 | playwright 双浏览器 context 同开一 session | 草稿隔离 PASS；B 305ms 看到 A 的发送 PASS；A 发送后 B 草稿原样 PASS；B 刷新恢复历史 PASS |
| E6 | B 页 DOM 增长采样（A 发长回复） | 400ms 间隔连续 4 次增长——对侧流式实时渲染 PASS |
| E7 | **同一浏览器 context** 3 标签页 | tab3 列表都加载不出、tab1 的发送 POST 被连接池卡死（30s 超时）——HTTP/1.1 每源 6 连接上限（3 tab × 2 SSE = 6 占满）；**2 标签页对照组全 PASS** |

## §2 结论矩阵

| 目标场景子项 | 判定 | 依据 |
|---|---|---|
| 双开 session 列表 | **已支持** | E5/E7（2 tab）；list 是无状态 unary |
| 双开同一 session 收流 | **已支持** | §1.1 fan-out；E1/E5 |
| 对侧 token 级流式实时 | **已支持** | E6：DOM 连续增长；305ms 首现 |
| 双向发送（两边都能发） | **已支持** | §1.4 FIFO；E2 |
| 草稿隔离 | **已支持**（天然） | §1.3；E5 |
| 刷新互不影响 | **已支持** | E4（断流不伤别人）+ E5（B 刷新恢复） |
| 同浏览器 ≥3 标签页 | **不支持**（部署边界，非架构缺陷） | E7：HTTP/1.1 每源 6 连接上限 |

## §3 改造清单（目标场景本身：**零改造**；以下为可选加固）

| 项 | 改什么 | 量级 | 风险 | 必要性 |
|---|---|---|---|---|
| HTTP/1.1 连接池边界 | 三选一：dsc web 换 HTTP/2（node:http2 h2c，webserver 包内）／两条 SSE 合一条／SharedWorker 共享单连接 | h2c 约百行；流合并约几十行（协议改动）；SharedWorker 中等 | h2c 需验 fetch 兼容；流合并动契约 | 仅当要求同浏览器 ≥3 tab 时 |
| FrameQueue 无界缓冲 | `api-proxy.ts:59` 加上限+断流策略（慢消费者踢掉走 resync） | 约 20 行 | 低 | 多 client 放大内存风险，建议顺手做 |
| mux 全量广播 | 目前每流收**所有** session 的事件；按订阅过滤是带宽优化 | 中 | 低 | session 多了才需要，与多 client 正交 |
| F.8 草稿 localStorage | 若实施，key 需含 tab 标识否则破坏隔离 | 备忘 | — | 未实施，仅前瞻标注 |

## §4 工程复杂度总评

**S**——目标场景当前代码已 100% 支撑，实测端到端全绿，改造量为零；唯一要花钱的是「同浏览器 3+ 标签页」这个超出目标的部署边界（M 级，可后置）。

**建议：做（准确说：宣布支持）。** 把设计文档里「多 client 行为未定义」的口径升级为「双 client 同 session 为已验证支持场景」，把 E1-E7 脚本沉为回归用例；FrameQueue 加界顺手做；HTTP/2 / 流合并等到真有 ≥3 tab 需求再立项。
