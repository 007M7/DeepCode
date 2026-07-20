# Web 插件体系——模块边界与实施规格

> **权威声明（2026-07-21 终版）**：接口签名的唯一权威=**[api-contracts.md](api-contracts.md) v3**；任务分派=**[dispatch.md](dispatch.md) v2**。本文保留模块职责/边界/验收的叙述性规格，与 v3 冲突处一律以 v3 为准——本文正文**未逐行重写**，读到以下旧概念时按右侧新词理解：Watchable→ObservableSnapshot；Store→SnapshotStore；createStore→createSnapshotStore；bindSelector→bindSnapshotSelector；SessionScopeGate/Gate→SessionProvider；SessionHandle/RootHandle→SessionBinding/RootBinding；ctx.layout/LayoutService→ctx.layout/LayoutService；SlotsService(emitChanged 回调版)→SlotCore（ui-slots 纯核）+runtime 真 Service 包装（直接 ctx.emit）；SlotOutlet 全局组件→注入面 `slots.renderSlot`（**单形态，无 Suspense，等 loader.settled() 一次成型**）；`conversation.detail` 坑→顶层 `details` 坑（归 ui-layout）；openDetail→openDetails（step 级 SelectionTarget）；包数=12（增 ui-primitives、ui-trajectory）；编制=8 开发（dispatch v2）。

## 0. 模块总图与依赖方向（定稿包名）

```
packages/client/
  ui-slots/       M1  slot 注册表 + SlotMap 类型 + SlotOutlet
  web-react/      M2  store（createSnapshotStore/ObservableSnapshot/shallowEqual/bindSnapshotSelector,子路径隔离 React 依赖）
                      + hooks（useInvoke/Gate/注入面装配）
  connection/     M3  与后端对等的类型封装 + 网络连接:
                      现 connection.ts/api.ts/events.ts/intents.ts/web-api-client.ts/fixture.ts
  runtime/        M4  cordis root ctx 启动 + 插件系统服务（loader/bootstrap）
                      + sessions（Session/SessionManager/ctx.sessions/列表 store）——后面再拆
  ui-layout/      M5a layout 插件: 顶层坑(sidebar/conversation) + AppFrame + Gate 使用
  ui-sidebar/     M5b sidebar 插件: 区块坑 + projects 列表(暂放此包) + 新建按钮
  ui-conversation/M5c conversation 骨架 + chat 视图/input(暂放此包) + detail + approvals
  ui-theme/       M6  theme 注册表 + CSS vars 应用          （旁路,零依赖）
  i18n/           M7  i18n 注册表 + t 绑定                  （旁路,零依赖）
  web/            M8  入口: React 启动(createRoot) + runtime 启动 + 拼装全部插件——只组装,无业务
```

依赖方向铁律：M1/M6/M7 零依赖旁路；M2 依赖 M1 类型面；M3 零依赖（wire 类型自包含）；M4 依赖 M2,M3；M5a/b/c 依赖 M1,M2,M4；M8 依赖全部（唯一组装点）。并发拓扑序：**{M1,M3,M6,M7} → M2 → M4 → {M5a,M5b,M5c 并发} → M8 收口**。

每模块下文给：职责 / 对外导出（API 边界）/ 类型边界（谁 declare 什么）/ 不许做什么 / 验收断言。

---

## M1 ui-slots：slot 注册表

**职责**：SlotMap 声明合并载体 + SlotsService（define/register）+ SlotOutlet 渲染基件。

**对外导出**：

```ts
// 类型面
export interface SlotMap {}                        // 空表,各 owner declare merge;条目形状={ kind; scope; props }
export type SlotKind = 'single' | 'list' | 'keyed'
export type SlotScope = 'root' | 'session'          // ★坑位的 scope 轴,declare 处定死:
                                                    //   root=sidebar 等(无会话语境);session=conversation.* 等
export interface SlotSpec<E> { kind: E['kind']; scope: E['scope'] }
export type SlotOptions<E> =                        // 条件类型:kind 决定字段
  E['kind'] extends 'keyed' ? { key: string; inject?: InjectFactory<E> }        // key=运行时分发判别值(如工具名);重 key throw
  : E['kind'] extends 'list' ? { id: string; order?: number; label?: string; inject?: InjectFactory<E> }  // id=list 项身份(only=/router 引用)
  : { inject?: InjectFactory<E> }                   // single: 无 key/id/order
// inject 工厂入参随坑位 scope 轴变化（编译期条件类型）:
//   session 坑 → SessionHandle（含活 Session 实例,仅 apply 世界用——绑方法进稳定 actions,实例不进 props）
//   root 坑   → RootHandle（无会话语境）
export type InjectFactory<E> =
  (h: E['scope'] extends 'session' ? SessionHandle : RootHandle) => Partial<E['props']>

// service（cordis 插件 'slots' provide）
export class SlotsService {
  define<K extends keyof SlotMap & string>(key: K, spec: SlotSpec<SlotMap[K]>): () => void
  register<K extends keyof SlotMap & string>(
    key: K, component: FC<SlotMap[K]['props']>, options?: SlotOptions<SlotMap[K]>): () => void
  /** 渲染侧读清单（SlotOutlet 内部用；对外只读） */
  entries<K extends keyof SlotMap & string>(key: K): readonly SlotEntry<K>[]
}
// 注册表变化不自设 onChange——复用 cordis events。本包保持零 cordis 依赖:
// SlotsService 构造时收一个 emitChanged(key) 回调;'slots/changed' 的 Events
// declaration merging 与 ctx.emit 接线都住 runtime(M4) 装配处。
// SlotOutlet 侧经 M2 的桥（cordis 事件→uSES 源,微任务合批）订阅——React 不直接挂 cordis 监听。

// React 基件
export function SlotOutlet<K extends keyof SlotMap & string>(props: {
  slot: K
  props: OwnerProps<SlotMap[K]>          // = props 去掉 inject 注入的字段（Omit 推导）
  entryKey?: string                      // keyed 必填,其余禁传（条件类型）
  only?: string                          // list 坑按项 id 过滤渲染子集
  fallback?: ReactNode                   // keyed 无命中时的回退
}): JSX.Element
```

**行为规格**：
- define 前 register = throw（fail loud）；single 重复 register = throw；keyed 重 key = throw。
- register/define 返回 disposer；调用方负责挂 ctx.effect。
- SlotOutlet：每 entry 包 ErrorBoundary（插件组件抛错→该卡位显示错误占位，不传染）；合并 props={...scope 标配注入(session 坑=useSession;root 坑无), ...cachedInject(h), ...ownerProps}；inject 工厂调用与缓存节律=**session 坑 per-(entry×session) 一次（缓存键=Session 实例,WeakMap,frozen 复用同 handle）；root 坑 per-entry 一次**。
- 变化通知走 emitChanged 回调→cordis 事件→M2 桥（微任务合批）→uSES。

**类型边界**：本包只出空 SlotMap 与泛型机制；**任何具体 slot key 由 owner 包 declare**。SessionHandle/RootHandle 是 opaque 接口（由 M2 hooks 侧定形），本包不 import runtime。

**不许**：认识任何业务 slot；import cordis/runtime；在 outlet 里做数据订阅。

**验收**：单测覆盖三型语义矩阵（define/register 顺序、重复、disposer 收回、inject 缓存恒等）；类型负样本（keyed 漏 key、single 传 key、props 不符 FC）expect-error 编译用例。

---

## M2 web-react：store + hooks

**职责**：数据契约（ObservableSnapshot）与 store 工具 + 框架内建的 React 缝（Gate、注入装配、useInvoke）。两个子路径：`web-react/store`（核心零 React 依赖）与主入口（React 面）。

**对外导出（store 子路径）**：

```ts
export interface ObservableSnapshot<T> {
  getSnapshot(): T                       // 纯读;数据没变必须返回同一引用
  subscribe(fn: () => void): () => void  // 通知在快照换代后发出
}
export interface SnapshotStore<T> extends ObservableSnapshot<T> {
  update(mutator: (draft: T) => void): void   // 命令式改;raf 合批;finalize 产 frozen 快照(结构共享)
  set(next: T): void                          // 整体替换（少用）
  /** uSES 绑定面:给注入/组件用的 selector hook（引用恒定,可直接进 props）——主入口构造时挂上 */
  readonly useSelector: <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S
}
export function createSnapshotStore<T>(init: T, opts?: { flush?: 'raf' | 'sync' }): Store<T>
export function shallowEqual(a: unknown, b: unknown): boolean
```

**对外导出（主入口 React 面）**：

```ts
/** 把任意 ObservableSnapshot 缝成稳定的 selector hook（五行胶水:uSES-with-selector） */
export function bindSnapshotSelector<T>(w: ObservableSnapshot<T>): <S>(sel: (s: T) => S, eq?: Eq<S>) => S

// Gate: layout 用;插件作者不写不碰。
// ★Gate 依赖倒置:不 import runtime——构造时收一个 resolveSession(id)=>SessionLike
//   的回调（M8 组装时把 ctx.sessions.manager.get 递进来）,保住 M2 不依赖 M4 的铁律。
export function SessionProvider(props: { renderEmpty?: () => ReactNode }): JSX.Element
export interface SessionLike extends ObservableSnapshot<unknown> { readonly useSelector: Function }

// 两种 Handle（M1 的 opaque 在此定形;都只活在 inject 装配时刻,不进 React/props）
export interface SessionHandle {
  sessionId: SessionId
  session: SessionAccess     // = { useSelector: UseSession } + 活实例访问（apply 世界绑 actions 用）
}
export interface RootHandle {}                       // root 坑注入语境（v1 空,留形状）
export type UseSession = <S>(sel: (s: ConversationSnapshot) => S, eq?: Eq<S>) => S
// 组件侧纯工具(无 ctx 依赖,可单测)
export function useInvoke(fn: () => Promise<unknown>): [invoke: () => void, pending: boolean]
// 包导出形态(领域 hook 内部组合用;组件文件禁 import——lint 规则)
export function useSessionSelector<S>(sel: (s: ConversationSnapshot) => S, eq?: Eq<S>): S
```

**行为规格**：
- createSnapshotStore：update 收 draft（mutative/immer 任选,产物结构共享）；raf 窗口合批为一次换代+一次通知；`flush:'sync'` 供测试；dev 模式 finalize 后深 freeze。
- Gate：订 router.current → resolveSession(id)（常驻恒等）→ `<SessionProvider value={session} key={id}>` → 渲染 `conversation` 顶层坑。切换=key 重挂；同 id 零刷新。
- 注入装配：为 SlotOutlet 提供 `resolveInject(entry, h)`——session 坑 WeakMap<Session> 缓存 per-(entry×session)，root 坑 per-entry；scope 标配注入（useSession）在此并入。
- useInvoke：invoke 引用稳定；pending 为内部 uSES 微源（不 setState）。

**不许**：store 核心 import React（子路径隔离）；import runtime/connection（Gate 靠依赖倒置）；出现业务类型（ConversationSnapshot 仅作为类型参数出现,经 type-only import）；给组件世界暴露 ctx。

**验收**：结构共享断言（改 a.b 后 a.c 引用不变）；raf 合批计数；selector 等值短路；并发渲染重放安全（getSnapshot 幂等）；Gate 切换 Profiler 计数（切 session 时 sidebar 零渲染）；注入面跨 render 引用恒等。

---

## M3 connection：wire 类型封装与网络连接

**职责**：与后端对等的类型封装 + 网络连接。现有文件平移归位：connection.ts（SSE 双流+重连）、api.ts/web-api-client.ts（RPC client）、events.ts（帧类型）、intents.ts、fixture.ts（假 host）。

**对外导出**：现有导出面原样（IApiClient、连接生命周期、帧类型、fixture 启动）——本包是"现 web-runtime 的 wire 消费层"改名搬家，**接口零变化**。

**不许**：改协议、改重连语义；import cordis（保持纯网络层,runtime 来消费它）。

**验收**：现有 connection/api 相关 spec 平移后全绿。

---

## M4 runtime：cordis 启动 + sessions（后面再拆）

**职责**：client cordis root ctx 创建、bootstrap/loader 插件系统服务；sessions 域（Session/SessionManager 现有类 + ctx.sessions service + 列表 store）。暂同包，后拆预留内部目录边界：`src/kernel/`（ctx 启动/loader）与 `src/sessions/`（会话域）。

**对外导出**：

```ts
// kernel
export function bootClientRuntime(opts: BootOptions): { ctx: Context; dispose(): Promise<void> }
//   创建 root ctx → 挂 connection(M3) → 挂 loader → 按清单 apply bundled 插件
// sessions 插件（bundled,bootClientRuntime 默认清单成员）
declare module 'cordis' { interface Context { sessions: SessionsService } }
export class SessionsService {
  readonly list: Store<SessionListState>            // M2 createSnapshotStore;数据源=list RPC 快照+host 流增量
  readonly manager: SessionManager                   // 现有类,常驻实例注册表
  get(key: SessionId): Context | undefined           // 该 session 的 scoped ctx 视图
  create(opts: { cwd?: string }): Promise<SessionId>
}
export interface SessionListState { ids: SessionId[]; byId: Record<SessionId, SessionSummary> }
```

**Session 类改造（仅两条,其余不动）**：
1. 补 `implements ObservableSnapshot<ConversationSnapshot>`（subscribe/getSnapshot 现成；buildSnapshot 分段 rev 结构共享已在做——补断言测试钉住）。
2. 构造时 `readonly useSelector = bindSnapshotSelector(this)`（M2）。

**不许**：改 wire、改重连、改 SessionManager 生命周期、加"通道/信封"层；kernel 与 sessions 互相 import 只允许 sessions→kernel 单向。

**验收**：现有 session/ spec 全绿不动；新增结构共享断言 + useSelector 等值短路；bootClientRuntime 的 keyless 启动 smoke。

---

## M5a ui-layout：壳与顶层坑

- own SlotMap：`sidebar:{kind:'list',scope:'root'}`、`conversation:{kind:'single',scope:'session'}` + define。
- 组件：AppFrame（两栏网格）+ 两个 SlotOutlet + SessionProvider（包 conversation 坑）。
- **router 插件也住此包**（导航是壳的事）：provide `ctx.layout`：`{ current: Store<RouterState>; open(id): void; openView(sessionId, view): void }`；内部 Zustand（nav/layout/prefs/drafts slices 的宿主）；prune 桥：session removed → 清 keyed 条目。
- 现资产映射：AppShell.tsx → AppFrame；三个旧 registry（leftMenu/sessionTab/detail）废弃删除。**旧壳现存目录 leftmenu/{sessions,rpclog}/ 与 sessiontabs/ 的组件按新插件归属迁移或删除（RpcLog 面板/RailBadge 在新清单里无归属=删除,历史在 git）**。

## M5b ui-sidebar：区块插件群

- projects 区块（暂放此包）：会话列表按 cwd 分组呈现 + running 绿点 + lineage 缩进；数据=inject sessions 后订 `ctx.sessions.list`；注入面给组件 `{ useSessions, actions:{open} }`。
- 新建按钮区块：`sessions.create` → `router.open`。
- register 进 `sidebar` 坑（list,各带 id/order）。

## M5c ui-conversation：对话域（chat/input 暂放此包）

- **conversation 骨架插件**：provide `ctx.conversation`（send/cancel/openDetails/closeDetails——send/cancel 内部走 M3 的 prompt/cancel RPC,scope 从 caller ctx 读;openDetails 收 {callId,toolName,block} 写自己的观看态 store,ConversationRoot 订它开合侧板+按 toolName 查 detail 坑）；own SlotMap `'conversation.views':{list,scope:'session'}`、`'conversation.statusline':{list,scope:'session'}`、`（detail 已上收为顶层 details 坑,归 ui-layout——见 v3 §5）` + define；组件 ConversationRoot（ViewSwitcher+三个 SlotOutlet+InputBar）。InputBar 现组件原样,draft 走 router 的 drafts slice。
- **chat 视图插件**（暂同包）：register views(id:'chat')；provide **`ctx.toolviews` 具名注册表**（`register(tool, component, filter?:{scope?})` + `resolve(tool, scopeKey)`——scope 精确匹配>全局>others 兜底;多视图共同消费,不走 SlotMap 字符串 key,细节见 plugins.md T 层）；ChatView（现 ConversationView 改造:数据经注入的 useSession）+ MessageItem 等平移；GenericToolCard 为 fallback；现 toolCardRegistry 语义并入。
- **detail 插件**（暂同包）：register detail(key:'tool')；ToolCallDetail 现组件改造。
- **approvals 插件**（暂同包）：pending 数据=mux approval/question 帧→自家 Store；PendingCard 进 chat 内嵌位+statusline 徽标。**注意（P-II 实施前置）**：respond 设计稿（tasks/20260721-0209-respond-design/）按旧对象层写成,实施前先做一页对齐（PendingInteractionRegistry→本插件 Store 的映射;§0 现状警示 bootHost 未挂审批服务仍有效——P-I 期先不注册本插件即可）。
- gantt 视图插件：register views(id:'gantt')；现 GanttPlaceholder 起步。

**M5 通用不许**：组件文件 import cordis/M2 包导出 hook（lint enforce,注入面是唯一通道）；跨插件直接 import 别家组件（要复用=经 slot 或提升共享纯组件包）。

---

## M6 ui-theme / M7 i18n（旁路）

- M6 provide `ctx.theme`：`{ register(id, tokens): ()=>void; apply(id): void }`；apply=写 CSS variables 至 :root；单占用冲突 throw；无 React 面（换肤=DOM 级联,零渲染）。
- M7 provide `ctx.i18n`：`{ register(ns, locale, dict): ()=>void; bind(ns): Translate; locale: Store<string> }`；React 面=标准 Provider+useT（locale 切换整树重渲染,低频接受）；bind 产物引用恒定（可进注入面）。
- zh/en 字典、默认主题各为独立 bundled 插件（骨架跑通后补）。

---

## M8 web：入口组装

- 唯一职责：`createRoot` 挂 React + `bootClientRuntime`（M4）+ 默认插件清单（layout/router/sidebar/conversation/theme/i18n/zh/en/默认主题）+ 把 root ctx 与 React 树缝合（Gate 挂载点）。
- vite 入口/静态资源/index.html 归此包；现 apps/web 的入口职责迁此（或 apps/web 直接瘦身为本包的消费端,实施时按最小 diff 选）。
- **不许**：任何业务逻辑/组件/slot 声明。

---

## 并发实施调度方案（P-I 定稿版——teammate 编制/派单/合流纪律）

### 编制：6 名常驻 teammate + 主会话当调度

| 代号 | 承包面 | 生命周期 |
|---|---|---|
| **fw-slots** | M1 ui-slots + M6 ui-theme + M7 i18n（三个零依赖小包一人包圆,总量≈一个中包） | W1 起,完工后转机动 |
| **fw-react** | M2 web-react（store+hooks+Gate+注入装配） | W1 起（.d.ts 桩先行）,W2 主力 |
| **rt-core** | M3 connection 搬家 + M4 runtime（kernel+sessions） | W1 起（M3 纯搬家零依赖）,W3 主力 |
| **ui-shell** | M5a ui-layout（三栏骨架/拖宽开合/router）+ M8 web 入口 | W2 起读契约,W4 主力,W5 组装 |
| **ui-side** | M5b ui-sidebar（树列表全量） | W4 |
| **ui-convo** | M5c ui-conversation（骨架+chat-view+details 极简+toolview 样例） | W4——**最大单元,可加派 1 人拆 chat-view**（届时 ui-convo 当 owner 分工:骨架+composer vs 消息流+toolview） |

原则：**按包分人、包即属地**——同一包永远只有一人写,物理杜绝混刀;人少于包时按波次串行复用（fw-slots 三小包、ui-shell 两包都是串行承包）。

### 时序（依赖驱动,非整波等齐）

```
T0 冻结契约 → W1: fw-slots(M1)/fw-react(M2桩)/rt-core(M3) 三线并发
                 ├─ M1 类型面落地 → fw-react 转实做 M2
                 ├─ fw-slots 续做 M6/M7（不阻塞任何人）
                 └─ M3 搬完 → rt-core 开 M4
W2/3: M2+M4 完成 → 发"契约就绪"通告
W4:  ui-shell(M5a) 先行冻结顶层 SlotMap declare（半天内）→ ui-side/ui-convo 并发
      ui-shell 完成 M5a 后直接开 M8 壳（用桩插件先跑通 boot 链）
W5:  ui-shell 收口组装;全员修各自包的集成问题;主会话跑验收清单
```

关键路径=fw-react(M2)→rt-core(M4)→ui-convo(M5c)。M5c 若明显拖尾,加派拆分（见编制表）。

### 每份任务书必带（除全局纪律五条外）

1. **属地=自己的包目录 + 自己的 missions/tasks/ 档案**,pathspec commit,别的包只读。
2. **契约冻结表**（下方）是法律:实现中发现契约错→SendMessage 主会话仲裁改表,**不许自行改接口**;改表后主会话广播全员。
3. 桩规则:依赖包未就绪时,按冻结契约手写 .d.ts 桩开工;合流时删桩换真包,桩与真包不符=契约违规上报。
4. 测试随包:每包自带 vitest（GUI 门禁宽松期口径:能跑即可,PR 窗口再收口）;跨包集成测试归 W5 主会话安排。
5. 小步快跑:每完成一个可编译单元落盘+一句话回执;>15 分钟零落盘=主会话催报;API 死线复活流程照旧（断点烧任务书重开）。
6. 现有代码迁移用 `git mv` 保历史;删除旧件（三 registry/RpcLog 等）单独成刀。

### 跨模块契约冻结点（T0 定稿,变更走仲裁）

SlotMap 机制类型与 SlotOptions/SlotScope（M1）、ObservableSnapshot/SnapshotStore/SessionBinding/RootBinding/UseSession(v3)（M2）、ConversationSnapshot（M4 现状即约）、顶层 SlotMap 条目（M5a declare,W4 首日冻结）、**ToolViewRegistry 接口**（M5c provide,但接口 T0 就冻——ui-convo 与将来工具卡插件的边界）、selection 通道形状 `{turn, step}|null`（conversation 观看态,T0 冻）。

### W5 集成验收清单（P-I "基本等同现有功能略微超出"的标准）

1. 现有 playwright 面语义等价：test:gui 全绿 + verify-session 语义等价改造版 + verify-session-real（真 host）;RpcLog 面板相关断言退役记档。
2. 三链路 Profiler 计数断言（发 prompt/delta 风暴/切 session——流式期间统计行=0、邻行=0、历史 MessageItem=0）。
3. 新增面各一条 e2e：三栏拖宽/开合/让步顺序;树展开与状态点;details 极简联动（点 tool 行→右栏显示 args/result）;**toolview 自定义样例**（bash 或 todo 专属行渲染经注册表生效+卸载回退兜底）;暗色主题切换。
4. 断线刷新恢复 + cold session 打开。
5. fixture 与真 host 双跑（fixture 全绿不算完,真 host 冒烟必过）。

## 全局纪律（每个 teammate 任务书必带）

1. wire/host/Session 三不改；发现"不得不改"=停下上报,不自作主张。
2. 组件世界零 ctx/零框架 import；一切经 props（值+稳定 hook）。
3. 相等性协议：快照结构共享;selector 默认 Object.is,选对象声明 shallowEqual;深比较禁止。
4. 渲染红线：订阅结果不进 state/store;列表父订 id 序列子订内容;markdown 增量 parse;滚动 raf 直改 DOM。
5. 每插件的 SlotMap declare + define + register 三件必须同 PR;register 到未 define key 的运行期错误要有测试。
