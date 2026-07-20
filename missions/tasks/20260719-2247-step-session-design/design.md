# step-session 里程碑 · 实现级设计（v1 完稿，待 review）

> 2026-07-19 起草。读者 = 无上下文编码 teammate。排在 RPC 调试面板里程碑（`../20260719-2140-ui-milestone1-design/design.md`）验收之后实施。
> 契约基线：`../20260719-1902-apiproxy-api-design/design.md` v2.0（四象限）；api/ 代码已落地 typecheck 绿（`packages/host/apiproxy/src/api/`），本文类型名直接引用真代码。
> 核心命题（用户 2026-07-19 22:4x 拍板，9 条全记在任务书）：**Session 面向对象**（对象封装一切需 sessionId 的底层调用）+ **逻辑面与 UI 展示面分离**（UI 组件可整体替换而逻辑层零改）。
> 纪律：GUI 期间跳过仓库门禁；本文只设计不写代码。

## 目录

- §A 数据对象层（web-runtime）：Session / SessionManager / fold 适配 / 与 RPC 面板产物的关系
- §B hook 层（逻辑面，web-ui/hooks）：useSessionList / useConversation + useSyncExternalStore 接线
- §C 展示组件层（可替换 UI 面，web-ui/components）：纯 props 契约
- §D 与契约的对接面：方法/帧清单、翻页锚定、增量 fold 策略
- §E 验收清单（fixture / 真 host 两级）
- §F 不做清单

---

## §A 数据对象层（web-runtime）

### §A.0 模块布局与依赖增量

```
packages/client/web-runtime/src/
  session/
    conversation.ts   ← ConversationSnapshot / ConversationNode 等 UI 节点类型（§A.4/§A.5）
    fold-adapter.ts   ← SurfaceManager 接线 + 节点缓存 + padding 窗口（§A.5）
    partial.ts        ← assistant/chunk 累积器（§A.6）
    session.ts        ← Session class（§A.2）
    manager.ts        ← SessionManager + initSessionManager/getSessionManager（§A.3）
    lineage.ts        ← 列表谱系树扁平化（§A.3）
  connection.ts       ← 既有 ConnectionController **本里程碑扩展**：帧下沉回调（§A.1）
  store.ts            ← 本里程碑零改动（选中态/草稿均不进全局 store，§A.7 review 整改 #1）
  intents.ts          ← 加 createSession / refreshSessions（§A.7）
  boot.ts             ← 装配点扩展：initSessionManager + controller 回调接线（§A.8）
```

- 新增依赖：**core 类型**。web-runtime 的 `package.json` 不加运行时依赖；`SessionEvent`/`ContentBlock`/`StreamChunk` 等一律 `import type`（类型擦除后 vite 不见这些包）。运行时值仍只有 apiproxy 的 `createApiClient` / `RpcId()`（W3 后）。
- **实现前置依赖**：本设计按契约真形（流 yield `RpcRequest<MuxFrame>`，信封 rpcId 可见）编写。当前 web-runtime 的临时 `api-types.ts`（W3 前副本）流签名是裸帧无信封——实现本里程碑时若 W3（fetch 载体）已落地则直接替换 import；未落地则先给临时副本补上 `RpcRequest<帧>` 窄形（fixture 同步补 mint），不改本设计。
- 唯一出口纪律沿用：`index.ts` 导出 hooks 所需最小面（`getSessionManager`、快照/节点类型、intents）；Session/SessionManager 的构造函数不导出给 UI（只有 boot 与 manager 能建）。

### §A.1 与 RPC 面板里程碑产物的关系（谁 own 谁）

```
boot.ts（唯一装配点）
  ├─ createApiClient(fetch, { onEnvelope: tapToStore })   ← rpcLog tap 原样不动
  ├─ SessionManager（本里程碑新建，持有 api 引用）
  └─ ConnectionController（既有，本里程碑加三个回调）
        onMuxEnvelope   → manager.handleMuxEnvelope
        onHostEnvelope  → manager.handleHostEnvelope
        onConnected     → manager.handleConnected（每代连接建立后回调，含首连与重连）
```

- **ConnectionController 仍 own 物理流**（打开/迭代/断线退避重连——RPC 面板里程碑 §A.3 原样），本里程碑给它加构造参数 `sinks?: { onMuxEnvelope?; onHostEnvelope?; onConnected? }`：泵循环体从「空转」改为「逐帧调 sink」。sink 抛异常不得炸泵（包 try/catch console.error——业务层坏不拖垮连接层）。
- **SessionManager own 业务分发**：帧按 sessionId 路由到 Session 实例；host 帧维护列表。Controller 不认识 Session，Manager 不碰流与重连——单向：Controller → sinks → Manager。
- **rpcLog 面板零改动**：tap 在载体层咽喉，本里程碑新增的所有流量（history/prompt/cancel/帧）自动进台账——调试面板天然成为本里程碑的开发观测工具。
- **store 红线延续并加严**（RPC 面板 §C.7 + review 整改 #1）：sessions/conversation 业务数据一律不进 zustand；且本里程碑 zustand **零增量**——选中态是视图容器局部 state、草稿住 Session 对象（§A.7）。
- `onConnected` 时机 = 每代连接的两条流开启且 `host.describe` 成功之后（Controller 既有序列的第 3 步成功点）；Manager 在此刻做 `refreshList()` + 通知各活 Session `resync()`（重连=重建，§D.4）。首连也走同一路径（首次 refreshList 即来自它，boot 不再单独调）。

### §A.2 Session class（session.ts）

**职责**：封装 apiproxy 一切需传 sessionId 的调用（拍板 1：外界不再手传 sessionId）；持有本 session 的事件窗口 + fold 状态 + 流式 partial + 待答交互，产出不可变快照供 React 订阅。**实例常驻**（拍板 2）：一旦创建不销毁，后台持续吃 mux 帧更新自己。

```ts
/** 由 SessionManager 懒建与持有；UI 经 hook 拿到实例只调公开方法，不 new。 */
export class Session {
  readonly sessionId: SessionId

  // ---- 操作面（内部带自己的 id 调契约方法；rpcId mint 由 client 载体层收口，Session 不感知信封）----

  /** 发送（拍板 6：queue/steer 双按钮语义 1:1 透传）。返回业务结果：ok / agent-busy 等 RpcResult 原样给调用方；同时把失败以 `{op:'send', error}` 写进快照 promptError（§A.4；input-ux 批次1：op 判别让停止失败不误标发送失败）。 */
  prompt(content: ContentBlock[], mode: 'queue' | 'steer'): Promise<RpcResult<{ accepted: true }>>

  /** 停止：契约 session.cancel 的 1:1（清两条 FIFO + abort 当前 step）。 */
  cancel(): Promise<RpcResult<{ accepted: true }>>

  /** 草稿写入（review 整改 #1：per-session 数据跟对象走，不进全局 store）；触发订阅通知，快照 draft 字段承载读路径。 */
  setDraft(text: string): void

  /** 发送草稿全链内聚：trim 空白 no-op → `[{type:'text',text}]` → prompt(mode)。**乐观清稿**（input-ux 批次1 修订，原「ok 后清」废弃）：发送瞬间即清并同步通知（真 host 延迟下滞留草稿读作「没发出去」）；失败把已发文本回填到在途期间新输入之前（`sent + 新输入`——回填安全性依赖 draft 挂常驻 Session 对象，切换/切回不丢 sent）；在途锁 `draftInFlight` 吞重入（Enter 连发/双击），settle 后再发=正当排队。UI 的发送按钮只传 mode。 */
  sendDraft(mode: 'queue' | 'steer'): Promise<void>

  /** 首次打开：拉尾页 history（幂等——已加载或在途则直接返回既有 Promise）。openSession intent 调用（§A.7）。 */
  open(): Promise<void>

  /** 向上翻页：以窗口首事件 seq 为 beforeSeq 拉更早一页并前插（§D.2 锚定算法）。hasMore=false 或在途时 no-op。 */
  loadOlder(): Promise<void>

  /** 重连重建（manager 在 onConnected 时对已 open 过的实例调用）：窗口重置回尾页 + 清 pending 交互重收基线重放（§D.4）。 */
  resync(): Promise<void>

  // ---- 订阅面（useSyncExternalStore 直连，拍板 3）----

  /** 注册变更监听；返回退订函数。通知语义见 §A.9（微任务合批）。 */
  subscribe(listener: () => void): () => void

  /** 返回缓存的不可变快照对象；仅在数据实际变更后才换新引用（uSES 防撕裂前提）。 */
  getSnapshot(): ConversationSnapshot

  // ---- manager 专用入口（UI 不调；文档标注 @internal）----

  /** mux 帧到达（信封 rpcId + 帧）。见 §A.9 帧分发表。 */
  handleMuxEnvelope(rpcId: RpcId, frame: MuxFrame): void

  /** host/session-status 翻转（manager 从 host 流路由过来）。 */
  handleRunning(running: boolean): void

  /** host/agent-error 透传（无 turn 位置的 live 失败诊断）。 */
  handleAgentError(message: string): void
}
```

**内部状态（全私有，不直接暴露；快照是唯一读窗口）**：

| 字段 | 类型/说明 |
|---|---|
| `events` | `SessionEvent[]`：已加载窗口，seq 连续升序；尾部随 live `session/event` 帧 append，头部随翻页 prepend |
| `baseSeq` | 窗口首事件 seq（padding fold 的偏移，§A.5） |
| `hasMore` | 契约 history 返回透传 |
| `openState` | `'cold' | 'loading' | 'open' | 'error'`：open() 状态机；error 存 RpcError 供快照 |
| `loadingOlder` | 翻页在途标志（防重入） |
| `foldAdapter` | `FoldAdapter` 实例（§A.5）：SurfaceManager + 节点缓存 |
| `partial` | `PartialAccumulator | null`（§A.6）：进行中 assistant 输出 |
| `openCalls` | `Map<CallId, RunningToolCall>`：已见 `tool/call` 未见 `tool/result` 的在途工具卡素材 |
| `frozenNodes` | `ConversationNode[]`：中断终态冻结节点（turn/end 定格清扫产物，input-ux bb1a7ed5f）；分数 seq 归并进快照 nodes；随 rebuildDerivedFromWindow 从窗口事件重建（派生态同 partial/openCalls） |
| `pending` | `Map<string, PendingInteraction>`：审批/问答 requested 占位（key 见 §A.9） |
| `running` | host 流 status 与 list 快照合成的运行位 |
| `promptError` / `lastAgentError` | 最近一次 send/stop 失败 `PromptError{op:'send'\|'stop', error}` / agent-error 文本（下次 prompt 发起时清空；op 判别驱动 UI 文案，input-ux 批次1） |
| `draftInFlight` | sendDraft 在途锁（重入即弃；不进快照——纯防抖非展示态，input-ux 批次1） |
| `draft` | 输入框草稿（review 整改 #1：per-session 数据跟对象走——切 session 草稿不串、常驻实例天然保稿；不进全局 store，也不放容器局部 state——容器 key=sessionId 重挂载会丢稿） |
| `liveBuffer` | `SessionEvent[]`：open()/resync() 在途期间到达的 live 事件暂存，历史就绪后按 seq 合并去重（§D.3 缝合规则） |
| `snapshotCache` / `dirty` | 快照缓存与失效标志（§A.9） |

**纪律**：Session 不碰 zustand、不碰 DOM、不做展示格式化（相对时间/截断都在 UI 侧）；一切输出经 `ConversationSnapshot`。事件窗口内只存契约透传的原始 `SessionEvent`——UI 节点是 fold 适配层的派生缓存，可随时由原始窗口重建。

### §A.3 SessionManager（manager.ts）

**职责**：单例持有 `Map<SessionId, Session>`（拍板 2 懒建、常驻）；mux/host 帧总入口按 sessionId 分发；session 列表状态（summaries + live 覆盖 + 谱系扁平化）自己持有并供订阅——列表数据同样不进 zustand。

```ts
export class SessionManager {
  /** boot 注入 api；构造不发请求。 */
  constructor(api: ApiProxy)

  // ---- 实例管理 ----
  /** 懒建：已有实例直接返回；没有则 new Session 并入 Map（不自动 open——open 由 intent 显式触发）。 */
  get(sessionId: SessionId): Session

  // ---- 列表面 ----
  /** 拉 session.list 全量刷新 summaries（单飞：在途时复用同一 Promise）。 */
  refreshList(): Promise<void>
  /** 契约 session.create；成功后就地把新条目并入 summaries（不等下次 refresh）并返回 id。 */
  create(cwd?: string): Promise<RpcResult<{ sessionId: SessionId }>>

  // ---- 订阅面（useSessionList 用）----
  subscribe(listener: () => void): () => void
  getListSnapshot(): SessionListSnapshot

  // ---- ConnectionController sinks（boot 接线；UI 不调）----
  handleMuxEnvelope(envelope: RpcRequest<MuxFrame>): void
  handleHostEnvelope(envelope: RpcRequest<HostFrame>): void
  handleConnected(): void
}
```

**帧路由（handleMuxEnvelope / handleHostEnvelope）**：

| 帧 | 路由 |
|---|---|
| mux `session/*`、`approval/*`、`question/*`（都带 sessionId） | `sessions.get(sessionId)?.handleMuxEnvelope(rpcId, frame)`——**只投给已存在的实例**，未实例化的 session 丢帧（不懒建：打开时 history 全量补齐，见 §D.3；避免 mux 全量广播把所有 session 都实例化，违背懒建初衷） |
| mux `stream/error` | 不路由（ConnectionController 已把它当流故障处理，Manager 忽略） |
| host `host/session-added` | summaries 增条目（`updatedAt=Date.now()` 占位，下次 refresh 校正；parentSessionId 入谱系） |
| host `host/session-removed` | summaries 删条目；**Session 实例不销毁**（拍板 2；实例若存在标记 `removed` 进快照，UI 显示已结束态即可，v1 素朴处理） |
| host `host/session-status` | summaries 就地改 running + `sessions.get(id)?.handleRunning(running)` |
| host `host/agent-error` | `sessions.get(id)?.handleAgentError(message)`（列表不表现） |
| host `stream/error` | 同 mux，忽略 |

**列表快照与谱系扁平化（lineage.ts，拍板 8）**：

```ts
export interface SessionListEntry {
  sessionId: SessionId
  updatedAt: number
  running: boolean
  parentSessionId?: SessionId
  cwd?: string
  /** 谱系缩进层级：根=0；由 lineage 扁平化计算，UI 只乘 indent 宽度。 */
  depth: number
}
export interface SessionListSnapshot {
  items: readonly SessionListEntry[]
  state: 'idle' | 'loading' | 'error'
  error: RpcError | null
}
```

扁平化算法（纯函数 `flattenLineage(summaries): SessionListEntry[]`，可单测）：
1. 按 parentSessionId 建 children 索引；parent 不在 summaries 里的条目视为根（孤儿谱系降级，不丢条目）。
2. 根层按 updatedAt 倒序；DFS 展开，每层子节点同样 updatedAt 倒序，depth=父+1。
3. 环防御：DFS 带 visited 集合，命中环时该条目按根输出（fail-soft，console.warn）。

**单例接线**：模块级 `let instance: SessionManager | null`；`initSessionManager(api): SessionManager`（boot 专用，重复调用覆盖——与 bindIntents 同纪律）与 `getSessionManager(): SessionManager`（hooks 用；未 init 时 throw——misconfiguration fails loud，UI 在 boot 之后 mount，正常时序必然已 init）。

### §A.4 快照类型（conversation.ts）——逻辑面与展示面的数据分界

快照是逻辑面吐给 UI 的唯一数据形状（拍板 9 的「接口形状」主体）。**不可变契约**：每次变更换新顶层对象；未变的子结构保持引用（React.memo 生效前提）。

```ts
export interface ConversationSnapshot {
  sessionId: SessionId
  /** surface fold 产物（§A.5），已定稿的对话节点，surface 序。 */
  nodes: readonly ConversationNode[]
  /** 进行中 assistant 输出（chunk 累积，§A.6）；无进行中输出为 null。 */
  partial: PartialAssistant | null
  /** 已请求未出结果的工具调用（tool/call 已到、tool/result 未到），渲在 partial 之后。 */
  runningCalls: readonly RunningToolCall[]
  /** 审批/问答占位卡片（拍板 4：可见不可答），渲在对话流末尾。 */
  pending: readonly PendingInteraction[]
  running: boolean
  /** 列表已移除（host/session-removed 后）；UI 置灰禁输入。 */
  removed: boolean
  openState: 'cold' | 'loading' | 'open' | 'error'
  openError: RpcError | null
  hasMore: boolean
  loadingOlder: boolean
  /** send/stop 失败并集（input-ux 批次1）：op 判别子驱动 UI 文案（停止失败≠发送失败）。 */
  promptError: { op: 'send' | 'stop'; error: RpcError } | null
  lastAgentError: string | null
  /** 草稿（§A.2 setDraft 写入；per-session 数据住对象，review 整改 #1）。 */
  draft: string
}
```

**对话节点 union（判别子 kind；每节点带 seq 作 React key 与调试锚）**：

```ts
export type ConversationNode =
  | UserMessageNode | AssistantMessageNode | SteeringMessageNode
  | ContextMessageNode | ToolResultNode | UnknownSurfaceNode

export interface UserMessageNode {
  kind: 'user'; seq: number
  content: readonly ContentBlock[]          // 透传；UI 只渲 text 块，其余 JSON 折叠
  source: MessageSource
}
export interface AssistantMessageNode {
  kind: 'assistant'; seq: number
  turn: number; step: number
  /** content 按块序拆好给 UI：text 块正文、reasoning 块可折叠（拍板 4）、tool-call 块转卡片头。 */
  blocks: readonly AssistantBlock[]
  usage?: TokenUsage
  /** 中断终态标记（input-ux bb1a7ed5f）：停止定格的 partial 冻结节点——非 fold 产物，由 turn/end
   *  清扫生成（§A.9），seq 用分数 `turn/end seq - 0.9` 保序（严格晚于本 turn 全部事件、早于下一 turn）；
   *  live 冻结与 history 重放走同一清扫函数，刷新后重建出相同节点（chunk 已落日志）。UI 渲安静
   *  「已中断」内联标签非报警态。中断工具卡同理（seq-0.8+偏移，error.code='interrupted'）。 */
  interrupted?: true
}
export type AssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool-call'; callId: CallId; name: string; argsRaw: string }  // 卡片体在 ToolResultNode / runningCalls
  | { kind: 'other'; block: ContentBlock }   // merge-extensible 兜底：JSON 折叠
export interface SteeringMessageNode {
  kind: 'steering'; seq: number; turn: number
  content: readonly ContentBlock[]; source: MessageSource
}
export interface ContextMessageNode {
  kind: 'context'; seq: number
  content: readonly ContentBlock[]; source: MessageSource
  envelope?: ContextEnvelope    // core 原样透传（§D.5 对齐表核出的补字段：v1 折叠卡里 JSON 渲出，不解释语义）
  meta?: unknown                // 同上（core JsonValue）
  // ui-product §7 的「诊断视图」后置（§F）；v1 在普通流里渲折叠卡，先可见。
}
export interface ToolResultNode {
  kind: 'tool-result'; seq: number
  callId: CallId
  /** 从 openCalls / tool/call 事件回填的调用头（name/argsRaw）；窗口截断致 call 不在窗口时为 null，卡片头显示 callId。 */
  call: { name: string; argsRaw: string } | null
  content: readonly ContentBlock[]
  isError: boolean
  error?: { name: string; code: string }
  meta?: unknown            // 透传不解释（presentation 后置，§F）
}
export interface UnknownSurfaceNode {
  kind: 'unknown'; seq: number; type: string; data: unknown   // merge-extensible surface 扩展兜底：JSON 折叠
}

export interface RunningToolCall {
  callId: CallId; name: string; argsRaw: string
  turn: number; step: number
}
export type PendingInteraction =
  | { kind: 'approval'; rpcId: RpcId; approvalId: ApprovalRequestId; toolName: string; callId?: CallId; reason?: string }
  | { kind: 'question'; rpcId: RpcId; questions: readonly AskUserQuestionItem[] }

export interface PartialAssistant {
  turn: number; step: number
  /** 已定稿/增长中的块序列（§A.6 累积器产物），形状与 AssistantBlock 一致。 */
  blocks: readonly AssistantBlock[]
}
```

设计要点：
- **tool 卡片一分为二**：assistant 消息里的 `tool-call` 块只是「卡片头引用」；完整卡片 = 在途时 `runningCalls`（等结果）、定稿后 `ToolResultNode`（surface 序中天然紧跟其 assistant 消息）。状态「原地翻转」的观感由 UI 层用 callId 对齐实现（§C）；逻辑层不做合并节点，保持与 surface 序一一对应（fold 复用的最短路径）。
- **reasoning 在 content 块里**（core `ReasoningBlock`），不是独立事件——拆块交给 fold 适配层，UI 拿到的 AssistantBlock 已分好类。
- `PendingInteraction.rpcId` = requested 帧的**信封 rpcId**（server mint、重放复用）——它就是将来 respond 回填键，v1 只展示；approval 另带 approvalId（契约 §3.4 id 双层，帧 payload 自带）；question 的帧 payload 无 id（契约如此），信封 rpcId 是唯一标识。

### §A.5 fold 适配层（fold-adapter.ts）——复用 core foldSurface（拍板 5）

**为什么能直接复用**：core `SurfaceManager`（`packages/core/session/src/surface.ts`）构造收 `readonly SessionEvent[]`（借引用），`nodes` getter 惰性折叠**新追加的**事件（`_lastProcessedSeq` 游标），天然增量——Session 往 `events` 尾部 push 后读 `surface.nodes` 只折叠新事件。surface.ts 无 Node 依赖，浏览器可 import。**已核实（review 整改 #2 顺带）**：包根 index.ts:27 只 re-export `foldSurface`/守卫/类型，**不含 SurfaceManager class**——走子路径 `import { SurfaceManager } from '@deepseek-ai/dsh-session/src/surface.ts'`（package.json `"./src/*"` 通道在，apiproxy 同款先例）。

**两个适配问题与解法**：

1. **seq 偏移（padding 窗口方案）**：`foldSurface`/`SurfaceManager` 断言事件 seq 与数组下标连续相等（`event.seq !== expectedSeq` 即 throw），而翻页窗口的首事件 seq = `baseSeq > 0`。**解法**：fold 输入数组前部填充 `baseSeq` 个哨兵事件 `{ seq: i, type: 'noop/padding', data: {} }`——非 surface-eligible 类型走 `surfaceOpOf` 的 undefined 分支被安全跳过，O(baseSeq) 一次性成本只在构造/重建时发生（session 万级事件 = 万次空循环，微秒级；不改 core）。窗口数组 `padded = [...Array(baseSeq) 哨兵, ...events]`，`SurfaceManager` 借它的引用；**尾部 append 直接 push 进同一数组**（增量惰性折叠生效）；**头部 prepend（翻页）必须重建**——baseSeq 变小、哨兵数变少，游标失效：new 一个 SurfaceManager 重折整窗（§D.2 翻页频率低、每页消息数有限，全量重折可接受；这就是「至少每消息级缓存」性能注记的取舍点——节点缓存见下，重折不重做节点物化）。
   - **replace 语义的窗口性风险**：`surfaceOp: {op:'replace', start, end}` 若引用**窗口之前**的 seq（被翻页截掉的 surface 节点），`replacementRange` 会 throw「start seq not found」。契约 history 按消息边界切页不保证 replace 闭包（接缝问题 #1，报 README）。**防御**：fold 调用包 try/catch；throw 时该窗口降级为「从最近一次成功 fold 的节点集 + 尾部逐事件宽容追加」不再走 SurfaceManager，快照置 `foldDegraded: true`（快照类型补此布尔），UI 顶部渲一条细警告。v1 触发面极窄（compact/replace 事件本就罕见），不为它做窗口扩拉。
2. **fold 输出是 seq 数组，UI 要节点对象**：`surface.nodes: readonly number[]` → 逐 seq 物化 `ConversationNode`。**节点缓存 `Map<seq, ConversationNode>`**：物化纯函数 `materializeNode(event, ctx): ConversationNode`（switch on `event.type`，五个 surface 类型 + unknown 兜底，见 §A.4 节点形状；`ToolResultNode.call` 从 `ctx.callIndex`——窗口内 `tool/call` 事件的 `Map<CallId, {name, argsRaw}>`——回填）。缓存键 = seq：事件不可变，seq 级缓存永不失效（除非重建窗口整体清空）；每次快照重算 `nodes` 数组 = `surface.nodes.map(seq => cache.get(seq) ?? materialize…)`——数组引用每次变更换新，但节点对象引用稳定（React.memo 边界，§C）。

```ts
export class FoldAdapter {
  /** 窗口重建（open/resync/翻页 prepend 后）：换 padded 数组、new SurfaceManager、清节点缓存、重建 callIndex。 */
  reset(events: SessionEvent[], baseSeq: number): void
  /** 尾部追加（live session/event）：push 进 padded 数组 + callIndex 增量维护；tool/call 到达时顺带失效其 pending 中 ToolResultNode 缓存（不存在，no-op）。 */
  append(event: SessionEvent): void
  /** 当前节点数组（内部读 surface.nodes + 缓存物化）+ 降级位。 */
  nodes(): { nodes: readonly ConversationNode[]; degraded: boolean }
  /** 窗口内 tool/call 索引（Session 拿它算 runningCalls 与回填）。 */
  readonly callIndex: ReadonlyMap<CallId, { name: string; argsRaw: string; turn: number; step: number }>
}
```

（`ConversationSnapshot` 补一个字段：`foldDegraded: boolean`——上文防御位。）

### §A.6 chunk 累积器（partial.ts）——流式增长（拍板 4）

**输入** = `session/event` 帧里的 `assistant/chunk` 事件（`{ turn, step, chunk: StreamChunk }` 透传，token 流即事件流）。core `StreamChunk` 六型（`packages/llm/llm/src/types.ts`）按块 index 相关联；累积器把 delta 流折成 `AssistantBlock[]`：

| chunk | 累积动作 |
|---|---|
| `block-start` | `blocks[index] = 按 blockType 建空块`（text→`{kind:'text',text:''}`；reasoning 同理；tool-call→`{kind:'tool-call', callId: 待 delta 补, name:'', argsRaw:''}`；未知 blockType→`{kind:'other', block: null}` 占位） |
| `text-delta` / `reasoning-delta` | `blocks[index].text += text`（**字符串拼接每 chunk 换该块对象引用，其余块引用不动**——块级不可变） |
| `tool-call-delta` | 对应块 `argsRaw += argumentsDelta`；`id`/`name` 首见回填 |
| `block-end` | 用定稿 `block` 整体替换该 index 的累积块（含 other 兜底的真身回填） |
| `usage` / `finish` | 忽略（usage 定稿走 assistant/message；finish 后紧跟 assistant/message 事件收尾） |

- **生命周期**：首个 `assistant/chunk`（新 turn/step）到达 → new 累积器；对应 `assistant/message` 事件到达（surface fold 收编定稿消息）→ 累积器丢弃（partial=null）——**定稿即切换**，UI 观感是 partial 区变成正式节点（内容一致，无闪烁风险：同一批通知里完成，§A.9 合批保证单次 render 完成切换）。
- **turn/step 错位防御**：累积中若来了不同 (turn,step) 的 chunk（乱序理论不发生，seq 连续），直接弃旧起新 + console.warn。
- **增量 fold 策略的答案（任务书 §D 性能注记）**：chunk 根本**不进** fold——`assistant/chunk` 非 surface-eligible，SurfaceManager 跳过它；但它进 `events` 窗口（透传纪律：窗口=原始事件），fold 增量游标扫过为 O(1) 跳过。真正的每 chunk 成本 = 累积器一次字符串拼接 + 一次微任务合批通知 + React 一次 partial 区重渲——已是消息级缓存之下的块级增量，无「每 chunk 全量重 fold」问题。

### §A.7 zustand store 与 intents 增量（review 整改 #1 后：本里程碑 store 零增量）

**单例边界澄清（用户 2026-07-19 追认）**：「不应有全局单例」只针对 **selectedSessionId 这类视图选中态**（「哪个面板在看」的 UI 局部事实）；**SessionManager 模块级单例维持不动**（initSessionManager/getSessionManager 照旧，hooks 可用），bindIntents/rpcLog store 单例形态同样不动。

**选中态不进全局 store（review 整改 #1，用户拍板「不应有这种全局单例」）**：`selectedSessionId` 归属**视图容器局部 state**——组件树里拥有「列表+会话区」组合的容器（§C.1 SessionsScreen）`useState` 持有，选中回调经 props 下发。**多视图前瞻**：将来分屏/多面板 = 多个 SessionsScreen 实例各自持有自己的选中态，互不干扰——全局单例恰恰是那条路的死障，容器局部是其自然形。

**drafts 也不进全局 store**：草稿挂 **Session 对象**（§A.2 `setDraft` + 快照 `draft` 字段）。理由一句：草稿是 per-session 数据，跟着 per-session 对象走——常驻实例让切换/切回天然保稿；若放容器局部 state 会随 key=sessionId 重挂载丢稿，若放全局 store 则违反本条整改的原则（Record<SessionId,…> 切片就是变相全局单例）。清稿由 Session.sendDraft 内部完成（乐观清稿：发送瞬间 `draft=''` 同步通知、失败回填，§A.2 input-ux 修订），§B.2 的 send 句柄不再管草稿清理。

于是 **store.ts 本里程碑零改动**（仍只有 rpcLog + rpcLogOpen）；zustand 只承载真正的跨视图全局展示态，本里程碑没有新增的这类状态。

**intents.ts 增量**（intent=普通函数纪律不变；仅剩不依赖选中态的两个）：

| 函数 | 行为 |
|---|---|
| `refreshSessions()` | `manager.refreshList()` 透传（列表手动刷新钮/首连自动） |
| `createSession(): Promise<RpcResult<{sessionId}>>` | `manager.create()` 透传；**选中新 session 是容器的事**——容器回调里 await 结果后 setState 本地选中（§C.1），intent 不做导航副作用 |

原 `selectSession` intent 删除：选中=容器 setState + `manager.get(id).open()`（容器回调内联做，见 §C.1）；`setDraft/clearDraft` intent 删除（挂 Session 对象）。prompt/cancel/loadOlder 仍不做 intent——Session 对象方法（拍板 1 封装面），hook 层绑定暴露（§B）。

### §A.8 boot 装配（boot.ts 增量）

```ts
export function bootWebRuntime(options: BootWebRuntimeOptions): WebRuntimeHandle {
  const api = /* 既有：fixture | createApiClient(fetch, { onEnvelope: tapToStore }) */
  bindIntents(api)
  const manager = initSessionManager(api)
  const controller = new ConnectionController(api, {
    onMuxEnvelope: (e) => manager.handleMuxEnvelope(e),
    onHostEnvelope: (e) => manager.handleHostEnvelope(e),
    onConnected: () => manager.handleConnected(),
  })
  controller.start()
  return { stop: () => controller.stop() }
}
```

- 装配顺序保证 hooks 在首帧到达前就能 `getSessionManager()`（React mount 晚于 boot 同步段）。
- fixture 路径同一装配零分叉（§C.6 纪律沿用）；fixture 能力增量见 §E.1。

### §A.9 订阅与通知（Session/Manager 共用模式）

**变更→通知管线**（两类对象同构，写一个 `Notifier` 小基件复用）：

1. 任何内部状态变更（帧到达、请求状态迁移）→ `dirty = true` + `scheduleNotify()`。
2. `scheduleNotify` 微任务合批（同 rpcLog 泵思路）：`queueMicrotask` 一次 flush——**一帧 SSE 常带多个事件、chunk 风暴常态**，合批把 N 次变更收敛为一次 listener 调用（React 一次 re-render）。
3. flush 时**先重算快照缓存再通知**：`snapshotCache = buildSnapshot()`；`getSnapshot()` 只返回缓存引用，**绝不在调用中计算**——uSES 要求 `getSnapshot` 稳定（同一状态多次调用同一引用），否则无限重渲。
4. 快照构建的引用纪律：顶层对象每次新建；`nodes` 数组每次新建但元素引用来自缓存（§A.5）；`partial.blocks` 只有变更块换引用；`pending`/`runningCalls` 无变更时**沿用上一快照的数组引用**（构建函数按 dirty 细分位判断，v1 简化为：这些子数组在各自变更计数未变时复用旧引用——每类状态一个 revision 计数器，构建时比对）。
5. `subscribe` 返回退订闭包；listener 异常不吞（React 的 uSES listener 不会 throw，无需防御性 catch——出问题要炸在开发期）。
6. **`notifyNow` 同步逃生口（input-ux 批次1 增补）**：微任务合批对「用户直接输入的回显」有一帧滞后感——sendDraft 乐观清稿与 setDraft 键入回显走 `notifyNow()`（同步 rebuild+通知）；帧驱动的状态变更一律仍走 `markDirty` 合批。边界纪律：**只有用户手势的直接回响允许 notifyNow**，其余入口用它即违例（重新引入逐帧 setState 风暴）。

**Session.handleMuxEnvelope 帧分发表**（§A.2 的实现规格）：

| 帧 | 动作 |
|---|---|
| `session/event` | 事件 seq ≤ 窗口尾 seq → 丢（重放重叠，§D.3）；open 在途 → 进 liveBuffer；否则 `events.push` + `foldAdapter.append` + 按 type 附加动作：`assistant/chunk`→累积器；`assistant/message`→partial 清除；`tool/call`→openCalls 增；`tool/result`→openCalls 删；**`turn/end`→定格清扫同 turn 的 partial 与 openCalls**（aborted turn 不补发 assistant/message——core loop 实证；audit S2 bb16d956b 首修删除式清扫，bb1a7ed5f 升级「定格」：有内容 partial 冻结为 `interrupted:true` 终态节点、在途工具卡冻结为 interrupted 终态卡——中断输出是价值非残渣；冻结节点入 `frozenNodes` 派生态，快照时与 fold 产物按分数 seq 稳定归并，rebuildDerivedFromWindow 同函数重放保证 live 与刷新一致）；其余无附加 |
| `session/subscribed` | 记 `lastSeq` 供缝检测（§D.3）；open 前到达则暂存 |
| `approval/requested` | `pending.set('a:'+rpcId, …)`（key 前缀防两域 rpcId 理论碰撞——不同 mint 空间，纯防御） |
| `approval/resolved` | 按 approvalId 扫 pending 删除（resolved 帧带 approvalId 非 rpcId——契约如此）|
| `question/requested` | `pending.set('q:'+rpcId, …)` |
| `question/resolved` | 帧带 `questionRpcId`，删 `'q:'+questionRpcId` |

（`stream/error` 不进 Session——Controller 层已收敛为重连。）

---

## §B hook 层（逻辑面；web-ui/src/hooks/）

**定位（拍板 9 的分界线）**：hook 层是逻辑面的 React 出口——把 §A 对象翻译成「纯数据 + 操作句柄」。展示组件（§C）只吃 hook 返回值经 props 传下去的数据；**hook 只在容器组件（§C.1）调用，展示组件零 hook、零数据获取**。将来换 UI 库 = 重写 §C 组件、§B 与 §A 零改。

```
packages/client/web-ui/src/
  hooks/
    useSessionList.ts
    useConversation.ts
```

（住 web-ui 而非 web-runtime：hook 是 React 绑定，runtime 无 React 依赖——分界即包界。web-ui 由此获得对 `getSessionManager` 等 runtime 出口的依赖，仍不许碰 apiproxy——§C 对齐纪律沿用。）

### §B.1 useSessionList

```ts
export interface SessionListHandle {
  /** 谱系扁平化后的列表（§A.3 SessionListSnapshot 透传）。 */
  list: SessionListSnapshot
  // ---- 操作句柄（绑定 intents，引用稳定）----
  create: () => Promise<RpcResult<{ sessionId: SessionId }>>   // = createSession intent 透传（容器拿结果做本地选中）
  refresh: () => void                                          // = refreshSessions
}
export function useSessionList(): SessionListHandle
```

**选中态不在此 hook**（review 整改 #1）：`selectedSessionId` 是容器局部 state（§C.1），列表条目高亮由 `SessionListViewProps.selectedId` props 驱动；本 hook 只供数据与无导航副作用的操作。

实现规格：

```ts
export function useSessionList(): SessionListHandle {
  const manager = getSessionManager()
  const list = useSyncExternalStore(
    useCallback((cb) => manager.subscribe(cb), [manager]),
    () => manager.getListSnapshot(),
  )
  return useMemo(() => ({ list, create: createSession, refresh: refreshSessions }), [list])
}
```

- `getSnapshot` 直接传 manager 方法包装箭头：Manager 保证缓存引用稳定（§A.9.3），满足 uSES 合同。
- 操作句柄就是模块级 intent 函数——引用天然稳定，useMemo 只为聚合对象。

### §B.2 useConversation

```ts
export interface ConversationHandle {
  /** §A.4 全形快照（nodes/partial/runningCalls/pending/openState/hasMore/draft…）。 */
  snapshot: ConversationSnapshot
  // ---- 操作句柄（绑定 Session 实例方法；对本 hook 的同一 id 引用稳定）----
  setDraft: (text: string) => void          // = session.setDraft（草稿住对象，§A.7）
  /** 发送当前草稿：Session.sendDraft 内聚——空白 no-op、组 ContentBlock、乐观清稿+失败回填+在途锁（§A.2）。 */
  send: (mode: 'queue' | 'steer') => void
  stop: () => void                          // = session.cancel() fire-and-forget（错误进快照 promptError）
  loadOlder: () => void                     // = session.loadOlder() fire-and-forget
}
export function useConversation(sessionId: SessionId): ConversationHandle
```

实现规格：

```ts
export function useConversation(sessionId: SessionId): ConversationHandle {
  const session = getSessionManager().get(sessionId)   // 懒建；常驻实例，重复调用同一引用
  const snapshot = useSyncExternalStore(
    useCallback((cb) => session.subscribe(cb), [session]),
    () => session.getSnapshot(),
  )
  const ops = useMemo(() => ({
    setDraft: (text: string) => session.setDraft(text),
    send: (mode: 'queue' | 'steer') => void session.sendDraft(mode),
    stop: () => void session.cancel(),
    loadOlder: () => void session.loadOlder(),
  }), [session])
  return useMemo(() => ({ snapshot, ...ops }), [snapshot, ops])
}
```

- **草稿读写全在 Session 对象**（review 整改 #1 连带）：`snapshot.draft` 读、`setDraft` 写、`sendDraft(mode)` 发——「trim 空白 no-op→`[{type:'text',text}]`→prompt→乐观清稿/失败回填」整链内聚在 Session（§A.2；原 hook 里读 store 组装的逻辑随 drafts 切片一并删除）。hook 层零 zustand 依赖。
- **切换 session 即换 id 重跑 hook**：uSES 自动退订旧实例订阅、订新实例；旧 Session 常驻后台继续吃帧（拍板 2），下次切回快照即最新，无需重拉（缝检测兜底 §D.3）。
- `open()` 不在 hook 里调——由容器的选中回调触发（§C.1 SessionsScreen.select），hook 保持纯订阅（渲染路径无副作用；StrictMode 双调安全）。

### §B.3 ~~useSelectedSession~~（review 整改 #1 删除）

选中态无全局读出口——它是 SessionsScreen 容器的 `useState`（§C.1）。hooks/ 目录只有 useSessionList 与 useConversation 两个文件。

### §B.4 uSES 接线要点（防撕裂清单，写给实现者）

1. **getSnapshot 恒返缓存引用**（§A.9.3 已定）：对象层 flush 时先重算缓存再通知；React 在通知后调 getSnapshot 拿到新引用，比对旧引用触发 re-render。绝不在 getSnapshot 内 build——同渲染两次调用必须同引用，否则 React 18 dev 撕裂告警 + 无限循环风险。
2. **subscribe 引用稳定**：useCallback 依赖 [session]/[manager]；session 实例常驻保证切换外零重订。
3. **服务端渲染缺位**：不传 getServerSnapshot——本项目纯 CSR（vite SPA），SSR 不在范围。
4. **列表与对话双源一致性**：running 位同时活在列表条目与对话快照，同一 host 帧驱动两处（Manager 改 summaries + 转发 Session），同一微任务批内 flush——单 render 周期内两处一致，无中间态闪烁。

---

## §C 展示组件层（可替换 UI 面；web-ui/src/components/）

**红线（拍板 9）**：本节所有组件**纯 props 进、回调出**——零 hook（React 内建 useState/useRef/useEffect 做纯视图态除外：折叠开合、滚动 ref）、零 store/manager/intent import、零 runtime 类型之外的数据感知。类型只 import §A 快照/节点类型与本节 props 接口。**将来换 List/UI 库 = 整目录替换，§A/§B 与容器零改。**唯一例外是两个容器组件（§C.1）——它们是分界线本身：调 hook、传 props、不写样式结构。

本轮素朴实现口径：无样式追求（沿用 RPC 面板变量表的基本色），布局能用即可；不引组件库、不引 markdown 渲染（正文纯文本 `white-space: pre-wrap`——GFM/KaTeX 在 ui-product §7 有产品口径，本里程碑后置进 §F）。

### §C.0 文件清单

```
packages/client/web-ui/src/
  App.tsx                                ← 渲 <SessionsScreen /> + <RpcLog />（RPC 面板浮层保留）
  hooks/…                                ← §B
  components/
    sessions/
      SessionsScreen.tsx                 ← 视图容器：选中态 useState 在此（§C.1）；两列布局归它
      SessionListContainer.tsx           ← 容器：useSessionList → SessionListView（§C.1）
      SessionListView.tsx                ← 纯列表（§C.2）
      SessionListItem.tsx                ← 单条（§C.2）
    conversation/
      ConversationContainer.tsx          ← 容器：useConversation → ConversationView（§C.1）
      ConversationView.tsx               ← 对话流骨架：滚动区 + 节点分发 + 输入区（§C.3）
      MessageItem.tsx                    ← user/steering/context/unknown 四类简单节点（§C.4）
      AssistantMessage.tsx               ← assistant 节点：blocks 循环（text/reasoning 折叠/tool-call 头）（§C.4）
      ToolCallCard.tsx                   ← 工具卡片：running/result 双态（§C.5）
      PendingCard.tsx                    ← 审批/问答占位卡（§C.5）
      JsonBlock.tsx                      ← JSON 折叠块（复用思路同 RPC 面板 PayloadJson：stringify+截断；独立实现避免跨面板耦合）
      InputBar.tsx                       ← 草稿 + queue/steer/停止（§C.6）
    panels/RpcLog/…                      ← 既有不动
```

（每组件同目录 `.module.css` 同名文件，全清单略——素朴实现，类名跟组件节结构走。）

### §C.1 容器组件（分界线本身；review 整改 #1 后选中态在 SessionsScreen 局部）

```tsx
/** 视图容器：「列表+会话区」组合的 owner，选中态是它的局部 state——非全局单例。
 *  多视图前瞻：将来分屏/多面板 = 渲多个 SessionsScreen 实例，各自持有自己的选中态互不干扰。 */
export function SessionsScreen() {
  const [selectedId, setSelectedId] = useState<SessionId | null>(null)
  const select = useCallback((id: SessionId) => {
    setSelectedId(id)
    void getSessionManager().get(id).open()   // 选中即触发打开（fire-and-forget，错误进该 Session 快照）
  }, [])
  return (
    <div className={css.screen}>              {/* grid: var(--sidebar-width, 280px) minmax(0,1fr); height:100% */}
      <aside className={css.sidebar}><SessionListContainer selectedId={selectedId} onSelect={select} /></aside>
      <main className={css.main}>
        {selectedId === null ? <EmptyPane /> : <ConversationContainer key={selectedId} sessionId={selectedId} />}
      </main>
    </div>
  )
}

export function SessionListContainer({ selectedId, onSelect }: {
  selectedId: SessionId | null; onSelect: (id: SessionId) => void
}) {
  const h = useSessionList()
  const create = useCallback(async () => {
    const r = await h.create()
    if (r.ok) onSelect(r.value.sessionId)     // 新建即选中：容器回调组合，intent 无导航副作用（§A.7）
  }, [h.create, onSelect])
  return <SessionListView list={h.list} selectedId={selectedId}
    onSelect={onSelect} onCreate={() => void create()} onRefresh={h.refresh} />
}

/** key=sessionId（上面 JSX 已加）强制切 session 重挂载：滚动位置/折叠态等视图态按 session 重置（v1 简化拍板——不做跨切换视图态保持；草稿不受影响——住 Session 对象，§A.7）。 */
export function ConversationContainer({ sessionId }: { sessionId: SessionId }) {
  const h = useConversation(sessionId)
  return <ConversationView snapshot={h.snapshot}
    onDraftChange={h.setDraft} onSend={h.send} onStop={h.stop} onLoadOlder={h.loadOlder} />
}
```

（SessionsScreen/容器是允许调 hook 与 `getSessionManager` 的仅有两层；SessionListContainer 收 props 转 props，是「容器也可被组合」的示例——分界线在「展示组件零数据获取」，不在「容器必须零 props」。）

### §C.2 SessionListView / SessionListItem（拍板 8）

```ts
export interface SessionListViewProps {
  list: SessionListSnapshot
  selectedId: SessionId | null          // 容器局部 state 下发（§C.1）；高亮纯 props 驱动
  onSelect: (id: SessionId) => void
  onCreate: () => void
  onRefresh: () => void
}
export interface SessionListItemProps {
  entry: SessionListEntry
  selected: boolean
  now: number                    // 相对时间基准：View 层 30s tick（RPC 面板同款模式）
  onSelect: (id: SessionId) => void
}
```

- View 结构：标题行（「Sessions」+「+」新建钮 + 刷新钮）｜滚动列表（`flex:1; overflow-y:auto`）｜state==='loading' 且空列表渲「载入中」、'error' 渲错误行+重试（onRefresh）、空渲空态。
- Item 单行：`padding-left: calc(8px + depth * 16px)`（谱系缩进=纯 CSS，数据已给 depth）；内容 = running 状态点（绿=true 灰=false）+ mono sessionId 截断（头 8 字符 + `…`，title 挂全值）+ 右侧相对时间（formatRelative 复用 utils/，RPC 面板已建）。选中态底色 `--color-accent-soft`。
- `React.memo(SessionListItem)`：list.items 数组换引用时壳重渲，条目 entry 引用未变的行跳过（Manager 快照构建保持未变条目引用稳定——§A.9.4 同纪律，summaries 增量更新只换变更条目）。

### §C.3 ConversationView（对话流骨架）

```ts
export interface ConversationViewProps {
  snapshot: ConversationSnapshot        // draft 在快照内（§A.4；review 整改 #1 后无独立 draft prop）
  onDraftChange: (text: string) => void
  onSend: (mode: 'queue' | 'steer') => void
  onStop: () => void
  onLoadOlder: () => void
}
```

纵向三段：

1. **头行**（固定）：sessionId 截断 + running 点 + `foldDegraded`/`lastAgentError`/`removed` 的细条警示（有则渲）。
2. **滚动区**（`flex:1; overflow-y:auto`）：
   - 顶部哨兵：`hasMore` 时渲「加载更早」行（`loadingOlder` 时转圈禁点）；**v1 用显式按钮不用 IntersectionObserver 自动触发**（素朴实现；自动化留给 UI 替换轮）。
   - `snapshot.nodes.map(node => 按 kind 分发)`：user/steering/context/unknown→`MessageItem`、assistant→`AssistantMessage`、tool-result→`ToolCallCard`（key 一律 `node.seq`）。
   - `snapshot.partial` 非空 → `AssistantMessage`（partial 形状复用 blocks 渲染，加「生成中」脉冲点）。
   - `snapshot.runningCalls.map` → `ToolCallCard`（running 态，key=callId）。
   - `snapshot.pending.map` → `PendingCard`（key=rpcId）。
3. **InputBar**（§C.6）。

**滚动行为（翻页锚定 + 跟随，任务书拍板 7）**：

- 跟随底部（input-ux bb1a7ed5f 修订，两规则并存）：①**流式跟随**——`atBottom` 位由 `onScroll` 监听维护（原「effect 里测距」在程序化滚动与快照连发下会断链），贴底时每快照置底、用户上滚离底即自然停跟；②**用户发送强制置底**——发送手势记 `forceBottom`（含发送时节点数），直到自己的消息节点入流为止强制贴底（即使此前处于离底状态——发消息表达的就是「看最新」意图）。无显式 paused 态，素朴版不做「回到底部」浮钮。
- **翻页锚定算法**（prepend 不跳屏）：`onLoadOlder` 点击前记 `prevScrollHeight = el.scrollHeight` 与 `prevScrollTop`；节点 prepend 渲染后（`useLayoutEffect` 观察 nodes[0]?.seq 变小），设 `el.scrollTop = prevScrollTop + (el.scrollHeight - prevScrollHeight)`——内容高度差整体补偿，视口停在原消息上。记录值放 ref（`pendingAnchor: {h, t} | null`），补偿一次即清。
- 挂载时（open 完成首批 nodes 到达）滚到底一次：`useLayoutEffect` 监 openState 变 'open'。

### §C.4 MessageItem / AssistantMessage

```ts
export interface MessageItemProps { node: UserMessageNode | SteeringMessageNode | ContextMessageNode | UnknownSurfaceNode }
export interface AssistantMessageProps {
  /** 定稿节点或 partial 投影（此形状差异收在容器分发处：partial 时 seq 传 -1、streaming=true）。 */
  blocks: readonly AssistantBlock[]
  streaming: boolean
}
```

- text 块渲染统一走 `<MessageText text={…}/>` 单组件（F.11 预埋：Markdown 化=换其内部实现）。
- MessageItem 按 kind 渲：user=右对齐气泡（text 块拼接 pre-wrap；非 text 块 JsonBlock 折叠）；steering=user 同款加「插话」徽标；context=折叠卡（标题「上下文注入」+ JsonBlock，默认收起——ui-product「非人类交互不进普通时间线」的素朴近似）；unknown=折叠 JsonBlock（标题=type）。
- AssistantMessage 按块序渲：text→pre-wrap 正文；reasoning→折叠区（默认**收起**，标题「思考过程」+字符数；拍板 4 可折叠）；tool-call→内联卡片头（名称+callId 短形，实体卡片在 ToolCallCard——视觉上仅是「调用了 X」一行）；other→JsonBlock。`React.memo`：blocks 数组引用不变即跳过（§A.9.4 partial 只换变更块引用，但 blocks 数组本身每 chunk 换引用——partial 消息始终重渲，定稿消息 memo 命中，符合预期成本模型 §A.6）。

### §C.5 ToolCallCard / PendingCard

```ts
export interface ToolCallCardProps {
  callId: CallId
  call: { name: string; argsRaw: string } | null   // null=窗口截断（§A.4），头部渲 callId
  /** running=无 result；done=有。 */
  result: { content: readonly ContentBlock[]; isError: boolean; error?: { name: string; code: string } } | null
}
export interface PendingCardProps {
  item: PendingInteraction
  /** F.10 预埋：respond 里程碑传入即出按钮；本轮不传=纯展示。 */
  onRespond?: (rpcId: RpcId, payload: unknown) => void
}
```

- ToolCallCard：头行 = 状态点（running 黄脉冲/ok 绿/isError 红）+ name mono + callId 短形；体 = args JsonBlock（默认收起）+ result 有则 content 渲染（text 块 pre-wrap、其余 JsonBlock）。**「原地翻转」观感**：ConversationView 分发时 running 卡与 result 卡 key 不同（callId vs seq）会导致 DOM 重建——v1 接受（素朴实现无过渡动画，重建无感知差异）；UI 替换轮若做动画再统一 key。JSON 折叠、presentation 后置（拍板 4）。
- PendingCard：approval=黄底卡「等待审批：{toolName}」+reason；question=黄底卡逐条渲 questions 的 question/header 文本。**无按钮**（拍板 4 可见不可答；respond 交互 §F）；注一行灰字「请在原客户端处理」。

### §C.6 InputBar（拍板 6：queue/steer 双按钮 + 停止）

```ts
export interface InputBarProps {
  draft: string
  running: boolean
  disabled: boolean          // removed 或 openState!=='open' 时禁输入
  promptError: { op: 'send' | 'stop'; error: RpcError } | null
  onDraftChange: (text: string) => void
  onSend: (mode: 'queue' | 'steer') => void
  onStop: () => void
}
```

- props.draft 来自 `snapshot.draft`（ConversationView 拆传；草稿住 Session 对象——§A.7 整改后 InputBar 仍是纯 props，零感知归属变化）。
- 结构：textarea（自动增高 1–6 行；Enter=发送、Shift+Enter=换行）+ 右侧竖排按钮组。
- **按钮语义**（core 三原语一步到位，空闲发送即开轮——契约 prompt 的 queue 空闲时自动开轮，UI 无需分支）：
  - 「发送」= `onSend('queue')`——排队/空闲开轮一个按钮（core send 语义一体，ui-product §8 表）。
  - 「插话」= `onSend('steer')`——仅 `running` 时可用。置灰是 **UI 教育语义**非 core 限制（直核 agent/src/types.ts:110：steer idle 时行为=send，不会拒绝；§D.5 对齐表）——置灰让两按钮语义区分可感知，避免「idle 时两个按钮等价」的困惑。
  - 「停止」= `onStop()`——仅 `running` 时渲染。
  - Enter 默认走「发送」；draft 空白时两发送钮禁用。
- promptError 非空渲错误细条（`error.message` + code），下次发送自动清（§A.2 语义）。

### §C.7 App.tsx 改版

```tsx
<div className={css.app}>                 {/* height:100vh；两列布局归 SessionsScreen（§C.1）——选中态 owner 与布局 owner 同一组件 */}
  <SessionsScreen />
  <RpcLog />                              {/* 浮层不动，继续当开发观测器 */}
</div>
```

RPC 面板里程碑 §E.2 的 Sidebar 三段式素材（品牌行/Footer/Settings）**仍不启用**——本里程碑左栏只有列表本体；`--sidebar-width` 变量此轮引入 `:root`。

---

## §D 与契约的对接面

### §D.1 消费清单（契约方法/帧 ↔ 本设计消费点）

| 契约面 | 消费点 |
|---|---|
| `session.list` | `SessionManager.refreshList`（onConnected 自动 + 刷新钮） |
| `session.create` | `SessionManager.create`（createSession intent；新建即选中由容器回调组合，§C.1） |
| `session.history` | `Session.open`（尾页）/ `Session.loadOlder`（beforeSeq 页）/ `Session.resync`（重连重拉尾页） |
| `session.prompt` | `Session.prompt`（queue/steer） |
| `session.cancel` | `Session.cancel` |
| `host.describe` | 不新增消费（Controller 既有连通探测；host 快照展示后置） |
| mux `session/event` | Session 窗口 append + fold/累积器/openCalls（§A.9 分发表） |
| mux `session/subscribed` | 缝检测基线（§D.3） |
| mux `approval|question/requested|resolved` | Session.pending 占位卡 |
| mux/host `stream/error` | Controller 重连（既有），业务层忽略 |
| host `session-added/removed/status/agent-error` | Manager 列表维护 + Session 转发（§A.3 路由表） |
| `/api/respond`（ClientResponse） | **不消费**（respond 交互 §F；PendingCard 只展示） |

未消费的契约面（fork/inject/task/listModels §8 预留、`since` 续传、`approvals/questions` respond）本里程碑均不触碰——契约零改动诉求。

### §D.2 历史翻页（拍板 7 的完整数据路径）

```
open():   history({ sessionId })                    → events=E, baseSeq=E[0].seq, hasMore
loadOlder(): history({ sessionId, beforeSeq: baseSeq, maxMessages: PAGE_MESSAGES })
          → 前插 events = [...older, ...events]；baseSeq=older[0].seq；FoldAdapter.reset（§A.5.1 重建）
```

- `PAGE_MESSAGES = 50`（open 尾页与 loadOlder 同值；模块常量，GUI 免门禁期不做 config——契约 maxMessages 缺省行为由 server 定，client 恒显式传）。
- **返回窗口连续性断言**：`older` 尾事件 seq + 1 必须 === 旧 `baseSeq`（契约页边界按消息切但事件 seq 连续无洞）；不满足则 console.error + 丢弃该页并置 hasMore=false（fail-soft：显示已有窗口，不渲乱序流）。
- UI 锚定补偿在 §C.3（scrollHeight 差）；数据层职责止于「前插后同一微任务 flush 一次快照」——锚定需要 prepend 前后各一次同步测量，由 useLayoutEffect 保证在 paint 前完成。
- 翻页与 live append 并发：prepend 只动窗口头部、append 只动尾部，天然无交叠；FoldAdapter.reset 在 prepend 时以「当时窗口全量」重建，期间到达的 live 事件排在 JS 任务队列后续处理（单线程顺序保证一致性）。

### §D.3 打开/重连的缝合规则（subscribed.lastSeq 缝检测）

打开 session 的事件序（契约 §5 主路径的 client 侧精化）：

1. mux 流常开（Controller 起代即开，全 session 聚合）；`session/subscribed` 帧在流打开时对 attached session 下发——**冷 session 无 subscribed 帧**（未 attach），其 lastSeq 基线视为「无」。
2. `open()` 发 `history()`（冷 session 由 impl 隐式 resume——契约 §3.1；resume 后该 session 变 attached，此后帧照常来。**接缝问题 #2**：resume 发生在 mux 流已开之后，契约未明确 host 会不会为「新 attach 的 session」补发 subscribed 帧——若不补发，client 拿不到 lastSeq 基线，缝检测降级为「liveBuffer 合并去重」路径，可接受但基线语义残缺；报 README 请契约明确）。
3. history 响应就绪：`events` 窗口初始化 → 合并 `liveBuffer`（open 在途期间到达的 live 事件）：按 seq 过滤 `> 窗口尾 seq` 的 buffer 事件依次 append，重叠丢弃——**seq 是唯一去重键，透传纪律的直接红利**。
4. 缝检测：若曾收 `subscribed.lastSeq > 当前窗口尾 seq` 且 liveBuffer 未覆盖中间段 → 再拉一次 history 补缝（契约 §3.3 拍板用途 1:1）；实现为 open() 完成前的一次收尾核对。
5. `resync()`（重连）：= 清窗口回 `open()` 路径重跑（重连=重建，契约 §0.7）；pending 交互清空等 subscribed 基线重放帧重建（契约 §3.4——host 对 pending 的 requested 帧原样重放，rpcId 不变，PendingCard 无感）。

### §D.4 增量成本模型（任务书性能注记的汇总答案）

| 事件 | 成本 |
|---|---|
| 每 assistant/chunk | 累积器一次字符串拼接（块级引用更新）+ dirty 标记；fold 游标 O(1) 跳过；React 一次 partial 区重渲（微任务合批后） |
| 每消息定稿（assistant/message） | SurfaceManager 增量折一个事件（O(1) append）+ 物化一个新节点（缓存 miss 恰一次）+ partial 清除 |
| 翻页 prepend | SurfaceManager 全量重建 O(窗口事件数)+节点缓存清空重物化 O(窗口消息数)——低频用户操作，可接受（§A.5.1 取舍） |
| 帧风暴（多 session 并发跑） | 非选中 Session 照常吃帧更新内部状态，但其 listener 集为空（无订阅）→ 只有 dirty 标记无快照构建（§A.9.3 flush 仅在有 listener 时 build——实现细则：Notifier 无监听者时跳过 build，仅置 dirty；下次 subscribe/getSnapshot 时惰性 build） |

### §D.5 core 对齐对照表（review 整改 #2；2026-07-19 逐条直核 packages/core/{session,agent}/src 与 packages/llm/llm/src 源码，非契约转述）

#### 方法链（本设计方法 ｜ 契约方法 ｜ core 原语 + file:line）

| 本设计 | 契约 | core 原语（直核） |
|---|---|---|
| `Session.sendDraft('queue')` → `prompt(content,'queue')` | `session.prompt` mode:'queue' | `Agent.send(content, options?)` — agent/src/types.ts:103（queue detached input；**空闲自动开轮**「starts a turn when idle」——§C.6 按钮语义的 core 依据） |
| `Session.sendDraft('steer')` → `prompt(content,'steer')` | `session.prompt` mode:'steer' | `Agent.steer(content, options?)` — agent/src/types.ts:110（injected between steps of the current turn；**idle 时行为=send**——§C.6「非 running 置灰」是 UI 教育选择，core 不会拒绝） |
| `Session.cancel()` | `session.cancel` | `Agent.cancel(reason?)` — agent/src/types.ts:127（clear queued+steering work＋abort active step——契约「清两条 FIFO + abort 当前 step」1:1 成立） |
| `Session.open()/loadOlder()/resync()` | `session.history` | core `Session.events` getter — session/src/index.ts:322（append-only log 的不可变快照；seq=下标连续从 0——§D.2 连续性断言的 core 依据）；分页切边界用的消息事件类型即 surface-eligible 五型 — session/src/surface.ts:11-17 |
| `SessionManager.create()` | `session.create` | `SessionStore.create(id?, options?)` — session/src/index.ts:606（options.meta 带 cwd/parentSession 入 SessionHeader） |
| `SessionManager.refreshList()` | `session.list` | **无单一 core 原语**（契约即如此设计）：持久化条目=impl readdir+stat（updatedAt=mtime）；live running 位可由 `SessionStore.list()` — session/src/index.ts:826（仅 live session，creation order）+ `Agent.status` 合成。非不对齐，是 impl 组合面，此处备档 |
| 快照 `running` | `host/session-status` 帧 | `Agent.status: AgentStatus` — agent/src/types.ts:95；union `'idle'|'running'|'disposed'` — types.ts:47；翻转事件 `agent/status` — types.ts:165。**注意三态→二态投影**：契约 running:boolean = (status==='running')，`disposed` 与 idle 同渲为不 running（列表条目无生命周期终态语义；host/session-removed 才是移除信号） |
| 快照 `lastAgentError` | `host/agent-error` 帧 | `agent/error` 事件族（agent/src/types.ts 的 error 通道；契约 core-coverage L5 裁决透传）——client 只消费 message 文本，无字段推导 |
| （§F 不做，备档）fork | 契约 §8 预留 `session.fork` | `SessionStore.fork(source, boundary?, childSessionId?)` — session/src/index.ts:843 |

#### 数据推导（ConversationSnapshot 字段 ← core 事件/字段；「core 原样」=透传零转换）

| 快照字段 | 来源与推导 |
|---|---|
| `nodes`（surface 序） | `SurfaceManager.nodes`（session/src/surface.ts:255；`foldSurface` 同源 surface.ts:244）吐 seq 数组 → 逐 seq 物化。surface-eligible 五型 = user/assistant/tool-result/context/steering message（surface.ts:11-17）——§A.4 六节点 union 的前五种 1:1，第六种 unknown 兜底 merge-extensible 扩展 |
| `UserMessageNode.content/source` | `'user/message': { content: ContentBlock[]; source: MessageSource }` — session/src/types.ts:199，core 原样 |
| `AssistantMessageNode.turn/step/usage` | `'assistant/message': { turn; step; content; provenance; usage? }` — session/src/types.ts:226，core 原样。**provenance 不进快照**（v1 无消费方，物化时丢弃——标注非透传纪律违例：快照是 UI 投影非 wire） |
| `AssistantMessageNode.blocks` | 同事件 `content: ContentBlock[]` 按块 type 分拣（llm/src/types.ts:44-49 四型 map）：`TextBlock{type:'text',text}`→kind:'text'；`ReasoningBlock{type:'reasoning',text}`(llm types.ts:17-20)→kind:'reasoning'——**reasoning 是 ContentBlock 类型非独立事件，直核确认**；`ToolCallBlock`→kind:'tool-call'；其余→kind:'other' |
| `AssistantBlock(tool-call).callId/name/argsRaw` | `ToolCallBlock { type:'tool-call'; **id**: CallId; name; **arguments**: string }` — llm/src/types.ts:23-30。**字段名映射（易错点标出）**：块内是 `id`/`arguments`，**不是** callId/argsRaw——适配层映射 `block.id→callId`、`block.arguments→argsRaw`；而 `tool/call` **事件**的字段名是 `callId`/`arguments`（session/src/types.ts:232）——core 两处命名本就不一致，物化函数按各自真名取 |
| `ToolResultNode.*` | `'tool/result': { turn; step; callId; content; isError; error?; meta? }` — session/src/types.ts:242，core 原样；`call` 头 = 窗口内 `'tool/call': { turn; step; callId; name; arguments }`（types.ts:232）按 `CallId` join（callIndex，§A.5） |
| `SteeringMessageNode.turn/content/source` | `'steering/message': { turn; content; source }` — session/src/types.ts:244，core 原样（**无 step 字段**，直核确认——节点不设 step） |
| `ContextMessageNode.content/source/envelope/meta` | `'context/message': { content; source; envelope?; meta? }` — session/src/types.ts:212-217，core 原样（envelope/meta 本次整改补进节点，v1 JSON 渲出不解释） |
| `UnknownSurfaceNode.type/data` | merge-extensible `SessionEventMap` 未知扩展（session/src/types.ts:254 注释：plugin-merged extensions included）——documented-default 兜底 |
| `PartialAssistant.blocks` | `'assistant/chunk': { turn; step; chunk: StreamChunk }` — session/src/types.ts:219 累积；`StreamChunk` 六型 — llm/src/types.ts:151-163，§A.6 表逐型核对：block-start 带 `blockType`、text/reasoning-delta 带 `index/text`、tool-call-delta 带 `index/id/name?/argumentsDelta`、block-end 带定稿 `block`、usage/finish 忽略——**与源码逐字段一致** |
| `runningCalls` | 窗口内 `tool/call` 减去已有 `tool/result` 的 CallId 差集（两事件 callId 同名同 brand——llm CallId，session types.ts:232/242） |
| 节点 `seq` / 去重键 / 翻页锚 | `SessionEvent.seq`（session/src/types.ts:324 信封；seq=log 下标，index.ts:322 快照注释——「seq 连续无洞」断言的 core 保证） |
| `hasMore` | 契约 history 返回值（server 分页产物，core 无对应——分页是 apiproxy 层发明，core 只有全量 log） |
| `pending` | mux `approval/question requested/resolved` 帧（apiproxy 控制面发明，core 对应物是 approval waterfall/userInteraction provider——不经 SessionEvent，无字段推导） |
| `draft/promptError/openState/loadingOlder/foldDegraded/removed` | client 侧自造态，无 core 对应（备档防误会） |
| 列表 `parentSessionId/cwd` | `SessionHeader.parentSession/cwd` — session/src/types.ts:45/47（readonly，contract 经 SessionSummary 透传；header 不在事件日志里——index.ts:264 注释「kept out of the event log」，所以走 list 快照不走 fold） |
| 列表 `updatedAt` | 持久化文件 mtime（impl 产物，core 无「最后活动时间”字段——备档） |

**不对齐发现：0 红线，2 处已消化进设计的注意点**——① ToolCallBlock 字段名 `id`/`arguments` vs 事件字段 `callId`/`arguments`（上表标出，物化函数按真名映射）；② AgentStatus 三态 vs 契约 running 二态投影（disposed 的列表语义靠 session-removed 帧补齐）。方法链全部 1:1 成立，无 core 能力缺口。

---

## §E 验收清单（两级）

### §E.1 fixture 级（无 host；`?fixture`；fixture.ts 能力增量前置）

fixture 需扩展（实现工单的一部分，RPC 面板 §A.5 基线上加）：
- `session.history`：对 fx-alpha 返回一段**手造事件脚本**（约 3 页量：含 user/assistant/tool call+result/steering/reasoning 块/context 各若干，seq 连续、surfaceOp 齐全），支持 beforeSeq 切页；fx-beta/gamma 返回空。
- `events.mux`：打开后对 fx-alpha 依次推「subscribed → 延时逐帧回放一段 live 脚本（含 assistant/chunk 流式段 + tool call/result + approval/requested）」——chunk 段按 80ms/帧回放模拟打字机。
- `session.prompt`：收到后往 mux 流回推「user/message 事件 → chunk 流式段 → assistant/message 定稿」循环脚本；`cancel` 停止当前回放段。

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 开 `?fixture` | 左列表 3 条（fx-alpha running 绿点；谱系若 fixture 配 parentSessionId 则见缩进）；右侧空态 |
| 2 | 点 fx-alpha | 对话流渲出历史脚本全节点：user 气泡/assistant 正文/reasoning 折叠（点开有内容）/工具卡双态/steering 徽标/context 折叠卡；滚动在底部 |
| 3 | 顶部「加载更早」 | 前插一页，**视口不跳**（锚定在原消息）；到最早页按钮消失（hasMore=false） |
| 4 | 观察 live 脚本 | partial 区打字机增长 → 定稿瞬间转正式节点无闪烁；工具卡 running→done；approval 占位卡出现（无按钮） |
| 5 | 输入框发送（queue） | user 气泡入流 + 回放的流式回复；草稿清空；Enter 触发同按钮 |
| 6 | running 期间「插话」 | steer 路径走通（fixture 回 accepted；流里回放 steering/message 帧）；非 running 时按钮置灰 |
| 7 | 「停止」 | 回放段停止；running 点熄灭（fixture 推 status 帧） |
| 8 | 切到 fx-beta 再切回 fx-alpha | fx-beta 空对话；切回 fx-alpha 即时呈现（实例常驻，无重拉 loading 闪烁）；期间 fx-alpha 后台若有帧，切回可见 |
| 9 | 新建按钮 | 列表新增条目并自动选中打开 |
| 10 | RPC 面板对照 | 以上每步流量在调试面板可见（history/prompt/cancel 往返 + 帧台账）——两里程碑产物互证 |

验收方式：playwright chromium headless 自跑（gui-playwright-self-verify 纪律），不留人手验。

### §E.2 真 host 级（W1–W5+impl 全通后）

| # | 步骤 | 期望 |
|---|---|---|
| 1 | `dsc web` 起真 host，开首页 | 列表=真 .sessions 目录（updatedAt 倒序）；含子 session 时缩进正确 |
| 2 | 打开一个有历史的 session | 尾页渲染正确（与 jsonl 对读抽查）；向上翻页至最早，事件无缺无重 |
| 3 | 新建 + 发送真 prompt | 流式回复打字机；工具调用卡片随执行翻转；停止按钮中断 |
| 4 | 第二个浏览器页签打开同 session | 两页签同步收帧（多 client 行为未定义但不崩——契约 v1 口径） |
| 5 | kill host 重启 | 重连后列表刷新、打开中的 session 重拉尾页重建；pending 审批卡随基线重放恢复 |
| 6 | 长 session（数千事件） | 打开耗时可感知但不卡死；翻页/流式期间输入不掉帧（增量模型 §D.4 生效的粗验） |

---

## §F 架构妥协台账（review 整改 #3：不只列「不做」，每条给【触发条件→返工点→预埋要求】）

**读法**：触发条件是具体事件（「上了 X 之后」），不是「将来」；预埋要求是本轮实现就要守的形，让返工时收得拢。无返工含量的纯范围排除收在 F.13 一行。

| # | 妥协 | 触发条件 | 返工点 | 预埋要求（本轮就做） |
|---|---|---|---|---|
| F.1 | 跨切换视图态不保持（key=sessionId 重挂载，滚动/折叠全重置） | 上 recycle/虚拟列表分页时——虚拟列表本身要求滚动位置/可视窗口状态外置化，届时视图态保持是必做不是可选 | 视图态从组件局部提升到 per-session 归属（大概率挂 Session 对象或容器持有的 per-id Map） | 组件视图态读写走**单一入口**：ConversationView 及子组件的滚动/折叠态若超出单组件，就收敛为 props 可选对 `viewState?/onViewStateChange?`，不散落多处 useState |
| F.2 | tool 卡「原地翻转」靠 DOM 重建（running 卡 key=callId、result 卡 key=seq，两张卡非同一节点） | 上状态过渡动画时——动画要求 running→done 是同一 React 节点的状态变化 | ConversationView 分发处合并两态为单一 `<ToolCallCard key={callId}>`（result 从 snapshot 按 callId join 进 props） | ToolCallCardProps 已是双态一体（call+result 可空）——**分发逻辑集中在 ConversationView 一处**，不让子组件各自感知两态来源 |
| F.3 | 翻页 replace 跨窗即 foldDegraded 降级（fail-soft 显示+警条） | compact/replace 事件真实落地进任何被翻页打开的 session（现在触发面≈0，compact 上线后必现） | 契约补 replace 闭包语义（replace 目标所在页整体返回或 server 侧展开——接缝 #1），client 删降级分支 | 降级路径**独立成 FoldAdapter 内一个分支函数**+快照单布尔 foldDegraded，删除时零散点；不在 UI 层特判 |
| F.4 | `PAGE_MESSAGES = 50` 模块硬编码 | 本包转正进仓库门禁（GUI 免门禁期结束）——「无硬编码 tunables」家规届时直接命中 | 升 Config 字段走 cordis.yml/boot options | 常量**单点定义**在 session.ts 顶部并注明「转正时升 Config」；调用处全部引用常量名 |
| F.5 | 翻页 prepend 全量重建 SurfaceManager + padding 哨兵 O(baseSeq) | 万级事件 session 实测翻页可感知卡顿（§E.2-6 粗验不过） | core surface 支持 seq 偏移窗口（SurfaceManager 收 baseSeq 参数）或 client 自写增量 prepend fold | FoldAdapter 的 reset/append 已是唯一 fold 入口——返工只动 fold-adapter.ts 一文件；**不让 Session 直接碰 SurfaceManager** |
| F.6 | removed/闲置 Session 实例常驻不释放（拍板 2 全实例活着） | 长跑单页（数百 session 打开过）内存实测超预算，或 host/session-removed 高频场景出现 | SessionManager 加逐出策略（removed 且无订阅者 N 分钟后 dispose；Map 换 LRU） | Session 已有明确「无监听者不 build 快照」惰性（§D.4）；**新增 dispose() 预留为 no-op 方法**，Manager 是唯一持有 Session 引用的地方（hooks 不长期持引用） |
| F.7 | 未实例化 session 的 mux 帧直接丢（§A.3 路由表「不懒建」） | 需要「后台未打开 session 的未读计数/预览」类需求（ui-product §6 待处理计数上列表时） | Manager 帧路由加轻量 per-session 计数器（不建全量 Session，只记 metadata） | 路由函数**单点 switch**（§A.3 表即代码结构）；丢帧分支显式 `// drop: not instantiated` 注释可 grep |
| F.8 | 草稿仅内存（刷新即丢） | 用户实际丢稿投诉出现，或做「多 client 草稿同步」时 | Session.setDraft 加 localStorage 写透（key=sessionId），构造时读回 | draft 读写已收口 Session 对象两个方法——加持久化只动 session.ts，UI 零改 |
| F.9 | api-types.ts 临时契约副本（W3 前） | W3（apiproxy fetch/client + 包出口）落地即触发（不是可选：§C 对齐纪律 2 要求真 import） | 删 api-types.ts，全部 import 改 `@deepseek-ai/dsh-apiproxy` 真类型；流信封窄形随真签名 | 副本文件头已标「W3 后删除」；**web-runtime 内所有契约类型 import 集中经 api-types.ts 一个文件转口**，替换=改一处 re-export |
| F.10 | respond 交互不做（PendingCard 可见不可答） | 下一里程碑主菜（用户已排期），无额外触发条件 | PendingCard 加按钮 + `/api/respond` 通路（ClientResponse 回填 rpcId） | PendingInteraction 已带 rpcId（回填键在手）；PendingCardProps 预留 `onRespond?` 可选回调位——**本轮不传即纯展示** |
| F.11 | 对话正文纯文本 pre-wrap（无 Markdown/GFM/KaTeX/高亮） | UI 打磨轮启动（style-design 调研落地后） | MessageItem/AssistantMessage 的 text 块渲染函数换 Markdown 组件 | text 渲染**抽 `<MessageText text={…}/>` 单组件**，替换=换其内部实现，卡片结构零动 |
| F.12 | 诊断视图不做（context/message 折叠卡混在主流） | ui-product §7「非人类交互不进普通时间线」被用户重申（大概率随真实 harness 会话——context 注入高频——一起来） | ConversationView 分发处按 kind 分流到诊断区/主流两列表 | ContextMessageNode 独立 kind 已就位——分流只是分发处加一行 filter，节点类型无需重构 |
| F.13 | 纯范围排除（无预埋、无返工形状，触发即整块新做）：tool presentation 附件（契约 §3.3 遗留）、虚拟列表（ui-product 一期口径）、样式/动画/暗色（RPC 面板 §E.4 素材另轮）、重命名/标题（契约无 title 字段，additive）、列表排序/筛选/搜索/分页、多 client 互斥/since 续传/rpcId 幂等（契约 §6 同步）、agent-error toast 通道 | — | — | — |

## §G 实现工单切分建议（供 dispatcher 参考，非本文约束）

1. **S1 runtime 对象层**：session/ 五文件 + connection sinks + store/intents/boot 增量（§A 全部）——纯 TS 可单测（fold 适配、lineage、累积器、缝合都是纯逻辑）。
2. **S2 fixture 扩展**：§E.1 前置的脚本能力（依赖 S1 的类型，不依赖 UI）。
3. **S3 hook + 组件**：§B+§C（依赖 S1 出口）。
4. **S4 playwright 验收**：§E.1 清单脚本化。

S1/S2 可并行 S3 的组件静态部分（props 契约已定，可先用假快照渲）；对接真契约（删 api-types.ts 换 import）视 W3 进度独立小工单。
