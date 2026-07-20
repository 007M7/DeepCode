# dsh Web 插件体系 RFC——走读版【过程档，已废止】

> **本文是 2026-07-21 讨论期的中间态存档，不是现行契约。** 现行权威=[api-contracts.md](api-contracts.md) v3（接口）+ [dispatch.md](dispatch.md) v2（分派）+ [plugins.md](plugins.md)（业务）+ [architecture.md](architecture.md)（讲解）。本文含大量已被推翻的概念（信封协议 wire 层、通道三级分类学、defineProjection 投影注册表、scope 镜像事件等）——它们是**将来双半边插件/host 数据面立项时的设计输入**（walkthrough 封存价值所在），不是 P-I 实施依据。仍然有效的独有内容：§10 运行链路走查的频率表与 Profiler 验收计数（W5 验收时取用）。（本档内 serve()/ctx.router/投影等词汇均为讨论期旧称——一律以 v3 为准,不再逐处订正。）

## 0. 一图总览

```
┌─ Host 进程（现有运行时，基本不动）────────┐        ┌─ 浏览器 ─────────────────────────────────────┐
│ host cordis 树                            │        │ client cordis 树                              │
│  root                                     │        │  root ctx                                     │
│   ├─ agent scope ×N（dsh-scope 既有）      │        │   ├─ bootstrap（静态）: carrier+mux+loader     │
│   │   └─ 插件 node 半边（per-scope 实例）   │  既有   │   ├─ loader 拉起的 bundled 插件:               │
│   ├─ sessions/agents（既有权威+SessionLog）│  SSE   │   │    router/slots/i18n/theme/conversation/…  │
│   ├─ 通道路由（host 侧信封收发,新增薄层）    │  +POST │   ├─ session scope ×M（mintScope,观看驱动）     │
│   └─ WebServer: SSE/POST+bundle 分发(既有) │◀──────▶│   │    ├─ session service（框架唯一 scope 件）   │
│                                           │  信封   │   │    ├─ 投影 ×若干（owner 插件声明）           │
│                                           │  帧    │   │    └─ per-session 插件实例（Fiber）×K        │
└───────────────────────────────────────────┘        │   └──────────── 唯一一座桥 ─────────────       │
                                                     │ React: SlotOutlet 注入 scoped ctx → 领域 hook   │
                                                     │        → 纯展示组件；Zustand=观看状态           │
                                                     └───────────────────────────────────────────────┘
```

总纲一句话：**cordis ctx 是一切运行时事实的宿主，React 是纯投影，Zustand 只管"怎么看"**。host 与 client 插件集不对等（谁声明谁存在），scope 结构对等（session 精度镜像）；peer 点对点整体暂缓（§9）。

## 1. 通信层：host 零改动，通道是 client 内部适配层

**wire = 现有 apiproxy 契约原样**（一字不动）：上行 sessions.list/create/history/prompt/cancel 等 RPC；下行 mux 流（session/event 透传 + subscribed(lastSeq) + approval/question 帧）与 host 流（session-added/removed/status）。既有的 `since`/lastSeq 重连语义就是 watermark 续传的现成实现。

**"通道"不是新 wire 格式，是 client 运行时内部的适配层**：client mux 消费上面两条既有流和既有 RPC，在内部整理成「按通道分发」的形态供投影订阅——

- **feed 通道（唯一特例，框架内建）**：session 事件流。init 原料=history RPC（分页即 loadOlder），续流=mux 的 session/event 帧，重连=mux(since) 既有语义。全系统独一份，插件永不声明这种形态。
- **状态通道（其余一切）**：init 原料=某个既有 RPC 的应答（如 list），增量=既有流帧（如 host 流的 status 翻转），重连=重拉快照。session 列表、approvals、config 全部如此。

epoch/watermark/快照重拉全是 client mux 内政；插件作者的心智模型一句话：「重连后我会重新拿到一份快照」。（原信封 wire 格式与"三级分类学"降为将来插件私有通道立项时的设计输入——那时才需要动 host，见 §9。）

## 2. scope 镜像：session 精度，cordis 原生架构

**client 的 session scope 就是 host agent scope 那套 intercept 架构照搬**（dsh-scope mintScope：`ctx.plugin(no-op)` 得 Fiber 当载体 + `fiber.ctx.extend({[kScope]: key})` 打标；dispose scope = dispose Fiber）。没有平行的 scope 管理器，没有"fork 架构"这种额外概念——多实例 = 在不同 scope ctx 下多次 `ctx.plugin(clientHalf, config)`，每次一个标准 Fiber。

- **生命周期权威是"观看需求"，不是 host 镜像**：首次要看（router 选中 / sessions.get 解析）才惰性建 scope；host 的 scope 事件只是状态输入（live 可用 / 转 frozen）；关 tab/LRU 才拆。host scope 死 ≠ client scope 死（frozen 视窗还开着）。
- **两侧 session 同名不同范畴（公理）**：host session=过程（启动→事件流→结束，历史的作者）；client session=视窗（任意时刻连上/离开）：

```
cold ──attach──▶ backfilling（history 分页+快照）──▶ live（水位缝合续流）
                                                    └─ host 结束 ──▶ frozen（终局只读）
```

- history 不是第二条数据：同一条流的已固化前缀。翻页/缝合/冻结全在 client session service 内部，消费者不可见。
- **client 没有第二套 agents**：host 的 sessions/agents 是一实体两面（agents 按 sessionId 键控 1:1，= 活着的 sessions 子集）；client 侧这个二象性就是上面的状态机（cold=无 agent / live=有 / frozen=已终）。session→agent 解析（含 resume-on-prompt）是 host 权威；client 的 intent 只带 session scope key，永远不认识 agent。**v1 不做 agent 级隔离**：挂 agent 寿命的 host 插件，client 半边可能见 resume 前的 stale 状态——明知接受，台账（§11），启用方案已存档。

## 3. 页面形态与全体名册：service、插件、slot 树

**页面骨架**：Layout（壳）只有一个大框框，顶层两个坑——左 `sidebar`、右 `conversation`。

```
┌─ Layout（壳，非插件）─────────────────────────────┐
│ ┌─ sidebar 坑 ─┐ ┌─ conversation 坑 ─────────────┐ │
│ │ projects 区   │ │ conversation 插件占据:          │ │
│ │ (projects 插  │ │  ├─ 视图区（子坑: chat/甘特图…）  │ │
│ │  件注入)      │ │  ├─ statusline（子坑）           │ │
│ │ 其他区块…     │ │  └─ chat 输入框（骨架自有 UI）    │ │
│ └──────────────┘ └────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

**root services 名册**（bundled 插件提供，与第三方同权）：

| service | 定位 |
|---|---|
| `ctx.sessions` | 会话域：列表投影 + get(key)→scoped ctx + create()——明确要有 |
| `ctx.slots` | 统一 UI 注册表（含嵌套注册模型，见 §5） |
| `ctx.router` | 当前选中/导航命令（内部读写 Zustand） |
| `ctx.i18n` / `ctx.theme` | 简单做（纯字符串注册表）：i18n=locale×namespace 映射表注册，React 面=标准 Provider+useT 查表（locale 变化整树重渲染，低频可接受）；theme=token→值字典注册，应用=写 CSS variables 到 :root——**连 Provider 都不需要**，换肤是 DOM 级联，React 零渲染 |
| `ctx.conversation` | 对话域动作面（send/cancel） |
| ~~`ctx.projects`~~ | **不设**——projects 可从 sessions 算出（按 cwd 聚合），不值得一个 service；**projects 是插件不是 service**：声明自己的投影（从 sessions 列表投影派生）、往 sidebar 注入一块列表呈现 |

```
client cordis root ctx
 ├─ bootstrap（root 原生，静态写死）: carrier(SseHttp|InProcess) + mux + loader
 ├─ loader 拉起的 bundled 插件:
 │    slots / router / i18n / theme / sessions      ← service 提供者
 │    projects       sidebar 区块插件: sessions 派生投影 + 注入 sidebar
 │    conversation   对话区 owner: ctx.conversation + 骨架(输入框) + 子坑注册模型(views/statusline/…)
 │    chat-view      视图子插件: 经 conversation 的注册模型注入 chat 视图 + 再开 toolview 坑
 │    gantt-view     视图子插件: 同型
 ├─ 镜像驱动（运行时内部件，非 API）: 列表通道事件 → 惰性建/拆 session scope
 └─ session scope ×M（mintScope）
      ├─ session service   框架唯一的 scope 件: 事件 feed + attach/history/frozen 状态机
      ├─ 投影 ×若干         全部用户空间: owner 声明（defineProjection），框架只供机制
      └─ per-session 插件实例（Fiber）×K
```

**投影所有权**：框架只拥有 session service 的**事件 feed**（唯一原料）和 **defineProjection 机制**（按 handle 挂累加器：reduce 调度、raf 合批、快照结构共享、惰性/保温、随 scope dispose）。类型定义权与 reduce 实现权在声明者：conversation 投影归 conversation 插件、timeline 归甘特图插件（Traj import 同一 handle 共享，reduce 只跑一份）、swarm 投影归 swarm 插件。会话列表也不例外——root 列表通道上的一个投影（sessions 插件声明）。

## 4. 插件包形态与装载

一个 npm 包按需三入口（判据：有没有这一层的东西）：

| 入口 | 拥有什么 | conversation 实例 |
|---|---|---|
| `./shared` | **跨线契约**：一个 TS interface（方法签名即契约）+ 通道级别/绑定轴声明；zod 只做边界校验，藏在框架里 | `ConversationRpc` interface + `conversationChan` 一行声明 |
| `"."`(node) | **权威**：`implements ConversationRpc` 的实现类、快照供给 | send 受理→agent-loop、落 log（薄） |
| `./client` | **消费与呈现**：service、投影、领域 hook、slot 注册、组件 | ConversationService、conversationProj、useConversation、聊天视图 |

- client 半边 = 一个 cordis 插件 `apply(ctx)`，bundle 成单文件 dist.js（cordis external）；组件/字典都是 apply 里递给注册表的值。
- 装载链复用已验收基建：host 声明清单（config 同源、重启生效）→ client loader 按 ID 拉 bundle → 全局注册 → 点火 apply；类型宇宙隔离（client program 看不见 host 侧 interface merge）+ gate 脚本照旧。
- 纯 client 插件（主题/语言包/播放器）只有 `./client`；纯 host 插件只有 `"."`——三入口按需出现。

## 5. slot 系统：一个 slots service + SlotMap 声明合并 + inject 所有权链

注册 API 只有一个（`ctx.slots.register(key, Component, options?)`），类型与所有权靠两个既有机制拼出来——**SlotMap 声明合并**（本仓"typed events 用 declaration merging + merge-extensible maps"惯例的直接复用）+ **inject 依赖链**：

```ts
// ── slots 插件: 空表 + 泛型 register ──
export interface SlotMap {}          // 各 owner declare merge 进来; 值形状 = { kind; props }
class SlotsService {
  /** 注册物就是 React 组件函数本身: FC<SlotMap[K]['props']> 直接锁强类型——
   *  组件 props 与坑位契约不符 = 该实参位置编译错,无需间接层。
   *  list/keyed 的 key/order 走第三参 options（条件类型: keyed 必填 key,single 禁传）。
   *  未 define 的 key 运行期 fail loud。 */
  register<K extends keyof SlotMap & string>(
    key: K, component: FC<SlotMap[K]['props']>, options?: SlotOptions<SlotMap[K]>): () => void
  define<K extends keyof SlotMap & string>(key: K, spec: SlotSpec<SlotMap[K]>): () => void
}

// ── layout 插件: 挖顶层坑——declare 声明 + define 落账 ──
declare module '@deepseek-ai/dsh-client-slots' { interface SlotMap {
  sidebar:        { kind: 'list';   props: SidebarBlockProps }
  conversation:   { kind: 'single'; props: ConvRootProps }
} }
export default { inject: ['slots'], apply(ctx) {
  ctx.slots.define('sidebar', { kind: 'list' })
  ctx.slots.define('conversation', { kind: 'single' })
  // Layout 组件里: <SlotOutlet slot="sidebar"/> / <SlotOutlet slot="conversation"/>
} }

// ── conversation 插件: inject [slots, layout] → 注册进 layout 的坑 + 挖自己的子坑 ──
declare module '@deepseek-ai/dsh-client-slots' { interface SlotMap {
  'conversation.views':      { kind: 'list';  props: ConvViewProps }
  'conversation.statusline': { kind: 'list';  props: StatusItemProps }
} }
export default { inject: ['slots', 'layout'], apply(ctx) {
  ctx.slots.register('conversation', ConversationRoot)   // ← 组件函数直接上: FC<ConvRootProps> 编译期锁
  ctx.slots.define('conversation.views', { kind: 'list' })
  ctx.slots.define('conversation.statusline', { kind: 'list' })
  // 骨架组件里: 输入框(自有 UI) + <SlotOutlet slot="conversation.views"/> + …
} }

// ── chat 插件: inject [slots, conversation] → 注册进 conversation 的坑 + 再挖 toolview ──
declare module '@deepseek-ai/dsh-client-slots' { interface SlotMap {
  'conversation.chat.toolview': { kind: 'keyed'; props: ToolViewProps }
} }
export default { inject: ['slots', 'conversation'], apply(ctx) {
  ctx.slots.register('conversation.views', ChatView, { key: 'chat', label: '聊天', order: 0 })
  ctx.slots.define('conversation.chat.toolview', { kind: 'keyed' })
} }

// swarm 插件: inject ['slots', 'chatView']
ctx.slots.register('conversation.chat.toolview', SwarmCard, { key: 'agent_swarm' })
//   SwarmCard: FC<ToolViewProps> 不符 ⇒ 这一行编译错
```

四个机制各司其职，全是既有 cordis 语义：

- **类型**：SlotMap 声明合并给 register 一轮完整类型推断——key 打错=不在 keyof SlotMap；entry 不符=props/kind 推断报错；single 传 key、keyed 漏 key 由 `SlotEntry<SlotMap[K]>` 条件类型锁。
- **所有权**：谁 declare+define 谁是 owner；**inject 链即所有权链**——chat 要注册 `conversation.views` 就必须 `inject: ['conversation']`，没 inject 到 owner 的 service（也就拿不到它 declare 的类型语境），装配期 fail loud。
- **生命周期**：inject 的原生语义顺便解决级联——conversation 卸载 → 依赖它的 chat 的 Fiber 停 → chat 的注册随 disposer 自动收走，无需手工级联清理。
- **运行期对账**：register 到未 define 的 key = fail loud（防止只 declare 类型不落账的漂移；define 返回 disposer，坑随 owner 卸载消失）。

**slot props 里可以流什么（数据流裁决）**——SlotMap['props'] 是跨插件 ABI，允许的内容收窄为四类，其余禁止：

| 允许 | 例 | 理由 |
|---|---|---|
| branded 身份 | sessionId / callId / toolName | 组件当 key/调试/跳转锚点用；hooks 取数的定位由树位置负责，不靠它 |
| 纯展示参数 | variant / density / label | owner 的排版决定，纯 JSON |
| **owner 已物化的不可变快照切片** | chat-view 把 conversation 投影里的 tool-call block 递给工具卡 | owner 渲染列表本来就持有这块数据；投影快照不可变+结构共享，memo 天然生效；且该数据变化时 owner 反正要重渲染这条目 |
| 罕见的纯 UI 协调回调（引用稳定） | onRequestClose 这类与 owner 骨架的视图协调 | 领域动作不许走 props——那是 service/action 的事 |

**禁止**：class 实例/活对象（Session、service）、Zustand store、ctx、任何可订阅源。判据一句话：**props 传"定位你的那份已物化数据"，不传"你自主需要的数据"**——后者走 hooks（useWatch 投影/自家通道）。反例即事故：owner 专为子组件去订阅一份自己不用的数据再灌 props = owner 变数据泵，失效半径爆炸（§8 的窄失效模型全毁）。swarm 卡是标准双通道样本：props 收 tool-call block（位置+基础数据），进度条自己 useWatch swarm 投影（插件私有活数据）。

渲染侧同样吃到 SlotMap 的强类型：`<SlotOutlet slot={key} props={…}/>` 是泛型组件——`slot` 限定 `keyof SlotMap`，**`props` 位要求恰好是 `SlotMap[K]['props']`**（owner 骨架给子坑喂参数少字段/错类型=JSX 处编译错），keyed 坑还要求传 `entryKey` 选择实例。即 renderChildren/renderSlots 这个动作两头都被锁死：注册方的组件签名（register 第二参）和渲染方的供参（outlet props 位）来自同一个 SlotMap 条目，改契约必两侧同时报错。outlet 统一做 ErrorBoundary + scoped ctx 注入（§7）+ 身份 props。输入框、视图切换器是 conversation 骨架自有 UI，不开坑——要替换整个对话架构=往顶层 `conversation`（single 坑）注册别的根组件。

## 6. 消费栈四层（本轮定稿的核心）

```
组件（纯 props，消费领域 hook）                ← 展示面，耗材
  ↑ 领域 hook（owner 写: useConversation）     ← React 缝，框架原语拼装
ctx service（cordis 本义: ctx.conversation.send）← 插件间 API 面（apply 世界）
  ↑ service 实现内部
wire 声明（./shared zod）                      ← 只在跨线边界出现一次
```

**service 是插件间 API**（declaration merging + provide/inject，cordis 正统）；跨线契约是 **TS interface**——wire 声明退到一行，zod 校验藏进框架。**service 是 root 单例、scope 敏感**——per-session 感来自 caller ctx 的 scope 标，不是每 session 一个实例。完整链路：

```ts
// ── ./shared: 跨线契约 = 普通 TS interface（方法签名即契约）──
export interface ConversationRpc {
  send(text: string, mode: 'queue' | 'steer'): Promise<{ accepted: true }>
  cancel(): Promise<{ accepted: true }>
}
// 一行通道声明: 名字+级别+绑定轴。schema 从 interface 推导边界校验所需的部分,
// 由构建期生成或框架运行时反射——插件作者不手写 zod（复杂载荷才补 schema 覆盖）
export const conversationChan = channel<ConversationRpc>('conversation', { level: 'log', scope: 'session' })

// ── "."(node): 权威实现 = implements,普通 TS 类 ──
class ConversationHost implements ConversationRpc {
  async send(text, mode) { /* agentFor(sessionId) → agent.send/steer → 落 log */ }
  async cancel() { … }
}
export default function apply(ctx: Context) {
  ctx.effect(() => conversationChan.serve(ctx, new ConversationHost(ctx)))
  // serve 缺方法/签名不符 ⇒ 编译错（implements 直接锁）
}

// ── ./client apply: service 内部就是"经通道调对岸的同名方法" ──
declare module 'cordis' { interface Context { conversation: ConversationService } }
export default function clientApply(ctx: Context) { ctx.provide('conversation', new ConversationService(ctx)) }

class ConversationService {
  private rpc = conversationChan.remote(this.ctx)   // ConversationRpc 的类型化代理: rpc.send(...) 即发帧
  // ctx proxy: 方法被调用时拿到 caller 自己的 ctx（host scoped 路由同机制）
  async send(text: string, mode: 'queue' | 'steer') {
    const key = scopeOf(this.ctx)                   // caller 的 scope 标（extend 链继承）
    if (key === undefined) throw new Error('requires a session scope')
    await this.rpc.send(text, mode)                 // scope 由 remote(ctx) 绑定,信封框架填
  }
}

// ── 别的插件调用（apply 侧）──
// per-session 实例里: 零动作拿到——extend 链共享 registry，root service 子 scope 直接可见
ctx.conversation.send('hi', 'queue')                    // scope 自动=本 session
// root 里定向: get(key) 返回该 session 的 scoped ctx（真 Context，service 可见且 scopeOf=key）
ctx.sessions.get(key)?.conversation.send('hello', 'queue')  // 用完即弃，不长期持有

// ── React 面见 §7: 组件不 import 框架,一切经 SlotOutlet 注入 props ──
```

写作面自查：shared=一个 interface+一行 channel；node=一个 implements 类+一行 serve；client=一个 service 类+slot 注册。**通篇没有 builder 链、没有手写 zod**——声明式仅剩"名字+绑定轴"，其余全是普通 TS（RPC 类型自动化=通道层实现细节，用户自理）。

## 7. React 面：完全外部注入（D43 定稿）

**组件所需的一切经 props 注入；唯一铁律=注入物引用稳定（不引发多余 rerender）。** 组件文件对框架包零 import——纯值 + 注入的 hooks 全在 props 里，SlotMap 锁类型。三份文件的完整示例：

```ts
// ════ ./shared —— 跨线契约(与 React 无关) ════
export interface ConversationRpc {
  send(text: string, mode: 'queue' | 'steer'): Promise<{ accepted: true }>
  cancel(): Promise<{ accepted: true }>
}
export const conversationChan = channel<ConversationRpc>('conversation', { scope: 'session' })

// ════ ./client —— apply 世界: service + slot 声明(仍无 React 渲染逻辑) ════
// SlotMap 声明: props = 纯值 + 注入 hook 的签名,一处锁两侧
declare module '@deepseek-ai/dsh-client-slots' { interface SlotMap {
  'conversation.chat.toolview': { kind: 'keyed'; props: ToolViewProps }
} }
export interface ToolViewProps {
  callId: CallId                      // 身份(纯值)
  block: ToolCallBlock                // owner 已物化的 frozen 切片(纯值)
  useSession: UseSession              // 注入 hook: <S>(sel: (s: ConversationSnapshot) => S, eq?) => S
  useSwarm: UseWatch<SwarmProgress>   // 注入 hook: swarm service 的 store 订阅面
  actions: SwarmCardActions           // 注入动作: { pause(callId): Promise<void> } — 引用恒定
  t: Translate                        // 注入文案: t('swarm:pause')
}

export default { inject: ['slots', 'chatView', 'i18n'], apply(ctx: Context) {
  const store = createStore<Record<CallId, SwarmProgress>>({})   // 命令式更新,raf 合批+frozen 内置
  ctx.effect(() => swarmChan.onUpdate(u => store.update(d => { d[u.callId] = u })))

  // 注册时把"注入面"一次性构造并缓存——SlotOutlet 渲染时原样透传,per-(坑位×scope) 恒等引用:
  ctx.slots.register('conversation.chat.toolview', SwarmCard, {
    key: 'agent_swarm',
    inject: (scope) => ({                       // scope 建立时调一次,结果缓存(引用稳定的全部来源)
      useSession: scope.session.useSelector,    // Session 对象(Watchable)的 uSES 绑定,框架造好
      useSwarm:   store.useSelector,            // 自家 store 的订阅面,同型
      actions:    { pause: (id) => ctx.swarm.pause(id) },   // 包 service 方法,构造一次
      t:          ctx.i18n.bind('swarm'),
    }),
  })
} }

// ════ ./client 的 react 文件 —— 组件: 零框架 import,只认 props ════
export function SwarmCard({ callId, block, useSession, useSwarm, actions, t }: ToolViewProps) {
  const running  = useSession(s => s.runningCalls.some(c => c.callId === callId))  // 会话快照切片
  const progress = useSwarm(s => s[callId], shallowEqual)                          // 自家数据
  const [pause, pausing] = useInvoke(() => actions.pause(callId))                  // pending 包装(纯 React 工具)
  return (
    <Card title={block.args.title} live={running}>
      {progress && <Progress {...progress}/>}
      <button disabled={pausing} onClick={pause}>{t('pause')}</button>
    </Card>
  )
}
```

**为什么外部注入不引发 rerender**——三段保证，全在框架侧：
1. **Gate（框架内建，开发者不写）**：router.current → 常驻 Session 实例（同 id 恒同引用）→ Provider `key={sessionId}`。切 session=子树重挂（语义正确），不切=Provider 值恒等零刷新。
2. **注入面缓存**：`inject(scope)` 每个 (坑位×scope) 只调一次，结果对象冻结缓存；SlotOutlet 渲染时 `{...cached, ...ownerProps}`——hook/actions/t 的引用跨 render 恒定，memo/shallow 协议不破。
3. **hook 内部即 uSES**：`useSession`/`useSwarm` 就是「绑定了具体 Watchable 的 useSyncExternalStoreWithSelector」——重渲染只由 selector 结果变化驱动，与注入机制无关。

props 白名单（§5）补第五类：**框架注入的 hook/动作/文案函数（引用稳定）**。组件测试=直接传假 hooks（不搭 Provider 树）；包导出形态的 `useSession` 保留给领域 hook 内部组合用（两口同源）。

**幂等契约五条**（React 高性能红线，违者打回）：getSnapshot 纯读+引用稳定（并发渲染安全）；subscribe 引用稳定；selector 走 uSES 等值短路位；invoke 引用稳定、pending 不走组件 setState；render 体零副作用零解析。**禁止订阅结果拷进 state/store**。

## 8. React 与 Zustand 分工

**运行时事实的权威在 ctx，观看方式的权威在 Zustand**（世界 vs 相机）：

| 状态 | 归属 |
|---|---|
| session 列表/事件/连接态/插件状态 | ctx（hooks 直读，不落店） |
| 当前选中 session/tab、面板开合、布局 | Zustand |
| 主题/语言的**选择** | Zustand + persist |
| per-session 草稿 | Zustand keyed slice；scope dispose → prune（单向通知） |
| 悬停/瞬时态 | 组件 useState |

红线 14 升格：**store 无运行时事实副本**。插件读选中态经 router service、写经导航命令，永不直碰壳 store；插件内部私用 Zustand 是它 bundle 的私事。

## 9. peer 点对点——暂缓，预埋两处

peer 体系（ctx.peer/Gateway/双向调用/hold/绑定轴）本稿不设计；cordis-web 已验收资产封存待另稿。预埋：①通道谱系留"插件私有通道"位（peer 帧将来是其中一种）；②per-session 插件实例 ctx 是将来 scoped 对端挂点。在此之前，插件动作面 = 自己通道上的 intent/receipt（conversation 的 send 就是范例）——对"点按钮让 host 干活"够用。

## 9.5 数据流转全景：五段、三次形态转换、各段的相等性协议

下行全链（上行 intents 是镜像，略）：

```
SSE 帧(JSON 文本)
  │ ①解码转换: JSON.parse + zod 边界校验 + brand 化 → 类型化事件（唯一一次 parse）
  ▼
ChannelMux ──按 chan 分发,watermark/epoch 去重──▶ 通道事件流（不留状态,纯管道）
  │
  ▼
投影累加器（cordis scope 上,②唯一的"可变世界"）
  │  reduce: 事件 → 直接改可变 draft（这里是 immer/mutative 的正确落点——
  │  作者写 draft.turns[i].text += delta 的朴素代码,库负责产出结构共享的不可变快照）
  │  raf 合批: 攒够一帧才 finalize
  ▼ ③物化转换: draft → 不可变快照（结构共享: 没动的子树保留旧引用——这是下游一切 memo 的根基）
投影快照（frozen,引用即版本）
  │
  ▼
useWatch(handle, selector?)
  │  uSES: getSnapshot 返回当前快照引用
  │  selector 收窄: 相等性协议在这里——selector 结果默认 Object.is,
  │  选出对象/数组时声明 shallowEqual（框架内置,Zustand 同款语义）
  ▼
容器组件 re-render（仅当 selector 结果不等）
  │  props 组装: 快照切片原样透传（不 map/filter 出新引用!加工必须进 selector 或投影）
  ▼
纯展示组件: React.memo 默认 shallow props 比较——切片引用没换就整棵短路
  │
  ▼ DOM
```

**三次形态转换，一次不多**：①线上 JSON→类型化事件（边界，zod）；②事件→可变 draft（投影 reduce 内部）；③draft→不可变快照（finalize，结构共享）。除此之外任何"转换"都是嫌疑犯——组件里 map 一遍、容器里 filter 一遍，都是在制造新引用打穿 memo。

**各段的相等性协议一张表**：

| 边界 | 协议 | 说明 |
|---|---|---|
| mux 去重 | seq/epoch 数值比较 | 不看内容 |
| 投影 bump | 无比较——finalize 即新版本；等值短路可选（status 没变不 bump） | 快照引用=版本号 |
| useWatch 无 selector | Object.is(快照引用) | 结构共享保证"没变的投影"引用恒同 |
| useWatch selector | Object.is 默认,选对象声明 shallowEqual | 深比较禁止（有深比较需求=该在投影里物化一个切片） |
| React.memo | shallow props | props 白名单（§5）保证成员都是快照切片/标量/稳定引用,shallow 就够 |
| Zustand 侧 | 自家 selector+shallow,同款语义 | 两个世界一个心智模型 |

**immer/mutative 的定位**：只住在投影 reduce 内部（②→③），是实现细节不是 API——defineProjection 的契约是"produce 不可变快照"，用 immer、手写 spread 还是 mutative 由投影作者选；框架验收只断言两条：finalize 产物 frozen（dev 模式 Object.freeze）+ 未变子树引用相等（结构共享测试）。**zstandard 之类的压缩属于传输层 carrier 内部**（SSE 现状无压缩，将来载体议题一并考虑），与本数据流无关；Zustand 侧同款 selector+shallow 语义，两个世界一个心智模型。

## 10. 运行链路走查

### 10a. 发送 prompt（全链）

```
① InputBar(纯展示) onSend
② useConversation 的 ops.send → ctx.conversation.send(text,'queue')
③ service 读 scopeOf(ctx)=本 session key → intent 帧（HTTP 上行,rpcId client mint）
④ host 通道路由 → serve 实现 → agentFor(sessionId)（不活则 resume-on-prompt）→ agent.send/steer
⑤ user 事件落 SessionLog（权威产生）→ session 通道 event 帧（seq=N,SSE 下行）
⑥ mux 分发 → conversation 投影 reduce → raf bump → 聊天框出气泡
   status 投影 idle→running → 绿点/statusline/输入框锁 各渲染一次
```

**无乐观插入**：自己的消息也等 log 回声（画的必须是 log 里有的）；乐观 UI 只准表达"发送中"按钮态；失败=receipt 报错→恢复草稿+toast。多端/刷新/重放零特判。

### 10b. delta 风暴（流式 token）

```
网络帧(50~100/s) → 信封解码按 chan 分发 → 投影 reduce(O(delta) 进累加器)
                     ↓ raf 合批(≤60/s)   → bump 版本(结构共享快照)
                     ↓ uSES 唤醒仅订阅者  → React commit ≤1 次/帧
```

流式期间：只有正在流式的 turn 组件每帧渲染；历史 MessageItem memo 短路、列表容器/statusline/甘特图/其他 session **零渲染**；markdown 只重 parse 尾部未闭合块；滚动走 raf 不经 React state。turn 结束才固化累加器、status/timeline/usage 各 bump 一次。

### 10c. 多视图同订 / 刷新恢复 / cold session

- **多视图**：投影 per-scope 单例，视图是订阅者——第 N 个视图=一条订阅边，reduce 零增长；token 风暴只醒聊天，span 开合只醒甘特图。一致性边界=投影（内部原子，跨投影 ≤1 帧撕裂接受）。
- **刷新**：boot → attach 列表通道（B 级快照）→ router 恢复选中（Zustand persist）→ 惰性建 scope → attach session 通道（fromWatermark 续）+ 各 B 级通道（快照）——一条定律覆盖所有恢复。
- **cold session**：无 live 通道的退化形态——只 backfill 不订流；投影照常构建；intents reject。证明 client session 本体=log 投影，live 只是加速器。

## 11. 需求映射与妥协台账

| 需求(P0–P2) | 落点 |
|---|---|
| P0 尽量插件化 | 判据：经 slot/通道/service 注册的都能插件化（conversation/gantt/内置卡/默认主题/zh-en 全是 bundled）；core=壳网格、bootstrap、session service、loader |
| P1 左侧按钮+面板 | sidebar 顶层坑(list)：插件注入区块（projects 即首例）；区块自己可再带注册模型 |
| P1 聊天框 statusline | statusline slot(list)；数据走 status 投影或自家 B 级通道；颜色只准 theme token |
| P1 session 内多视图（原"tabs"） | conversation.views(list)：聊天/甘特图/Traj/Waterfall 都是注入的子插件，注入一个多一个 |
| P1 tool 卡自定义 | chat-view 的 registerToolView(key=工具名)；swarm 卡订自家通道投影 |
| P2 详情页 tab | detail slot 扩 keyed 多 tab |
| P2 Traj/Waterfall 行为 | 纯数据 slot {color,label} |
| P2 主题/皮肤 | single 槽+token 字典→CSS vars；默认主题=bundled；Winamp 级后置 |
| P2 语言插件 | i18n 注册表+fallback 链；插件自带 namespace；存量文案抽 catalog 单独排期 |

| 妥协 | 触发条件 | 返工点 |
|---|---|---|
| peer 整体暂缓（动作面先走通道 intent） | 复杂请求-应答词汇需求出现 | 另稿收编封存资产；预埋位已留 |
| client 无 agent 级隔离（session 精度；agent 寿命插件可能见 stale） | 第一个撞 resume-stale 的插件 | agent 绑定轴或 incarnation（细则 §2.4 已想清） |
| 跨投影 ≤1 帧撕裂 | 肉眼可辨联动错位实证 | 投影对合并 |
| 插件无沙箱（ErrorBoundary 唯一隔离） | 第三方不可信插件 | Webview 级隔离另议 |
| 信封骑既有 SSE/POST（载体不动） | 载体收敛单独立项 | carrier 缝已显式，换载体不动上层 |
| 存量中文文案未抽 catalog | i18n 线开工 | 全 UI 扫荡，独立排期 |
