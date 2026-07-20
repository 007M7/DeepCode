# apiproxy 统一 API 层 · 设计（v2.0：四象限 RPC 消息模型）

> 2026-07-19 主会话起草；19:48 Q1–Q8 修订；20:15 RPC 命名体系（RpcResponse）；20:41 形态 B 终选；20:56 RpcError 强类型化；21:04 rpcId+信封两层；21:13 整轮裁决（L1/L2/L5+审批问答+§8 预留）；21:19 问答 id 复用 RpcId+帧信封对称；**22:00-22:3x 四象限统一消息模型定型（v2.0）**：通道与消息解耦、四具名判别 union、签名显式收窄形 RpcRequest<P>、respond 重建模为 client-response、泛型工具改名 RequestPayload/ResponseValue。拍板全记录见同目录 README.md。
> 定位：`packages/host/apiproxy` 对 Web / Electron / TUI 暴露的**唯一契约层**；web client 的 HTTP/SSE 只是它的一种承载。

## 0. 总原则（已拍板）

1. **TS interface 是权威契约**，HTTP/SSE 是载体。同进程形态（Electron main、测试）直接注入 handler 当 fetch，跨进程走真 HTTP——签名完全一致（opencode 同构点，已经调研证实其 fetch 面连 Worker RPC 边界都能过）。
2. **透传 core 数据结构**：wire 上的事件/消息/内容块就是 `SessionEvent` / `ContentBlock` 等 core 类型，不自造第二套 DTO。类型经 `import type` 依赖链直达浏览器。
3. **RPC 风格**，按业务域分组，一域一对文件（`sessions.ts` 类型 + `sessions.schema.ts` zod）。
4. **错误 = 类型化 RpcResponse 信封**（`RpcResponse<T>` + `RpcError`），方法不 throw 业务错误。
5. **zod 双向校验**（C→S 命令、S→C 事件都 parse），schema 用 `satisfies z.ZodType<T>` 锚定编译期防漂移——形态 B 下 `T` 是 infer 派生类型（`satisfies z.ZodType<RequestPayload<'session.list'>>`），锚定等价可行，代价（报错信息展开为字面量结构）已被用户接受（2026-07-19 20:41）；不 passthrough。可 dev-only 开启（开关是实现细节不进签名）。**实现修正（21:55，W1 落地发现）**：仓库 `exactOptionalPropertyTypes` 与 zod `.optional()` 输出类型（`T | undefined`）不兼容，锚定统一写 `satisfies z.ZodType<Wire<T>>`——`Wire<T>` 是深度「| undefined」宽化（api/rpc.schema.ts 定义并注释），JSON wire 上缺席与 undefined 同形故不损失校验语义；透传宽分支（SessionEvent/ContentBlock/帧 union/RpcError discriminatedUnion）与 brand id schema 用显式 cast + 注释。
6. **历史 = 事件重放**：一套 fold（client 侧），历史分页拉 + live 增量贴同一条代码路径；server 不做物化快照第二套。
7. **重连 = 重建**：v1 不实现续传 cursor（签名留可选 `since`），断线重连一律重开流 + 重拉 history（opencode 同款）。

## 1. 分层与文件布局

```
packages/host/apiproxy/src/
  api/                    ← 契约层（纯类型 + zod schema，浏览器可 import）
    index.ts              ← export interface ApiProxy { sessions, host, events }
    sessions.ts           ← SessionsApi 接口（方法签名 = 出入参事实源）
    sessions.schema.ts    ← 上者的 zod schema（一域一对文件，同名 .schema.ts 后缀）
    host.ts / host.schema.ts
    events.ts / events.schema.ts   ← 流签名 + 帧类型 + 帧 schema
    approvals.ts / approvals.schema.ts   ← 审批域（v1.5，§3.4）
    questions.ts / questions.schema.ts   ← 问答域（v1.5，§3.4；问题标识复用 RpcId，无新 brand）
    rpc.ts                ← RpcResult / RpcError / RpcId / 窄形 RpcRequest·RpcResponse / 四具名 wire 全形 + RpcMessage / RpcReceipt
    rpc-map.ts            ← RpcMethodMap + RequestPayload / ResponseValue
  impl/                   ← Node 侧实现（boot harness core、实现 ApiProxy）
  fetch/
    handler.ts            ← toFetchHandler(api): (Request) => Promise<Response>
    client.ts             ← IApiClient + AbstractApiClient + InProcessApiClient（§4.1 类体系）
```

- `api/` 零 Node 依赖；`impl/` 只在 host 进程加载；client 包只 import `api/` + `fetch/client.ts`。
- 新域（provider、approvals…）= 新的一对文件 + `ApiProxy` 根接口一个字段。

### 依赖方向

```
apps/dsc ──► apiproxy/impl ──► harness core
                 │ implements
                 ▼
           apiproxy/api（契约，唯一权威）
                 ▲ import type + AbstractApiClient 子类
web-runtime ──► apiproxy/fetch/client ──► HTTP or 注入的 handler
```

### id 纪律（branding，2026-07-19 拍板）

- **`SessionId`：复用 core 的 branded 类型**（type-only import 自 dsh-session，浏览器零运行时）。契约中所有 sessionId 一律 `SessionId`。id 全部源自 server 响应（list/create），client 只回传，无需构造器；zod parse 在 shape 校验后一次 cast 上 brand（每个 `.schema.ts` 一个 cast 点）。brand ≠ 存在性校验——`session-not-found` 仍由 impl 判。
- **cursor 不 brand（2026-07-19 20:00 拍板）**：v1 未实现的预设占位不提前上 brand，签名用裸 `string`（`cursor?: string`）；将来实现分页时再决定是否 brand。
- **`RpcId` brand（2026-07-19 21:04 随信封拍板；21:19 语义扩展）**：opaque + 跨界往返 → brand；与 cursor 占位不同，v1 实装即进签名。mint 方 = **交互发起方**：unary 调用由 client mint（应答只回显）；server 发起的交互由 host mint——问答 ask 的问题标识、每条 SSE 帧的推送标识（帧信封）。单一品牌单一构造函数 `RpcId()`（core `SessionId()` 先例），谁发起谁构造。
- **事件内部 id 免费**：`CallId` 等随 `SessionEvent` 透传，core 已 brand，本层不重复定义。
- **seq 一族有意不 brand**（`beforeSeq` / `lastSeq` / `since` 值）：非 opaque——要做大小比较、且从透传的 `event.seq`（core 裸 `number`）派生；只在本层 brand 会逼每处派生 cast，与透传相抵。v1 仅 seq 一族数字无混用风险；出现第二族（revision/generation）再上 BrandedNumber。
- 闭合 union（`mode`、错误码）不 brand——union 是更强的约束。

### 命名 convention（2026-07-19 20:15 拍板，20:41 随形态 B 终选改写）

- **方向在消息 tag 上可辨识**（22:00 四象限重写）：wire 全形 = `ClientRequest`/`ServerResponse`/`ServerRequest`/`ClientResponse` 四具名判别 union（§2）；签名窄形 = `RpcRequest<P>`/`RpcResponse<T>`；payload 派生 = `RequestPayload<K>`/`ResponseValue<K>`。帧是 ServerRequest 的 payload（具名帧 union 保留，§3.3）。
- **禁重复内联**（20:15「每方法具名/签名禁内联」拍板随 B 放宽）：参数/返回的字面量结构只住方法签名一处（事实源），签名之外——handler、client、store、测试——一律 `RequestPayload<K>` / `ResponseValue<K>` 泛型引用，不复写字面量、不另起具名平铺类型。
- **空 request 写空字面量 `{}`**：将来加字段就地扩展签名，泛型引用处零迁移。
- **`AbortSignal` 不进 input**：input 定义为 wire 载荷，与 schema 一一对应；signal 不可序列化，混入会迫使 schema omit 字段、破坏 `satisfies z.ZodType<T>` 锚定。流方法签名为 `(input, signal: AbortSignal)`——signal 是本地控制参数，独立第二参。
- **信封 = `RpcResponse<T>`**（rpc.ts）：unary 一律 `Promise<RpcResponse<…>>`；`T` 是业务返回结构，信封管成败。
- **RPC map key 用域单数**：`session.list` / `host.describe` / `events.mux`（events 本身无单复），wire 路径同步 `/api/session.list`。单复数经用户授权由设计层定（2026-07-19 20:30）。
- **schema 命名按 map key 推导**：`sessionListRequestSchema` / `sessionListValueSchema`（住 `<域>.schema.ts`），锚定对应泛型引用（见 §0.5）。
- **消息层/业务层两层，签名显式感知窄形**（21:04 两层分离拍板 → 22:00 四象限重写）：wire 全形=四具名判别 union（§2），业务 payload 纯净内嵌；域接口签名收/吐窄形 `RpcRequest<P>`/`RpcResponse<T>`（rpcId 显式，业务 payload 内不混 rpcId）；全形补全（type tag/method）收口在 fetch 载体层。

### RPC map：函数签名即事实源（2026-07-19 20:41 终选形态 B）

**方法签名是唯一权威**：接口方法的参数/返回结构直接内联写在签名里；`RpcMethodMap` 登记方法本身；Request/Response 一律经条件类型从签名反推，任何签名之外的地方只引用泛型。

```ts
// rpc-map.ts —— map 只登记 client-request 方法（respond 是 client-response 不在此，22:00 四象限）
export interface RpcMethodMap {
  'session.list':    SessionsApi['list']
  'session.create':  SessionsApi['create']
  'session.history': SessionsApi['history']
  'session.prompt':  SessionsApi['prompt']
  'session.cancel':  SessionsApi['cancel']
  'host.describe':   HostApi['describe']
}
// 22:1x 撞名重命名（wire 四具名占用原名 ClientRequest/ServerResponse）：
export type RequestPayload<K extends keyof RpcMethodMap> = Parameters<RpcMethodMap[K]>[0]['payload']
export type ResponseValue<K extends keyof RpcMethodMap> =
  Awaited<ReturnType<RpcMethodMap[K]>> extends RpcResponse<infer T> ? T : never
```

- map key 即 wire 路径段（`POST /api/session.list`），`toFetchHandler` / `AbstractApiClient` 对 map key 类型安全机械遍历。
- 流方法不进 `RpcMethodMap`（不是 unary RPC）：`events.mux` / `events.host` 的 input 结构同样内联在签名，帧类型是具名 union（§3.3）。
- **平铺具名 Request/Response 类型删除**（非降级为派生别名）：别名是同一事实的第二个名字，与「任何地方都引用泛型」相抵；zod 直接锚 `RequestPayload<'session.list'>`，不需要中间名。
- 备选未采用：形态 A（类型对 map，具名 interface 为事实源 + map 登记类型对），2026-07-19 20:30 曾并排呈案，用户终选 B。

## 2. RPC 消息模型：四象限统一信封（2026-07-19 22:00 定型，推翻 21:04「签名不感知信封」）

**通道与消息解耦**：HTTP = client→server 物理通道，SSE = server→client 物理通道，仅此而已。逻辑消息独立于通道，每个 wire 消息统一带 `initiator`（谁发起）× `kind`（request/response）——四象限：① client-request（经 HTTP body）② server-response（经 HTTP 应答，回填①的 rpcId）③ server-request（经 SSE 帧，server mint——审批/问答 requested 即此类）④ client-response（对③的应答，物理经 HTTP 发出，逻辑 kind=response、回填③的 rpcId）。kind/direction 在消息上而非靠通道推断——将来「client-request 的 response 走 SSE 送回」（订阅型/长回答）只是 ② 换了通道，信封不变。

```ts
// api/rpc.ts

/** 消息关联 id：request=发起方 mint（谁发起谁构造，RpcId() 照 core SessionId() 先例）；response=回填对应 request 的 rpcId，不 mint 新 id。 */
export type RpcId = Branded<'rpc-id'>
export type RpcInitiator = 'client' | 'server'

/** 业务成败结果（原 RpcResponse 更名：RpcResponse 现在是消息层名字）。 */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

/** 签名层窄形·请求（两个方向通用）：rpcId 显式进签名，kind/initiator/method 由调用位置决定、载体层补全。 */
export interface RpcRequest<P> {
  rpcId: RpcId
  payload: P
}

/** 签名层窄形·应答（两个方向通用）：rpcId 恒为对应 request 的回填。 */
export interface RpcResponse<T> {
  rpcId: RpcId
  result: RpcResult<T>
}

/** wire 全形 = 四具名类型的判别 union（22:1x 用户裁决字面四具名；判别子 = type 四字面量，initiator/kind 由 tag 自明不设冗余字段）。 */
export interface ClientRequest {
  type: 'client-request'; rpcId: RpcId; method: string; payload: unknown
}
export interface ServerResponse {
  type: 'server-response'; rpcId: RpcId; result: RpcResult<unknown>
}
/** server 发起的消息：需应答的交互（approval/question requested，rpcId 稳定）与纯推送（session/event 等，rpcId 标识该次推送）共用此形——是否期待应答由 method 静态区分（22:1x 用户采纳设计层严格二分，不设第三 kind）。 */
export interface ServerRequest {
  type: 'server-request'; rpcId: RpcId; method: string; payload: unknown
}
export interface ClientResponse {
  type: 'client-response'; rpcId: RpcId; result: RpcResult<unknown>
}
export type RpcMessage = ClientRequest | ServerResponse | ServerRequest | ClientResponse

/** 载体回执（非 RpcMessage——属载体层，同「HTTP status 只表载体」纪律）：承载 client-response 的 POST 的 HTTP 应答体。 */
export type RpcReceipt = { accepted: true } | { accepted: false; reason: 'not-pending' | 'bad-response' }
```

**窄形与全形的关系**：`RpcRequest<P>` / `RpcResponse<T>`（上文）是**域接口签名视角**的窄形（只含业务层必须感知的 rpcId+载荷）；四具名是 **wire 权威全形**——载体层把窄形补全为全形（补 type tag 与 method），方向不靠通道推断。
**撞名重命名（全链一致）**：wire 四具名占用 ClientRequest/ServerResponse 名字，rpc-map 的派生泛型工具改名——`ClientRequest<K>` → **`RequestPayload<K>`**（= `Parameters<RpcMethodMap[K]>[0]['payload']`，提取 payload 穿过 RpcRequest 窄形）、`ServerResponse<K>`/`ServerValue<K>` → **`ResponseValue<K>`**（= 返回的 `RpcResponse<T>` 中 infer `T`；原两名合一，中间形无消费者）。

**四象限纪律**：
- **签名显式收信封窄形**（推翻「签名不感知」）：unary 方法 `method(request: RpcRequest<{…}>): Promise<RpcResponse<{…}>>`——业务字面量仍只住签名（形态 B 不变），但包在 `RpcRequest<>` 里；impl 必须回显 `request.rpcId` 进返回的 `RpcResponse`（server 感知 rpcId 是模型要求，不因 HTTP 自带信道而省略）。流方法 yield `RpcRequest<帧>`（server-request 窄形）——可应答帧的 rpcId 是 client 回填应答所必需，必须暴露给业务层，不再有「载体层拆掉」一说。
- **纯推送 = 不期待应答的 server-request，严格二分不设第三 kind（22:1x 用户采纳设计层方案）**：是否期待应答是 method/帧型的静态语义（登记表可查），不是每条消息的动态属性；接收方对两者处理本就相同（处理、不回）。迟到应答走既有 late-response 丢弃路径（RpcReceipt not-pending）。
- **rpcId mint 规则**：client-request=client mint；server-request=server mint——**其 rpcId 是稳定逻辑请求 id**（ask 受理时 mint 一次，subscribed 基线重放时原样复用，client 以它回填应答）；notify 的 rpcId 标识该次推送（每次发射新 mint）。response 一律回填、绝不 mint 新 id（对称性：谁发起谁 mint，应答方回填）。
- **method 字段**：request 全形必带（unary=map key；帧载 request=帧的 type，与 payload.type 重复是「帧保持 fold 可直接消费」的代价）；response 无 method（rpcId 已关联）。handler 仍校验 unary 的 path==method。
- **client-response 的 HTTP 应答 = RpcReceipt 载体回执**，不是逻辑消息（response 不再有 response）；迟到/重复应答 → `{accepted:false, reason:'not-pending'}` + server 日志，逻辑收敛面仍是 resolved 帧。**approval-not-pending / question-not-pending 两错误码随之删除**（其宿主——respond 作为 unary 方法的 RpcResult——已不存在）。
- **rpcId 不承担 cursor**：durable 事件续传/补缝锚仍是透传的 `event.seq`；prompt 的 rpcId 额外经 `MessageSource` 透传进 `user/message`（provisional 关联机制，执行 v1 不做，§6）。
- **zod 分层**：wire 全形 schema 一个（kind 判别 + method 合法性）+ 业务 payload schema 按 method/帧型分派，两级 parse。

### 2.1 错误模型（details 强类型化，20:56 拍板；22:00 随四象限删两码）

```ts
export interface RpcErrorDetailsMap {
  'bad-request':       { issues: z.ZodIssue[] }     // zod 校验失败明细
  'session-not-found': { sessionId: SessionId }
  'agent-busy':        { reason: string }           // core 拒绝原因透传
  'internal':          {}                           // 无结构化信息可给（message 已在信封）
}
export type RpcErrorCode = keyof RpcErrorDetailsMap

// map 展开的分布式 union（非泛型 interface）：code 是判别子，switch 后 details 自动窄化。
export type RpcError = {
  [C in RpcErrorCode]: { code: C; message: string; details: RpcErrorDetailsMap[C] }
}[RpcErrorCode]
```

- **details 必填**（internal 显式 `{}`）：与「必须真填」纪律互锁（rpc-compare 2026-07-19），漏填=编译错误；bad-request 放 zod issues、session-not-found 放 sessionId、agent-busy 放 core 拒绝原因。
- **zod**：`rpcErrorSchema = z.discriminatedUnion('code', [...])` 逐支锚定；新码=map 加行+schema 加支。
- transport 故障（断网、进程没起）由 fetch 载体抛异常，与业务错误两层不混；流正常结束=server 关流，中途错误以 `stream/error` 帧收敛，断线由载体抛异常。

## 3. ApiProxy 根接口

```ts
export interface ApiProxy {
  sessions: SessionsApi
  host: HostApi
  events: EventsApi
  /** 对 server-request 的应答入口（client-response，回填其 rpcId）；不是域方法（22:00 四象限，§3.4）。 */
  respond(message: ClientResponse): Promise<RpcReceipt>
}
```

### 3.1 SessionsApi（sessions.ts）

```ts
export interface SessionSummary {
  sessionId: SessionId
  updatedAt: number      // 持久化文件 mtime（v1 不建索引，list 时 readdir+stat）
  running: boolean       // attached agent 的 status；冷 session（未 attach）恒 false
  parentSessionId?: SessionId  // fork/spawn 谱系（session.header.parentSession 透传）；根 session 缺省（v1.5，L1）
  cwd?: string           // session 工作目录（header.cwd 透传）；未记录则缺省（v1.5，L2）
}

// 方法签名即事实源（形态 B）：参数/返回结构只住在这里，
// 其余一切引用 RequestPayload<'session.*'> / ResponseValue<'session.*'>。

export interface SessionsApi {
  /** 列出已持久化 session（updatedAt 倒序）。v1 全量返回；cursor 留座不实现。 */
  list(request: RpcRequest<{ cursor?: string }>): Promise<RpcResponse<{ items: SessionSummary[] }>>

  /** 创建新 session（并创建对应 agent，空闲待命）。 */
  create(request: RpcRequest<{ cwd?: string }>): Promise<RpcResponse<{ sessionId: SessionId }>>

  /**
   * 读取历史事件窗口，**页边界对齐消息边界**：一页 = 整数条消息所辖的全部原始事件
   * （含其 chunk / tool 事件），绝不从一条消息中间截断。尾页（beforeSeq 缺省）额外
   * 含「进行中 partial」——最后一条未定稿消息已有的 chunk 事件。
   * 返回仍是原始 SessionEvent[] 透传，client 用统一 fold 重建。
   */
  history(request: RpcRequest<{ sessionId: SessionId; beforeSeq?: number; maxMessages?: number }>):
    Promise<RpcResponse<{ events: SessionEvent[]; hasMore: boolean }>>

  /** 发送。content 直接用 core 的 ContentBlock[]；mode 1:1 映射 queue→send、steer→steer。 */
  prompt(request: RpcRequest<{ sessionId: SessionId; mode: 'queue' | 'steer'; content: ContentBlock[] }>):
    Promise<RpcResponse<{ accepted: true }>>

  /** 停止：清两条 FIFO + abort 当前 step（agent.cancel 的 1:1）。 */
  cancel(request: RpcRequest<{ sessionId: SessionId }>): Promise<RpcResponse<{ accepted: true }>>
}
```

（22:00 签名信封化：一切 unary 收 `RpcRequest<P>`、返 `RpcResponse<T>`（rpcId 回填）；业务字面量仍只住签名（形态 B），impl 感知并回显 rpcId。）

```ts
```

- **冷 session 隐式 resume**：`history()` / `prompt()` 命中未 attach 的 session 时 impl 内部自动 resume/attach，client 无感；attach 与否不对客暴露（`running` 已覆盖 UI 所需）。实现注记：并发触发同一 session 的 resume 必须去重（`Map<SessionId, Promise>` 在途表，照 jsonrpc server `sessionCreations` 先例；rpc-compare 2026-07-19）。
- `SessionSummary` 保持三字段最小面；title/eventCount/待处理计数等后续按需 additive。
- prompt 幂等（commandId）v1 不做；input 加可选字段即是接缝。
- history 分页实现注记：server 从尾向前扫 surface 消息事件（`user/message` / `assistant/message` / `steering/message`）计数到 `maxMessages`，在消息组边界切 `beforeSeq`；chunk 归属其定稿消息（`sourceEventSeqs` 锚定），页内事件保持原始 seq 序。

### 3.2 HostApi（host.ts）

```ts
export interface HostApi {
  /**
   * host 一次性快照。空 request 用空字面量 `{}`（将来加字段就地扩展）。
   * version = host 应用（apps/dsc）package.json 版本；cwd = host 进程工作目录
   * （session 持久化与工具执行的根）；provider/model = 新建 agent 未显式指定时
   * 生效的默认值，host 未配置显式默认则缺省（adapter 内部兜底）；
   * attachedSessions = 当前已 attach（有活 agent）的 session 数。
   */
  describe(request: RpcRequest<{}>): Promise<RpcResponse<{
    version: string
    cwd: string
    provider?: string
    model?: string
    attachedSessions: number
  }>>
}
```

- **不设协议版本**（2026-07-19 20:02 拍板）：client/host 绑定发布，wire 兼容判断无消费者；将来若出现独立发布的 client 再引入 protocolVersion。
- provider/model 形状对齐 core `AgentOptions`（可选裸 `string`，非 branded），透传原则；缺省表示 host 未配置显式默认（adapter 内部兜底）。

### 3.3 EventsApi（events.ts）——两条流

```ts
export interface EventsApi {
  /**
   * 全 session 聚合 mux 流。打开即对每个 attached session 发 subscribed 控制帧。
   * since：续传接缝，v1 不实现（传了也忽略）；重连走「重开流 + 重拉 history」。
   * signal 是本地流控制参数，独立于 input（不上 wire）。
   * 22:00 四象限：yield 的是 server 消息窄形 { rpcId, payload: 帧 }——rpcId 必须暴露给业务层
   * （approval/question requested 帧的应答要回填它），不再有「载体层拆掉信封」。
   */
  mux(request: RpcRequest<{ since?: Record<SessionId, number> }>, signal: AbortSignal): AsyncIterable<RpcRequest<MuxFrame>>

  /** host 级信息流：session 创建/销毁、运行状态翻转。空 payload 用 `{}`。 */
  host(request: RpcRequest<{}>, signal: AbortSignal): AsyncIterable<RpcRequest<HostFrame>>
}

// ---- Frame 族（server→client 推送，具名 union 保留，不适用 infer） ----

export type MuxFrame =
  | { type: 'session/event'; sessionId: SessionId; event: SessionEvent }   // 核心：纯透传
  | { type: 'session/subscribed'; sessionId: SessionId; lastSeq: number }  // 控制帧（lastSeq 保留：缝检测）
  // ---- 审批/问答控制帧（v1.5，§3.4）：requested 下行提问，resolved 收敛 ----
  | { type: 'approval/requested'; sessionId: SessionId; approvalId: ApprovalRequestId; toolName: string; callId?: CallId; reason?: string }
  | { type: 'approval/resolved';  sessionId: SessionId; approvalId: ApprovalRequestId; outcome: ApprovalOutcome }
  | { type: 'question/requested'; sessionId: SessionId; questions: AskUserQuestionItem[] }   // 问题标识=信封 rpcId（帧 payload 无独立 id）
  | { type: 'question/resolved';  sessionId: SessionId; questionRpcId: RpcId; outcome: 'answered' | 'cancelled' }
  | { type: 'stream/error'; error: RpcError }

export type HostFrame =
  | { type: 'host/session-added'; sessionId: SessionId; parentSessionId?: SessionId }  // 谱系锚（v1.5，L1）
  | { type: 'host/session-removed'; sessionId: SessionId }
  | { type: 'host/session-status'; sessionId: SessionId; running: boolean }
  | { type: 'host/agent-error'; sessionId: SessionId; message: string }  // 无 turn 位置的 live 失败诊断（agent/error 无 session 事件时的唯一出口；v1.5，L5）
  | { type: 'stream/error'; error: RpcError }
```

**透传纪律**：`session/event` payload 就是 core `SessionEvent`（自带 seq；`assistant/chunk` 原样过——token 流即事件流，无独立 delta 帧）。`SessionEventMap` 是 merge-extensible：client fold 对未知 type documented-default（计数忽略）；事件 schema 在 union 层面留「合法信封 + 未知类型」分支，信封（seq/type 结构）仍严格——这不是字段级 passthrough。

**`subscribed.lastSeq` 的用途（已拍板保留）**：client 拉完 history 后对比 history 尾 seq 与 lastSeq，有缝（开流与拉历史之间 session 前进了）就再补一次 history；一个字段消掉一类竞态。

**tool presentation（已拍板：先透传，标注遗留）**：v1 卡片直接渲 `tool/call` / `tool/result` 原始 args/result；`presentCall/presentResult` 的 render intent（generic/terminal/diff/locations）在 Node 侧才有，后续以 additive 附件帧或旁挂字段引入，不动透传主体。

### 3.4 审批/问答域（approvals.ts / questions.ts，v1.5 采纳，2026-07-19 21:13）

**形态（21:00 拍板；22:00 四象限重建模）**：审批/问答的 requested 帧 = **server-request**（rpcId=server mint 的稳定逻辑请求 id）；client 的回答 = **client-response**（回填该 rpcId，物理经 `POST /api/respond` 发出，逻辑上是应答不是新调用——**不再是 unary 方法，不 mint 新 rpcId**）。`*/resolved` 帧是收敛面——多 client、tool 取消、policy 决掉都靠它撤卡片；client-response 的 HTTP 应答体是载体回执 `RpcReceipt`（见 §2），最终结局统一看 resolved。

```ts
// approvals.ts / questions.ts —— 应答 payload 形状（client-response 的 result.value 位）
/** 审批应答：outcome 只收 client 可给的二值（cancelled/unavailable 是 host 侧结局）。 */
export interface ApprovalResponsePayload {
  sessionId: SessionId
  approvalId: ApprovalRequestId   // core 审计关联（impl 对账 asked/decided 用）；wire 关联以回填的 rpcId 为准
  outcome: 'allowed-once' | 'rejected'
}
/** 问答应答：整批回答一次 ask（core：一次 ask 多题一个 answer，不拆单题）。 */
export interface QuestionResponsePayload {
  sessionId: SessionId
  answer: AskUserQuestionAnswer
}
```

- **respond 不进 RpcMethodMap**（map 只登记 client-request 方法）：client-response 是对 server-request 的应答，wire 承载 `POST /api/respond`（单端点，body=ClientResponse 全形，rpcId 即路由键——host 从 pending 表查该 rpcId 属审批还是问答再按对应 payload schema parse）。ApiProxy 根接口相应无 approvals/questions 域方法；client 侧发应答走 `IApiClient.respond(message: ClientResponse)` 载体级入口（AbstractApiClient 实现，§4.1）。
- **id 双层**：wire 关联 = requested 帧的 rpcId（server mint、重放复用、client 回填）；`approvalId`（core `ApprovalRequestId` 透传）保留在审批 payload 内层供 impl 对账 durable 审计事件 `approval/asked`/`decided`——它是 core 已 brand 的透传非本层自造（21:19 拍板的不对称理由继续成立）。问答无 core id，payload 不含资源 id（rpcId 已足）。
- **竞争语义：先到先赢**，host 内存 pending 表（keyed by rpcId）是唯一裁判，一个 rpcId 只 settle 一次。竞争方：client-response vs tool `signal` abort（→cancelled）vs 另一 client。policy `'never'` 在 answerer 链之前解决，requested 帧根本不发。core 无审批超时，不发明。迟到/重复应答 → `RpcReceipt {accepted:false, reason:'not-pending'}`（载体回执，非业务错误码——两个 not-pending 错误码已随四象限删除）。
- **刷新恢复：subscribed 基线重放**——mux 重开后，host 在每个 session 的 `session/subscribed` 帧后立即重放该 session 仍 pending 的 `*/requested` 帧（**rpcId 原样复用**，来源=内存 pending 表）。单一事实源走 mux；不从 history 推（问答不落日志；审批 crash 后 asked-without-decided 是悬案）。
- **impl 结构**：host 注册「wire answerer」进 `approval/request` waterfall 链（收请求→mint rpcId 发 server-request 帧→等 client-response/abort→返回 outcome，链上其他 answerer 组合语义不变）；问答侧 host 代理 provider 是 `userInteraction.registerProvider` 的唯一注册者。`approval/asked`/`decided` 审计事件照旧透传——帧=live 控制面，事件=durable 审计，职责分离。

## 4. fetch 载体（RPC 映射，机械可推导）

| 逻辑消息（四象限） | wire 承载 |
|---|---|
| client-request | `POST /api/<map key>`（即 `/api/session.list`，域单数），body=`ClientRequest` 全形 JSON |
| server-response | 上述 POST 的 HTTP 应答体，`ServerResponse` 全形 JSON，HTTP 200 恒定 |
| server-request / 纯推送 | SSE 帧：`GET /api/events.mux` / `GET /api/events.host`，`data:` = `ServerRequest` 全形 JSON |
| client-response | `POST /api/respond`（单端点），body=`ClientResponse` 全形 JSON；HTTP 应答体=`RpcReceipt` 载体回执 |

- `toFetchHandler(api)`：unary 路径查方法 → 全形 zod parse（type/rpcId/method 结构 + path==method 校验）→ payload 按 method 分派 schema parse（拒收 = `bad-request`）→ 调 api 方法（传窄形 `RpcRequest<P>`）→ 回填 rpcId 封 `ServerResponse`；`/api/respond` → ClientResponse 全形 parse → rpcId 查 pending 表路由到审批/问答 → payload schema parse → 返回 `RpcReceipt`；流方法包 SSE Response，帧以 `ServerRequest` 全形发出（method=帧 type；可应答帧 rpcId=稳定逻辑 id，纯推送=每次新 mint）。
- HTTP status 只表载体：404 路径不存在 / 400 body 非 JSON / 500 handler 自身炸；业务错误一律 200 + ServerResponse（RpcResult error 位）。

### 4.1 client 载体：AbstractApiClient 类体系（2026-07-20 shape-a + abstract-base 拍板；commit 893421d50 落地，取代 createApiClient 工厂形）

**协议不变量住抽象基类，平台差异是两个继承切面**：抽象方法 `doFetch(url, init)`（传输）+ 可覆写 `onEnvelope`（观测）。

- **`IApiClient`（caller 视图，shape a）**：与 ApiProxy 同域树，但 unary 方法**收业务 payload 直传**——载体 mint rpcId 并包信封，**业务代码永不 mint**；需要本次调用 rpcId 的从返回 `RpcResponse` 回显里读。三者关系：ApiProxy = impl 侧实现的窄形签名契约；IApiClient = client 侧消费的 payload 直传视图；AbstractApiClient 桥接两者。域方法逐 key 从 RpcMethodMap 派生，map 加行即机械更新。
- **`AbstractApiClient` 持有的协议路径**：`callUnary`（mint→tap→POST 全形→ServerResponse parse→**rpcId 回显校验**（不符 throw）→tap→吐窄形）；`readSse`（streaming fetch 非 EventSource、`\n\n` 分帧、ServerRequest 全形 parse、tap、吐窄形 `RpcRequest<帧>`）；`respond` 透传（rpcId 是回填不 mint）；unary 超时 `AbortSignal.timeout`（默认 30s 构造参数可调，流不设超时）；`resolveBase`（浏览器=同源 origin，无 location 环境=`http://dsh.internal` 假 authority）。`callUnary`/`openMux`/`openHost` 是 **protected virtual**——假载体（fixture）在协议层覆写，不再需要信封包装器。
- **实例级 envelope 观测切面**：四象限全形均过 `onEnvelope`；基类实现=**实例持有的微任务合批缓冲**（帧风暴不逐帧惊扰消费者；实例持有防跨实例/测试泄漏）。观测者经 `subscribeEnvelopes(listener)` 批量订阅（收 `readonly RpcMessage[]`，返回退订函数）；listener 异常隔离（观测不得反噬载体）；无订阅者零缓冲成本。原 `onEnvelope` 构造选项与 `ApiEnvelopeTapEvent` 四支形状废除——tap 事件即 RpcMessage 全形本身，kind=type tag。rpcLog 调试面板降级为纯订阅者（连接主体身份取消）。
- **子类表**：`InProcessApiClient`（apiproxy 本包；doFetch=注入的 `{fetch}` handler；**同构点新写法** `new InProcessApiClient(toFetchHandler(api))` 全程不过网络——dsc -p headless 即此）；`WebApiClient`（web-runtime；doFetch=globalThis.fetch 同源）；`FixtureApiClient`（web-runtime；协议层覆写四虚方法，自己就是假 server、帧 rpcId 由它 mint）；将来 Electron IPC 桥=又一子类只换 doFetch。

## 5. web client 侧（web-runtime）架构

```
WebApiClient（AbstractApiClient 子类，§4.1）
      │
ConnectionController     ← boot 开两条流；断线指数退避重连；重连后对每个打开的
      │                     session 重拉 history 重建（v1 无续传）
SessionFold（纯函数）     ← SessionEvent[] → UI 树；历史与 live 同一 fold；
      │                     tool call/result 按 CallId 合并；优先复用 core foldSurface
Session/SessionManager   ← 业务对象层（step-session 设计）；React 经 uSES 订阅对象快照，
                            store 只承载跨视图展示态
```

- 打开 session 主路径：开 mux（收 `subscribed.lastSeq`）→ `history()` 拉尾页 → 比对 lastSeq 补缝 → live 帧续贴。
- 单客户端互斥（ClientSlot）v1 不实现：第二个页面各自收流，行为未定义但不崩。
- unary 请求 client 侧设超时（`AbortSignal.timeout` 在 AbstractApiClient.callUnary 内，默认 30s 构造参数可调）：浏览器 fetch 默认无超时，host hang 会让请求永久 pending（rpc-compare 2026-07-19）。流不设超时（长连接本性）。

## 6. 不做清单（v1）

- mux `since` 续传实现（签名留座）
- rpcId 幂等去重的执行（rpcId 已全量上 wire 是其接缝，2026-07-19 21:04）；provisional 转正的**关联机制已就位**（rpcId 经 MessageSource 透传进 `user/message`），client 侧转正逻辑 v1 不做
- SessionSummary 索引（eventCount/title/待处理计数）、keyset 分页
- ~~审批/问答域~~（v1.5 升格进契约，§3.4；**实现排期仍可后置**）；provider 配置事务、模型切换（类型接缝见 §8）
- tool presentation 附件（§3.3 标注）
- ClientSlot、connectionGeneration/streamId fencing

## 7. 裁决记录

三批问题（Q1–Q8 等）已全部拍板，无开放问题；全记录见 README.md 拍板表。opencode 对照结论见 `opencode-crosscheck.md`（重连砍 cursor 的建议已被采纳，即 §0.7）。core 覆盖度盘点与漏判裁决（L1-L7）见 `core-coverage.md`；L1/L2/L5 已合入本文（v1.5），L3/L4/L6/L7 类型预留见 §8。

## 8. 预留接缝类型（L3/L4/L6/L7，2026-07-19 21:13 裁决：类型写全，暂不实现）

**纪律**：以下签名是将来实现时可直接照抄的定稿形状，但**不进 `RpcMethodMap`、不进 ApiProxy 根接口**——map 只含已实现方法，未知 method 在信封 parse 即 fail loud（`bad-request`），优于 not-implemented 兜底码：后者要求每个方法实现「假在场」，让「契约有」和「能用」脱钩，违反 misconfiguration-fails-loud 家规。实现某条时：把签名抄进对应域接口 + map 加一行 + schema 加一对，即完成升格。

```ts
// ---- L3 fork（session 域；core 原语 SessionStore.fork 完整，错误码 SessionForkErrorCode） ----
// map key（届时）：'session.fork'
fork(input: { sessionId: SessionId; boundary?: number; childSessionId?: SessionId }):
  Promise<RpcResponse<{ sessionId: SessionId }>>
// RpcErrorDetailsMap 届时加：'fork-rejected': { code: SessionForkErrorCode }（core 五码透传：
// SESSION_NOT_FOUND/SESSION_NOT_LIVE/SESSION_ALREADY_EXISTS/INVALID_BOUNDARY/OPEN_TURN）

// ---- L4 inject（prompt.mode union 扩展；core Agent.inject 第三输入原语） ----
// 非新方法——现 prompt 签名的 mode 加一值：
prompt(input: { sessionId: SessionId; mode: 'queue' | 'steer' | 'inject'; content: ContentBlock[] }):
  Promise<RpcResponse<{ accepted: true }>>
// inject 语义：注入上下文不触发模型回复（idle 时 core 包一次性 turn）；impl 分发 agent.inject()。

// ---- L6 后台任务面板（新 task 域；core ctx.tasks TaskSnapshot） ----
// map key（届时）：'task.list'；域文件 tasks.ts / tasks.schema.ts
list(input: { sessionId?: SessionId }):   // 缺省=全部；带 sessionId=按 owner agent 过滤（core list(caller) 语义）
  Promise<RpcResponse<{ tasks: TaskSnapshot[] }>>   // TaskSnapshot 透传 core（dsh-tasks）
// 完成通知（届时）HostFrame 加：
// | { type: 'host/task-done'; taskId: TaskId; status: 'completed' | 'killed' | 'failed' }

// ---- L7 provider/model 枚举（host 域；与模型切换域一起实现） ----
// map key（届时）：'host.listModels'（独立方法，不并入 describe——describe 是轻快照，
// 枚举可能触发 adapter 查询，成本与缓存策略不同）
listModels(request: RpcRequest<{}>):
  Promise<RpcResponse<{ providers: { provider: string; models: string[] }[] }>>

// ---- host 实例标识（ui-design 2026-07-19 22:1x 提出；v1 重连=重建故零影响，将来续传/缓存需要） ----
// describe 返回加可选字段（届时）：
//   hostInstanceId?: string   // host 进程每次启动 mint（uuid），client 据此察觉 host 重启、废弃本地缓存
// 砍 protocolVersion（20:02）的连带缺口，实装时同批评估是否需要 brand。
```
