# P-I API 契约终版 v3（冻结；teammate 照抄实现）

> **本文件即冻结契约本体**——实现中发现契约错 → SendMessage 主会话仲裁改本文件并广播；不许自行改接口。配套：[dispatch.md](dispatch.md)（任务分派）、[plugins.md](plugins.md)（业务+布局规则）、[architecture.md](architecture.md)（机制讲解）、figma-analysis/（视觉）。services.md 已并入本版作废。
> 包名前缀 `@deepseek-ai/dsh-client-<dir>`（下文省略）。ESM 源码、strict TS、类型 import 一律 `import type`。

## 0. 包清单、依赖图、装载链

### 0.1 包（12 个）

```
packages/client/
  ui-slots/        SlotCore 纯注册表 + SlotMap 类型 + ScopedSlots 双形态类型
  ui-primitives/   纯 React 原子件:State四色点/ic_ds_图标族/按钮胶囊菜单/markdown族（零 cordis 依赖）
  web-react/       store(zustand 引擎)+ObservableSnapshot+bindSnapshotSelector+SessionProvider+outlet 实现+useInvoke
  connection/      wire 类型封装+网络连接(现文件原样搬家)
  runtime/         cordis 启动+SlotsService 包装+sessions(scope 树)+loader(渐进式)
  ui-layout/       layout 插件:三栏 AppFrame+拖拽+ctx.layout service(壳级观看态总归口:导航+面板)
  ui-sidebar/      sidebar 插件(树列表全量)
  ui-conversation/ conversation 骨架+chat 视图+toolviews+details 极简+bash toolview 样例
  ui-trajectory/   trajectory+waterfall 占位视图(独立 teammate,不要求效果)
  ui-theme/        theme 注册表+CSS vars
  i18n/            i18n 注册表+t 绑定
  web/             入口壳:global 挂载+boot+AppRoot+vite/构建管线
```

### 0.2 依赖方向（import 面）

```
ui-slots ←─ web-react ←─ runtime ←─┬─ ui-layout ←──── web
    ↑           ↑           ↑      ├─ ui-sidebar
ui-primitives ──┘       connection └─ ui-conversation ←─ ui-trajectory
（ui-* 均可用 ui-slots 类型/web-react hooks/ui-primitives 组件;ui-theme、i18n 零依赖旁路）
```

### 0.3 装载链（v4 修订:默认等全量加载完再画真 UI）

```
GET / → host webserver 渲染 index.html,注入 window.__DSH_BOOT__（§9.2）
  → web 壳: 挂 ctx.loader（loader 机件由壳静态持有,不能经自己装载）
  → createRoot 渲染 <AppRoot> 的 **boot loading 页**（纯壳组件,不依赖任何插件）
  → loader.start(): 读 __DSH_BOOT__,immediately 组并行拉取+组内 inject 拓扑 apply
      (connection/runtime(slots/sessions)/ui-theme/i18n) → 全组就位后
  → 其余插件按 inject 拓扑逐个拉 bundle（layout 等）
  → await loader.settled() → AppRoot 切换渲染真 UI（此刻全部注册已到位,一次成型）
```

**默认=等所有插件加载完才开始画实际 UI**（loading 页→整 UI 一次切换）;Suspense/渐进点亮/局部依赖加载全部后置（台账）——loader 的渐进能力(status/单插件失败标记)保留,只是 AppRoot 不利用它做渐进渲染。单插件 load 失败:P-I 直接在 loading 页显示错误(fail loud),不做部分可用。
插件（含基建四包）全部经 bundle loader 动态加载（CSS 随插件注入+隔离 §9.1）——生产模式不可重打包主入口，壳静态内置的只有 loader 机件与纯库。dev 与 prod 同链：插件改动=tsdown watch 重编译+刷新，**无 HMR**（后置）。

**双入口包形态（每个 UI 插件包）**——UI 插件本身就是 host 插件；**client 产物靠声明发现,不靠 apply 里调注册**：

```
package.json:
  "dshClient": { "inject": ["ui-layout"], "platform": "web", "immediately": true? }   ← 声明位
  "exports": { ".": ..., "./client": "./dist/client.js" }   ← client 产物走标准 exports,不进 dshClient
"."(node 半边)  : cordis host 插件。纯 UI 插件的 apply 可以是空函数——
                  存在的意义=让插件出现在 host cordis.yml/Loader 里(装载与生命周期跟 host 走);
                  有 host 逻辑的插件(将来 approvals/swarm)在此加码
"./client"      : 浏览器半边(tsdown 闭包 bundle,§9.1)
"./shared"      : 仅当有跨线契约时出现(P-I 无)
```

dshClient 字段语义（2026-07-21 修订 immediately）：`inject: string[]`=client 半边的装载依赖（**与 cordis inject 同名同念**——按它拓扑排序）;`platform: 'web'`=目标平台（暂一插件一平台,将来 electron 等再扩枚举）;`immediately: true`=**先行装载组**——仍是标准动态 bundle（有 url,与其余插件同构）,loader.start() 先并行拉取该组、按组内 inject 拓扑 apply,**全组就位后才开始装载其余插件**（layout 等）。
**声明范围（八包）**：connection/runtime/ui-theme/i18n 带 `immediately: true`（基建;runtime 的 client 半边供 slots/sessions;**loader 机件例外**——装载器不能经自己装载,由 web 壳静态持有并在 boot 时挂 ctx.loader,代码家仍在 runtime 包）;ui-layout/ui-sidebar/ui-conversation/ui-trajectory 不带。纯库 ui-slots/ui-primitives/web-react 与壳 web 不声明。host cordis.yml 全列八包（config 同源:装/卸=改 yml 重启）。

**发现机制（HostWebPluginRegistry,归 webserver 属地/rt-core 实施）**：订阅 host Loader 的插件加载面（实施时对照 vendor/loader 实际事件名,无则 registry 遍历+update 事件）,对每个已加载插件解析其 package.json：有 `dshClient` 且 platform 匹配 → 进 web 插件表（id=包名;client 产物路径=解析该包 `exports["./client"]`）;插件卸载=移出表。webserver 由此表生成 __DSH_BOOT__ 与 /plugins/<id>/client.js。**apply 零仪式**——插件作者只写 package.json 声明;config 同源落地=装/卸 UI 插件就是改 host cordis.yml 重启。类型宇宙隔离照旧:client 编译单不得见 node 半边 merge,verify-client-closure 扩到 12 包（T0 接）。

## 1. ui-slots

```ts
export interface SlotMap {}                        // owner declare merge;条目={ kind; scope; props }
export type SlotKind = 'single' | 'list' | 'keyed'
export type SlotScope = 'root' | 'session'
export interface SlotEntryDef { kind: SlotKind; scope: SlotScope; props: object }

// inject 装配语境（apply 世界专用,永不进 props）
export interface SessionBinding {
  readonly sessionId: string                       // web-react re-export 收窄为 SessionId
  readonly session: SessionAccess                  // { useSelector },web-react 收窄
  readonly ctx: unknown                            // 该 session 的 scoped cordis ctx(runtime 充实)
}
export interface RootBinding { readonly ctx: unknown }
export interface SessionAccess { readonly useSelector: unknown }
export type InjectFactory<E extends SlotEntryDef> =
  (b: E['scope'] extends 'session' ? SessionBinding : RootBinding) => Record<string, unknown>

export interface SlotSpec<E extends SlotEntryDef> { kind: E['kind']; scope: E['scope'] }
export type SlotOptions<E extends SlotEntryDef> =
  E['kind'] extends 'keyed' ? { key: string; inject?: InjectFactory<E> }
  : E['kind'] extends 'list' ? { id: string; order?: number; label?: string; inject?: InjectFactory<E> }
  : { inject?: InjectFactory<E> }

// 纯注册表核心（零 cordis;事件发射归 runtime 的 Service 包装）
export interface SlotEntry<E extends SlotEntryDef> { component: FC<E['props']>; options: SlotOptions<E> }
export class SlotCore {
  define<K extends keyof SlotMap & string>(key: K, spec: SlotSpec<SlotMap[K]>): () => void
  register<K extends keyof SlotMap & string>(
    key: K, component: FC<SlotMap[K]['props']>, options?: SlotOptions<SlotMap[K]>): () => void
  entries<K extends keyof SlotMap & string>(key: K): readonly SlotEntry<SlotMap[K]>[]
  spec(key: string): SlotSpec<SlotEntryDef> | undefined
  subscribe(key: string, fn: () => void): () => void   // 微任务合批
  getVersion(key: string): number
  onMutate(fn: (key: string) => void): () => void      // Service 包装的事件桥挂点
}

// 渲染注入面类型（实现住 web-react;P-I 单形态——Suspense/局部依赖加载后置,接口预留位见台账）。
// ★交付形态=props 注入:owner 组件的 props 类型里带 `slots: ScopedSlots<'a'|'b'>`(白名单泛型),
//   由注册处 inject 工厂/框架标配注入下发——组件不 import 任何渲染器,能开哪些坑在签名上强类型可见。
export interface ScopedSlots<K extends keyof SlotMap & string> {
  renderSlot<Key extends K>(key: Key, props: OwnerProps<SlotMap[Key]>, opts?: RenderOpts): ReactNode
}
export interface RenderOpts { entryKey?: string; only?: string; fallback?: ReactNode }
export type OwnerProps<E extends SlotEntryDef> = /* E['props'] 去掉 inject 键与标配注入键 */
```

行为规格：define 前 register=throw；single 重复 register=throw；keyed 重 key=throw；register/define 返回 disposer。零依赖（React 仅 `import type`）。

## 2. web-react

```ts
// ── 子路径 web-react/store —— zustand 为引擎 ──
export interface ObservableSnapshot<T> { getSnapshot(): T; subscribe(fn: () => void): () => void }
export interface SnapshotStore<T> extends ObservableSnapshot<T> {
  update(mutator: (draft: T) => void): void        // immer 中间件
  set(next: T): void
  readonly useSelector: SnapshotSelectorHook<T>
}
export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S
export function createSnapshotStore<T>(init: T, opts?: { flush?: 'raf' | 'sync'; persist?: { name: string } }): SnapshotStore<T>
//   = zustand vanilla + immer + subscribeWithSelector + 自研 rafFlush 中间件 + persist(opt-in) + dev freeze
//   flush 缺省='sync'（受控输入要同 tick 回响;帧驱动 store 由创建方显式传 'raf'——Notifier 双通道纪律的 store 面）
export function shallowEqual(a: unknown, b: unknown): boolean   // re-export zustand/shallow

// ── 主入口（React 面） ──
export function bindSnapshotSelector<T>(w: ObservableSnapshot<T>): SnapshotSelectorHook<T>
export type UseSession = SnapshotSelectorHook<ConversationSnapshot>
export interface SessionBinding { sessionId: SessionId; session: { useSelector: UseSession }; ctx: Context }

// SessionProvider（依赖倒置,不 import runtime;2026-07-21 仲裁修订:两坑渲染归装配方）
export interface SessionProviderDeps {
  useCurrent: () => SessionId | undefined
  resolveBinding: (id: SessionId) => SessionBinding | undefined
  renderBody: (id: SessionId) => ReactNode   // 装配方（web 壳）闭包自己的 scopedSlots 渲染 conversation+details 两坑——坑归 layout own,Provider 不认识坑名
}
export function createSessionProvider(deps: SessionProviderDeps): FC<{ renderEmpty?: () => ReactNode }>
//   订 current → resolveBinding(恒等引用) → <BindingContext value key={id}> → renderBody(id)

// RootBinding 供给通道（2026-07-21 仲裁新增）：root 坑 inject 工厂需要 b.ctx（如 sidebar 拿 layout/sessions）,
//   由壳顶部挂一次 <RootBindingProvider value={rootBinding}>;SlotOutlet 渲染 root 坑 inject 时读取,缺失=throw
export const RootBindingProvider: FC<{ value: RootBinding; children?: ReactNode }>

// ScopedSlots 工厂（outlet 实现;不全局导出组件——一切经注入面下发,白名单收窄）
export function scopedSlots<K extends keyof SlotMap & string>(core: SlotCore, ...keys: K[]): ScopedSlots<K>
//   renderSlot: 订注册表(subscribe+getVersion 走 uSES),按 kind 渲染,每 entry 包 ErrorBoundary,
//     合并 props={...标配注入(session 坑=useSession), ...cachedInject(binding), ...ownerProps}
//     inject 缓存: session 坑 per-(entry×session) WeakMap;root 坑 per-entry

export function useInvoke(fn: () => Promise<unknown>): [invoke: () => void, pending: boolean]
```

白名单纪律：组件能开哪些坑写在它的 props 类型上（`slots: ScopedSlots<'a'|'b'>`）——来源=自己 define 的坑+owner 显式转授；越权=编译错。

## 3. connection —— 接口零变化搬家

现 web-runtime wire 消费层原样改名搬家：IApiClient、connect/ConnectionHandle（SSE 双流+重连+since）、MuxFrame/HostFrame、createFixtureApi。契约=现状导出面（rt-core 搬家时附实际清单于本节尾）。不 import cordis。

### 3.1 附注：apiproxy 纯度原则（2026-07-21 裁决；rt-core 对账清单的判据）

apiproxy 只准含两种代码：①窄形↔全形协议胶水；②wire 契约明文承诺的读投影（如分页边界对齐）。判据：**换个消费面（ACP/headless）还需要吗？** 需要→下沉 host 能力层；只有浏览器需要→上移 client；只有这条 wire 契约需要→留下。

存量三类判决：

| 存量 | 判决 |
|---|---|
| agentFor（resume-on-prompt）、summarizeCold（cold 列表合并） | **下沉 host 能力位**——P-I 原样使用，rt-core 对账清单标 TODO(P-II) 下沉 |
| paginate | **留**（wire 契约的读投影） |
| viewFor / backscanArgs（ToolEventView 呈现计算） | **P-I 随 toolviews 迁移整体删除**（呈现归 client） |

语义边界：隐式 resume 保留（cold→live 迁移是 host 内政，in-flight 表去重），**永不隐式 create**。可议项：history 的隐式 resume 应改纯持久化读（看历史不该拉起 agent）——记入 rt-core 对账清单，P-I 不改。

### 3.2 附录：实际导出清单（rt-core 对账 2026-07-21；本节尾附清单=契约授权动作）

搬家后接口零变化实测（`export *` 已改精确清单）。§3 正文「connect/ConnectionHandle」为旧稿措辞，现状实体=ConnectionController/ConnectionSinks（对账认现状）。

| 来源文件 | 值导出 | 类型导出 |
|---|---|---|
| api.ts | RpcId、AbstractApiClient、resultOf、transportError | ApiProxy/SessionsApi/SessionSummary/HostApi/EventsApi/MuxFrame/HostFrame/ApprovalResponsePayload/QuestionResponsePayload/HistoryEntry/ToolEventView/ToolCallView/ToolResultView/RpcRequest/RpcResponse/RpcResult/RpcError/RpcErrorCode/ClientRequest/ServerResponse/ServerRequest/ClientResponse/RpcMessage/RpcReceipt/IApiClient/SessionId/SessionEvent/ContentBlock/StreamChunk |
| connection.ts | ConnectionController | ConnectionConfig/ConnectionSinks/ConnectionState |
| web-api-client.ts | WebApiClient | — |
| fixture.ts | FixtureApiClient、createFixtureApi | — |

溶解项（不入 connection 导出面）：events.ts（WEB_EVENTS/WebEventName）随死码退役刀删除（web-cordis pre-provision,零消费者,2026-07-22）;intents.ts 整文件死——rpc-log 五 intent+pingHost 随 D18/RpcLog 族退役，refreshSessions/createSession 职责归 runtime SessionsService；store.ts（ConnectionSlice 观看态）不属 wire 层，connection 状态可见性归 runtime 侧挂账。ToolEventView/ToolCallView/ToolResultView 的 re-export 随 §3.1 viewFor 删除刀同步移除（toolviews 迁移触发，届时更新本表）。

## 4. runtime

### 4.0 类型宇宙隔离（2026-07-22 终裁——host/client 双 TS program）

> 实证：client 包 `declare module 'cordis'` 与 host 侧同名键撞车（`sessions` 撞 core/session 的 SessionStore、`loader` 撞 vendor/loader）。~~ClientContext extends Context 方案~~已作废（extends 消不掉父类——若 program 仍装载 host declare,继承照样撞）。
>
> **终裁（用户拍板）=多 tsconfig 拆分**,已全案落地（细案与执行记录=同目录 clientcontext-audit.md）：①typecheck 拆两 program——`tsc -b tsconfig.json tsconfig.client.json`（根=host 聚合,client 独立聚合）;②A 类类型链切断——session/llm/tools/approval/interaction 出纯类型子路径（./types、./presentation、llm/brand）,connection/apiproxy/runtime 的 import 全量切换,client program 不再装载 host 的 cordis augmentation;③client 包照常 `declare module 'cordis'` 声明自家服务键（sessions: SessionsService/loader: ClientLoader/layout/conversation/toolviews/theme/i18n）——双 program 下与 host 声明永不同室。ui-theme/i18n 对 runtime 的 type-only devDep 豁免保留（§0.2 零依赖旁路指零运行时依赖）。

```ts
// ── slots Service 包装（真 cordis Service,直接 ctx.emit） ──
declare module 'cordis' { interface Events { 'slots/changed'(key: string): void } }
declare module 'cordis' { interface Context { slots: SlotsService } }
export class SlotsService extends Service {        // static provide='slots'
  private core = new SlotCore()                    // core.onMutate(k => this.ctx.emit('slots/changed', k))
  // define/register/entries/spec/subscribe/getVersion 代理 core
}

// ── sessions（含 scope 树,P-I 就做） ──
declare module 'cordis' { interface Context { sessions: SessionsService } }
export interface SessionSummary { id: SessionId; title: string; cwd?: string; parentId?: SessionId; running: boolean; updatedAt: number }
export interface SessionListState { ids: SessionId[]; byId: Record<SessionId, SessionSummary> }
export class SessionsService {
  readonly list: SnapshotStore<SessionListState>   // list RPC 快照+host 流增量;重连重拉
  readonly manager: SessionManager                 // 现有类原样
  create(opts: { cwd?: string }): Promise<SessionId>
  scope(id: SessionId): Context | undefined        // scoped ctx 视图(用完即弃)
  binding(id: SessionId): SessionBinding | undefined   // SessionProvider.resolveBinding 供给
  ancestry(id: SessionId): SessionSummary[]        // 面包屑供数:沿 parentId 回溯(list store 内查,含自身,根在前)
}
// scope 树:dsh-scope mintScope 模式照搬(no-op 插件 Fiber+extend({[kScope]:id}));
//   生命周期=观看驱动(首次解析惰性建;列表 removed 且无人观看才拆;host 死≠scope 死,frozen 保留)
export function scopeOf(ctx: Context): SessionId | undefined

// ── Session 类改造(仅加法两行) ──
class Session implements ObservableSnapshot<ConversationSnapshot> {
  readonly useSelector: UseSession                 // = bindSnapshotSelector(this)
}

// ── loader（渐进式;机件壳静态持有——runtime 出 `./loader` 专用子路径供壳 import,
//    壳 bundle 不得捎带 runtime 整个 client 半边（双实例禁令）） ──
// 工厂签名（2026-07-22 仲裁,ui-shell/rt-core 接缝）：
//   export function createClientLoader(opts: { ctx: Context; modules: Record<string, unknown> }): ClientLoader
//   —— modules=壳播种的纯库实体表（seed.ts 形状）;loader 拥有该表并在装载后回登记 bundle 导出面
//   export interface ClientLoader { requireModule(spec: string): unknown }  // 追加成员:壳装配面取
//   已装载模块导出（如 layout 的 CenterColumn）,查无=throw——与递给 factory 的 require 同一实现
declare module 'cordis' { interface Context { loader: ClientLoader } }
export interface BootPluginEntry { id: string; url: string; inject: string[]; immediately?: boolean }
export interface ClientLoader {
  start(): void                                    // 读 __DSH_BOOT__:immediately 组并行拉+组内 inject 拓扑 apply,全组就位后其余按拓扑装,不阻塞
  load(id: string): Promise<void>                  // script 注入→DSHClientProxy 单槽 handoff→ctx.plugin(apply)→style 归属登记
  unload(id: string): Promise<void>                // P-I 空实现(throw not-implemented)——HMR 立项时补(Fiber dispose→级联收回→移 style)
  settled(): Promise<void>                         // 全部到位——AppRoot 等它后才画真 UI(见 §0.3 v4 修订)
  readonly status: SnapshotStore<Record<string, 'loading' | 'active' | 'failed'>>
}
```

## 5. ui-layout（单插件:AppFrame + ctx.layout service）

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap {
  sidebar:      { kind: 'single'; scope: 'root';    props: SidebarRootProps }
  conversation: { kind: 'single'; scope: 'session'; props: ConvRootProps }
  details:      { kind: 'single'; scope: 'session'; props: DetailsProps }
  'conversation.empty': { kind: 'single'; scope: 'root'; props: {} }
  // ↑ 2026-07-22 仲裁（EmptyState 挂载点缺口）：无选中会话时 SessionProvider.renderEmpty
  //   由壳 renderSlot('conversation.empty') 渲染——EmptyState 归 ui-conversation 包,
  //   经注册表进坑（inject 工厂供 startSession/cwd 派生）;壳不得经 requireModule 点名
  //   插件导出件（防幽灵耦合）。转场同组件裁决不变:EmptyState 与常态 InputBar 共用输入组件。

declare module 'cordis' { interface Context { layout: LayoutService } }
export interface NavState { sessionId?: SessionId; viewFor: Record<SessionId, ViewId> }
export interface PanelState { open: boolean; width: number }
export class LayoutService {                       // 壳级观看态总归口(zustand+persist)
  readonly current: SnapshotStore<NavState>
  readonly sidebar: SnapshotStore<PanelState>      // 默认 300,[240,420]
  readonly details: SnapshotStore<PanelState>      // 默认 360,[300,520];P-I 全局不随 session
  open(id: SessionId): void                        // 校验存在于 sessions.list
  openView(sessionId: SessionId, view: ViewId): void
  toggleSidebar(): void; setSidebarWidth(px: number): void
  openDetails(): void; closeDetails(): void; setDetailsWidth(px: number): void
}
export type ViewId = keyof ConversationViewMap & string
// prune: 订 sessions.list 的 removed → 清 viewFor 等 keyed 条目(单向);current.sessionId 指向 removed 会话时同刀置 undefined(回落 EmptyState)
// 让步链第4步 auto-close details=派生 0 宽,不写 details.open 的 persist 态(窗口回宽自动恢复)

// AppFrame: 三栏 grid+两条拖拽把手(pointer+raf 节流)+让步链(中栏 min640→clamp details→clamp sidebar→auto close details)
//   details 收起=0 宽不 unmount;各坑一律 renderSlot;
//   AppRoot(web 壳)第一帧的 boot 骨架被 layout 插件到达后替换
```

## 6. ui-sidebar

register 进 `sidebar` 坑（整栏独占）。SidebarRoot 结构照 figma（Logo 行+折叠钮/NewSession/Search/区头+Group-by 菜单/树列表/Foot Settings 占位）。
treeStore=插件自建 SnapshotStore：订 sessions.list → 物化派生（cwd 分组→project 节点;parentId→session 树;排序）+expandedIds+query。组件订 treeStore，不在 render 里派生。
注入面（inject from RootBinding）：`{ useTree: treeStore.useSelector, actions: { open, create, toggleSidebar } }`（经 b.ctx.layout/b.ctx.sessions 绑定）。
状态点：P-I 数据源两态（running→ongoing 环/无）；四色组件齐（ui-primitives State 件），done/error/琥珀数据源记台账。

## 7. ui-conversation

```ts
// ── ViewMap（强类型视图注册） ──
export interface ConversationViewMap {}            // 本包 merge {chat};ui-trajectory merge {trajectory,waterfall}
// merge 目标路径（2026-07-22 对账,§6b 双入口后类型真身在 client 半边）：
//   declare module '@deepseek-ai/dsh-client-ui-conversation/client'（对根路径 merge 挂不到真身）
declare module '@deepseek-ai/dsh-client-ui-conversation' { interface ConversationViewMap { chat: {} } }
export interface ViewEntry<Id extends ViewId = ViewId> {
  id: Id; label: string; order?: number
  component: FC<ConvViewProps>
  chrome?: { header?: FC<ChromeProps>; footer?: FC<ChromeProps> }   // 统计条挂点(chat 用 footer)
}
export interface ChromeProps { sessionId: SessionId; useSession: UseSession }

// ── ConversationService（scope 寻址,无 sessionId 参数） ──
declare module 'cordis' { interface Context { conversation: ConversationService } }
export interface SelectionTarget { turnSeq: number; stepSeq?: number; callId?: CallId; toolName?: string }
export class ConversationService {
  // 方法从 caller ctx 读 scope(scopeOf);root ctx 调用=throw。跨 session: ctx.sessions.scope(id)!.conversation.xxx
  send(text: string, mode: 'queue' | 'steer'): Promise<void>
  cancel(): Promise<void>
  readonly selection: SnapshotStore<SelectionTarget | null>   // per-scope 实例账(挂 scope 树)
  openDetails(target: SelectionTarget): void       // 写 selection + ctx.layout.openDetails()(编排;布局态归 layout)
  registerView<Id extends ViewId>(entry: ViewEntry<Id>): () => void
  readonly drafts: SnapshotStore<string>           // per-scope;persist keyed by sessionId
}
export interface ConvViewProps {
  sessionId: SessionId; useSession: UseSession
  useSelection: SnapshotSelectorHook<SelectionTarget | null>
  actions: { openDetails(t: SelectionTarget): void; loadOlder(): void }
  slots: ScopedSlots<never>                        // chat P-I 无子坑转授(toolview 走具名注册表)
}

// ── ToolViewRegistry（agent/session 维度 P-I 生效） ──
declare module 'cordis' { interface Context { toolviews: ToolViewRegistry } }
export interface ToolViewProps {
  callId: CallId; toolName: string; block: ToolCallBlock   // frozen 切片
  useSession: UseSession
  actions: { openDetails(): void }                 // 已绑本 call
  t: Translate
}
export class ToolViewRegistry {
  register(tool: string, component: FC<ToolViewProps>,
           opts?: { scope?: (sessionId: SessionId) => boolean; inject?: InjectFactory<any> }): () => void
  resolve(tool: string, sessionId: SessionId): ResolvedToolView | undefined
  // 解析序:scope 匹配(注册序后者优先) > 无 filter 全局(同样后者优先——后装插件可覆写默认渲染) > undefined(渲染方 fallback GenericToolCard)
}
// 验收样例:bash 专属行注册两份(全局一份+某 scope filter 一份)证明差异渲染链路

// 组件归属: 骨架=ConversationRoot(Header面包屑+按钮排+ViewSwitcher+composer)/InputBar 平移/EmptyState 同组件转场
//   chat=ChatView/MessageItem/AssistantMarkdown 平移改注入取数/ToolRow 5形态/GenericToolCard/统计行(chrome.footer)
//   details=DetailsPanel 极简(关闭钮+选中 call 的 args/result 展示)

// 模型/effort 选择器: P-I 只显示(host describe 供数)不可改——写回窗口等后端能力,记台账
// ── 空态首发链（先创建再 send;figma NEW SESSION 屏）──
// 无选中会话时 conversation 坑渲染 EmptyState:居中大输入框+左上角 project(cwd)下拉
//   (选项=sessions.list 派生的 cwd 集合+"新目录"输入;figma New Session 按钮的隐藏下拉箭头即此)
// 提交: conversation.startSession({ cwd?, text, mode }) —— root 语境专用方法(不吃 scope):
//   ① await ctx.sessions.create({cwd}) ② ctx.layout.open(id)(SessionProvider 随之建 scope)
//   ③ 经新 scope 的 conversation.send(text) —— 三连由 service 内部编排,组件一次调用
// EmptyState 的输入框与常态 InputBar 是同一组件(空态转场裁决§0.1-8),仅 onSend 绑定不同
```

## 8. ui-trajectory / ui-theme / i18n / ui-primitives

- **ui-trajectory**：merge ConversationViewMap{trajectory,waterfall}+registerView 两条+占位实现（span 粗糙即可,不要求效果）;chrome.header 挂统计条（第二客户实证）。**不挂任何 ctx service**——判断:它只消费（registerView+useSession 派生渲染）,无人需要调用它;插件≠必有 service,纯消费型插件零 declare merge（这也是"最小插件"样板）。
- **ui-theme**：`ThemeService { register(id, tokens): ()=>void; apply(id): void; current(): string }`。**token 体系=用户提供的 cssdesign/ 两份文件（design-platform.css + gradient-shadow-text.css），统一用这套 `--dsw-*` 变量，不沿用现有代码任何色值**（figma 报告 token 表仅对照参考）。结构：static 色阶层（`--dsw-static-*`）+ alias 语义层（`--dsw-alias-*`）+ 渐变/阴影/blur/字体；暗色=`body[data-ds-dark-theme]` 属性整段覆写——**apply(id) 的实现=切换该 body 属性**。两份 CSS 由 web 壳作为 base 样式表直接引入（成品变量表,不经 register 转译）;ThemeService 管"选哪套"+将来第三方主题（=覆写同名 `--dsw-alias-*`）。**全体组件只准用 `--dsw-*` 变量,禁 hardcode 色值/阴影/渐变**（lint 面）。单占冲突 throw。
- **i18n**：`I18nService { register(ns, locale, dict): ()=>void; bind(ns): Translate; locale: SnapshotStore<string> }`;`Translate=(key, params?)=>string`;zh/en 空结构起步。
- **ui-primitives**：纯 React 组件（零 cordis）：`<StateDot state>`四色件/ic_ds_* SVG 图标族（figma-flows 供数）/Button/Pill/Menu/Input 原子件/markdown 渲染族（现 components/ 迁入）。全部只吃 props+token vars。

## 9. 构建、分发、装载（bundle loader 全链）

### 9.1 插件构建（每个 UI 插件包）——闭包+依赖注入,无 global

bundle 编译为**闭包工厂**：external 依赖不挂全局,作为初始化入参注入（require 形态,但解析源=cordis 依赖注入实体）：

```js
// dist/client.js 的产物形状(tsdown banner/footer 包装):
window.DSHClientProxy.loadPlugin({
  id: 'ui-sidebar',
  factory: (require) => {           // require: (spec: string) => unknown
    const React = require('react')                          // ← loader 从模块表供给
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-web-react')
    ...bundle 主体(tsdown external→require 调用)...
    return { apply, ...其余导出 }   // 模块导出面:apply=cordis 插件本体;整面登记进模块表供后装者 require
  },
})
```

- **模块表归 client loader**（机件由壳静态持有,§0.3）：壳 boot 时播种纯库实体 `{ react, react-dom, cordis, ui-slots, web-react, ui-primitives }`;**插件 bundle 的 factory 返回其模块导出面（含 apply）,loader 装载成功后以包名登记进模块表**——inject 拓扑保证后装者可 require 先装者（如 ui-sidebar require runtime 的 scopeOf、i18n 的消费面）。loader 在 load 时把绑定了模块表的 `require` 递给 factory;要什么查什么,查无=fail loud（明确报缺依赖）。无 window.DSH.* 命名空间、无 import map;将来换机制只动 loader 的 require 实现。
- zod 等非共享依赖照旧内联。
- **CSS 随插件**：CSS Modules 产物内联进 client.js（执行时注入 `<style data-plugin="<id>">`）;隔离=CSS Modules 哈希+插件 id 归属;unload 时 loader 统一移除;插件包禁 `:global` 越界与裸元素选择器（token 变量除外）。
- dev 工作流：`tsdown --watch` 重编译+手动刷新,无 HMR（后置）。

### 9.2 分发与 boot 注入（host 侧改动=webPlugins 注册表+收编已验收端点+HTML 注入）

- **HostWebPluginRegistry（host 侧,webserver 属地）**：订阅 Loader 加载面+读 package.json `dshClient` 声明（client 产物取 exports["./client"]）构建 web 插件表（§0.3 发现机制）;声明式,无 serve() 调用面。
- `GET /plugins/<id>/client.js`（cordis-web B5 已验收端点收编,文件源=该表）。
- **`GET /` 渲染 index.html 时注入**：

```ts
window.__DSH_BOOT__ = {
  plugins: [{ id, url: '/plugins/<id>/client.js', inject: [...], immediately?: true }, ...],
  // = HostWebPluginRegistry(host Loader 实际加载 ∩ 带 dshClient 声明);
  //   immediately=true 组先并行装载(组内 inject 拓扑),全组就位后其余按 inject 拓扑
}
```

零往返：HTML 到手即知拉什么。host 插件集变化=重启生效（config 同源既有裁决）。fixture server 注入同一协议。
**P-I config 同源达标口径（2026-07-21 仲裁）**：现 dsh web 链无 Loader 实例——host/runtime 装配层挂 @cordisjs/plugin-loader 并 loader.create×八包（内存树）即达标;yml 文件形态后置（届时装/卸=改文件重启）。HostWebPluginRegistry 订阅面：vendor/loader 无「加载完成」单事件,走 registry 遍历 entries()+订 internal/plugin 去抖重扫（实勘结论,rt-core）。

### 9.3 web 壳（M8）

- 无 global 挂载：共享依赖经 loader 的模块表+require 注入（§9.1）;壳只负责把这些实体在 boot 时递给 loader 构造模块表。
- AppRoot：第一帧 boot 骨架（logo/loading）;layout 插件到达后被顶层坑替换;SessionProvider/scopedSlots 装配在此闭合（deps 注入）。
- 构建管线：vite 管壳自身;插件包各自 tsdown;`dsh web` serve 壳 dist+插件 dist+注入端。归 ui-shell（构建模板）+rt-core（serve/注入）协调。

## 10. P-I 台账（明知偏差）

| # | 偏差 | 触发 |
|---|---|---|
| 1 | 侧栏状态点仅 running/无 两态有数据 | P-II approvals+通知 |
| 2 | details 极简（无三段/步进/深链） | P-II/III |
| 3 | trajectory/waterfall 占位不要求效果 | P-III 实装 |
| 4 | scope filter 仅函数形态 | 第三方声明式需求 |
| 5 | loader 无完整性校验（第一方产物） | 第三方插件 |
| 6 | 无 HMR（dev=重编译+刷新） | 工作流优化期 |
| 6b | 无渐进渲染/Suspense（等 settled 一次成型;单插件失败=loading 页 fail loud） | 局部依赖加载立项（renderSuspenseSlot 设计已议,届时恢复） |
| 7 | ~~全纯 client 插件~~ **已撤销**：UI 插件=双入口（node 半边 serve 注册+client 半边）;./shared 仍零实例（P-I 无跨线契约需求,首个私有 wire 插件激活封存设计） | — |

## 11. 现有代码迁移映射

| 现文件 | 去向 |
|---|---|
| web-runtime/src/{connection,api,events,intents,web-api-client,fixture}.ts | → connection/（git mv,导出面不变） |
| web-runtime/src/session/* | → runtime/src/sessions/（git mv;Session 两行加法） |
| web-runtime/src/boot.ts | → runtime/src/kernel/ 改造 |
| web-runtime/src/{store,rpc-log}.ts | store 评估并入 sessions;rpc-log **删除**（D18） |
| web-ui/src/sessiontabs/conversation/* | → ui-conversation/（git mv;容器改注入取数;PendingCard 保留现状挂 chat 流） |
| web-ui/src/components/* | → ui-primitives/（markdown 族等,git mv） |
| web-ui/src/shell/*+leftmenu/* | AppShell/SessionsPanel 参考重写;三 registry/RpcLog 族删除 |
| apps/web | → web/ 包（vite/index.html;最小 diff 自选） |
