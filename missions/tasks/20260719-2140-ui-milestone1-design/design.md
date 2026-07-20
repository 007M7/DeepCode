# UI 首里程碑（RPC 调试面板）· 实现级设计（v2.1 完稿，待 review）

> 2026-07-19 起草。读者=无上下文编码 teammate，照抄即可建文件写代码。
> 契约基线：`../20260719-1902-apiproxy-api-design/design.md`——本文只消费不改。**契约变更提示（2026-07-19 22:0x）**：用户推翻「签名不感知信封」，定型严格双向 RPC——①ApiProxy 方法签名收 `RpcRequest<P> = { rpcId, payload }` 封装（server 感知 rpcId）；②SSE 帧本身 = server 发起的 request（帧 rpcId 由 server mint）；③审批/问答 respond 的 payload 回填 requested 帧的 rpcId 作 wire 关联（respond 调用自身另有新 rpcId）。修订稿由 apiproxy-design 维护中，**本文引用契约类型的具体泛型/信封名以修订稿为准**，涉及处以「契约修订稿」字样弱引用、不写死。
> 骨架现状：step1 五包已 commit（`../20260719-1843-step1-skeleton-design/design.md` v2.1）；本里程碑会**改写** web-runtime / web-ui / apps-web 三包的入口文件（§A.0 / §B）。
> 范围（2026-07-19 22:0x 两条收窄拍板后）：**最简 App 壳 + 右下角强浮动 RPC 调试面板，仅此**。左侧导航 / Sessions 列表 / Settings 入口 / 新建按钮 / 主题切换全部降级下一里程碑（已写素材保留在 §E，不作本里程碑交付物）；store 只存 rpcLog + 面板轻量 view 态，sessions/connection 业务数据走 OOP 演进方向（§A.1 注记）。对话流不做。
> 纪律：GUI 期间跳过仓库门禁（无测试/coverage/JSDoc 门），只求 typecheck 过 + 能跑。

---

## §A web-runtime 数据层

### §A.0 模块布局与导入纪律

```
packages/client/web-runtime/src/
  index.ts        ← 唯一出口：bootWebRuntime + store + intents + 本层类型 re-export
  store.ts        ← WebStore（rpcLog + 轻量 ui 态）+ zustand vanilla 模块单例（§A.1）
  rpc-log.ts      ← RpcLogEntry 类型 + tap→store 微任务批量泵 + 环形截断（§A.2）
  connection.ts   ← ConnectionController：boot 序列 + 重连退避循环（§A.3）
  intents.ts      ← intent 普通函数集（rpcLog 三件 + 面板演示触发，§A.4）
  fixture.ts      ← FixtureApi：无 server 时的假 ApiProxy（§A.5）
  boot.ts         ← bootWebRuntime(options)：选 real/fixture、装 tap、起 controller（§A.6）
```

`packages/client/web-runtime/package.json` 的 `dependencies` 新增两项（step1 时该包零依赖）：

```json
  "dependencies": {
    "@deepseek-ai/dsh-apiproxy": "workspace:^",
    "zustand": "~4.4.7"
  }
```

**导入纪律（§C 会重申，两处冲突以本节为准）**：

- 契约类型一律 type-only import 自 apiproxy 的 api 层：`import type { ... } from '@deepseek-ai/dsh-apiproxy/src/api/index.ts'`（借 step1 已有的 `"./src/*"` exports 通道；vite/tsx 均吃 src）。
- 运行时值只允许两个来源：`createApiClient` 自 `@deepseek-ai/dsh-apiproxy/src/fetch/client.ts`；`RpcId()` 构造函数自 api 层（fixture 造假信封用；api/ 零 Node 依赖，浏览器可 import）。
- **禁止 import `@deepseek-ai/dsh-apiproxy` 包根**——根出口 re-export `bootHost`，会把 cordis/Node 依赖拖进浏览器 bundle。
- `SessionId` type-only import 自 `@deepseek-ai/dsh-session`（契约 id 纪律同款；类型擦除后 vite 不见此包，package.json 不加该依赖）。
- zustand 只用 `zustand/vanilla` 的 `createStore`（本包无 React）；`useStore` hook 属于 web-ui（§B）。
- 不引 immer（deepseekchat 基线有、此处偏离）：切片浅、手写 spread 足够，少一个依赖。

### §A.1 store：切片 TS 类型（store.ts 全文形状；2026-07-19 22:0x 拍板瘦身后）

**拍板**：store 里不存复杂业务数据对象——sessions 列表/摘要、connection 状态机全都**不进 store**。本里程碑 store 只有两块：rpcLog（核心）+ 面板自身的轻量 view 态。

```ts
import { createStore } from 'zustand/vanilla'
import type { RpcLogEntry } from './rpc-log.ts'

// ---- rpcLog 切片 ----

export interface RpcLogSlice {
  /** 追加序（旧→新），长度 ≤ RPC_LOG_CAP（500），溢出丢最旧（§A.2）。 */
  entries: RpcLogEntry[]
  /** 因溢出丢弃的累计条数（面板顶部「已丢弃 N 条」提示）。 */
  droppedCount: number
  /** 面板折叠期间新到条数（角标徽标）；面板展开瞬间清零，展开期间恒 0。 */
  unread: number
  /** 只冻结面板自动跟随（§B 滚动行为），采集永不停。 */
  paused: boolean
}

// ---- ui 切片（纯面板 view 态，无业务对象）----

export interface UiSlice {
  rpcLogOpen: boolean
}

// ---- 根 ----

export interface WebStore {
  rpcLog: RpcLogSlice
  ui: UiSlice
}

/** 模块单例（不造 bridge：web-ui 直接 import 此 store 包 useStore）。 */
export const store = createStore<WebStore>()(() => ({
  rpcLog: { entries: [], droppedCount: 0, unread: 0, paused: false },
  ui: { rpcLogOpen: false },
}))
```

- 主题切换随左导航一起移出本里程碑（§E）；`data-theme` 架构届时按 §E.4 变量表接入，本里程碑 global.css 只写 `:root` 亮色变量（面板要用色值）。
- **变更纪律**：一切写入走 `store.setState()`（顶层浅合并）；每次只重建被改的切片对象（spread），未动切片保持引用不变——§B selector 稳定性的前提。写入方只有 rpc-log.ts 泵与 intents；React 组件零写入。

**数据对象演进方向（拍板注记，本里程碑不定型）**：connection / session 这类「数据 + 操作」将走 OOP 化——runtime 层持有 `Connection` / `Session` 类实例（方法即操作，如 `session.prompt()`、`connection.reconnect()`），React 界面操作调用对象方法；React 需要的展示态届时经**窄投影**进 store（对象在状态迁移点写入最小标量，如 `connected: boolean`）或经 `useSyncExternalStore` 直接订阅对象自身的变更通知——两条路线届时定型，不在本文预设。因此 v1 版本文里的 ConnectionSlice / SessionsSlice / DraftSlice 已删除；ConnectionController（§A.3）保留但其状态不进 store。

### §A.2 rpcLog：tap 形状 + 环形 buffer（rpc-log.ts）

**采集点唯一**：fetch 载体层咽喉——`createApiClient(fetchLike, options)` 的 `onEnvelope` 选项，**四象限 wire 单元**全过此口。契约 wire 模型已定型为四具名判别 union（用户拍板）：**ClientRequest**（client 发起的 unary）/ **ServerResponse**（对它的应答）/ **ServerRequest**（SSE 帧，server 发起，含无需应答的 notify 子集；「帧」只是它的承载俗称）/ **ClientResponse**（client 对 ServerRequest 的应答——物理走 HTTP、payload 回填帧 rpcId、**不 mint 新 id**）。契约签名（ApiProxy 各域方法）零污染。

**onEnvelope 形状（W3 实装在 fetch/client.ts 并导出，本节是消费方规格；各支 envelope 的具体类型名以契约修订稿为准，本节锁定「四支分类 + 各带完整 wire 单元」的形状约定，分类字面量直接用四象限词汇）**：

```ts
// 住 apiproxy fetch/client.ts（载体层类型，非契约 api/）；web-runtime type-only import。
export type ApiEnvelopeTapEvent =
  | { kind: 'client-request';  envelope: /* 契约修订稿·ClientRequest wire 单元 */;  method: string }
  | { kind: 'server-response'; envelope: /* 契约修订稿·ServerResponse wire 单元 */; method: string }
  | { kind: 'server-request';  envelope: /* 契约修订稿·ServerRequest wire 单元 */;  stream: 'mux' | 'host' }
  | { kind: 'client-response'; envelope: /* 契约修订稿·ClientResponse wire 单元 */; method: string }
export type ApiEnvelopeTap = (e: ApiEnvelopeTapEvent) => void

export interface CreateApiClientOptions { onEnvelope?: ApiEnvelopeTap }
// createApiClient(fetchLike, options?: CreateApiClientOptions): ApiProxy
```

- 四支都要能取到 `rpcId` 与 payload（wire 单元自含）；`method` 在 client 调用点天然可知，tap 带上省得面板查 pending 表。`stream` 字段只住 server-request 支（SSE 承载信息）。
- **rpcId 归属**：client-request 的 rpcId 由 client mint，server-response 回显同 id；server-request 的 rpcId 由 server mint，client-response **回填同一 id、不 mint 新 id**——两族各自闭环，四象限在台账上完整可对账（§B.3 配对高亮）。
- **tap 时机**：client-request=wire 单元构造后 fetch 前；server-response=parse 成功后、业务结果返回调用方前；server-request=parse 后、业务帧 yield 前；client-response=respond 调用的 wire 单元构造后发出前。transport 异常（fetch throw、流断）**不经 tap**——那是 ConnectionController 的事（§A.3）。
- **v1 范围注记**：实际会产生 client-response 的只有审批/问答 respond（本里程碑 UI 不调用），实现可先留支不填——类型四支齐全，W3 接线时 respond 路径补 tap 即可。
- **tap 不得反噬业务**：client 侧对每次 `onEnvelope` 调用包 try/catch 吞异常。

**日志条目（web-runtime 自己的展示模型，不是契约类型）**：

```ts
export type RpcLogEntry =
  | { id: number; at: number; kind: 'client-request';  rpcId: string; method: string; payload: unknown }
  | { id: number; at: number; kind: 'server-response'; rpcId: string; method: string; ok: boolean; errorCode: string | null; payload: unknown }
  | { id: number; at: number; kind: 'server-request';  rpcId: string; stream: 'mux' | 'host'; frameType: string; payload: unknown }
  | { id: number; at: number; kind: 'client-response'; rpcId: string; method: string; payload: unknown }
```

- `id`：模块级单调计数器（React key + unread 计数依据）；`at` = `Date.now()`（相对时间渲染在 §B 算）。
- `rpcId`：`String(wire 单元的 rpcId)`（brand 只在类型层，运行时就是 string；展示截断在 §B）。client-response 支存的是**回填的帧 rpcId**（与其应答的 server-request 同值——配对高亮的关联键）。
- `payload` 存**引用**不深拷贝不序列化：client-request→业务 payload、server-response→整个业务结果（RpcResponse 含 ok/error）、server-request→业务帧对象、client-response→respond 业务 payload（字段名按契约修订稿，映射在 toEntry 一处收口）；JSON.stringify 只在面板行展开时做（§B）。
- `ok`/`errorCode`/`frameType`：入表时反正规化（`result.ok`、`result.error.code`、`frame.type`），让行渲染不必探 payload。client-response 的 `method` = respond 方法名（`approval.respond`/`question.respond`），标注它属于哪个域。
- v1 范围：client-response 支入表路径随 tap 同步留空（§A.2 注记），类型先齐。

**微任务批量泵 + 环形截断（防 SSE 帧风暴逐帧 setState）**：

```ts
export const RPC_LOG_CAP = 500
let nextId = 1
let pendingBatch: RpcLogEntry[] = []
let flushScheduled = false

/** boot.ts 把它接到 onEnvelope（real 与 fixture 同一入口）。 */
export function tapToStore(e: ApiEnvelopeTapEvent): void {
  pendingBatch.push(toEntry(e))            // toEntry: 四支 tap 事件→四支条目的机械映射
  if (flushScheduled) return
  flushScheduled = true
  queueMicrotask(() => {
    flushScheduled = false
    const batch = pendingBatch
    pendingBatch = []
    store.setState((s) => {
      const merged = [...s.rpcLog.entries, ...batch]
      const dropped = Math.max(0, merged.length - RPC_LOG_CAP)
      return { rpcLog: {
        ...s.rpcLog,
        entries: dropped > 0 ? merged.slice(dropped) : merged,
        droppedCount: s.rpcLog.droppedCount + dropped,
        unread: s.ui.rpcLogOpen ? 0 : s.rpcLog.unread + batch.length,
      } }
    })
  })
}
```

- `paused` 不影响采集（只管 §B 自动跟随），所以泵里不看它。
- `clearRpcLog` intent（§A.4）要同时清 `pendingBatch`（防已排队批次在 clear 后复活）。

### §A.3 ConnectionController：生命周期（connection.ts；瘦身拍板后）

保留理由：两条流必须有人打开并 `for await` 迭代（AsyncIterable 拉模式，没人拉就没人读 socket、tap 也不触发），rpcLog 才有帧可看。但**其状态不进 store**（拍板）：phase/attempt/lastError 全部是类实例私有字段，将来 OOP 化（§A.1 注记）时它就是 `Connection` 对象的雏形。

```ts
export class ConnectionController {
  constructor(private api: ApiProxy) {}
  start(): void      // 幂等；进入连接循环
  stop(): void       // abort 当前代；循环退出
}
```

**退避参数（写死为模块常量，不做配置）**：

```ts
const BACKOFF_BASE_MS = 500
const BACKOFF_FACTOR = 2
const BACKOFF_MAX_MS = 10_000
// 第 n 次重试延迟：cap = min(BACKOFF_MAX_MS, BASE * FACTOR^(n-1))；
// 实际取 [cap/2, cap] 均匀随机（半区间 jitter，防多标签页齐步重连）。
// 无重试上限，断线永远在重试。
```

**一次连接尝试（attempt）的序列**：

1. 新建本代 `AbortController`（代号 = 模块级 generation 计数器自增；旧代残余任务的报错以代号比对丢弃——fencing）。
2. **先开两条流**：`api.events.mux({}, signal)` 与 `api.events.host({}, signal)`，各起一个 `for await` 消费任务（不 await 完成）。**两条流的循环体都为空**——帧在载体层已被 tap 进 rpcLog，本里程碑无任何 UI 消费业务帧；仅 `stream/error` 帧视同流故障（进入重连），其余含未知类型一律忽略（documented-default）。
3. **再发一条 unary**：`api.host.describe({})`（面板演示数据源，§A.4「pingHost」同一函数）。成败只影响日志台账与重连判定：`ok:false` 不判败（host 活着能回错误也是「通」）；fetch throw 判败 → 进入重连。
4. 常态驻留：流泵到 throw（断线）或 `stop()`。任一流 throw / 提前正常结束 → abort 本代（另一条流一并终止）、`console.warn` 一行、退避 sleep、回到 1。两条流同时炸只触发一次（generation fencing 天然去重）。

**连接状态投影（最窄）**：本里程碑砍掉左栏后没有任何组件展示连接态，**不设投影**。若 review 期要求面板标题栏带在线点，就地给一个 `connected: boolean` 进 UiSlice（`describe` 成功置 true、进入重连置 false），一行写入两行订阅——预留决策，不默认做。

**重连后的重建**：无跨代派生态可保留（store 无业务数据），重连 = 重跑序列 2–3，rpcLog 台账连续累积（不清空——断线前后的台账对照正是调试面板的价值）。契约 `host.describe` 无 host 实例标识的缺口（README 接缝 #1）在本收窄范围下影响进一步归零，仅留将来参考。

### §A.4 intent 函数集（intents.ts，完整清单；收窄后）

intent = runtime 导出的普通函数（非 hook 非类），内部调 ApiClient + 写 store；React 组件只准调这些函数，自己不碰 api/store 写入。模块顶部 `let api: ApiProxy`，由 `bindIntents(api)`（boot 专用，导出但仅 boot.ts 调）注入。intent 内只构造业务 payload 并调 ApiProxy 方法；rpcId 的 mint 与 wire 单元包装（契约修订稿的 RpcRequest 封装）由 client 封装层收口，intent 不感知。

| 函数 | 签名 | 行为 |
|---|---|---|
| `bindIntents` | `(api: ApiProxy) => void` | boot 注入 api 引用；重复调用覆盖（fixture/real 切换仅发生在 boot，运行中不换） |
| `openRpcLog` | `() => void` | `rpcLogOpen=true` 且 `rpcLog.unread=0`（展开即已读） |
| `closeRpcLog` | `() => void` | `rpcLogOpen=false` |
| `toggleRpcLog` | `() => void` | 按当前值分派上两者 |
| `setRpcLogPaused` | `(paused: boolean) => void` | 只写 `rpcLog.paused`（冻结面板自动跟随；采集不停，§A.2） |
| `clearRpcLog` | `() => void` | `entries=[]`、`droppedCount=0`、`unread=0`，并调 rpc-log.ts 导出的 `clearPending()`（清微任务批次，防清空后复活） |
| `pingHost` | `() => Promise<void>` | **面板演示数据源**：调 `api.host.describe({})`，结果不落任何 store——它的产出就是 rpcLog 里的一对 client-request/server-response。boot 序列自动调一次（§A.3 序列 3），面板工具行的「ping」dev 按钮手动再触发（§B.3） |

演示数据源拍板落地：boot 自动 describe 一次 **且** 面板留 ping 按钮——自动那次保证「打开页面即有台账」，按钮让演示者随时再造一对往返（同一个 `pingHost`，无第二实现）。左导航相关 intent（refreshSessions/createSession/selectSession/openSettings/toggleTheme）移至 §E（下一里程碑素材）；将来加 = 此表加行，模式不变。

### §A.5 fixture 模式（fixture.ts）：无 server 时 UI 可独立开发

两件套：**假 ApiProxy** + **假信封包装器**（让调试面板在 fixture 下也有台账可看）。

```ts
/** 内存假 host：3 个预置 session（只为让 host 流有 status 帧可翻转）。 */
export function createFixtureApi(): ApiProxy
```

- 预置数据：3 条内存 `SessionSummary`（id 为 `'fx-alpha' | 'fx-beta' | 'fx-gamma'` cast `SessionId`，`running` 分别 true/false/false）。收窄后没有列表 UI 消费它们，其唯一作用是给 host 流当翻转素材、给 `session.list`（若被调）当返回值。
- `host.describe` → `{ version: '0.0.0-fixture', cwd: '/tmp/fixture', attachedSessions: 1 }`（pingHost 的应答体，面板台账主角）。
- `sessions.list` → 内存表倒序；`create` → 新增并从 host 流吐 `session/added`；`history` → `{ events: [], hasMore: false }`；`prompt`/`cancel`/`approvals.respond`/`questions.respond` → `{ ok: true, value: { accepted: true } }` 空实现——本里程碑 UI 都不调，实现只为满足 ApiProxy 接口类型。
- `events.host` 流：打开后每 5s 随机挑一个 session 翻转 `running` 并吐 `host/session-status`（**面板滚动的周期素材**）；`signal` abort 时结束。
- `events.mux` 流：打开时对每个 running session 吐一条 `session/subscribed`（`lastSeq: 0`）然后静默挂起到 abort（形状最简、不伪造 SessionEvent）。

```ts
/** fixture 专用：real 模式的 wire 单元在载体层天然存在，fixture 直连 ApiProxy 没有，
 *  此包装器在 api 面上补造三种 tap 事件，喂同一个 tapToStore。 */
export function wrapApiWithFakeEnvelopes(api: ApiProxy, tap: ApiEnvelopeTap): ApiProxy
```

- unary 各方法包一层：mint 假 rpcId（`fx-rpc-<计数>` cast；契约修订稿的 `RpcId()` 构造函数可用就用真的）→ `tap({kind:'client-request', ...})` → await 原方法 → `tap({kind:'server-response', ..., method})` → 透传返回值。
- 两条流包一层：逐帧 mint 帧 rpcId、按 §A.2 形状补造 server-request 事件后 yield（帧 rpcId 本应由 server mint，fixture 里包装器就是「假 server」，语义自洽）。client-response 支 v1 无产生路径（§A.2 注记），fixture 不造。
- **升级路径**：W1（api 代码）+ W3（fetch 载体）落地后，fixture 可改走同构管道 `createApiClient(toFetchHandler(fixtureImpl).fetch, { onEnvelope })`——wire 单元由真载体层生成，本包装器整体删除。设计上 fixture.ts 与 boot.ts 之外无人知道包装器存在，删除零波及。

### §A.6 boot（boot.ts + apps/web 接线）

```ts
export interface BootWebRuntimeOptions {
  mode: 'real' | 'fixture'
}
export interface WebRuntimeHandle { stop(): void }

export function bootWebRuntime(options: BootWebRuntimeOptions): WebRuntimeHandle {
  const api = options.mode === 'fixture'
    ? wrapApiWithFakeEnvelopes(createFixtureApi(), tapToStore)
    : createApiClient((input, init) => globalThis.fetch(input, init), { onEnvelope: tapToStore })
  bindIntents(api)
  const controller = new ConnectionController(api)
  controller.start()   // 内部序列含首次 pingHost（§A.3/§A.4：面板演示数据源）
  return { stop: () => controller.stop() }
}
```

- real 模式 fetchLike 用箭头包装 `globalThis.fetch`（防 Illegal invocation）；wire 路径 `/api/*` 是相对路径，同源部署（dsc 同时服务静态与 API）下无需 baseUrl——step1 `Runtime.baseUrl` 概念删除。
- unary 超时（`AbortSignal.timeout`）是 W3 在 createApiClient 内部的职责（契约 §5 已定），本层不重复包。
- `index.ts` 出口：`bootWebRuntime`、`store`、`WebStore`/`RpcLogSlice`/`UiSlice`、`RpcLogEntry`、§A.4 表中全部 intent 函数。**不导出** ConnectionController / fixture 内部件（boot 是唯一组装点）。
- `apps/web/src/main.ts` 改写（step1 的 createRuntime/mount(el, runtime) 签名废弃）：

```ts
import { bootWebRuntime } from '@deepseek-ai/dsh-web-runtime'
import { mount } from '@deepseek-ai/dsh-web-ui'

const el = document.getElementById('root')
if (el === null) throw new Error('missing #root')
bootWebRuntime({ mode: new URLSearchParams(location.search).has('fixture') ? 'fixture' : 'real' })
mount(el)   // mount 不再收 runtime：组件直连 store 单例（§B）
```

fixture 开关 = URL query `?fixture`（无构建期开关，`pnpm --filter @deepseek-ai/dsc-web build` 一份产物两用；W5 开发期直接 vite 起 apps/web 加 `?fixture` 即可，不需要 host）。

---

## §B web-ui 组件层（收窄后：最简 App 壳 + RPC 调试面板，仅此）

### §B.0 文件全清单与包配置

```
packages/client/web-ui/src/
  index.tsx                      ← mount(el)：createRoot(el).render(<App />)（不再收 runtime 参数）
  use-web.ts                     ← 订阅 hook（§B.1）
  utils/formatRelative.ts        ← formatRelative(now, at): string（§B.3 时间列；纯函数工具一律住 utils/，不散落组件文件内）
  css-modules.d.ts               ← declare module '*.module.css' { const c: Record<string,string>; export default c }
  style/global.css               ← reset + :root 亮色 CSS 变量（§B.5）+ body 字体；index.tsx 顶部 import
  App.tsx / App.module.css       ← 最简壳（§B.2）
  components/
    panels/                      ← panel 概念的可扩展位：将来 Settings、诊断等各占一个子目录
      RpcLog/RpcLog.tsx + RpcLog.module.css  ← 浮动壳：open ? <RpcLogBody/> : <RpcLogBadge/>
      RpcLog/RpcLogBadge.tsx                 ← 折叠角标（未读徽标）
      RpcLog/RpcLogBody.tsx                  ← 展开浮层（工具行+滚动列表+自动跟随）
      RpcLog/LogRow.tsx                      ← 单条台账行；props { entry: RpcLogEntry; now: number; paired: boolean; onHover(rpcId: string | null): void }；React.memo
      RpcLog/PayloadJson.tsx                 ← 展开的完整 JSON；props { payload: unknown }
```

- **utils/ 归属定在 web-ui 而非 web-runtime**：`formatRelative` 唯一消费方是渲染层（LogRow 时间列），runtime 不做任何展示格式化——按消费方就近。将来 runtime 层出现自己的纯工具（如退避计算抽函数）同理在 web-runtime 建 utils/，两包各自就近、不共享工具包。
- （Sidebar/ 与 Main/ 组件族已随范围收窄移出本里程碑，设计素材保留在 §E。）

deepseekchat 习惯对齐：每组件一目录、`Foo.tsx + Foo.module.css` 同名同目录、clsx 拼类名；偏离项：不用 typed-css-modules 生成 `.css.d.ts`（门禁跳过期用 `css-modules.d.ts` 一张全局声明顶替，类名无编译期校验，接受）。

`packages/client/web-ui/package.json` dependencies 增量（react/react-dom/@types 已有）：

```json
    "@deepseek-ai/dsh-web-runtime": "workspace:^",   // 已有（step1）
    "clsx": "^2.0.0",
    "zustand": "~4.4.7"
```

apps/web 增量：`devDependencies` 加 `"postcss-nested": "^6.0.0"`，包根新建 `postcss.config.cjs`：

```js
module.exports = { plugins: { 'postcss-nested': {} } }
```

（vite 内建 CSS Modules + postcss 装载，无需改 vite.config.ts；PostCSS 面上只要 nested——custom-media/autoprefixer 等 deepseekchat 全家桶暂不引，本里程碑用不上。）

### §B.1 订阅 hook 与订阅纪律（use-web.ts）

```ts
import { useStore } from 'zustand'
import { shallow } from 'zustand/shallow'
import { store, type WebStore } from '@deepseek-ai/dsh-web-runtime'

/** 唯一订阅入口：绑定 runtime 的 store 单例。zustand ~4.4 的三参 useStore 支持 equalityFn。 */
export function useWeb<T>(selector: (s: WebStore) => T, equalityFn?: (a: T, b: T) => boolean): T {
  return useStore(store, selector, equalityFn)
}
export { shallow }
```

纪律：组件**只准**经 `useWeb` 读 store、经 web-runtime 导出的 intent 函数写（事件处理器里直接调用）；不准 `store.setState` / `store.getState`（例外：无。渲染取值一律走 hook 保证订阅）。selector 返回派生对象/数组时必须配 `shallow`；返回原始值或 store 内既有引用则不用。

### §B.2 App 最简壳

**App.tsx**：无订阅，纯结构——能挂面板即可。

```tsx
<div className={css.app}>
  <main className={css.blank}>
    <h1>dsc web</h1>
    <p>RPC debug milestone</p>
  </main>
  <RpcLog />
</div>
```

**App.module.css 要点**：

```css
.app {
  height: 100vh;
  background: var(--color-bg);
  color: var(--color-text);
}
.blank {
  height: 100%;
  display: grid;
  place-items: center;
  text-align: center;
  color: var(--color-text-secondary);
}
```

（左栏网格、Sidebar 三段式、MainArea 三分支的设计素材见 §E.2——本里程碑不建这些文件。）

### §B.3 RPC 调试面板：完整交互规格（RpcLog/）

**形态（已拍板：强浮动，readonly 纯观察）**：不占布局流。RpcLog.tsx 只做分支：

```tsx
export function RpcLog() {
  const open = useWeb((s) => s.ui.rpcLogOpen)
  return open ? <RpcLogBody /> : <RpcLogBadge />
}
```

**定位与 z-index（RpcLog.module.css）**：

```css
.badge {  /* 折叠角标 */
  position: fixed; right: 16px; bottom: 16px; z-index: 100;
  /* 圆角胶囊按钮：「RPC」字样 + 未读徽标 */
}
.panel {  /* 展开浮层，盖在内容之上 */
  position: fixed; right: 16px; bottom: 16px; z-index: 100;
  width: min(560px, calc(100vw - 32px));
  height: min(420px, calc(100vh - 32px));
  display: flex; flex-direction: column;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: var(--shadow-panel);
}
```

z-index 全应用只此一层浮动物，100 即可；无 backdrop、无 focus trap（不是 modal，点外部不关闭）。

**RpcLogBadge（折叠态）**：胶囊按钮，`onClick={openRpcLog}`。内容 = `RPC` 字样 + 未读徽标（`unread > 0` 时显示红底白字小圆，`unread > 99` 显示 `99+`）。订阅只有 `s.rpcLog.unread`。

**RpcLogBody（展开态）**：纵向三段。

1. **工具行**（固定高）：左 = 标题「RPC」+ 灰字统计 `{entries.length} 条`（`droppedCount > 0` 时追加 `· 已丢弃 {droppedCount}`）；右 = 四按钮：
   - ping：`onClick={() => void pingHost()}`（dev 演示按钮：手动造一对 describe 往返进台账，§A.4；面板唯一会发 RPC 的控件，发的是只读快照查询，不破 readonly 语义）。
   - 暂停/继续：`onClick={() => setRpcLogPaused(!paused)}`；paused 时按钮高亮且列表顶部出现细条提示「已暂停跟随」。
   - 清空：`onClick={clearRpcLog}`（只写本地日志态，不发任何 RPC）。
   - 关闭 ×：`onClick={closeRpcLog}`。
2. **滚动列表**（`flex: 1; overflow-y: auto; font-family: var(--font-mono); font-size: 12px`）：`entries.map(e => <LogRow key={e.id} entry={e} />)`。
3. 无第三段（无输入区——readonly）。

**LogRow 行结构（单行网格：方向 | 标签 | rpcId | 相对时间）**——方向列直接可视化四象限模型：

| 列 | 内容 |
|---|---|
| 方向 | `client-request`→`→`（accent 色）；`server-response`→`←`（ok 绿 / !ok 红）；`server-request`→`⇐`（mux 紫 / host 蓝——server 发起进站）；`client-response`→`⇒`（accent 色空心/淡化变体——client 应答出站，与 `→` 同向不同族） |
| 标签 | client-request / server-response / client-response→`method`（server-response 且 !ok 时追加红字 `errorCode`）；server-request→`frameType` |
| rpcId | `slice(0, 8)`，`title` 属性挂全值，灰色 |
| 时间 | `formatRelative(now, entry.at)`：`<10s`→「刚刚」、`<60s`→「Ns 前」、`<60min`→「Nmin 前」、否则本地 `HH:MM:SS`。`now` 来自 RpcLogBody 一个 30s `setInterval` 的 state tick（只在面板展开时运行，卸载即清） |

- **同 rpcId 配对高亮（按族）**——四象限有两个配对族：**client-request ↔ server-response**（client mint 的 id 闭环）与 **server-request ↔ client-response**(server mint、respond 回填的 id 闭环）。RpcLogBody 持 `hoveredRpcId` state（`useState<string | null>`），LogRow 鼠标进出上报；高亮条件 = `entry.rpcId === hoveredRpcId` **且与 hover 行同族**（族判定：kind ∈ {client-request, server-response} 为一族，kind ∈ {server-request, client-response} 为另一族——两族 id 由不同方 mint、空间独立，理论无碰撞，同族约束让语义显式）。命中行加浅 accent 底色类。一个 state 一个类名，不做连线等重装饰；hover 一条 requested 帧看到它的 respond 应答同亮，正是四象限模型的核心演示价值。
- 行 `onClick` 翻转本行展开态（`useState<boolean>` 在 LogRow 内部——展开态是纯视图态，不进 store；折叠面板/清空自然重置）。
- **展开区（PayloadJson）**：`JSON.stringify(payload, null, 2)` 在 `useMemo` 内计算，`<pre>` 渲染，`max-height: 200px; overflow: auto`。**大 payload 截断**：字符串化结果 `> 20_000` 字符时只渲前 20_000 + 尾行「… 已截断，共 {N} 字符」（不做「点开完整」二级展开——行内已给全量滚动区，截断只防单帧几 MB 卡死渲染；stringify 对 BigInt/循环引用 throw 时 catch 后渲 `String(payload)`）。
- `LogRow` 用 `React.memo` 包裹：entries 数组每批追加都换引用（list re-render），但旧行的 `entry` 对象引用不变，memo 让旧行跳过重渲（时间列相对性由 tick 驱动 RpcLogBody 重渲、传 `now` prop 给行——`now` 变化时行会重渲，接受：30s 一次、可视行数有限）。

**自动跟随（跟随最新，可暂停）**：

- RpcLogBody 持 `listRef`；`useEffect` 依赖 `[entries, paused]`：`!paused` 时 `listRef.current.scrollTop = scrollHeight`（无平滑动画，日志面板要快）。
- **手动上滚即暂停**：列表 `onScroll` 中，若 `!paused` 且滚离底部超过 24px（`scrollHeight - scrollTop - clientHeight > 24`）→ `setRpcLogPaused(true)`。程序化滚动本身触发的 onScroll 事件因距底 0px 不满足阈值，天然不误触发。「继续」按钮解除并立即滚底。
- 面板展开瞬间（RpcLogBody mount 的 `useEffect([])`）滚到底一次。

**性能边界（写给实现者的红线）**：500 条 cap（§A.2）+ 行内 memo + JSON 只在点开时 stringify + 微任务批量泵——四道闸后，帧风暴下面板的每秒 setState 次数 ≈ 事件循环微任务批次数，列表 DOM ≤ 500 行，无虚拟滚动的必要；**不要**引 react-window 等虚拟列表依赖。

### §B.4 selector 订阅表（re-render 边界，逐组件；收窄后）

| 组件 | 订阅 | equalityFn | 重渲当且仅当 |
|---|---|---|---|
| App | 无 | — | 从不 |
| RpcLog | `s.ui.rpcLogOpen` | 默认 | 开合 |
| RpcLogBadge | `s.rpcLog.unread` | 默认 | 未读数变 |
| RpcLogBody | `s.rpcLog`（整切片：entries/paused/droppedCount 全用） | 默认 | 日志批次到达 / 暂停翻转 / 清空 |
| LogRow | 无订阅（props: entry/now/paired/onHover；React.memo） | — | 自身展开态、`now` tick、`paired` 翻转、entry 引用变（不会发生——条目不可变）。`onHover` 用 `useCallback` 稳定引用，否则 memo 失效 |

设计原则（供 review 对照）：**列表壳订数组、行吃引用稳定性**——entries 每批追加换数组引用（壳重渲做 map），旧行 entry 引用不变靠 memo 跳过；hover 配对高亮只翻转受影响行的 `paired` prop（其余行 memo 命中）。（左导航组件族的订阅表随素材移至 §E.2。）

### §B.5 CSS 变量表（style/global.css；收窄后只落 `:root` 亮色）

主题切换随左导航移出本里程碑（§A.1 拍板注记）：本里程碑 global.css **只写 `:root` 亮色实值**，不写 `[data-theme='dark']` 块、不设切换按钮；双主题架构（dark 占位块 + 名集一致纪律 + toggleTheme 接线）整套素材在 §E.4，下一里程碑原样接入，变量名从现在起就按双主题口径起名（无「light」前缀之类的单主题假设）。

```css
:root {
  /* 表面 */
  --color-bg: #ffffff;             /* 页面底 */
  --color-bg-elevated: #ffffff;    /* 浮层底（调试面板） */
  --color-hover: #ececee;          /* hover 面 */
  --color-border: #e2e2e6;
  /* 文字 */
  --color-text: #1a1a1e;
  --color-text-secondary: #8a8a93;
  /* 强调（deepseek 蓝系近似值，无品牌规范包袱） */
  --color-accent: #4d6bfe;
  --color-accent-soft: #e8edff;    /* 配对高亮底（§B.3） */
  /* 语义 */
  --color-ok: #22a06b;             /* response ok 方向符 */
  --color-error: #d63841;          /* response !ok / 未读徽标底 */
  /* 调试面板方向色 */
  --color-frame-mux: #8250df;
  --color-frame-host: #0969da;
  /* 杂项 */
  --shadow-panel: 0 8px 24px rgba(0, 0, 0, 0.12);
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
```

global.css 另含：`* { box-sizing: border-box }`、`body { margin: 0; font-family: system-ui 栈; background: var(--color-bg); color: var(--color-text) }`、`button` reset（继承字体、无默认边框底色）。

---

## §C 对齐纪律（web-ui ↔ web-runtime ↔ 契约）

1. **类型引用方向单向**：web-ui 只准 import `@deepseek-ai/dsh-web-runtime`（`WebStore`/`RpcLogSlice`/`UiSlice`、`RpcLogEntry`、intent 函数、`store` 单例）。web-ui **禁止**直接 import `@deepseek-ai/dsh-apiproxy` 任何路径——契约类型到 UI 必须经 §A 转译（UI 不认识契约 wire 单元类型，只认识 `RpcLogEntry`）。
2. **契约类型只从 api/ 进**：web-runtime 中一切契约类型 `import type` 自 `@deepseek-ai/dsh-apiproxy/src/api/index.ts`；运行时值仅 `createApiClient`（fetch/client.ts）与 `RpcId()`（api/rpc.ts）两个（§A.0）。不准从 impl/ import 任何东西。契约具体类型名以 apiproxy-design 的**修订稿**（严格双向 RPC 版）为准，本文弱引用处（§A.2）实现时对照落名。
3. **两处不一致以 §A 为准**：§B 提到的任何 store 字段/intent 名以 §A.1/§A.4 定义为权威；若实现中发现 §B 引用了 §A 没有的字段，按 §A 改 §B 侧用法并回报设计 owner，不准擅自往 store 加字段。
4. **与契约的不一致同理升级**：若 W1 落地的真实契约代码与本文引用的类型名/形状冲突，以契约修订稿为准修正本文；发现文档层面缺口走 README「接缝问题」上报，不擅改契约。
5. **写路径唯一**：store 写入只发生在 web-runtime（intents/rpc-log 泵）；web-ui 零 `setState`。新交互 = 先在 §A.4 表加 intent，再在组件接线。
6. **fixture 与 real 的行为等价面**：UI 代码不感知 mode（没有 `if (fixture)`）；两模式差异全部收在 boot.ts 的 api 装配一处（§A.6）。
7. **store 无业务对象红线**（22:0x 拍板）：任何人往 store 加 session/connection 业务数据切片都是设计违例——那类数据走 §A.1「数据对象演进方向」的 OOP 路线，先找设计 owner 定型。

## §D 验收清单（浏览器手工，配合 W1–W3 完成度分级；面板口径）

| # | 前置 | 步骤 | 期望 |
|---|---|---|---|
| 1 | 仅 W4/W5 落码（无 server） | vite dev 起 apps/web，开 `?fixture` | 页面见「dsc web」占位 + 右下角 RPC 角标；未读数含 boot 自动 ping 的一对往返 + subscribed/status 帧，且随 5s 周期帧增长 |
| 2 | 同上 | 点角标展开面板 | 台账见：两条流打开后的帧（subscribed×running 数 + 周期 status）+ `host.describe` 往返一对；未读清零 |
| 3 | 同上 | 点「ping」 | 新增一对 client-request/server-response（method=host.describe，方向符 →/←）；hover 任一行时同 rpcId 同族的配对行同步高亮 |
| 4 | 同上 | 点任意行 | JSON payload 展开；再点收起 |
| 5 | 同上 | 上滚列表 | 自动跟随暂停（按钮态同步）；点「继续」回到底部跟随 |
| 6 | 同上 | 点「清空」 | 列表空、统计归零；周期新帧继续进入 |
| 7 | W1+W2+W3+dsc 接线全通 | `pnpm run demo:web` 起真 host，浏览器开首页（无 `?fixture`） | 面板见真 RPC 台账：mux/host 两流开流帧 + describe 往返滚动 |
| 8 | 同上 | kill dsc 再重启 | 台账停止增长后恢复增长（重连重开流的新一轮帧进入；台账不清空，断线前后连续可对照） |

---

## §E 下一里程碑素材（22:0x 范围收窄拍板降级；保留不删，非本里程碑交付物）

以下内容是 v1 稿为「布局分区」写的设计，随「只做 RPC 面板」拍板整体移出交付范围。下一里程碑启用前需先按届时的 OOP 数据对象定型（§A.1 注记）改写数据来源——**组件结构/CSS 可直接复用，selector/数据源部分肯定要改**（v1 稿假设 sessions/connection 住 store，已被推翻）。

### §E.1 移出的 store 切片与 intents（v1 原案，仅供参考，数据源待 OOP 定型重写）

- ConnectionSlice（phase/attempt/lastError/host 快照）、SessionsSlice（ids + byId + listLoaded/listError）、DraftSlice、UiSlice 的 view（blank/session/settings 三分支）与 theme —— OOP 化后这些以对象 + 窄投影/useSyncExternalStore 供给，不再是切片。
- intents：refreshSessions（单飞合流 + 收尾核对选中）、createSession（create→刷新→选中）、selectSession、openSettings、toggleTheme（唯一 DOM 触点 `data-theme`）。

### §E.2 移出的组件族（组件结构与 CSS 要点可复用）

- 布局：App 改 grid 两列 `var(--sidebar-width) minmax(0, 1fr)`、高 100vh。
- Sidebar 三段式：品牌行（dsc 字标 + ConnectionBadge 状态点：online 绿/connecting 黄/reconnecting 黄闪 + 次数）｜SessionList（`flex:1; min-height:0; overflow-y:auto` 唯一滚动区；标题行右侧「+」新建；载入/错误/空三态）｜SidebarFooter（Settings 入口 + 主题切换钮，横排两半，border-top）。
- SessionListItem 两行布局：mono 截断 id + running 绿点｜cwd 次要色 ellipsis；选中态 `--color-accent-soft`、hover `--color-hover`。
- MainArea 按 view 三分支居中占位（blank 渲 host 快照小字/session 占位/settings 占位）。
- 订阅纪律要点（届时按新数据源重写）：列表壳只订 id 数组、行订 byId 单条——running 翻转只重渲该行。

### §E.3 移出的验收项：左栏列表三态、新建即选中、Settings 切换、主题翻转（v1 §D 1/6/7 项）。

### §E.4 双主题接入包（架构已定、亮色先行的原拍板在收窄后顺延至此）

- `[data-theme='dark']` 占位块（值粗糙可用）：bg #1e1f24 / bg-elevated #26272e / hover #2e2f36 / border #3a3b42 / text #e6e6ea / secondary #8a8a93 / accent #6b84ff / accent-soft #2b3560 / ok #3fb884 / error #e05c66 / frame-mux #a37cf0 / frame-host #539bf5 / shadow-panel 0 8px 24px rgba(0,0,0,.5)；另补 sidebar 底色变量（亮 #f7f7f8 / 暗 #17181c）与 warn 色（#e8a13c 双主题同值）。
- 纪律：dark 块与 `:root` **主题变量名集完全一致**（缺名静默漏亮色值，坏得无声）；`--font-mono`/`--sidebar-width` 等主题无关变量只在 `:root` 声明，两块各加一行注释标注边界。
- 接线：toggleTheme intent 写 `<html data-theme>`，boot 用同一 `applyTheme` helper 设初值；切换按钮保留可点不藏不禁用（用户明示，暗色难看也放着）。

---

## 附：与既有拍板的对照索引（review 用，不新增决策）

- 强浮动/readonly/环形 500/暂停+清空 —— step2 README「UI 六问」Q2/Q5 + 任务书。
- **只做 RPC 面板、store 瘦身（无业务对象、OOP 演进）—— 2026-07-19 22:0x 两条拍板（经 team-lead 转达），覆盖六问中 Q1/Q3/Q4 的本里程碑执行（素材降级 §E）。**
- **严格双向 RPC（签名收 RpcRequest 封装、帧=server request、respond 回填 rpcId）—— 22:0x 契约变更（apiproxy-design 修订中），本文以弱引用消费（§A.2）。**
- CSS Modules + PostCSS + clsx 无组件库 —— Q6（deepseekchat 基线文档）。
- React 不碰流/不发请求、intent 普通函数、useStore 直连无 bridge —— step2 README「已定 React 架构」。
- onEnvelope 咽喉 tap、契约零污染 —— 同上。
