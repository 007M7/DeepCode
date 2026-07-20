# apiproxy 协议 vs 仓内 dsh-jsonrpc 平视对比

> 2026-07-19。对象：`missions/tasks/20260719-1902-apiproxy-api-design/design.md`（v1.2，RPC map 按形态 B 理解）vs `packages/ui/jsonrpc/`（src/index.ts、server.ts、transport.ts + README + tests）及其真实消费方 `python/sdk/src/deepseek_harness/client.py`（jsonrpc-demo 只是 bin 壳，协议客户端在 python SDK）。
> 场景声明：jsonrpc 是**进程间 stdio、单流全双工、SDK 驱动**场景；apiproxy 是**浏览器 HTTP/SSE、每请求独立信道**场景。纯场景差异导致的不同不计为学习点。

## 维度 1：帧 / 信封形状

| 子项 | 我方（apiproxy） | jsonrpc | 评价 |
|---|---|---|---|
| 信封 | `RpcResponse<T> = {ok:true;value} \| {ok:false;error}`，HTTP 200 恒定，载体状态码只表载体故障（design §2、§4） | JSON-RPC 2.0 帧：`{jsonrpc,id,method,params}` 请求 / `{id,result\|error}` 应答 / 无 id 为 notification，按「id+method / 仅 id / 仅 method」三分（transport.ts:1-7, 162-177） | 各得其所：单条共享流必须靠 `id` 关联请求应答；HTTP 每请求自带信道，我方省掉 id 关联层是合理简化 |
| id 生成 | 无（HTTP 关联） | client 侧 `req_`+uuid 字符串（transport.ts:98）；python 客户端同样 uuid（client.py:230） | 场景差异，无学习点 |
| 批量（batch） | 无此概念 | **未实现**：JSON-RPC 2.0 批量数组帧会静默落空（`handleLine` 三分支全不匹配即丢弃，transport.ts:162-177） | 双方一致不做批量；对方的「静默丢弃」还不如显式拒绝，见维度 3 容错评价 |
| notification（无 id 帧） | 无对应物；server→client 推送走独立 SSE 流的 Frame 族 | **重度使用**：server→client 事件全部走 notification（`session.event` server.ts:81、`session.finished` server.ts:139、`subagent.started` server.ts:86、`subagent.finished` server.ts:97）；client→server 方向也支持（client.py:173-177，实际未用） | 等价物：他们的 notification ≈ 我们的 Frame 族。双方都把「推送不是应答」这件事在帧形状上区分开了——他们靠去掉 id，我们靠独立的流 + Frame 类型族 |
| 帧命名纪律 | 已拍板机械推导 convention：方法 key 点号（`session.list`），Frame type 斜杠（`session/event`）（design §1 命名 convention） | **无 convention，自然漂移**：方法名 `session/prompt` 用斜杠（server.ts:199），notification 名 `session.event`/`session.finished` 用点号（server.ts:81,139）——与我方约定恰好完全相反且包内自身不一致 | 我方优。对方是「没有显式约定就会漂移」的实证，反向验证了我们把命名 convention 写进拍板的价值 |

维度小结：信封差异基本由载体决定（共享流 vs 每请求信道），无需互搬。对方 wire 命名漂移是反面教材，不构成改动项。

## 维度 2：方法注册与类型安全

| 子项 | 我方（apiproxy） | jsonrpc | 评价 |
|---|---|---|---|
| 方法注册 | `RpcMethodMap`（形态 B：登记方法签名本身，`'session.list': SessionsApi['list']`），handler/client 按 map key 机械遍历（design §1 RPC map） | 单个 `onRequest(handler)` 槽位（transport.ts:84-86）+ server 内裸字符串 `switch(method)` 派发三个方法（server.ts:195-206），无 map、无遍历机制 | 我方结构化程度高一档；对方仅 3 个方法，裸 switch 成本尚可接受，但每加一方法要同时改 switch + 类型 + python 双份 |
| 参数类型约束 | `ClientRequest<K>` = `Parameters<RpcMethodMap[K]>[0]` 反推，签名即事实源；wire 入口 zod parse 拒收 → `bad-request`（design §1、§4） | 接口类型仅作文档（`InitializeParams`/`SessionPromptParams`，server.ts:20-47），派发处 **`params as unknown as InitializeParams` 双重 cast，零运行时校验**（server.ts:198,200）；transport 层只把非对象 params 归一成 `{}`（objectParams，transport.ts:220-223） | 我方显著更严：对方 wire 与类型之间没有任何强制关联，恶意/漂移 payload 直接以 any 语义进 handler |
| 契约的跨语言事实源 | TS interface 单一权威，client 经 `import type` 直达（design §0.1） | **契约双份**：TS interface（server.ts:20-47）+ python pydantic 模型（models.py:26-31）各写一遍，靠人肉对齐，无生成或校验链 | 我方优（v1 单 TS 生态占了便宜）；若将来 apiproxy 出现非 TS 消费方，对方这个「双份漂移风险」就是前车之鉴——到时需要 schema 导出（zod → JSON Schema）而非手抄 |
| 返回值类型 | `ServerValue<K>` infer 去信封；zod `satisfies z.ZodType<T>` 双向锚定 | 返回 `Promise<unknown>`（transport.ts:14, server.ts:195），python 侧 pydantic `model_validate` 兜底（client.py:171） | 我方优；对方把校验责任推给了客户端 |

维度小结：类型安全是两者差距最大的维度。对方是「接口类型只当注释用」的典型形态，任何一处 wire 漂移要靠 python 侧 pydantic 报错才能发现；反向验证我方 RpcMethodMap + zod 双向校验的投入是值得的。此维度无可学习点，只有可引以为戒点。

## 维度 3：错误模型

| 子项 | 我方（apiproxy） | jsonrpc | 评价 |
|---|---|---|---|
| 错误码体系 | `RpcErrorCode` 闭合字符串 union，起步四码 `bad-request/session-not-found/agent-busy/internal`，按域扩展（design §2） | 标准 JSON-RPC 数字码但**只用两个**：`-32601` method-not-found（transport.ts:182）、`-32603` 兜底（transport.ts:189）；server 层所有业务异常（session 忙 server.ts:132、provider 无 adapter server.ts:119、shutting down server.ts:209）全部 throw Error → 统一压扁成 `-32603 + message 文本` | 我方显著优：对方客户端只能靠 message 字符串匹配区分「忙」和「炸」（python 侧 JsonRpcError.code 拿到的恒是 -32603）。我方 `agent-busy` 这类可编程区分的域码正是对方缺的 |
| error.data / details | `details?: unknown`（design §2） | 帧格式支持 `error.data`（python 读侧 client.py:345-347、写侧 respond_error client.py:207-218），但 **server 从不填**——data 通道形同虚设 | 双方形状同构（details≈data）；对方证明「留了通道不填」没有价值，我方 details 的价值取决于 impl 真的放结构化内容（如 zod issue 列表进 bad-request.details） |
| 业务错误 vs 传输错误分层 | 两层显式分离：业务错误 = 200 + RpcResponse.error；载体故障 = fetch throw / 4xx/5xx（design §2、§4 HTTP status 只表载体） | **无分层**：业务失败与 handler bug 同为 -32603 error 帧；传输死亡 = pending 全部 reject（transport.ts:213-217, python client.py:373-384） | 我方优。对方 -32603 语义上本应是「internal error」，被迫兼职业务错误码，是标准 JSON-RPC 码表太窄的直接后果 |
| 非法帧容错 | 404 未知路径 / 400 body 非 JSON —— 显式拒绝（design §4） | **静默丢弃**：JSON 解析失败 ignore（transport.ts:154-160）、非对象帧 ignore（transport.ts:162）、批量数组帧三分支全不匹配也静默落空（transport.ts:162-177）、孤儿 response 静默忽略（transport.ts:194-195） | 各有道理：共享长流上一条坏帧不该毒死整个连接（丢弃保流活）；HTTP 每请求独立，显式 4xx 无连坐风险。场景差异，但「孤儿 response 忽略」对应我方 SSE 重连后旧流帧要能安全丢弃——我方 v1「重连=重建」天然规避 |

维度小结：错误模型我方全面占优，且对方恰好演示了我方设计规避的两个坑（码表退化成单码、data 通道空转）。唯一带回家的是执行纪律而非契约改动：`details` 要在 impl 里真的填结构化内容。

## 维度 4：流式 / 事件推送

| 子项 | 我方（apiproxy） | jsonrpc | 评价 |
|---|---|---|---|
| 推送机制 | 两条 SSE（events.mux 全 session 聚合 + events.host），AsyncIterable<Frame>（design §3.3） | 无流概念；server→client 推送全走共享 stdio 流上的 notification（session.event server.ts:81、session.finished server.ts:139、subagent.started/finished server.ts:86,97） | 同构异形：单双工流 vs 独立 SSE 是载体差异。值得注意的相同点：**双方都选了「全量广播、client 侧过滤」**——对方 python 端 predicate 订阅过滤（client.py:185-196, 496-505），我方 mux 聚合流 client fold；无 server 侧按 session 订阅，路线互相印证 |
| 事件 payload | `SessionEvent` 纯透传（design §3.3 透传纪律） | **同样纯透传**：`notify('session.event', { sessionId, event })`，event 原样（server.ts:76-82） | 双方一致。透传纪律在对方已有实践先例，佐证我方拍板 |
| prompt 与事件的关系 | prompt 立即回 `accepted`，token/工具进度走 mux 流，turn 结束由 client fold `turn/end` 事件得出 | **prompt 请求悬到整轮结束**：`await whenIdle()` 后才回 accepted（server.ts:130-148），轮次结局另发 `session.finished` notification（status 由 turn/end reason 折算，server.ts:234-237）；README:23 一 session 单飞行 prompt，重叠立即失败 | 我方优（对我们的场景）：长轮次挂住一个 HTTP 请求分钟级不可接受，浏览器超时/代理都会杀它。对方 SDK 场景「阻塞到定稿」反而是易用性（同步语义）。`session.finished` 我方不需要——透传的 turn/end 事件已含此信息，对方是因为不透传完整事件序给 request 侧才需要补这个信号 |
| 缝隙检测 | `subscribed.lastSeq` + history 尾 seq 对比补缝（design §3.3 已拍板） | 无对应物：单条有序流从 session 创建起连续推送，无「开流 vs 拉历史」竞态窗口，也无 seq 概念上 wire | 场景差异（对方无历史拉取、无重连）。我方多出的复杂度是 HTTP 双通道（unary+SSE）的固有代价，lastSeq 是对的 |
| 子代理谱系 | HostFrame 只有 `session-added/removed/status`，**无父子关系**；SessionSummary 三字段无 parentSession（design §3.1、§3.3） | 一等公民：`session/created` 时若有 `parentSession` 即发 `subagent.started {parentSessionId, childSessionId}`（server.ts:83-90）；`subagent/end` 发 `subagent.finished` 带 provider/status/stopReason/lastAssistantMessage（server.ts:91-106），且只报 `local` 子 session（server.ts:97 快照纪律） | **对方有我方没想到的点**：SDK 消费者第一时间要子代理谱系，web UI 迟早同样要（子 session 归组显示在父会话下）。我方 host/session-added 帧撞上子 session 时 client 无从知道它是谁的孩子。学习点 → 建议清单 #1 |

维度小结：推送形态互相印证（广播+client 过滤、事件透传都撞车，是好信号）。真学习点一个：子代理谱系在 session 出生帧上的缺位。

## 维度 5：传输层抽象

| 子项 | 我方（apiproxy） | jsonrpc | 评价 |
|---|---|---|---|
| seam 形状 | `fetchLike` 函数（`createApiClient(fetchLike)`），同进程注入 `toFetchHandler(api).fetch` 即免网络（design §1、§4 同构点） | 双 seam：① 流级 —— `JsonRpcConfig.input/output` 收 `Readable/Writable`（index.ts:26-33），生产 stdin/stdout，测试注 PassThrough（transport.spec.ts:6-12 用两对 PassThrough 组 transportPair 全双工对测）；② 帧级 —— server 只依赖 `JsonRpcTransportPeer` 接口（request/notify 两方法，transport.ts:20-34，server.ts:74） | 同一思想不同层：都把「换传输」做成注入点，都能做到测试零真 IO。对方帧级 `TransportPeer` 接口值得注意——server 完全不知道底下是 stdio 还是别的；我方等价物是 `ApiProxy` 接口本身（handler 不知道 fetch 是真是假），层次同构 |
| 帧编码 | JSON body / SSE `data:` 行 | newline-delimited JSON + StringDecoder 处理跨 chunk 多字节 UTF-8（transport.ts:49,129；专项测试 transport.spec.ts:125-143） | 场景差异。但对方 UTF-8 splitting 专项测试提醒了一件事：我方 SSE 用 streaming fetch 手工切帧（design §4「非 EventSource」），**同样会遇到多字节字符跨 chunk 与跨 `data:` 行边界问题**——这是 client 实现的必测项，进清单（测试项，非契约改动） |
| exit/进程权 | 不适用（HTTP server 常驻） | `exit` 也是注入 seam（index.ts:31-33），协议 shutdown 先 flush 响应再 dispose 再 exit(0)（index.ts:57-74） | 场景差异，无学习点 |
| 背压/flush | 未提及；HTTP 响应体天然有背压 | `flush()` 用空写屏障等待所有先前帧落盘（transport.ts:115-126），shutdown 前显式 flush 保「响应先于退出」 | 对方解决的是「进程要死前别丢帧」，我方 host 常驻无此问题；SSE 断流时帧丢失由重连重建兜底。无需搬 |

维度小结：可替换性双方都做到了，思想同构（接口注入、测试零 IO）。带走一个实现期测试项：SSE 手工解帧的多字节/跨 chunk 边界测试。

## 维度 6：生命周期 / 取消 / 超时

| 子项 | 我方（apiproxy） | jsonrpc | 评价 |
|---|---|---|---|
| 请求取消 | unary：无（HTTP fetch 本身可 abort，但 server 侧不感知语义取消）；**业务级取消是显式 RPC**：`session.cancel` 清 FIFO + abort step（design §3.1） | **完全没有**：wire 无 prompt-cancel 方法，README:35 明列已知缺陷「一个 accepted prompt 跑到 idle 前该 session 无法再接受任何输入」；python 客户端超时（client.py:264）也只是放弃等待，server 侧照跑 | 我方优，且对方把这个坑写成了官方遗留。反向确认 `session.cancel` 进 v1 是对的 |
| 请求超时 | 未提及；fetch 载体可加 AbortSignal，但契约层无 timeout 语义 | client 侧 `request_timeout_seconds`（HarnessConfig，client.py:33; 超时逻辑 client.py:250-264），默认 None=无限等 | **对方有我方没写的点**：超时是纯 client 策略这个定位是对的（server 不该管），但我方 design §5 ConnectionController 未提 unary 超时——浏览器 fetch 默认无超时，host 若 hang，UI 会永久 pending。学习点（client 实现注记，非契约改动）→ 清单 #3 |
| 连接断开（client 死） | SSE 断流 server 侧收 abort；unary 无状态 | stdin EOF → dispose root → 进程退（bin.ts:49; demo README:27 「EOF 切断在飞轮次」）；pending 请求 reject（transport.ts:148-152） | 场景差异（对方 client 死=服务无意义；我方多 client 且 host 常驻）。无学习点 |
| 服务端主动关闭 | 无 shutdown 概念（host 生命周期独立于 client） | 协议级 `shutdown` 方法：响应先落盘再 flush → dispose 到静止 → exit 0（index.ts:67-74, server.ts:155-186）；幂等（shutdownTask 缓存 server.ts:156） | 场景差异。但其中「shutdown 期间新建 session 拒绝」（shuttingDown 闸门 server.ts:209）+「等 pending 创建落定再拆」（server.ts:162-164）是通用的**拆机纪律**，我方 host 将来做优雅退出（Electron 关窗）时同样要处理 in-flight prompt vs 拆机竞态——记为远期提示，不动 v1 契约 |
| 并发互斥 | prompt 无互斥需求（agent FIFO 队列天然吸收，mode:queue/steer 语义已覆盖）；单客户端互斥 ClientSlot v1 不做（design §6） | session 级单飞行 prompt，重叠**立即报错**（activePrompt 标志 server.ts:132）而非排队 | 有意思的分叉：对方「拒绝重叠」因为其 prompt 语义是同步等结局；我方 prompt=入队立返，天然无重叠问题。各自内洽，无学习点 |
| 惰性资源创建 | `session.create` 显式；history/prompt 对冷 session 隐式 resume（design §3.1） | prompt 未知 sessionId 直接惰性创建 agent+session（server.ts:38, 208-232），并发创建去重（sessionCreations map，server.ts:212-221） | 同路线（隐式创建/附着）。对方 `sessionCreations` 并发去重值得记一笔：我方两个并发请求同时命中同一冷 session 时 impl 也要做 resume 去重——实现注记 → 清单 #4 |

维度小结：取消上我方领先（对方官方承认缺失）；对方贡献三个实现期提醒：client 超时策略、并发 resume 去重、优雅拆机闸门。全部是 impl/client 层面，零契约改动。

## 建议采纳清单

平视结论先行：六个维度里，**契约形状层面没有一处需要向 JSON-RPC 2.0 靠拢**——信封、错误码、流形态的差异全部由场景（HTTP 多信道 vs stdio 单流）正当化，且对方在类型安全、错误码分辨力、取消能力三处反向验证了我方拍板。真正值得搬的是对方作为「已运行协议」暴露出的需求点和实现纪律，共 4 条 + 1 条反面自查：

1. **【唯一契约改动建议】host/session-added 帧补子代理谱系**：`HostFrame` 的 `session-added` 增可选字段 `parentSession?: SessionId`（core session header 已有此数据，server.ts:83-90 证明取用零成本）。jsonrpc 把 subagent.started/finished 做成一等公民，说明消费方第一时间就要谱系；我方 web UI 做子 session 归组时若无此字段，只能开一条 history 才能知道父子关系，代价不成比例。**成本：极低**——additive 可选字段，一行类型 + schema 一行 + impl 取 header 现成值；现在加避免将来 fold/store 按平铺 session 建模后返工。若用户认为 v1 UI 明确不显示子 session，可降级为「留座注记」写进 design §6 不做清单。
2. **【执行纪律，非改动】`RpcError.details` 必须真的填**：jsonrpc 的 error.data 通道从未被 server 填过（形同虚设）。落实到 impl 验收：`bad-request` 的 details 放 zod issues、`session-not-found` 放 sessionId。成本：impl 编码习惯，零契约变更。
3. **【client 实现注记】unary 请求超时**：浏览器 fetch 默认无超时，host hang 时 UI 永久 pending。python SDK 的做法（纯 client 侧 timeout 配置，client.py:250-264）定位正确。落到 design §5 ConnectionController 一句话注记即可。成本：低，一句设计注记 + client 实现一个 AbortSignal.timeout。
4. **【impl 实现注记】冷 session 并发 resume 去重**：两个请求并发命中同一冷 session 时的 resume 单飞（对照 sessionCreations map，server.ts:212-221）。成本：低，impl 内一个 Map<SessionId, Promise>，可写进 design §3.1 分页注记旁一句话。
5. **【反面自查，已通过】wire 命名一致性**：对方无 convention 导致 `session/prompt`（斜杠方法名）与 `session.event`（点号通知名）在同一包内互相打架。我方已拍板机械推导 convention（方法点号、Frame 斜杠），此坑已提前规避——无动作，仅记录佐证。

SSE 手工解帧的多字节 UTF-8 跨 chunk 测试（维度 5）并入 client 实现测试计划，不单列为契约建议。

