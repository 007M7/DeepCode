# 20260720-2125-gateway-design — host 侧 Client Gateway 设计

## 任务理解（外化，防掉线）

**身份**：gateway-design owner（常驻 teammate），工作树 worktree-web2（分支 worktree-web2）。
**铁律**：零 git 操作、零源码改动，纯设计文档作业；文档只落盘不 commit。history-rebase 手术进行中。

**任务**：产出 `design.md`（中文，供用户 review）——host 侧 Client Gateway 设计：
面向对象的 client 身份底座 + 输入排队广播。用户核心要求原话：「有一个面向对象的
Gateway + 一堆在 host 侧的 client proxy，这个标准对象我希望是有的」。

### 设计必须覆盖

1. **对象模型**：Gateway（单实例、client 注册表）+ ClientConnection/ClientProxy
   （每 client 一个 host 侧对象：clientId 铸造、拥有 mux/host 流与 FrameQueue、
   unary 归属、断线 dispose 级联）。与 peer 体系 PeerGateway/ClientPeerProxy 的
   关系定调（同一对象 vs 分层），给推荐+理由，命名与 blueprint §6a.4 协调。
2. **client 身份 wire 形态**：clientId 铸造时机、同页面多流归属同一 client 的机制
   （握手参数/首帧）、刷新=新 client 还是恢复（推荐+理由）、describe/attachedSessions
   是否透出 client 列表。
3. **输入排队广播**：队列镜像数据结构（挂 Gateway vs 挂 session）、queue/updated
   帧形态（全量 vs 增量）、三态生命周期（本地乐观→排队可见→定格）与 rpcId 关联、
   cancel/断线清理、重连重放时序（与 subscribed 帧先后）。
   主会话方案雏形：apiproxy impl 维护按 prompt rpcId keyed 的队列镜像，受理广播
   queue/updated live 帧（控制面不进 log，与审批 requested 帧同族）、开轮见同
   rpcId 的 user/message 即移出、cancel 清空、重连后 subscribed 帧后重放。
4. **复用面**：T4 审批 pending、将来 peer hold 账本共享此底座（一节带过）。
5. **红线**：harness core 零改动（core FIFO 一字不动，全住 apiproxy/host 侧）；
   live 控制帧不进 log（web 纯呈现层）；「model-visible⟺logged」不破。
6. 妥协台账三段式；方向性分叉（如刷新恢复语义）列选项给用户拍，不替拍。

### 输入排队问题（需求脉络）

两浏览器=两 client 连同一 host；A 在对方 turn 运行中 queue 提交 → 输入进 host
FIFO 但不发事件（未达模型不进 log）→ B 看不见、A 刷新也看不见。同步一定是 host
侧维持的广播状态，绝不进 harness core。

### 背景材料状态 ⚠️

派发单指定的材料在本工作树/全 workspace 均未找到（已 find 到 depth 12）：
- `missions/tasks/20260720-0356-multiclient-research/report.md` — **不存在**
- `missions/tasks/20260719-2339-web-cordis-design/blueprint-v2.md` + design.md — **不存在**
- `missions/conventions.md` — **不存在**

已向 team-lead 索要正确路径。在等待期间直接读实际代码面：
packages/host/apiproxy（mux/host 流、FrameQueue、session/subscribed 重放）、
contract 的 attachedSessions/describe、T4 审批 pending registry 现状。

## 批次计划

1. ✅ README（本文件）→ 回执
2. ✅ 对象模型批 → design.md §对象模型
3. ✅ wire 身份 + 输入排队批
4. ✅ 复用面 + 妥协台账批

## 追加口径（team-lead 四单，2026-07-20 晚）

1. **范围收窄（轻底座）**：Gateway/ClientProxy 只管「身份铸造+连接聚合+dispose
   级联+session 排队镜像」；unary API（list/create/history/describe…）照旧直通
   impl 不经 Gateway 路由。设计里画「管什么/不管什么」边界表，防过度设计。
2. **侵入性正面评估**：「侵入式改道 vs 旁挂观察者」两案对比+推荐（预期旁挂——
   mux 出帧路径 impl→FrameQueue→SSE 不动，Gateway 订阅同源事件维持 queue 状态
   并注入自己的 queue/updated 帧）；改动面量化到文件/函数级。
3. **peer 关系定调作废重写**：用户已定「两个独立对象，各归各层」——PeerGateway
   在 host 插件内部（cordis ctx 域），本 Gateway 在外部（apiproxy 载体层），
   不合并、不做上下层视图。唯一连接点：clientId 语义要不要打通（给建议）。
   命名提 2-3 候选（避免与 §6a.4 撞）：ClientGateway/ConnectionGateway/
   ClientRegistry 之类，用户挑。
4. **社区调研只看 opencode**（本机 /weka-hg/.../github/opencode）：server 侧有无
   client/connection 概念、多端输入怎么同步、session 数据流有无 Gateway 类中介。
   Live Share/tmux/Figma 对照不做。
5. **材料读法**：missions 背景材料用 `git show 7be03e985:<path>` 直读（重排前
   顶刀快照）；packages 源码以 `git show 94ff2fad2:<path>` 为准（工作树在手术
   中间态）。归档目录 untracked 不受影响。

### 批次计划（第二轮）

5. ✅ 消费材料：conventions.md + multiclient report + blueprint-v2 §6a 原文全读
6. ✅ opencode 调研（server/event handler、session/prompt+run-state、sync/README、
   CLI runtime.queue 实读）→ design.md §1.4
7. ✅ 修订批：design.md 整体重写为 v2——轻底座边界表（§2.2）、侵入性两案+改动面
   行级量化（§2a，推荐旁挂观察者+微任务合批）、peer 独立定调+clientId 打通建议+
   命名三候选（§2.4）、originClientId 撤到台账 T-1（unary 彻底直通）、台账改
   conventions#12 三段式（T-1..T-6）、分叉收敛为 F-1 刷新/F-2 命名。

### v2 关键修订记录（对 v1）

- opencode 结论：server 无 client 对象、受理即持久所以无排队镜像需求——支持
  轻底座方向，也证明我们的镜像是自家「未达模型不进 log」纪律下的必要补位。
- 侵入性：案二旁挂观察者，api-proxy.ts 仅 +18 行、unary 零触碰；定序靠
  queueMicrotask 合批（机制保证，非注册顺序约定）。
- peer：两个独立对象各归各层（用户定调）；唯一连接点 clientId 打通（建议打通，
  peer 层复用 hello 铸造的 id + 订阅 client 生命周期）。
- hold 账本从复用面撤下（归 peer 域 ClientPeerProxy，§6a.3）。

### v2.1（L-1 对表收尾，重排收官后）

- 重排收官（missions 树全量恢复），blueprint-v2 §6a + web-cordis 正式稿 design.md
  §1 树上直读对表完成。§2.4 补三条注记：①命名不撞车（peer 五词全避开，N3 的
  ClientProxy 与 ClientPeerProxy 一字之差故不推荐）；②生命周期桥接（§6a.3 定
  ClientPeerProxy 断线即 dispose vs 本层 linger——生命周期通知暴露两档粒度，
  peer 层按 §6a.3 选断流档，不替 peer 改已拍语义）；③hold 账本归属经原文确认。
- F-2「peer 分层 vs 同体」分叉按用户定调收敛为注记（不再是开放分叉）；现存分叉
  仅 F-1 刷新语义 + F-2（新编号）命名候选。
- 行号引用全部校准到重排后 HEAD 树（api-proxy.ts:359-394/319、session.ts:220）。

### v3（标准底盘与特殊功能拆两层，用户结构性口径）

- 用户锚点：「标准化指代的是统一 Map clients / connection 订阅的分发」；queue/
  broadcast 只是当下特殊需求，加功能必须不动底盘。
- 重构：§2 重画为底盘+插槽两层——底盘（clients Map + attach/detach + send/
  broadcast 通用动词 + onClientChange 两档粒度 + use() 插槽）零业务语义，词汇表
  只有 client/connection/frame + send/broadcast/replay；任何 sessionId/rpcId/
  approval 逻辑只能住 feature 文件。
- ReplayableDomain 升格为公开 GatewayFeature 接口（name/setup→disposer/
  replayFrames/onClientAttach/Detach）；queue-mirror 是第一个 feature（§4 整节
  改写为 feature 视角，业务语义不变）；T4 审批第二候选。
- 重放定序改 feature 注册序（boot 装配处 use 顺序即 v2 写死顺序的等价还原）；
  显式 priority 进台账 T-7。
- 微任务合批定序上移到底盘 send/broadcast 动词（feature 作者免知约定）。
- §2a 旁挂结论、边界表（加 feature 列）、命名候选、F-1 全保留；改动面重量化：
  底盘 gateway.ts 120-150 行一次写成后稳定 + features/queue-mirror.ts 80-100 行，
  impl 接触面不变 ~18 行。
- 验收剧本 +第 7 条：加功能零动底盘的不变量自查。

### v4（用户拍方案一：下行全帧过切面）

- 执行解读 A：切面=下行分发咽喉——所有下行帧（core 帧+feature 帧）统一过底盘
  send/broadcast 入队；**帧生产留 impl 侧单例 producer**（一套监听+一份 openCalls
  视图，从 per-stream 闭包平移收敛）；上行 unary 不过切面。解读 B（producer 一并
  进 Gateway/含上行）列 F-3 待确认，返工面隔离在 producer 归属一格。
- v3 反对改道三理由逐条正面回应（§2a.2 表）：①视图进底盘→生产/分发拆开消解，
  底盘纯度反升；②动主干→承认，用户知情拍板，且主体是代码搬家非重写；③故障半径→
  承认变大，四条缓解（底盘稳定/per-conn 隔离/feature 不在主通路/纯内存可全测）。
- 切面净收益：监听×1 视图×1（消 per-client 线性复制）、信封 rpcId 统一铸造
  （逐字节一致，强于现状 E1）、统一治理点（T-8 加界/踢流、将来过滤、观测单点落地）。
- FrameQueue 定调：切面内部实现（ClientConn 拥有 muxQueue/hostQueue），推荐案+
  否决备选（决策/缓冲劈两截会重引缝）。
- 定序升级结构保证：core 帧同步入队、feature 帧微任务合批入队，相位差与注册序无关。
- 改动面重量化：gateway.ts 180-220、frames.ts（producer，主体搬家）90-110、
  queue-mirror 80-100；api-proxy.ts mux/host 主干重构净 -40 行；sseResponse/
  webserver 不动。台账 +T-8（FrameQueue 加界，切面单点落地）。
- 验收 +第 8 条：切面一致性（信封 id 逐字节一致+到达序一致）。

## 进度日志

- 2126 README 落盘；发现背景材料缺失，向 team-lead 报告并索要路径。
- 2135 材料未到，不阻塞：直接读实际代码面打底（api-proxy.ts 现状、agent/queued、
  FrameQueue、rpc 四象限、connection 握手、session.ts pending 机制）。
- 2140 批 2 落盘：design.md §0-§2（对象模型，peer 关系推荐分层 A）。
- 2150 批 3 落盘：§3-§4（hello 握手 + header 归属 + 队列镜像 + 快照帧 + 重放时序）。
- 2155 批 4 落盘：§5-§8（ReplayableDomain 小契约、变更清单、台账 L-1..L-6、
  分叉 F-1..F-3、验收剧本）。design.md 完稿待 review；L-1（blueprint 对表）悬置
  等 team-lead 给路径。
