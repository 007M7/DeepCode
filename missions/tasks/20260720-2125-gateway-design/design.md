# Client Gateway 设计 — host 侧标准化 client 底盘（下行分发切面）+ 可插拔特殊功能

> 状态：草稿 v4，供用户终审。版本脉络：v1 初稿 → v2 轻底座/侵入性两案/peer 独立/
> opencode 调研 → v2.1 blueprint 对表 → v3 底盘+插槽两层 → **v4 按用户拍板「gateway
> 还是做方案一」：下行帧的统一出口从建议锚升格为切面硬机制——所有下行帧（core 帧
> + feature 注入帧）一律过底盘分发切面，单一咽喉；上行 unary 仍直通**。
> 作者：gateway-design，2026-07-20。
> 红线：harness core 零改动；live 控制帧不进 session log；「model-visible⟺logged」不破。
> 材料：multiclient report / blueprint-v2 §6a / web-cordis 正式稿 / conventions 均已读原文。

## 0. TL;DR

- 架构两层不变（v3），但下行通路按用户拍板改**切面硬机制**：
  - **标准化底盘（stable core）**：`Gateway`（命名候选 §2.5）= clients Map
    （clientId 铸造/注册/linger/dispose 级联）+ **下行分发切面**——per-client
    连接对象各拥有自己的 FrameQueue（切面内部实现，§2a.3），**所有下行帧统一经
    `send(clientId, frame)` 定向 / `broadcast(frame)` 扇出两个动词入队**，帧序/
    定向正确性/观测/将来的过滤与背压全部收在这一个咽喉。底盘仍**零业务语义**。
  - **特殊功能（feature modules）**：`GatewayFeature` 接口（§5）不变；
    queue-mirror 第一个 feature（§4），T4 审批第二候选，加功能零动底盘。
- **core 帧的生产与分发拆开**（对 v3 案一反对理由的正面回应，§2a.2）：帧生产
  （session/host 事件监听 + openCalls 呈现视图计算）收敛为 impl 侧**单例
  producer**（一套监听，不再 per-stream 复制），产出的帧调 `gateway.broadcast()`
  进切面；底盘只收帧不产帧，「底盘零业务语义」不变量完好。
- mux()/host() impl 瘦身为「attach 取流 + 重放」；FrameQueue 所有权移入底盘
  ClientConn（推荐案，§2a.3）。一次性重构量如实重评于 §2a.4/§6。
- 定序升级为**结构保证**：core 帧经切面同步入队，feature 帧经切面微任务合批
  入队——事件帧先于控制帧不再依赖任何注册顺序（§4.5）。
- client 身份（hello 握手/header 聚合/匿名 ephemeral/linger）、重放注册序、
  命名候选、F-1 刷新分叉、peer 独立定调全部维持 v3 不变。
- 上行（unary client→host）**不过切面、照旧直通**——用户从未要求动上行；执行
  语境解读与待确认项见 §2a.1 标注。

## 1. 背景与问题

### 1.1 现状：多 client 零改造可跑，但没有 client 概念

multiclient-research 实测结论（report 原文已读）：**目标场景（双网页同开同一
session、一边发送另一边 token 级实时看流、草稿独立）当前代码零改造已完整工作**——
Cordis 事件天然 fan-out：每次 `events.mux()` 打开各自建 `FrameQueue`、各自注册一套
`ctx.on(...)`（api-proxy.ts:359-394，重排后 HEAD 树），实测双浏览器对侧 305ms
首现、逐字节一致。

但「能跑」不等于「有身份」，且各流各建监听有实费：

- host 侧完全没有 client 概念——没有任何 client 标识、聚合或归属逻辑；一个浏览器
  页面 = 两条互不相识的 SSE 连接 + 若干匿名 POST，各流各连各死。
- **每流一套监听 + 一张 openCalls 视图表**：同一 core 事件的呈现视图计算随连接数
  线性复制（N 个 client 算 N 遍）；report §3 还点了 FrameQueue 无界缓冲的加固项
  ——这些分散在每流闭包里，没有统一的治理点。
- 没有连接聚合，「谁在线」、T4 审批「谁应答的」、排队输入可见性都无处落脚。

### 1.2 触发需求：输入排队互不可见

两个浏览器（A、B）看同一 session：

1. 对方 turn 运行中，A 以 queue 模式提交输入。
2. host 侧 `agent.send()` 把输入放进 core inbox FIFO——但**未达模型不进 log**
   （`user/message` 事件要等 turn 开启抽干 FIFO 时才产生），mux 流上没有任何帧。
3. 结果：B 看不见 A 排了什么；A 自己刷新后也看不见（历史里没有）。

同步只能靠 **host 侧维持的广播状态**：core 的 FIFO 语义一字不动（红线），在 host
层为「已受理未定格」的输入维护一个镜像，用 live 帧广播、重连重放恢复。

### 1.3 同族需求不止一个——这正是拆底盘的理由

「host 内存态 + live 帧 + 重连重放」的消费者已在册两个，且可预期继续增加：

| 消费者 | 内存态 | live 帧 | 重连重放 | 状态 |
|---|---|---|---|---|
| 输入队列镜像 | 按 session 分键的 entry 列表 | `queue/updated` 快照 | subscribed 后快照重放 | 本文第一个 feature |
| T4 审批/提问 pending registry | pending Map（稳定 rpcId） | `approval/requested`/`resolved`、`question/*` | subscribed 后 requested 帧原样重放 | 契约已在 events.ts，impl 挂起（respond 是 stub）；第二个 feature 候选 |
| （将来）presence、typing、tool 进度… | 各自 | 各自 | 各自 | 同形态接入 |

共性下沉为标准化底盘的公开插槽，每个消费者一个可插拔 feature 文件——加第 N 个
功能底盘零改动。（peer hold 账本不在此列：归 peer 域 ClientPeerProxy，§6a.3
原文确认，见 §2.6。）

### 1.4 社区对照：opencode 怎么做（只看 opencode，本机源码实读）

读了 `packages/opencode/src/server/`（SSE handler、routes）、`session/`（prompt、
run-state、status）、`sync/README.md`、CLI `run/runtime.queue.ts`。三个问题三个答案：

**① server 侧有没有 client/connection 概念？——没有。**
SSE 入口（`server/routes/.../handlers/event.ts`）每个 GET 各建一个 unbounded Queue
订阅全局事件总线，按 directory/workspace 过滤后编码下发，外加 10s 心跳；连接之间
互不相识，全 server 无 clientID（仅 MCP OAuth 场景有同名无关概念）。与我们的
现状基线完全同构——匿名 per-connection 队列 + 总线扇出。

**② 多端输入怎么同步？——受理即持久，问题被溶解而非被解决。**
`session/prompt.ts` 的 `prompt()` 入口第一步就 `createUserMessage`：user message
**立即写入存储并经 bus 广播**，然后才进 per-session 串行 Runner（`run-state.ts`
`ensureRunning`：同 session busy 时新 prompt 排进同一 runner 队列）。「排队中
输入」天生是 durable 数据，所有 client 经常规事件流即刻可见——不存在我们这种
「已受理但未达模型不落 log」的内存窗口，自然不需要镜像/快照机器。其 `sync/`
体系（事件溯源、单写者、seq 全序、多设备重放）同样把同步建立在 durable 事件
日志上。（另有 client 侧局部队列 `cli/cmd/run/runtime.queue.ts`——TUI 直连模式
prompt 本地排队、开轮前可编辑/撤回，不上 server，恰好反证 server 无此概念。）

**③ session 数据流有没有 Gateway 类中介？——没有。**
存储+总线是唯一权威源，SSE 流是哑过滤器；没有按 client 路由/聚合的中介对象。

**对本设计的含义**：
- opencode 证明「多端看流」本身不需要 client 对象；我们引入切面的动机不是看流，
  而是**身份/一致定序/统一治理点/排队镜像**这些它靠受理即持久绕开的问题。
- opencode 的解法（受理即持久）**我们不能抄**：把排队输入写进 session log 违反
  「model-visible⟺logged」（log 只记模型真正经历的事，conventions #18）。它用
  持久化换同步；我们用 host 内存态+live 帧换同步——镜像是自家纪律下的最小补位。
- 其 per-session 串行 Runner 印证我们 core 的 FIFO 角色分工；其 TUI 本地队列的
  「开轮前可编辑/撤回」是将来可借鉴交互（本轮不做，core FIFO 无撤回原语）。

## 2. 对象模型：标准化底盘（下行切面）+ 可插拔 feature

用户口径四句话，即本节结构：「有一个面向对象的 Gateway + 一堆在 host 侧的 client
proxy，这个标准对象我希望是有的」（对象要有）；「可能只有 session 的维持状态需要
这个，其他 API 应该还是直通的」（上行直通）；「标准化指代的是统一 Map clients /
connection 订阅的分发」（底盘=集合+分发）；「gateway 还是做方案一」（**下行帧
统一过切面**）。

### 2.1 总览：底盘 + 插槽两层，下行单一咽喉

```
host 进程
├── ApiProxy impl
│   ├── unary（list/create/history/prompt/cancel/describe/hello）——直通，不过切面
│   ├── frame producer（单例，impl 侧）：一套 core 监听 + openCalls 视图表
│   │     └── 产出 MuxFrame/HostFrame ──→ gateway.broadcast(frame)   ↓帧不再自摸 SSE
│   └── events.mux()/host() impl：gateway.attachMux/Host(clientId) 取流（瘦身）
│
├── 标准化底盘 Gateway（单例；零业务语义——不知道 queue/审批/session）
│   ├── clients: Map<ClientId, ClientConn>      ← 注册表（"谁在线"唯一事实源）
│   │     └── ClientConn（per client）
│   │           ├── clientId: ClientId（Branded<'client-id'>，host 铸造）
│   │           ├── muxQueue / hostQueue: FrameQueue  ← 切面内部实现（§2a.3）
│   │           └── linger 计时 + dispose（注销自身，绝不触碰 session/agent）
│   ├── 下行分发切面（唯一入口，全部下行帧过此）：
│   │     send(clientId, frame)    ← 定向（不在线/未挂流静默丢弃——live 帧本性）
│   │     broadcast(frame)         ← 扇出到全部已挂流
│   │     （帧序、信封 rpcId 铸造、观测、将来的过滤/背压/加界都在这一点）
│   ├── 生命周期订阅：onClientChange(cb)        ← 两档粒度（流挂载断 / conn 注销）
│   └── feature 插槽：use(feature)              ← 注册序即重放序（§5）
│
└── feature modules（每个一文件，实现 GatewayFeature，可插拔）
    ├── queue-mirror（本文实装，§4）：订 core 事件维护镜像 → broadcast 快照
    ├── approval-pending（T4 落位时）：pending registry → replay 重推 requested
    └── （将来）presence / typing / tool 进度 … 同形态
```

关键不变量（v3 立、v4 不破）：**底盘的词汇表里只有 client、connection、frame
三个名词和 send/broadcast/replay 三个动词**。帧的**生产**（什么事件出什么帧、
带什么呈现视图）住 impl 的 producer 与各 feature；帧的**分发**（给谁、什么序、
怎么缓冲）住底盘切面。任何出现 sessionId/rpcId/approval 字样的逻辑不得进底盘。

### 2.2 底盘 API（stable core 的全部公开面）

```ts
/** 标准化底盘。业务无涉：管 client 集合 + 下行分发切面 + 生命周期 + feature 插槽。 */
class Gateway {
  // -- clients Map --
  hello(resume?: ClientId, label?: string): { clientId: ClientId; resumed: boolean }
  readonly clients: ReadonlyMap<ClientId, ClientConn>   // describe 读 size

  // -- 下行分发切面 --
  /** mux 开流：铸/取 ClientConn，建 muxQueue，依次注入 baseline（impl 提供的
   *  subscribed 帧生成器）与各 feature.replayFrames（注册序），返回可直接作为
   *  ApiProxy events.mux 返回值的流。断流（signal abort）自动 detach。 */
  attachMux(clientId: ClientId | undefined, baseline: (push: Push) => void,
            signal: AbortSignal): AsyncIterable<RpcRequest<MuxFrame>>
  attachHost(clientId: ClientId | undefined, baseline: (push: Push) => void,
             signal: AbortSignal): AsyncIterable<RpcRequest<HostFrame>>
  /** 切面动词：定向。core 帧同步入队；feature 调用走微任务合批（§4.5）。 */
  send(clientId: ClientId, frame: MuxFrame): void
  /** 切面动词：向全部已挂 mux 流扇出。信封 rpcId 在此统一铸造（一逻辑帧一 id，
   *  各 client 收到的信封逐字节一致——比现状每流各铸更强的一致性）。 */
  broadcast(frame: MuxFrame): void
  broadcastHost(frame: HostFrame): void

  // -- 生命周期订阅（feature 与将来 peer 层共用） --
  onClientChange(cb: (e: ClientChangeEvent) => void): () => void
  // e: { kind: 'attached' | 'stream-detached' | 'disposed'; clientId; stream? }

  // -- feature 插槽 --
  use(feature: GatewayFeature): void   // 注册序即重放序；boot 装配处调用
}
```

- `attachMux(undefined, ...)` = 匿名 ephemeral ClientConn（§3.3）。
- baseline 回调是 impl 的 session 语义（subscribed 帧），以参数形式经过底盘但
  底盘不解释内容——底盘只保证「baseline → feature 重放 → live」的顺序。
- 上行（unary）没有任何底盘 API——**切面只管下行**（§2a.1 语境解读）。

### 2.3 管辖边界表（防过度设计的正面清单）

| | 归底盘（切面） | 归 impl producer / feature | 不归 Gateway 体系（照旧直通） |
|---|---|---|---|
| **身份** | clientId 铸造（hello）、注册表、linger、dispose 级联 | — | 鉴权/权限（v1 全站无鉴权，台账 T-4） |
| **下行帧** | 分发：入队、帧序、信封 rpcId、fan-out、per-conn 缓冲、（将来）过滤/背压 | 生产：core 事件→帧的翻译、openCalls 呈现视图（producer）；控制帧内容（feature） | — |
| **上行 unary** | — | — | list/create/history/prompt/describe **全部直通 impl**；cancel 多一行调 feature 钩子（§4.5） |
| **session 维持状态** | —（底盘不知道 session） | queue 镜像 + 快照 + 重放；（T4）审批 pending | session/agent 生命周期（client 死不陪葬） |
| **client 间通信** | —（send/broadcast 是「host→client 帧」原语，不是 client↔client） | — | 定向 RPC/插件通信——peer 层（PeerGateway）的事 |

impl 与 Gateway 体系的接触点（v4 重列）：mux/host 开流各一次 attach（含 baseline
注入）、producer 出帧调 broadcast/broadcastHost、cancel 受理后调 queue feature 的
clear、describe 读 clients.size、hello impl 转发底盘 hello。**加第 N 个 feature
不新增接触点**。

### 2.4 ClientConn 职责清单

1. **身份**：持有 clientId 与元数据（connectedAt、label?）。
2. **队列所有权**：muxQueue/hostQueue 归 ClientConn 所有（切面内部实现，§2a.3）；
   同类流重复打开，后开顶掉前者（旧队列 end，避免僵尸流吃帧）。
3. **断线 linger**：两条流都断后启动 `clientLingerMs`（Config 字段，非硬编码）
   计时；期内重挂任一流则取消；超时 Gateway 注销并发 disposed 生命周期事件。
   **dispose 绝不触碰 session/agent**——session 是 host 资产。

### 2.5 命名候选（已对表 §6a.4 全部词汇，零占用冲突；用户挑）

| 候选 | 底盘单例 | per-client | 说明 |
|---|---|---|---|
| **N1（推荐）** | `ConnectionGateway` | `ClientConnection` | 载体味最正（管的就是连接聚合与分发切面）；与 peer 五词字面距离最大；缺点：per-client 对象聚两条流，「一条 connection」词面略窄 |
| N2 | `ClientRegistry` | `ClientConnection` | 完全不占 Gateway 一词，零混淆；但 v4 底盘是分发切面，比 registry 语义宽得多，名不副实 |
| N3 | `ClientGateway` | `ClientProxy` | 最贴用户原话；ClientProxy 与 ClientPeerProxy 一字之差最易混（§2.6 注记 1） |

正文暂用 N1 简写（Gateway/ClientConn），定名后全文替换。feature 接口名
（`GatewayFeature`/`ClientFeature`）随单例定名联动，定名时一并拍。

### 2.6 与 cordis peer 体系的关系：两个独立对象、各归各层（用户已定调；已对表原文）

对表依据（web-cordis 正式稿 design.md §1 + blueprint-v2 §6a.3/§6a.4 原文）：
PeerGateway/ClientPeerProxy/HostPeer 是 **host 插件内部**的组件——三层对象图
居中层，「宿主位置=apiproxy plugin.invoke 域旁、runtime 装配层挂载」，职责是
插件双向通信的 group 管理与 per-client hold/pending 账本。本设计的 Gateway 在
**外部**：apiproxy 载体层，服务 wire 连接身份与 session 状态广播。**不合并、
不做上下层视图关系**——两者服务的消费者不同（peer 服务插件半边，本层服务 web
UI 的会话呈现）。

**对表注记三条**：

1. **命名不撞车**：§6a.4 命名规则「无 Proxy 后缀=本体、Proxy 后缀=对岸实体在本
   进程的替身」；PeerGateway/ClientPeerProxy/HostPeer/ClientPeer/HostPeerProxy
   五词已被 peer 域占用。本层候选全部避开；N3 的 `ClientProxy` 按 §6a.4 规则
   语义成立但与 `ClientPeerProxy` 一字之差，故不推荐。
2. **生命周期语义有别，打通时显式桥接**：§6a.3 定「ClientPeerProxy 断线即
   dispose（hold 队列/pending 随清）」，而本层 ClientConn 有 linger 宽限。若
   clientId 打通（下条），peer 层订阅底盘 onClientChange 的 **stream-detached
   档**（断流即 dispose ClientPeerProxy，忠于 §6a.3）而非 disposed 档（linger
   后才发）；两档粒度底盘都发，peer 层自选——不替 peer 层改已拍语义。
3. **hold/pending 账本归属确认**：§6a.3/§6a.4 原文明确 hold 账本挂
   ClientPeerProxy——它不是本层 feature；本层 feature 只服务 web 呈现域。

**唯一连接点：clientId 语义打通（建议：打通，同一次铸造）。**
peer 层实装时**复用本层 hello 铸造的同一个 ClientId**（brand 类型同源），
PeerGateway 经 onClientChange 创建/dispose 自己的 ClientPeerProxy：一个真实
浏览器 = 全 host 一个「谁」。不打通则将来要建第二张映射表。打通的只是 id 与
生命周期通知，两层对象各自独立。

## 2a. 切面决策：下行单一咽喉（方案一，用户拍板）

### 2a.1 语境解读（执行口径 + 待确认标注）

用户问过「gateway 当成标准切面看输入输出能否一致性」，随后拍「gateway 还是做
方案一」。本稿执行解读：

- **解读 A（本稿执行）**：「方案一」= §2a 两案里的改道方向，落成**下行切面**——
  所有下行帧（core 帧 + feature 帧）统一过底盘 send/broadcast 入队，帧序/定向/
  观测收单点；**帧生产仍留 impl 侧**（单例 producer，见 2a.2——这是对 v3 反对
  理由的消解，不是对抗用户拍板）；**上行 unary 不过切面**（用户从未要求动上行，
  「输入输出一致性」中的输入按「client 的输入经 unary 直达 impl、其结果以下行帧
  统一出口回看」理解）。
- **解读 B（字面案一，未采纳，标注待确认）**：Gateway 连帧生产一起收编（唯一一套
  监听 + openCalls 视图都进 Gateway）。未采纳理由：呈现视图是 session 语义，进
  底盘破坏「零业务语义」不变量（v3 分层是用户上一条已拍口径）；解读 A 已交付
  方案一的全部实益（单一咽喉）而不打架。**若用户本意是 B**（或含上行切面的更宽
  读法），§2.1 对象图中 producer 移入 Gateway 即可（或另拍上行方案），分发切面
  设计不变——差异被隔离在 producer 归属一格，返工面小。

### 2a.2 v3 反对改道的理由，在 v4 怎么正面回应

v3 反对案一的三条理由与现在的回应：

| v3 反对理由 | v4 回应 |
|---|---|
| ① openCalls 呈现视图被迫进 Gateway，底盘染业务语义 | **生产/分发拆开消解**：视图计算收进 impl 侧单例 producer（还是 impl 的地盘），底盘只收成品帧。底盘纯度不降反升——v3 里 impl 每流闭包还各抄一份视图表，v4 收敛为一份 |
| ② 动主干、改动量大 | 承认：mux()/host() 通路一次性重构（量化 §2a.4/§6）。**用户知情拍板选了切面收益**（单一咽喉的帧序/观测/治理），此代价是明码标价的交换；且重构主体是**代码搬家**（监听+视图表从 per-stream 闭包平移进单例 producer），不是重写逻辑 |
| ③ 故障半径：Gateway 挂了帧流全断（旁挂案里帧流照跑） | 承认半径变大，缓解见 2a.5：底盘小而稳定（一次写成后加功能零改动）、per-conn 推送异常隔离（一个坏连接不拖累其他）、**feature 异常不进 core 帧路径**（feature 只经切面注入，producer→切面的主通路不经过任何 feature 代码）——半径实际收敛为「底盘自身 bug」，而底盘是全系统最小、最少变更的部件 |

净收益（切面独有，旁挂给不了）：
- **一套监听/一份视图表**替代 per-stream 复制——per-event 开销不再随 client 数
  线性增长（report §1.1 实测的重复计算消除）。
- **信封 rpcId 统一铸造**：一逻辑帧一 id，各 client 收到的信封逐字节一致（现状
  E1 实测 payload 相同但信封 id 各异；T4 答复帧的稳定 id 语义与此同源）。
- **统一治理点**：report §3 点名的 FrameQueue 加界/慢消费者踢流（台账 T-8）、
  将来的 per-session 订阅过滤（report §3 带宽优化项）、帧观测——全部单点落地。

### 2a.3 FrameQueue 与切面的关系（给推荐）

两个选项：

- **推荐：FrameQueue = 切面内部实现**。per-connection 队列（muxQueue/hostQueue）
  归 ClientConn 所有，FrameQueue 类随之移入 gateway.ts（或 util 化）；attach 返回
  的 AsyncIterable 就是该队列的 iterate。理由：队列是纯载体缓冲（无业务语义，
  进底盘不破词汇表）；切面「决定给谁 + 实际入队 + 断流清理」原子闭环在一处，
  加界/踢流（T-8）才有落点；impl 不再持有任何缓冲——「咽喉」名副其实。
- 备选：FrameQueue 留 impl（切面下游）——切面只做路由决策、回调 impl 入队。
  否决理由：咽喉被劈成「决策在底盘、缓冲在 impl」两截，背压/加界/观测每一样都要
  跨两个文件协作，重新引入 v3 案一被批评的缝。

### 2a.4 通路对比（改前/改后）

```
现状（=v3 旁挂案下的既有通路）：
core emit → 每流自己的 ctx.on（×N，各带 openCalls 表）→ 每流自己的 FrameQueue → SSE

v4 切面：
core emit → producer 的 ctx.on（×1，一张 openCalls 表）→ 帧
                → gateway.broadcast(frame)          ┐ 切面：统一铸信封、
feature 状态变更 → gateway.broadcast/send(frame)     ┘ 同步/合批入各 conn 队列
                → ClientConn.muxQueue（×N，纯缓冲）→ SSE（既有 sseResponse 不动）
```

fetch handler（SSE 编码、`sseResponse`）与 webserver 完全不动；改的是 impl 内
「监听/队列的组织方式」，wire 上的帧形态与语义不变（信封 id 一致性还变强了）。

### 2a.5 故障半径的如实陈述与缓解

- 变化：切面成为下行主通路的一部分——底盘自身 bug 会影响帧分发（旁挂案里不会）。
- 缓解四条：① 底盘无业务语义、一次写成后零改动（v3 不变量），变更引入 bug 的
  面最小；② per-conn 推送包 try/catch——单连接异常踢该连接（end 队列走重连），
  不波及其他 client；③ feature 代码不在 producer→切面→队列的主通路上（feature
  异常只丢自己的控制帧，§8 剧本 6）；④ 底盘是纯内存数据结构（Map+数组+微任务），
  无 IO 无异步竞态面，单测可全覆盖。
- 结论：半径从「零」（旁挂）变为「底盘自身缺陷」，被上述四条压到实际很小；
  这是用户拍板切面收益时已知情的交换。

## 3. client 身份的 wire 形态

### 3.1 铸造时机：显式 `client.hello` 握手

新增 unary `client.hello`（一个 domain 文件对 + RpcMethodMap 一行，既有扩展路径）：

```ts
// api/client.ts
export interface ClientApi {
  /** 铸造或恢复 client 身份。resume 带上次的 clientId：host 认得（ClientConn 仍在，
   *  含 linger 期）则复用并 resumed: true；不认得（host 重启/linger 过期）则重铸。
   *  返回值永远是权威 id，client 无条件采纳。 */
  hello(request: RpcRequest<{ resume?: ClientId; label?: string }>):
    Promise<RpcResponse<{ clientId: ClientId; resumed: boolean }>>
}
```

- **host 铸造**（对齐 sessionId 先例：身份资源由拥有方铸造；rpcId 的「发起方 mint」
  是消息相关性规则，不适用身份资源；conventions #15 不受影响——clientId 不是 rpcId）。
- `ClientId = Branded<'client-id'>`（跨界 id 必须 brand）。
- 时序：client boot → hello（裸发）→ 采纳 clientId → 开两条流。ConnectionController
  每代连接握手本就先跑 describe（audit C2 严格握手），hello 并列加入——**每代
  重连都重新 hello（带 resume）**，linger 过期自动愈合（host 重铸新 id）。

### 3.2 流归属：`x-dsh-client-id` header，只挂两条 SSE

- hello 之后，**仅两条 SSE GET** 携带 `x-dsh-client-id` header。unary POST
  **不带**——上行直通、无归属需求（队列镜像 v1 不做 originClientId 标注，台账
  T-1；将来要做时 client 侧 doFetch 是单一出口，加一行即全覆盖）。
- 为什么是 header：SSE 是 GET 无 body，没有 envelope 可塞；query param 会进
  access log 且语义上这是载体层事实非业务参数。本仓库 SSE 用流式 fetch 而非
  EventSource（readSse），**自定义 header 可行**——方案前提，已核实。
- 送达 impl 的通道：`toFetchHandler` 在两个 SSE 分支解析 header，回填进 impl
  签名的 payload（`events.mux/host` 的 payload 加 `clientId?: ClientId` 字段——
  该 payload 本就是 handler 在服务端构造的，不经客户端 wire 传输，纯 host 内部
  回填位；契约 JSDoc 注明「载体回填，客户端无法经 body 提供」）。
- client 侧：`AbstractApiClient.setClientId(id)`，readSse 的 doFetch 注入 header。

### 3.3 无 header 的流：匿名 ephemeral ClientConn

curl 调试、旧测试、不 hello 的 InProcessApiClient 直开流：不拒绝（保零配置
可调试性），`attachMux(undefined, ...)` 为该流铸一个**匿名 ephemeral
ClientConn**（流断即 dispose、无 linger、不可 resume）。规则一句话：**每条流
永远有 owner；具名身份走 hello，匿名身份仅活一条流**。若流带了 host 不认识的
clientId（hello 与开流之间 linger 恰好过期的竞态窗），host 就地采纳该 id 建
ClientConn（不拒绝不换 id，避免归属中途分叉）；伪造风险与全站无鉴权同级
（台账 T-4）。

### 3.4 刷新 = 恢复还是新 client（分叉 F-1，用户拍）

- **选项 R（推荐）：刷新恢复**。clientId 存 sessionStorage（per-tab、刷新存活、
  新 tab 隔离——localStorage 会把多 tab 合并成一个 client，明确排除；report §1.3
  证实当前全 client 无任何 web 存储使用，这将是第一处，语义要挑干净的）。刷新后
  hello({resume}) 命中 linger 内的 ClientConn → 身份延续。理由：① host 视角刷新
  就是重连，linger 本为此存在；② 将来归属标注/presence 跨刷新稳定；③ peer 层若
  复用此 id（§2.6），刷新不至于 dispose 重建全部 ClientPeerProxy。
  注：clientId 进 sessionStorage 不违反「web 纯呈现层」（conventions #18）——
  它不是会话事实，是连接载体的恢复凭据，cookie 一族。
- **选项 N：刷新即新 client**。实现最少（不存储、hello 无 resume 参数），但身份
  每刷新断代；linger 退化为纯清理延迟。
- 推荐 R；`clientLingerMs` 默认 30s 量级（覆盖刷新+慢加载），Config 可调。

### 3.5 describe 透出

`host.describe` 加 `connectedClients: number`（底盘 clients.size；与
attachedSessions 同为计数，对齐既有粒度）。per-client 列表与 presence 帧不做
（public 面需现役消费者），台账 T-6——将来 presence 本身就是一个新 feature。

## 4. 第一个 feature：queue-mirror（输入排队广播）

以下全部逻辑住 `features/queue-mirror.ts` 一个文件，经 `gateway.use(queueMirror)`
注册；底盘对本节内容零感知。

### 4.1 数据结构：feature 私有态、按 session 分键

```ts
// feature 内部状态（不进 api/ 契约层；帧形态才是对外契约）
type QueueMirror = Map<SessionId, QueueEntry[]>

interface QueueEntry {
  /** 入队关联 id：web prompt 的 rpcId（经 user-rpc MessageSource 通道，
   *  api/sessions.ts 既有）；非 web 来源无 rpcId 时铸内部 id（台账 T-2）。 */
  rpcId: RpcId
  content: ContentBlock[]
  /** steering FIFO 还是主 inbox（agent/queued 的 info.steering 透传）。 */
  steering: boolean
  queuedAt: number
}
```

- **挂 feature 不挂 session 维度对象**：镜像是广播状态（所有 client 共享一份
  事实），session 只是分键；host 侧也没有 per-session 常驻宿主对象可挂（agent
  是 core 资产）。
- **挂 feature 不挂 ClientConn**：队列条目**不是 client 资产**——输入一旦被
  `agent.send()` 受理就进了 core FIFO，client 死了条目照样达模型。client 断线/
  dispose 对镜像**零影响**。这是镜像最容易挂错的地方。
- （originClientId 归属标注撤到台账 T-1：presence 级需求，且是唯一要求 unary
  带 header 的字段，砍掉后上行彻底直通。）

### 4.2 加入：由 core 既有 `agent/queued` 事件驱动

feature 自己 `ctx.on('agent/queued', (agent, content, info) => ...)`：

- 该事件在 `send()`/`steer()` 受理入队的**同步瞬间**发出（core agent.ts:237/246），
  携带受理后的冻结 content 与 `info: { source, steering }`——与 core FIFO 严格
  同步、无竞态窗口、core 零改动。优于「prompt impl 自己记账」：impl 记账漏掉
  其他表面（将来 TUI/ACP 同 host）的入队，且与 core 受理成败有窗口。
- 关联键：web prompt 把 `{ kind: 'user', rpcId }` 塞进 source（既有 user-rpc
  通道，api-proxy.ts:319），`info.source` 上直接可读——受理、排队可见、定格
  三方共用同一 rpcId，**不需要新通道**。
- steering 条目同样入镜像（对称性：两条 FIFO 都是「已受理未定格」；steer 通常
  秒级定格，条目短命但语义一致）。

### 4.3 帧形态：全量快照，live 控制面不进 log

```ts
// MuxFrame 新增成员（api/events.ts 联合加一行 + schema 一行——feature 的
// wire 形态登记在 api/ 契约层，运行时逻辑住 feature 文件）
| { type: 'queue/updated'; sessionId: SessionId; entries: QueueEntryWire[] }
```

- **全量快照 per session**，不是增量。理由：① 队列深度是人手打字量级（个位数）；
  ② 快照幂等自愈——丢帧/重复到达都无害，不给控制面引入 seq/缺口修复机器（那是
  session/event 的待遇）；③ 重连重放与 live 更新同一帧形态同一代码路径；④ 对齐
  「状态从单一权威源派生、在 commit 点发布」。增量省的字节买不回这四条。
- 与审批 requested 帧同族：**live 控制面帧，不进 session log**（conventions #18：
  「怎么画」类控制面一律 host 现算随帧下发，不持久化）。红线核对：排队内容唯一的
  model-visible 通道仍是定格后的 user/message（有 log），镜像与帧不新增任何
  model-visible 输入，「model-visible⟺logged」完好。

### 4.4 生命周期与 rpcId 关联

一条 web 输入的可见性阶段，一个 rpcId 贯穿（report §1.5 证实当前 client **没有**
乐观回显——user 气泡等真帧；「本地在途」只是 POST 未回执的极短窗口，不是渲染态；
将来若做乐观回显，rpcId 通道现成）：

```
本地在途（A 的 prompt POST 已发未回执；不渲染，或渲染为发送中）
   ▼  host 受理 → agent/queued → 镜像加入 → broadcast（切面合批）
排队可见（queue/updated 快照里出现该 rpcId 条目；A、B 同帧看见）
   ▼  turn 开启抽干 FIFO → user/message durable 事件（source.rpcId 同号）
定格（时间线接管渲染；快照移出条目紧随事件帧之后到达）
```

### 4.5 移出、cancel、定序

**移出触发**（feature 的 session/event 监听，观察 durable 事件）：

| 触发 | 语义 | 动作 |
|---|---|---|
| `user/message`（source 带 rpcId） | 条目达模型定格 | 按 rpcId 移出 |
| `steering/message`（source 带 rpcId） | steering 条目定格 | 按 rpcId 移出 |
| `prompt/blocked` | prompt-submit 钩子拦截：出了 FIFO 但没成为 user message | 按 rpcId 移出 |
| `session/disposed` | session 亡 | 整键删除，不广播（订阅端随 removed 帧自清） |

**cancel 清空**：`agent.cancel()` 清两条 FIFO——apiproxy cancel impl 受理成功后
调 feature 暴露的 `clearQueue(sessionId)` + broadcast 空快照（非 web 调用方直接
agent.cancel 的残留见台账 T-3，快照幂等兜底）。

**定序（v4 结构保证）**：切面对两类来源区别入队——**producer 的 core 帧同步
入队；feature 经切面动词的帧微任务合批入队**。同一 core 事件引发的「事件帧 +
快照帧”永远是事件帧先到（同步 vs 微任务的相位差），与监听注册顺序无关；一个
tick 内 N 次镜像变更合一发快照（batching）。所有 client 看到：先消息进时间线、
后队列缩短，无「队列消失了、时间线还没出现」的闪烁窗口。

### 4.6 重连重放时序：feature 注册序

client（重）挂 mux 流时，`attachMux` 内底盘按序注入：

```
1. baseline（impl 提供）：session/subscribed × N（lastSeq 基线——语义不变）
2. gateway.use 注册序逐个 feature.replayFrames：
   approval-pending（T4 落位后，先注册）→ 重推 pending requested 帧（rpcId 原样）
   queue-mirror（后注册）→ 每个非空 session 一发全量快照
3. 转入 live：该 conn 队列开始接收切面分发的实时帧
```

注册序在 boot 装配处一目了然（`gateway.use(approvalPending); gateway.use(
queueMirror)`），即写死顺序的等价还原，但**加第三个 feature 不改底盘**。
若将来出现注册序表达不了的跨 feature 定序需求再引入显式 priority（台账 T-7）。

client 侧 resync 已有「清 pending、等基线重放」的既定轨道（web-runtime
session.ts:220），队列视图走同一轨道——resync 清空，快照到达重建。A 刷新能
看见自己排的输入，B 断线重连也能，§1.2 闭环。

**边界一致性**：镜像是内存态，恰如它镜像的 core FIFO 也是内存态——host 重启
两者同归于尽，镜像永不谎报比 FIFO 更持久的状态；agent resume 时 FIFO 空、
镜像空，诚实对齐。

## 5. GatewayFeature：特殊功能接入底盘的标准接口

```ts
/** 一个可插拔的 client 侧特殊功能。加功能 = 新增一个实现文件 + boot 处 use() 一行。 */
interface GatewayFeature {
  /** 诊断与日志用名（如 'queue-mirror'）。 */
  readonly name: string
  /** 装配钩子：feature 在此订阅 core 事件、拿切面动词（send/broadcast）与
   *  onClientChange。返回 disposer（对称卸载，registrations-are-effects 纪律）。 */
  setup(gateway: Gateway, ctx: Context): () => void
  /** 重连重放钩子：client（重）挂 mux 流、baseline 之后，底盘按注册序调用。
   *  push 直达该新流（点对点，不经 broadcast）。 */
  replayFrames?(push: (frame: MuxFrame) => void): void
  /** 可选：client 生命周期钩子（presence 类 feature 用；queue-mirror 不需要）。 */
  onClientAttach?(clientId: ClientId): void
  onClientDetach?(clientId: ClientId): void
}
```

- **queue-mirror**（本文实装）：setup 订 `agent/queued` + `session/event` +
  `session/disposed`；replayFrames 推非空 session 快照。
- **approval-pending**（T4 落位时）：setup 接审批钩子维护 pending registry；
  replayFrames 重推 requested 帧（稳定 rpcId）；`respond()` 从 stub 变为查
  registry。本设计**不实装 T4**，只留标准插槽。
- **将来**（presence/typing/tool 进度…）：同形态，一文件一 use()。
- feature 之间**不许互相 import 运行态**（各自独立可插拔；真出现共享需求时经
  底盘加通用原语，而不是 feature 拉 feature）。
- feature 不在 producer→切面→队列的主通路上（§2a.5）：feature 崩溃只丢自己的
  控制帧，core 帧分发不受影响。
- peer 层不是 feature（§2.6）；它只消费底盘的 onClientChange 与 ClientId。

**验收基准（核心不变量）**：加一个新 feature 的 diff = `features/<name>.ts`
新文件 + boot 装配处 `gateway.use(...)` 一行 +（若有新帧/新 unary）api/ 契约层
常规加法；`gateway.ts` 底盘文件**零改动**。

## 6. 变更清单（全部 host 侧，core/webserver 零改动；行数对 HEAD 树）

| 文件 | 变更 | 量级 |
|---|---|---|
| `apiproxy/src/api/client.ts`（新）+ schema 对 | hello 契约 | 小，纯加法 |
| `apiproxy/src/api/rpc-map.ts` | +`'client.hello'` 一行 | 一行 |
| `apiproxy/src/api/events.ts` + schema | MuxFrame +`queue/updated` 成员；mux/host payload +`clientId?` 回填位 | 小 |
| `apiproxy/src/api/host.ts` + schema | describe +`connectedClients` | 一行 |
| `apiproxy/src/fetch/handler.ts` | SSE 两分支解析 `x-dsh-client-id` → payload 回填；UNARY_ROUTES +hello 一行。**sseResponse/SSE 编码不动** | +5 行 |
| `apiproxy/src/fetch/client.ts` | `setClientId()`；readSse 注入 header | +8 行 |
| `host-runtime/src/gateway.ts`（新，**底盘**） | Gateway + ClientConn（含 FrameQueue 所有权）+ 分发切面（同步/合批双通道、信封统一铸造、per-conn 异常隔离）+ onClientChange + use() + GatewayFeature 接口 | ~180-220 行，一次写成后稳定 |
| `host-runtime/src/frames.ts`（新，**producer**，impl 侧） | 单例 core 监听 ×1 套 + openCalls 视图表 ×1 份 → broadcast/broadcastHost。**主体为从 mux()/host() 闭包平移的既有代码** | ~90-110 行（净新增少） |
| `host-runtime/src/features/queue-mirror.ts`（新，**首个 feature**） | 镜像 + 订阅 + 快照 broadcast + replayFrames + clearQueue | ~80-100 行 |
| `host-runtime/src/api-proxy.ts` | **mux()/host() 重构瘦身**：删每流闭包（监听+队列 ~70 行移出），改为 attach 一行取流 + baseline 回调；cancel +1 / describe +1 / hello impl ~10 / createApiProxy 签名 +1 参 | 净 -40 行左右，但属主干重构 |
| `host-runtime/src/boot.ts` 或装配处 | `new Gateway(...)` + producer 装配 + `gateway.use(queueMirror(...))` | +3 行 |
| `web-runtime` | ConnectionController 握手加 hello（+sessionStorage 若 F-1 选 R）；session 层队列视图（吃 queue/updated、resync 清空等重放） | 中 |

对比 v3：多一个 frames.ts（producer，主体是搬家代码），api-proxy.ts 从「+18 行
加法」变为「mux/host 主干重构（净减行）」——这是方案一的明码代价（§2a.2 ②）；
底盘稍大（切面双通道+队列所有权）。稳态收益不变：加 feature 零动底盘。

## 7. 妥协台账与方向性分叉

### 妥协台账（conventions #12 三段式：触发条件 → 返工点 → 预埋要求）

- **T-1 队列条目无归属标注（originClientId 砍掉）**
  触发：presence/「谁排的」UI 立项，或 T4 审批需要「谁应答的」归属。
  返工点：unary 侧 doFetch 注入 header（client 单一出口 +1 行）；handler 对
  session.prompt 加 noteOrigin 一行；QueueEntry 与 QueueEntryWire 加 optional
  字段（加法兼容，快照形态不破）。
  预埋：clientId 铸造与注册表已在（本设计付清）；不预留 wire 字段。
- **T-2 非 web 来源入队无 rpcId 关联**
  触发：第二个表面（TUI/ACP）接入同一 host，或插件直接 agent.send。
  返工点：评估把 user-rpc 的 rpcId 语义泛化为「入队关联 id」由各表面自带。
  预埋：镜像对无 rpcId 条目铸内部 id（条目可见性不漏，只是无端到端对账）；
  QueueEntry.rpcId 的 JSDoc 写「入队关联 id」而非「web prompt id」。
- **T-3 非 web 调用方 cancel 的镜像残留**
  触发：任何绕过 apiproxy 直接 `agent.cancel()` 的调用方出现。
  返工点：若 core 届时已有 inbox 观测事件则切换驱动源（连 T-2 一并消解）；否则
  在该调用方处补 clearQueue。
  预埋：快照幂等已兜底——残留条目至多活到下次定格事件或重连重放。
- **T-4 clientId 无鉴权、header 可伪造**
  触发：web 面引入鉴权（token/cookie）。
  返工点：hello 绑定鉴权主体；header 由 webserver 中间件校验后传递。
  预埋：铸造单点在 hello、ClientId 有 brand 隔离，鉴权接入点唯一。
- **T-5 queue 快照无版本号**
  触发：引入多路复用/可乱序载体（HTTP/2 push、WebTransport 多流）。
  返工点：帧加单调版本 + client 丢旧。
  预埋：全量快照形态本身（新帧完整覆盖旧帧）；单连接 SSE 的 FIFO 是当前载体保证。
- **T-6 describe 只透计数不透 client 列表**
  触发：presence UI 立项。
  返工点：presence 作为新 feature 接入（client.list unary + client-added/removed
  帧 = clients Map 直接投影）；底盘零改动是分层验收项。
  预埋：connectedClients 计数已从 clients Map 读；onClientAttach/Detach 钩子已留。
- **T-7 重放定序只有注册序，无显式 priority**
  触发：出现注册序表达不了的跨 feature 定序需求。
  返工点：GatewayFeature 加 optional `replayPriority`，底盘排序改一行。
  预埋：注册序集中在 boot 装配处一目了然；optional 字段不破既有 feature。
- **T-8 FrameQueue 无界（report §3 加固项，v1 不做）**
  触发：慢消费者内存风险实测出现，或 client 数上量。
  返工点：切面入队处加界 + 慢消费者踢流（end 队列走重连 resync）——切面单点，
  一处改全局生效（这正是咽喉收益）。
  预埋：队列所有权已收进 ClientConn；踢流所需的重连自愈轨道（resync）既有。

### 方向性分叉（用户拍板，不替拍）

- **F-1 刷新语义**（§3.4）：R = sessionStorage 恢复（推荐）vs N = 刷新即新 client。
- **F-2 命名**（§2.5）：N1 `ConnectionGateway`+`ClientConnection`（推荐）vs
  N2 `ClientRegistry`+`ClientConnection` vs N3 `ClientGateway`+`ClientProxy`；
  feature 接口名随之联动。
- **F-3 方案一语境确认**（§2a.1）：本稿按解读 A 执行（切面=下行分发咽喉，帧生产
  留 impl 侧 producer，上行直通）；若用户本意是解读 B（producer 一并进 Gateway）
  或含上行的更宽切面，请明示——返工面已隔离在 producer 归属一格。

## 8. 验收剧本（设计自查用，非测试计划）

1. **双浏览器排队可见**：A、B 同看一 session；turn 运行中 A queue 提交 → B 在
   下一帧看到 queue/updated 条目；turn 开启定格 → 两边先见 user/message 进时间线、
   紧随的快照把条目移出，无闪烁。
2. **A 刷新自愈**：A 刷新 → hello(resume) 命中 linger → 同 clientId；baseline
   重放后收到 queue 快照 → 自己排的输入回到眼前（§1.2 闭环）。
3. **cancel 清空**：任一 client cancel → 空快照广播，两边队列视图同清。
4. **client 死不陪葬**：A 关浏览器 → linger 过期 ClientConn 注销；A 排的条目仍在
   镜像、仍会达模型；B 视图不变。
5. **匿名流不失序**：curl 直连 mux（无 header）→ 匿名 ephemeral ClientConn，收到
   完整 baseline+重放序列，断开即清理，connectedClients 不泄漏。
6. **feature 故障隔离**：（思想实验）queue-mirror 抛错 → producer→切面→队列的
   core 帧主通路不受影响，只丢 queue 控制帧——feature 不在主通路上的承诺（§2a.5）。
7. **加功能零动底盘**：（思想实验）实装 T4 审批或 presence feature 时，diff 只含
   `features/<name>.ts` 新文件 + boot 一行 use + api/ 契约加法；`gateway.ts`
   零改动。违反即分层失败，回 §5 返工。
8. **切面一致性**：双 client 同收一逻辑帧，信封 rpcId 逐字节一致（v4 新增保证，
   对照现状 E1 的「payload 同、信封各异」）；帧到达序两边一致（单一咽喉入队序）。
