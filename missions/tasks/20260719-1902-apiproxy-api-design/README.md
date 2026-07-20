# apiproxy 统一 API 层设计（step2 协议基础）

任务：定义 apiproxy 对多形态（Web/Electron/TUI）暴露的统一 API 接口层 + web client 的 HTTP/SSE 架构。主会话直写（决策密度高），文档等用户 review。

## 用户拍板记录（2026-07-19）

| 议题 | 结论 |
|---|---|
| 契约权威 | TS interface 权威 + fetch 载体（进程内注入 handler 当 fetch = opencode 同构点） |
| 流形态 | AsyncIterable + AbortSignal |
| 事件面 | 两条 SSE：全 session 一条 mux 聚合 + host 信息一条（沿用旧结论） |
| 接口分组 | 按业务域分文件：`sessions.ts` 一域一文件 |
| 路径映射 | RPC 风格，不考虑 REST 体验 |
| 错误模型 | 类型化 ResultType（不 throw） |
| 校验 | zod 双向校验，**不要 passthrough**；可 dev-only 开启 |
| 事件 payload | 原则透传 core 结构，不自造封装；tool presentation 先透传，文档标注遗留 |
| 历史读取 | 按简单来，不做多套（事件重放 + client 单一 fold） |
| mux 重连 | 不做 since 续传（签名留座），重连=重开流+重拉 history（采纳 opencode 对照建议） |
| 冷 session | attach 状态不对客暴露，只给 running（冷=false）；history/prompt 隐式 resume |
| history 分页 | **按消息边界切页**（不从消息中间截断，chunk 随定稿消息归组），参数 maxMessages |
| SessionSummary | v1 不建索引：sessionId + 文件 mtime(updatedAt) + running 三字段 |
| prompt 载荷 | 直接收 core `ContentBlock[]`，不设 text 简化层 |
| schema 文件 | 一域一对：`sessions.ts`（类型）+ `sessions.schema.ts`（zod） |
| subscribed 帧 | 保留 lastSeq 字段（history 补缝竞态检测） |
| SessionListCursor（2026-07-19 20:00） | **不 brand**：v1 未实现占位用裸 `cursor?: string`，实现分页时再定是否 brand |
| HostInfo（2026-07-19 20:02） | 五字段定稿：version/cwd/provider?/model?/attachedSessions；**不设 protocolVersion**（client/host 绑定发布，无跨版本组合；独立发布 client 出现时再引入） |
| RPC 命名体系（2026-07-19 20:15） | ApiResult→**RpcResponse**（方向可辨识：Request 族 / Response 族 / Frame 族）；**每方法具名 Request/Response，签名禁内联**；空 request 也具名；流方法 signal 独立第二参不进 Request；HostInfo 并入 HostDescribeResponse；`hostEvents` 方法名改 `host`（对齐 wire 路径 `events.host`，避免 EventsHostEventsRequest 推导怪名） |
| RPC map（2026-07-19 20:30） | 方向拍板：加 RpcMethodMap + ClientRequest\<K\>/ServerResponse\<K\> 泛型索引；`events.host` 改名通过；map key 单复数授权设计层定（定单数 `session.list`，wire 路径同步）；形态 A vs B 并排呈案 |
| RPC map 终选（2026-07-19 20:41） | **形态 B：函数签名即事实源**——参数/返回内联在方法签名，RpcMethodMap 登记方法，ClientRequest/ServerResponse/ServerValue infer 反推；「禁内联」放宽为「禁重复内联」；平铺具名 15 类型删除（zod 直接锚派生类型，报错展开代价用户接受）；空 request 用 `{}` |
| RpcError 强类型化（2026-07-19 20:56） | **details 走错误码→类型 map**（RpcErrorDetailsMap，与 RpcMethodMap 同构第二张表）；RpcError 用 map 展开分布式 union（泛型 interface 默认形式不窄化，弃）；**details 必填**（internal 显式 `{}`），「必须真填」纪律升编译期强制；zod 用 discriminatedUnion('code') 逐支锚定 |
| 审批/问答形态（2026-07-19 21:00） | **「unary 对」定案**：请求下行 mux 帧（requested，稳定 id+session 锚）、回答上行 HTTP unary（respond 带 id），不做双向帧；域从不做清单**升格为本轮出协议设计**（实现可排后）；细节提案见 core-coverage.md 审批/问答节，随 L1-L7 一并裁决 |
| rpcId + 信封（2026-07-19 21:04） | **所有 unary 指令带 client mint 的 rpcId**（不做只 prompt 带的区分）；**wire 两层分离**：RpcRequestEnvelope(rpcId/method/payload) / RpcResponseEnvelope(rpcId/result)；ApiProxy 签名不感知信封（载体层统一包/解）；method 字段保留（日志自含+path 校验）；RpcId brand（首个 client mint id，构造函数照 SessionId 先例）；SSE open 不带 rpcId；prompt 的 rpcId 经 MessageSource 透传为 provisional 关联机制（转正执行仍 v1 不做） |
| 整轮裁决（2026-07-19 21:13） | **L1/L2/L5 进契约**（SessionSummary+session-added 帧加 parentSessionId?、SessionSummary 加 cwd?、HostFrame 加 host/agent-error）；**L3/L4/L6/L7 类型写全预留**（design §8，不进 map——fail loud 优于 not-implemented 兜底）；**审批/问答提案整体采纳**并入正文 §3.4（先到先赢/resolved 收敛/subscribed 基线重放/ApprovalRequestId 复用+QuestionAskId host mint 均按推荐）；rpcId≠资源 id 辨析入档；design.md 定稿 v1.5 |
| 问答 id 统一（2026-07-19 21:19） | **取消 QuestionAskId**：问题标识复用 `RpcId` 类型（host 受理 ask 时同一 `RpcId()` mint）；RpcId 语义扩为「**交互发起方 mint**」；**审批仍透传 core ApprovalRequestId，有意不对称**（durable 审计事件关联+透传非自造）；rpcId≠资源 id 辨析措辞更新（类型统一、语义仍分立） |
| 帧信封对称化（2026-07-19 21:19） | **每条 SSE 帧包 `RpcFrameEnvelope{rpcId, frame}`**，rpcId 由 server 发帧时 mint（标识这一次推送）；职责=日志对账+去重/追溯接缝，**不承担 cursor**（续传锚仍是 event.seq）；流侧同样签名不感知信封（AsyncIterable\<MuxFrame\> 不变，createApiClient 内拆）；信封模型全对称：Request/Response/Frame 三信封 |
| 签名信封化（2026-07-19 21:5x） | **推翻「签名不感知信封」**：ApiProxy 方法签名显式收 `RpcRequest<P>` 封装（rpcId 进签名不进业务 payload）；「单次 HTTP 所以 rpcId 不重要」论证被用户否定——rpcId 是逻辑层关联，不因传输自带信道而省略 |
| 四象限消息模型（2026-07-19 22:00–22:1x，v2.0） | **通道与消息彻底解耦**（HTTP=C→S 通道、SSE=S→C 通道，仅此而已）；wire 全形=**四具名判别 union**（ClientRequest/ServerResponse/ServerRequest/ClientResponse，22:1x 用户坚持字面四具名，判别子=type 四字面量）；**纯推送=不期待应答的 server-request，严格二分不设 notify**（22:1x 用户采纳设计层方案）；**respond 重建模为 client-response**：回填 requested 帧 rpcId、不 mint 新 id、不进 RpcMethodMap，wire=POST /api/respond 单端点、HTTP 应答体=RpcReceipt 载体回执；两个 not-pending 错误码删除；泛型工具撞名改 RequestPayload\<K\>/ResponseValue\<K\>；流签名 yield RpcRequest\<帧\>（rpcId 暴露给业务层）；流程放宽：文档更新完直接生码不等确认 |
| client 载体类体系（2026-07-20 shape-a + abstract-base，commit 893421d50；本行由 rfc-consolidation 代笔补记——apiproxy-design 静默中，RFC 第二篇写作核码顺手补一致） | **createApiClient 工厂废除，改 AbstractApiClient 抽象基类**：协议不变量（mint/四象限包解/zod/SSE 解帧/超时/rpcId 回显校验）全在基类，平台差异=两切面（抽象 doFetch 传输 + 可覆写 onEnvelope 观测）；**IApiClient=caller 视图（shape a）**：unary 收业务 payload 直传、载体 mint、业务代码永不 mint，与 ApiProxy（impl 窄形契约）由基类桥接；**实例级 envelope 观测**：subscribeEnvelopes 批量订阅（微任务合批、异常隔离、无订阅者零成本），旧 onEnvelope 选项+ApiEnvelopeTapEvent 废除，rpcLog 降纯订阅者；子类=InProcessApiClient（同构点新写法）/WebApiClient/FixtureApiClient（协议层覆写虚方法，假信封包装器删除）；design.md §4.1/§5 已同步 |

## 文件索引

| 文件 | 内容 |
|---|---|
| `design.md` | API 层设计文档（主产出） |
| `opencode-crosscheck.md` | opencode 调研对照表（同构面验证/CQRS 同向/重连砍 cursor，建议已采纳） |
| `core-coverage.md` | core 能力面 × 契约覆盖度盘点（7 域四态标注 + 漏判清单 L1-L7 已裁决，存档；契约以 design.md 为准） |

## 进展

| 时间 | 事项 |
|---|---|
| 2026-07-19 19:02 | 主会话开写 design.md；核实 core 类型面（SessionEvent/seq/foldSurface/Agent 原语） |
| 2026-07-19 19:06 | design.md v1 落盘：三域接口（sessions/host/events）、ApiResult、fetch 载体映射、client 分层、不做清单、3 个开放问题 |
| 2026-07-19 19:10 | opencode 调研回队；对照写入 opencode-crosscheck.md（同构面/CQRS/无 cursor 重连三判断） |
| 2026-07-19 19:48 | 用户拍板 Q1–Q8；design.md 升 v1.1：重连重建、消息边界分页、ContentBlock 透传、schema 文件对、lastSeq 保留；开放问题清零（时间按 design.md 文件 mtime 推断） |
| 2026-07-19 20:00 | 用户拍板 SessionListCursor 取消 brand；design.md 同步（id 纪律 + §3.1 `cursor?: string`） |
| 2026-07-19 20:02 | 用户拍板 HostInfo 五字段定稿（去 protocolVersion，命名回 version）；design.md §3.2 落 interface 全文 + 决策边界注记 |
| 2026-07-19 20:15 | 用户拍板 RPC 命名体系重构；design.md 全文替换：RpcResponse/RpcError（rpc.ts）、11 个具名 Request/Response、Frame 族独立、新增「命名 convention」小节 |
| 2026-07-19 20:30 | 用户三点裁决：key 单复数授权设计层（定单数）、events.host 通过、map 形态待终选；design.md 落「RPC map 两种形态」对比小节（A 类型对 / B 函数签名 infer，五维差异表 + 推荐 A） |
| 2026-07-19 20:41 | 用户终选形态 B；design.md 升 v1.3 分批收尾：map 节改终选结论、§3 三域内联回归签名（删 15 个平铺具名）、convention 改「禁重复内联」、zod 锚 infer 派生、布局落 rpc-map.ts、wire 表 key 对齐 |
| 2026-07-19 20:54 | core-coverage.md 盘点完成（session/agent/subagent/tasks/审批问答/杂项/LLM 七域，file:line 为证）；漏判清单 L1-L7：建议进 v1 三条（L1 谱系/L2 cwd/L5 agent-error 帧）、留接缝四条（L3 fork/L4 inject/L6 tasks/L7 provider 枚举），待用户逐条裁决 |
| 2026-07-19 20:56 | 用户拍板 RpcError.details 强类型化，design.md §2 重写（RpcErrorDetailsMap + 分布式 union + details 必填 + zod discriminatedUnion + 扩展路径）；rpc-compare 三采纳项落档：details 真填纪律（并入 §2 升编译期强制）、client unary 超时注记（§5）、并发 resume 去重注记（§3.1） |
| 2026-07-19 21:00 | 用户拍板审批/问答「unary 对」形态并升格为本轮出协议；core-coverage.md 落协议提案节（方法/帧、id 纪律、竞争语义、subscribed 基线重放恢复、core 事实对齐六表），补核 user-interaction 无 request 级 id、ask 不落日志两事实；随 L1-L7 待整体修订轮裁决 |
| 2026-07-19 21:04 | 用户拍板全指令 rpcId + 信封两层分离；design.md 升 v1.4（§2 信封类型+纪律、§4 wire 两级 parse、id 纪律 RpcId、convention 二层分离、不做清单改写） |
| 2026-07-19 21:13 | 用户整轮裁决；design.md 定稿 **v1.5**：L1/L2/L5 合入（批1）、审批/问答域并入正文 §3.4+根接口+map+四帧+两错误码（批2）、§8 预留接缝类型 L3/L4/L6/L7（批3）、版头/README/core-coverage 标注（批4） |
| 2026-07-19 21:19 | 用户两条修订并入 v1.5：QuestionAskId 取消（问答 id 复用 RpcId，RpcId 语义扩「交互发起方 mint」，审批有意不对称留 ApprovalRequestId）；帧信封对称化（RpcFrameEnvelope{rpcId,frame}，SSE data 改信封 JSON，流侧签名不感知，rpcId 不承担 cursor）；design.md §2/§3.4/§4/id 纪律/convention/版头六处同步，core-coverage 提案节标注修订 |
| 2026-07-19 21:55 | W1 契约包（旧三信封模型）dispatcher 直写落盘 14 文件 typecheck 绿；Wire<T> 锚定修正回写 §0.5（exactOptionalPropertyTypes 与 zod .optional 不兼容） |
| 2026-07-19 22:00–22:3x | 用户三轮拍板推到四象限模型（签名信封化→通道解耦→四具名 union+二分裁决）；design.md 升 **v2.0**：§2 重写（四具名/窄形/RpcReceipt/错误码删两个）、§3 签名全改 RpcRequest<P>、§3.3 流 yield RpcRequest<帧>、§3.4 respond 重建模、§4 wire 四象限表、rpc-map 6 key+RequestPayload/ResponseValue、convention 同步、§8 补 hostInstanceId 预留（ui-design 提出）；期间主会话短暂接管又交还（用户澄清 owner 不变） |
