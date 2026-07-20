# 四篇 RFC · 大纲（v1，供用户过目后开写）

> 2026-07-20 02:4x。依据用户拍板：四篇重构（原 R2+R3 合并；web-cordis 豁免不做 RFC 留原路径）；受众=本项目其他开发者；目的=「这套 Web 架构怎么设计的、后续怎么在上面开发」；**不写取舍原因/演变过程**，多表格多 list，操作性优先。语言：大纲中文，正文语言待用户答。

## 体裁冲突点（写作前需确认一件事）

`verify-rfc-format` 门禁（doc-sync 一员）**强制每份 RFC 带 `## Alternatives considered` 节**，且 implemented 骨架必须 `## Problem` 开头。与「不写取舍原因」的调和方案，推荐 a：

- **a（推荐）**：仍落 docs/rfc/，`Problem` 压到 3–5 行（只说这层解决什么），`Alternatives considered` 压成每篇末尾一张「放弃项一行表」（放弃了什么+一句话为什么，不展开论证）——满足门禁，正文 95% 篇幅是现状与开发指引。
- **b**：不进 docs/rfc/，做成 docs/ 下的架构文档（如 docs/web-architecture/*.md，对标 docs/architecture.md 体裁，顺势替掉失效的 ui-tech.md）——体裁完全自由，但偏离用户「RFC」的原话。
- 大纲按 a 编制；若用户选 b，骨架去掉 Problem/Alternatives 两节即可，正文不变。

## 第一篇：GUI 总体分层架构

- **路径**：`implemented/architecture/2026-07-19-gui-host-client-layering.md`
- **定位一句话**：host/client 按「能力支持方」分层的概念模型，与 apiproxy 前置层 / hostruntime 装配层 / 两类消费边界——看完知道新东西该放哪一层、不该绕哪条线。

### 章节骨架

```
## Problem（3 行：多形态接入（web/headless/将来 Electron·acp）需要一个稳定分层，让接入方只做拼装）
## Decision（分层总模型图：host 侧 / client 侧 / 混合归 apps，一张依赖方向图）
## 分层角色表
   | 层 | 职责 | 关键纪律 |（apiproxy=前置层：契约+载体，零 harness 运行时依赖；
   hostruntime=后置装配层/应用实体：装配+host 级配置归属地；client 侧=消费投影；
   混合体一律归 apps——哪个 app 要混，拼装写在那个 app 里）
## 两类消费（核心概念，表格）
   消费型 client（web/Electron/headless）：唯一经 ApiProxy，差异只是「fetch 形函数的伪造方式」
   （HTTP / 进程内注入 / IPC 桥三承载表）
   协议桥前门（ACP 类）：把 core 暴露给外部生态，直接挂 ctx，不套 fetch——不是例外是第二类
## startHost 接缝（开发者操作面）
   RunningHost 五件套语义表（api/handler/defaults/ctx/dispose）；
   纪律 list：消费型 client 不得经 ctx 绕 api；壳不得用 ctx.plugin 改装配（挂前门≠改装配）；
   stdout 纪律（装配零写手，将来日志走 StartHostOptions 可关）；dispose 幂等
## 命名规则（host/client 目录组前缀包名 dsh-host-*/dsh-client-*；tsconfig 显式 paths 的原因一行）
## 怎么接入一个新形态（操作清单：判断消费型 or 前门 → 选 fetch 伪造方式 or ctx.plugin → 拼装归属）
## Alternatives considered（一行表：webserver 并入 hostruntime / 消费型 client 直连 ctx / 单包不分层）
```

### 包含 / 不包含

| 包含 | 不包含（用户边界：不做包与 apps 关系枚举） |
|---|---|
| 分层概念模型、两类消费边界、startHost 语义、命名规则、依赖方向纪律 | 包清单/逐包职责枚举（packages/README.md 自明）；apps/dsc 三文件拼装动线（web.ts/headless.ts 代码级）；webserver 包实现细节（MIME/SPA/close 语义）；Electron/acp 未实现部分的接缝细节（各留一行「将来形态」即可）；迁移步骤与 v1→v2 历史 |

### 写前核实点

startHost/RunningHost 真签名（packages/host/runtime/src/start.ts）；apiproxy 现 deps 面（退化后 6 项）；七包名；「webserver 不依赖 hostruntime」是否仍真。

## 第二篇：RPC 通信协议（原 R2+R3 合并）

- **路径**：`implemented/architecture/2026-07-19-gui-rpc-protocol.md`
- **定位一句话**：四象限消息模型 + 类型/zod 体系 + fetch 双向抽象 + Web HTTP/SSE 落地——看完能加一个新方法/新帧/新错误码，并知道换载体时什么不变。

### 章节骨架

```
## Problem（3 行：多端多载体需要一个通道无关的消息模型与单一契约事实源）
## Decision（四象限总图：initiator×kind 四格，通道只是承载）
## 消息模型
   四具名判别 union 表（ClientRequest/ServerResponse/ServerRequest/ClientResponse：字段/谁 mint rpcId/承载）；
   窄形 RpcRequest<P>/RpcResponse<T> 与全形的关系（载体层补全）；
   rpcId 纪律 list（谁发起谁 mint、应答回填不 mint、纯推送=不期待应答的 server-request 严格二分）；
   RpcReceipt 载体回执（respond 的 HTTP 应答体，非逻辑消息）
## 类型体系（形态 B）
   函数签名即事实源；RpcMethodMap 登记表（现 6 key）+ RequestPayload/ResponseValue 派生；
   禁重复内联纪律；RpcErrorDetailsMap 错误表（4 码：code/details 结构/何时抛）；
   zod 双向校验：两级 parse（全形→payload 分派）、satisfies z.ZodType<Wire<T>> 锚定与 Wire<T> 缘由一段
## 契约面（ApiProxy 五域 + respond）
   方法表（method key / 请求 payload / 返回 value / 语义一句话）；
   帧表（MuxFrame/HostFrame 逐型：字段/何时发）；
   透传纪律（wire 上就是 core SessionEvent/ContentBlock，零 DTO）；
   会话语义 list：历史=事件重放+client 单 fold、消息边界分页、重连=重建+subscribed.lastSeq 缝检测、
   冷 session 隐式 resume、审批问答形态（server-request/resolved 收敛/基线重放；respond 现为 stub 如实标注）；
   预留接缝纪律（不进 map、fail-loud 优于 not-implemented；现预留清单一行表）
## fetch 双向抽象（同构模型）
   toFetchHandler(api) / createApiClient(fetchLike) 对偶；载体可替换表（HTTP / 进程内直调 / 将来 IPC 桥）；
   同构点：createApiClient(host.handler.fetch) 全程真跑载体链（headless 即第二真实消费者）；
   onEnvelope tap（调试观测咽喉，契约签名零污染）
## Web 落地（HTTP+SSE 特定实现）
   wire 映射表（四象限→POST /api/<key> / HTTP 应答 / SSE data: / POST /api/respond）；
   HTTP status 只表载体（业务错误恒 200+信封）；SSE 帧=ServerRequest 全形；断线/重连语义
## 怎么扩展（操作清单：加 unary 方法五步 / 加帧型三步 / 加错误码两步 / 升格预留接缝）
## Alternatives considered（一行表：三信封旧模型 / JSON-RPC 2.0 复用 / 形态 A 类型对 / REST / DTO 层 / cursor 续传）
```

### 包含 / 不包含

| 包含 | 不包含 |
|---|---|
| 四象限模型、类型/zod 体系、五域契约+帧表、同构 fetch 抽象、HTTP/SSE 落地、扩展操作清单 | 拍板演变时间线（README 拍板表不搬）；jsonrpc/opencode 对比全文（结论化进 Alternatives 一行表）；impl 内部实现（FrameQueue、resume 去重等——包内注释承载）；web 客户端怎么消费（第三篇） |

### 写前核实点

rpc.ts 四 union+RpcReceipt+4 错误码、rpc-map 6 key（已初核）；fetch/client.ts 未 commit 改动以写作时真码为准；**respond stub 现状如实标注**（runtime/src/api-proxy.ts:257）；history 分页真实现；Wire<T> 注释真身（rpc.schema.ts）；预留接缝（fork/inject/task/listModels/since）仍未进 map。

## 第三篇：Web 客户端基础架构

- **路径**：`implemented/architecture/2026-07-19-gui-web-client-architecture.md`
- **定位一句话**：两层稳定资产——①React-free 数据对象层（Session/SessionManager/Connection：状态机、帧路由、fold/累积器、subscribe/getSnapshot 通知契约）+ ②React 对接的 hooks 纯数据层（uSES 接线、防撕裂合同、「数据+操作」返回形状）。组件层是耗材（用户拍板「组件肯定要重做」），只讲分离原则不讲具体组件。
- **章节比重**（用户细化）：对象层 ≈ 50%、hooks 层 ≈ 25%、连接/fold ≈ 20%、展示与 store 红线一节收尾 ≈ 5%。

### 章节骨架

```
## Problem（3 行：流式事件驱动的 UI 需要「业务对象不进 React、React 只订阅快照」的稳定分层）
## Decision（分层图：ConnectionController → SessionManager/Session（React-free）→ hooks（纯数据）→ 展示组件（可整体替换的耗材）；单向）
## 数据对象层（本篇主体 ①，React-free——zero React import 是可断言纪律）
   Session 职责表：封装一切带 sessionId 的调用——操作面（prompt/cancel/setDraft/sendDraft/open/loadOlder/resync）/
   订阅面（subscribe/getSnapshot）/ manager 专用入口（handleMuxEnvelope/handleRunning/handleAgentError）三组；
   内部状态表（events 窗口/baseSeq/openState 状态机/liveBuffer/pending/partial/openCalls/draft）；
   SessionManager：懒建常驻、mux/host 帧路由表（逐帧→动作）、列表快照+谱系扁平化（flattenLineage 纯函数）；
   ConversationSnapshot 快照契约：不可变 list（顶层每次新建/未变子结构保引用/getSnapshot 恒返缓存绝不现算）；
   节点 union 表（六 kind：形状+来源事件）；
   Notifier 微任务合批（chunk 风暴收敛为一次通知；无监听者不 build 惰性）；
   打开/重连缝合规则（liveBuffer 按 seq 合并去重、subscribed.lastSeq 缝检测、resync=重建）
## fold 与流式累积（对象层的两个内嵌引擎）
   fold 复用 core SurfaceManager（子路径 import；padding 窗口适配 seq 偏移；节点缓存 seq 键永不失效；
   降级位 foldDegraded）；chunk 不进 fold——PartialAccumulator 六型 chunk→块级增量表；成本模型四行表
## 连接层（ConnectionController：两流泵+指数退避重连+generation fencing；sinks 单向注入（Controller 不识 Session）；
   重连=重建，onConnected → refreshList+各 Session resync）
## hooks 层（本篇主体 ②，web-ui 侧唯一与 runtime 的接点）
   useSessionList/useConversation 签名与返回形状（「快照数据 + 引用稳定操作句柄」双段）；
   uSES 合同四条（getSnapshot 恒返缓存引用/subscribe useCallback 稳定/不传 getServerSnapshot（纯 CSR）/
   双源一致性——同一 host 帧驱动列表与对话两处同批 flush）；
   hook 只在容器层调用的纪律；加新 hook 的模板（订阅对象+useMemo 聚合句柄）
## 展示层与 store（一节收尾，只立原则）
   分离原则：展示组件纯 props 零数据获取、换 UI 库=hooks 以下零改（具体组件不进本篇——组件是耗材）；
   store 红线：zustand 只承载跨视图展示态（现状仅 rpcLog+面板开合），业务对象一律不进 store；
   intent=普通函数；选中态=容器局部 state、草稿住 Session 对象（per-session 数据跟对象走）
## 调试观测（onEnvelope tap→rpcLog 面板定位一段；fixture 模式：?fixture 同装配零分叉）
## 怎么开发（操作清单：消费新帧型（Session 分发表加行+快照字段+revision）/ 加对象方法 /
   加 hook / 加 intent / 「这个状态放哪」判断树（Session 对象/容器 state/store 三分））
## Alternatives considered（一行表：业务数据进 zustand / redux 类全局 store / React 直连流 / 自写 fold / 组件层定契约）
```

### 包含 / 不包含

| 包含 | 不包含（降权/排除） |
|---|---|
| 对象层全量（职责/状态/快照契约/通知/缝合）、fold+累积器、连接层、hooks 层全量（签名/uSES 合同/模板）、分离原则与 store 红线、扩展操作清单、fixture 与调试面板定位 | **展示组件层规范性内容**（SessionListView/ConversationView 等 props 契约、组件文件清单——用户拍板组件要重做，只留分离原则一句话）；样式设计（第四篇）；RPC 面板交互细节；妥协台账 F.1–F.13 全文（择要并入「怎么开发」边界提示）；playwright 验收纪律；web-cordis 插件化预案（豁免） |

### 写前核实点

web-runtime session/ 七文件+hooks 两文件现状（已初核在）；store.ts 仍零业务切片；SurfaceManager 子路径 import 仍真；padding 哨兵/foldDegraded 实现与设计一致；ConnectionController sinks 形状（连接风暴修复后真码）；Session 方法面与 §A.2 设计签名的落地差异（以真码为准）。

## 第四篇：样式体系

- **路径**：RFC `implemented/process/2026-07-19-web-styling-system.md`（若用户认为 token 表属 source 结构可改 architecture）+ **活规范 docs/web-styling.md 按本篇口径校准**（已存在且已是这个角色）
- **定位一句话**：RFC 定框架（token 两层、视觉基线来源、暗色机制、工程约束），web-styling.md 承载当前规则与 review 打勾清单——两文分工，互链。

### 章节骨架（RFC）

```
## Problem（3 行：无设计师供给下需要一套 agent 可执行的样式体系）
## Decision（框架五条表：视觉基线=deepseekchat 实测值；token 两层不三层；
   字号/间距不 token 化（组件内成对写 px）；边框/hover 透明度制；暗色只在 token 表做（组件零主题选择器））
## 工程约束（CSS Modules+clsx、无组件库、无 tailwind、PostCSS 白名单现状零插件、css-modules.d.ts 通配）
## 与 web-styling.md 的分工（本 RFC=框架与约束；web-styling.md=token 权威值+编码规范打勾清单+偏离记录；
   加 token/偏离基线的流程指针）
## Alternatives considered（一行表：三层 token / tailwind / 组件库 / 间距 token 化 / 实色灰 hover）
```

### web-styling.md 校准动作（随第四篇同批）

| 动作 | 内容 |
|---|---|
| 头部指针 | 「架构稿拍板」等模糊指向改指第四篇 RFC；§6 对 missions 归档的两处链接改指 RFC（消断链，归档删除前置条件） |
| 口径核对 | §1 token 表 vs global.css 实值一致性；RpcLog v2.1 改造后偏离表是否该记行；「PostCSS 零插件」现状 |
| 不动 | 规范条文本体（12 条）与 token 值——除非核对发现漂移 |

### 包含 / 不包含

| 包含 | 不包含 |
|---|---|
| 框架决策五条、工程约束、两文分工 | deepseekchat file:line 证据搬运（style-research 结论已固化为值，证据留 git）；token 逐项值表（web-styling.md 独家）；RpcLog 视觉词汇表（已在 web-styling.md §2） |

### 写前核实点

web-styling.md §1 vs global.css 实值一致；RpcLog v2.1 styled 后是否有未记录偏离；PostCSS 插件现状。

## 清单收口（对 v2 提案的增删）

| 项 | 处置 |
|---|---|
| 原 R1 | → 第一篇（收窄：去包/apps 关系枚举） |
| 原 R2+R3 | → 第二篇合并 |
| 原 R4 | → 第三篇（体裁改开发指引向） |
| 原 R5 | → 第四篇（RFC+web-styling.md 校准双件套） |
| 原 R6 web-cordis | **不做 RFC**；设计文档保留 missions/tasks/20260719-2339-web-cordis-design/ 原路径，用户后续自改；**归档删除方案中列为豁免目录** |
| 归档去向 A（删除留 git） | 不变，豁免清单 += web-cordis 目录；终局回刷口径不变 |
| 注释清扫审计 | 不变（v2 提案「四」节照旧） |
| 连带发现 ①ui-product/ui-tech | 建议维持：四篇落地后这两份旧定稿重写或废弃（第三篇吸收 ui-tech 有效部分后其协议节全废）——待用户顺手拍 |
| 语言 | 未答；大纲中文，正文语言开写前定 |
