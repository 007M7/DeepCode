# dsh Web 架构

> 面向开发者的整体架构说明——读完可独立开发任一层。本文是**完整自含**的：底座（协议/对象层/host 分层，随本分支交付）与插件化体系（本次新建）都在正文里，不需要再读别的决策文档。接口精确签名见 [api-contracts.md](api-contracts.md)；业务插件清单与布局规则见 [plugins.md](plugins.md)；任务分派见 [dispatch.md](dispatch.md)；主题变量表在 [cssdesign/](cssdesign/)；视觉稿解析在 figma-analysis/。

## 1. 总纲

dsh Web 是 harness 的浏览器界面，与 host（node 侧 harness 运行时）经 HTTP/SSE 通信。三句话：

1. **两端都是 cordis**：host 是一棵 cordis 插件树；浏览器里同样跑一棵 client cordis 树——UI 的每一块功能（布局、侧栏、对话、主题、语言包）都是 client cordis 插件，由 loader 动态装载。
2. **cordis ctx 是一切运行时事实的宿主，React 是纯投影**：数据与逻辑活在 ctx 的 service/store 上；React 组件零框架依赖、只吃 props；zustand 只存「怎么看」（导航/面板宽/偏好/草稿），永远不存运行时数据的副本。
3. **wire 与 host 权威层稳定**：apiproxy RPC + SSE 双流是插件化体系的既定地基；host 侧仅两小件为 Web 插件化服务（插件产物分发端点、HTML 启动注入）。

```
┌─ Host ────────────────────────────┐   ┌─ 浏览器 ─────────────────────────────────────────┐
│ sessions/agents/SessionLog        │   │ client cordis root ctx                            │
│ apiproxy: RPC + mux/host 双流     │◀──▶│  ├ loader 机件(壳静态持有,不能经自己装载)          │
│ webserver:                        │   │  ├ immediately 先行组(动态 bundle,并行先装):       │
│  ├ 静态托管 + /api 桥 + SSE 写出   │   │  │   connection/runtime(slots/sessions)/theme/i18n │
│  ├ GET /plugins/<id>/client.js    │   │  ├ 后续组(先行组齐后装): layout/sidebar/           │
│  │                                │   │  │   conversation/trajectory                      │
│  └ GET / 注入 window.__DSH_BOOT__  │   │  └ session scope ×N（观看驱动,惰性建）             │
└───────────────────────────────────┘   │      └ Session 对象（对象层核,可订阅快照源）        │
                                        │ React: loading 页 → 全部插件就绪 → 整 UI 一次成型   │
                                        │ zustand: 观看态（导航/布局/偏好/草稿）              │
                                        └───────────────────────────────────────────────────┘
```

## 2. 分层模型：host 三包与方向纪律

目录按**能力提供方**分层（不按产品形态）：`packages/host/*` 只供 host 侧能力，`packages/client/*` 只供 client 侧能力（每包单侧），`apps/` 放对外应用形态（host/client 混合体的装配——混合体永远不成包，装配写在 app 里）。

| 层 | 包 | 职责 | 关键纪律 |
|---|---|---|---|
| 前置层 | `dsh-host-apiproxy` | TS/zod 契约定义（api/）+ fetch 抽象（handler + 客户端基类） | node 与浏览器皆可 import；client 只准消费 `/api`、`/client` 两个浏览器安全子路径（type-only+基类）；消费端不得绕过 api 直连 ctx |
| 装配层 | `dsh-host-runtime` | 插件组合 + ApiProxy 集成；host 级配置的家 | 挂哪些插件、什么默认值只在这里定；壳不得改装配 |
| 载体层 | `dsh-host-webserver` | Web 形态 HTTP：静态托管 + `/api/*`→handler 转发 + SSE 写出 + 关闭语义；**插件分发端点 + __DSH_BOOT__ 注入** | 零 workspace 依赖——webserver 不依赖 runtime，靠 `{fetch}` 形注入（运行时注入关系，非包依赖） |
| client 侧 | `packages/client/*` 12 包 | §4 起 | 消费面只经 ApiProxy |
| 应用形态 | `@deepseek-ai/dsh`（apps/cli） | bin 分发 + 每形态一个装配模块（web.ts/headless.ts，动态 import 互不加载） | dist 位置这类 workspace 知识只住 app |

命名规则：host/、client/ 两组的包名必含目录组前缀（`dsh-host-runtime`、`dsh-client-web-react`）；tsconfig.base.json 需逐包显式 paths 条目。
**类型宇宙隔离**：typecheck=host/client 双 TS program（`tsc -b tsconfig.json tsconfig.client.json`：根=host 聚合、tsconfig.client.json=client 聚合）——两侧都对 cordis Context declare merge 同名键（sessions/loader），双 program 使其永不同室；client 经 session/llm/tools/approval/interaction 的**纯类型子路径**（./types 等）消费 wire 词汇表，不装载 host 的 augmentation（细案=missions/tasks/20260721-1520-web-plugin-rfc/clientcontext-audit.md）。

**新形态接入清单**：①选 fetch 形态（浏览器同源 HTTP / 进程内 `host.handler.fetch` 注入 / 自定义 doFetch 子类如将来 Electron IPC）②在 apps/ 写装配模块（startHost + 客户端子类 + 该形态的信号/打印/退出语义）③需要 HTTP 载体才 import webserver，否则零端口。现有两形态即模板：`apps/cli/src/web.ts`（startHost+startWebServer+信号关停）、`headless.ts`（startHost+InProcessApiClient 同构直调，零 HTTP 零端口）。

## 3. wire 协议：四象限消息模型

物理通道各异（HTTP/SSE、进程内直调、将来 IPC），协议因此与通道解耦：每条逻辑消息按「谁发起 × 请求/应答」两轴四格：

```
                 client 发起                      server 发起
  request   ① ClientRequest                 ③ ServerRequest
            （POST /api/<method> body）      （SSE 帧：session 事件、审批/问答 requested）
  response  ② ServerResponse                ④ ClientResponse
            （该 POST 的 HTTP 应答体）        （POST /api/respond body，回填 ③ 的 rpcId）
```

- **rpcId 纪律**（branded string）：谁发起谁 mint；应答只回显、永不新 mint。server-request 分两种（method 静态区分，无第三种）：**可应答帧**（approval/question requested——受理时 mint 一次稳定逻辑 id，基线重放原样复用，client 应答回显）与**纯推送帧**（session/event 等——每次推送新 mint）。业务代码永不 mint：unary 收敛在客户端基类 `callUnary`，帧收敛在 host 侧。
- **签名窄形**：领域接口只见 `RpcRequest<P> = {rpcId, payload}` / `RpcResponse<T> = {rpcId, result}`；载体层把窄形补全为带 type/method 的全形——方向永不从通道推断。`RpcResult<T> = {ok:true; value} | {ok:false; error: RpcError}`，方法不 throw 业务错误。
- **类型系统单一事实源**：方法参数/返回结构只活在领域接口签名里；`RpcMethodMap` 登记方法本身，其余位置（handler/client/测试）一律引用派生泛型（`RequestPayload<K>`/`ResponseValue<K>`）——抄字面量或引入扁平命名类型是禁令。错误码全集=`RpcErrorDetailsMap`（code 判别、details 必填，新码=一行 map+一条 schema 分支，漏写=编译错）。传输故障（网络断、host 未起）由载体层抛异常，与业务错误两层永不混。
- **双向 zod 校验**：全形 schema 一次（type/rpcId/method 结构）→ 按 method/帧型分发的业务 payload 第二次；拒收=`bad-request`。透传纪律：wire 上的事件/消息/内容块**就是核心类型**（SessionEvent/ContentBlock，type-only 链直达浏览器），无第二套 DTO；SessionEventMap merge-extensible，未知类型走 documented-default（忽略），信封保持 strict。
- **RpcReceipt**：④ 的 HTTP 应答体是载体回执 `{accepted} | {accepted:false; reason:'not-pending'|'bad-response'}`——不是 RpcMessage（应答没有应答）；迟到/重复应答得 `not-pending`，逻辑收敛面是 `*/resolved` 帧。

**客户端基类族（AbstractApiClient）**：协议不变量全在基类（mint→POST 全形→schema parse→rpcId 回显核对→窄形出）；平台差异只有两个切面——抽象方法 `doFetch`（传输）+ 可覆写 `onEnvelope`（观察，实例级微任务合批缓冲，RPC 调试面板即其纯订阅者）。子类表：

| 子类 | doFetch | 用途 |
|---|---|---|
| `InProcessApiClient` | 注入的 `{fetch}` handler | **同构点**：`new InProcessApiClient(toFetchHandler(api))` 不碰网络但真跑 wire 序列化/zod/SSE 分帧——headless 与协议层测试都用它 |
| `WebApiClient` | `globalThis.fetch` 同源 `/api/*` | 浏览器形态 |
| `FixtureApiClient` | 不用（协议层覆写 callUnary/openMux 等） | 无服务器 UI 开发：自身即假 server，`?fixture` URL 切入，装配零分叉 |
| （将来）IPC 子类 | IPC 往返 | 只换 doFetch，契约与基类不动 |

**session 语义承诺**（impl 侧）：history=事件重放（一次 fold 在 client；分页边界对齐消息边界；无第二套物化快照系统）；重连=重建（断线重开流+重拉 history，`subscribed.lastSeq` 对缝一次回补；无 cursor 续传）；cold session 隐式 resume（history/prompt 打到未附着会话时自动拉起，in-flight 表去重）；审批/问答=requested 帧稳定 rpcId+先答先赢+host 内存 pending 表唯一裁判，审计走持久 log（帧=活控制面，事件=持久审计）；无协议版本号（client/host 绑定发布）。**扩展是机械五步**：领域接口加签名→map 一行→schema 对→UNARY_ROUTES 一行→impl 实现。

## 4. client 侧包地图（12 包）

| 包 | 角色 | 关键物 |
|---|---|---|
| `ui-slots` | slot 注册表纯核（零依赖） | SlotMap 类型、SlotCore、ScopedSlots 类型 |
| `ui-primitives` | 纯 React 原子件（零 cordis） | StateDot 四色、ic_ds_* 图标族、Button/Pill/Menu、markdown 族 |
| `web-react` | ctx↔React 全部胶水 | createSnapshotStore、bindSnapshotSelector、SessionProvider、renderSlot 实现、useInvoke |
| `connection` | wire 消费层 | IApiClient 子类族、ConnectionController（SSE 双流+重连）、fixture |
| `runtime` | client cordis 启动+核心 service | SlotsService、SessionsService（scope 树+对象层）、ClientLoader |
| `ui-layout` | 壳插件 | AppFrame 三栏、ctx.layout（导航+面板观看态总归口） |
| `ui-sidebar` | 左栏插件 | 会话多级树、搜索、分组、状态点 |
| `ui-conversation` | 对话域（最大包） | conversation 骨架、chat 视图、ctx.toolviews、details 面板 |
| `ui-trajectory` | Trajectory/Waterfall 视图 | 零 service 的纯消费型插件（最小插件样板） |
| `ui-theme` | 主题 | ThemeService；token=cssdesign/ 的 `--dsw-*` 体系 |
| `i18n` | 文案 | I18nService、bind(ns)→t |
| `web` | 入口壳 | boot、AppRoot、require 模块表供给、vite/构建管线 |

依赖方向：`ui-slots ← web-react ← runtime ← ui-*（并列）← web`；ui-primitives/ui-theme/i18n 零依赖旁路。全部 ESM、strict TS。

## 5. 数据对象层（runtime/sessions，React-free）

流式事件驱动的会话 UI 里，业务状态（事件窗口、流式累积、pending 交互、连接状态机）若散在 React 组件和全局 store，每个 token chunk 都会摇动渲染树。对象层因此独立于 React 存在（zero React import，grep 可断言）：

```
mux/host 帧（ConnectionController 泵入,sinks 单向注入）
        ▼
SessionManager.handleMux/HostEnvelope   带 sessionId 的帧只投已存在实例
        ▼                                （审批/问答 requested 例外:入 pendingBuffers 缓冲,实例化时重放）
Session.handleMuxEnvelope ──► events 窗口（seq 连续升序,seq 是唯一去重键）
        │                        │ 定稿事件           │ chunk
        │                        ▼                   ▼
        │                   FoldAdapter        PartialAccumulator
        │                  （→ nodes）          （→ partial,delta 只换该块引用）
        ▼
Notifier 微任务合批 ──► ConversationSnapshot 缓存（结构共享）──uSES──► React
```

- **Session**（懒建常驻，切走切回秒显、草稿天然存续）：操作面 prompt/cancel/open（拉尾页 history，幂等）/loadOlder（向上翻页防重入）/resync（重连重建）；订阅面 subscribe/getSnapshot（恒返缓存引用）。open/缝合语义：open 落定后按 seq 合并 liveBuffer 去重；`subscribedLastSeq` 超窗口尾且未覆盖则回补一次。
- **ConversationSnapshot**（不可变快照契约）：nodes（定稿节点，fold 产物）/partial/runningCalls/pending/running/removed/openState/hasMore/promptError/draft 等。**引用纪律**（memo 与 uSES 的前提）：顶层对象每变必新；nodes 数组重建但**元素引用来自缓存**（分段 rev：calls/pending/nodes 各持版本号，事件只 bump 相关段，未变段复用旧引用）。
- **FoldAdapter** 复用核心 SurfaceManager（增量折叠；分页窗口 seq>0 用哨兵垫齐；跨窗口 replace 触发时降级容错线性扫描并置 foldDegraded）。**PartialAccumulator**：chunk 不进 fold（O(1) 跳过），累积成 AssistantBlock[]；定稿 assistant/message 到达即弃累积器（同一批内，partial 区无闪烁提升）。成本模型：每 chunk=一次字符串拼接+一个脏标记；未订阅 Session 在帧风暴下只花脏标记。
- **Notifier 双通道**：`markDirty()`（默认，帧驱动一律用）微任务合批，N 变化=1 通知=1 重渲染；`notifyNow()`（仅用户手势直接回响）同 tick 重建+通知——受控输入（textarea 由快照 draft 控制）延迟到微任务会导致 DOM 回滚+光标跳尾。帧驱动/异步回调用 notifyNow=合批塌回逐帧渲染，禁。
- **ConnectionController**：开 mux/host 双流 for-await 泵入，断线指数退避重连（500ms 翻倍至 10s 封顶，抖动，无限重试），代号围栏丢弃旧代残帧；sinks 单向注入（Controller 不认识 Session）；`onConnected`（双流开+describe 成功，含首连）→ refreshList + 各已打开 Session resync。

**插件化体系对对象层的改造只有两行**：Session 补 `implements ObservableSnapshot<ConversationSnapshot>`（subscribe/getSnapshot 本就同形）+ 构造时 `useSelector = bindSnapshotSelector(this)`。buildSnapshot 与上述全部机制原样保留。被替换的是旧消费面：hooks 直连 manager 单例（`getSessionManager()`）的形态、旧壳三 registry、`--bg-*` 旧 token——由 §7 起的插件模型接管。

## 6. UI 插件模型：双入口 host 插件

**每个 UI 插件同时是一个 host 插件**——UI 插件出现在 host 的 cordis.yml 里、由 host Loader 管辖生命周期，浏览器端装载清单由此推导，装/卸插件=改 host 配置重启（config 同源）。

```
my-plugin/
  package.json   "dshClient": { "inject": ["ui-layout"], "platform": "web", "immediately": true? }
                 "exports": { ".": <node半边>, "./client": "./dist/client.js" }
  src/index.ts         node 半边:cordis host 插件（纯 UI 插件=空 apply,存在意义=受 Loader 管辖;
                       带 host 逻辑的插件在此加码）
  src/client/index.ts  浏览器半边:apply(ctx) —— 挂 service/建 store/注册 slot 与 toolview
  src/client/*.tsx     React 组件（零框架 import,只认 props）
  src/client/*.module.css   CSS Modules,只用 var(--dsw-*)
  dist/client.js       tsdown 闭包工厂产物（单文件,CSS 内联,external→require DI）
```

`dshClient` 字段：`inject: string[]`——client 半边装载依赖（与 cordis inject 同名同念，决定装载拓扑序）；`platform: 'web'`（一插件一平台）；`immediately: true`——先行装载组（基建四包：connection/runtime/ui-theme/i18n；并行拉取+组内 inject 拓扑 apply，全组就位后才装其余插件；仍是标准动态 bundle，非静态打包）。client 产物路径取标准 `exports["./client"]`。`./shared` 入口（跨线私有契约）仅在插件自带 host 数据面时出现——当前无此类插件。**类型宇宙隔离**：client 半边编译单不得看见 node 半边的 Context merge（verify-client-closure gate 全覆盖）。

## 7. 装载链：从刷新到可用

```
GET /
  → host webserver 渲染 index.html,注入 window.__DSH_BOOT__ =
      { plugins: [{ id, url: '/plugins/<id>/client.js', inject, immediately? }] }
    清单来自 HostWebPluginRegistry:订阅 host Loader 加载面,收集带 dshClient 声明的已加载插件
    ——HTML 到手即知要拉什么,零额外往返
  → web 壳启动:挂 ctx.loader(机件由壳静态持有——装载器不能经自己装载),
    播种纯库实体(react/react-dom/cordis/ui-slots/web-react/ui-primitives)进 require 模块表
  → createRoot 渲染 boot loading 页（纯壳组件,不依赖任何插件）
  → loader.start(): immediately 组(connection/runtime/theme/i18n)并行拉取+组内 inject 拓扑
    apply,全组就位后其余按 inject 拓扑逐个装载:
      <script> 注入 → bundle 执行 DSHClientProxy.loadPlugin({ id, factory })（id 对账,错配 fail loud）
      → loader 调 factory(require) —— bundle 是闭包工厂,external 依赖经 require(spec)
        从模块表取（cordis 依赖注入实体;无 global、无 import map;查无=fail loud 报缺依赖）
      → factory 返回模块导出面(含 apply) → ctx.plugin(apply) → 导出面以包名登记进模块表
        (inject 拓扑保证后装者可 require 先装者) → 内联 CSS 注入 <style data-plugin="<id>">
  → await loader.settled() → AppRoot 从 loading 页切换渲染真 UI（一次成型）
```

- **一次成型**：默认等全部插件装载完再画实际 UI；单插件失败=loading 页显式报错，不做部分可用（渐进点亮/Suspense 为后续项）。
- **卸载**：`loader.unload(id)` 当前空实现（完整链——Fiber dispose→注册级联收回→移除 style——随 HMR 立项补齐）。
- **CSS 隔离**：CSS Modules 哈希类名 + style 标签带插件 id 归属；插件包禁 `:global` 越界与裸元素选择器。
- **dev 工作流**：与 prod 同链——插件包 `tsdown --watch` 重编译，改完刷新；无 HMR；vite 只管 web 壳。fixture 模式注入同一份 __DSH_BOOT__ 协议，双模式同构。

## 8. service 名册（插件间唯一 API 面）

service 是插件对外能力的唯一形态——UI 组件与注入面都不是 API；没有被调用需求的插件就不挂 service（ui-trajectory 即样板）。

| service | 提供者 | 职责 |
|---|---|---|
| `ctx.connection` | connection | api client + 双流句柄挂载面 |
| `ctx.slots` | runtime（核在 ui-slots） | define/register/entries；变化发 `'slots/changed'` cordis 事件 |
| `ctx.theme` | ui-theme | register/apply（=切 `body[data-ds-dark-theme]`）/current |
| `ctx.i18n` | i18n | register(ns, locale, dict) / bind(ns) / locale store |
| `ctx.sessions` | runtime | list store、manager、create、scope(id)/binding(id)、ancestry(id) |
| `ctx.loader` | runtime（代码家）；机件由 web 壳静态持有并 boot 时挂载——装载器不能经自己装载 | start/load/unload/settled/status |
| `ctx.layout` | ui-layout | current+viewFor+sidebar+details 四面观看态；open/openView/openDetails 导航动作 |
| `ctx.conversation` | ui-conversation | send/cancel（scope 寻址）、startSession、selection、openDetails 编排、registerView、drafts |
| `ctx.toolviews` | ui-conversation | 具名工具渲染注册表（§12） |

**scope 寻址范式**（与 host 侧 tool/system-prompt 同构）：service 是 root 单例、scope 敏感——方法不收 sessionId 参数，从 caller ctx 读 scope 标（`scopeOf(ctx)`）。per-session 语境里 `ctx.conversation.send('hi','queue')` 自动打到本会话；root 语境定向=换 ctx：`ctx.sessions.scope(id)!.conversation.send(...)`（用完即弃）；root 语境直接调 scoped 方法=throw。

## 9. session scope 树

client 侧按会话建 cordis 子 scope，机制与 host 的 agent scope 完全同构（dsh-scope mintScope：`ctx.plugin(no-op)` 得 Fiber 载体 + `extend({[kScope]: id})` 打标）：

- **生命周期权威=观看需求**：首次解析（选中会话/binding(id)）惰性建；host 端会话结束 ≠ scope 拆除（转 frozen 只读视窗）；列表 removed 且无人观看才拆。
- scoped ctx 承载三件事：service 的 scope 寻址（§8）、per-session 状态挂账（conversation 的 selection/drafts 按 scope 实例化）、注入面的会话绑定（§11）。
- **两侧 session 范畴不对称**（公理）：host session=过程（启动→事件流→结束，历史的作者）；client session=视窗（任意时刻连上/离开，要处理 history 回补）——cold（纯历史）→ live（续流）→ frozen（终局只读）状态机。client 不建第二套 agents 集合：agent 的存活即状态机 live 态，session→agent 解析（含 resume-on-prompt）是 host 权威。

## 10. slot 系统：页面怎么拼

页面是一棵坑位树，谁拥有区域谁声明坑位；类型与所有权由两个机制拼出：

**① SlotMap 声明合并**（仓库 typed-events 惯例复用）——坑的契约在 declare 处一次定死：

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap {
  sidebar:      { kind: 'single'; scope: 'root';    props: SidebarRootProps }
  conversation: { kind: 'single'; scope: 'session'; props: ConvRootProps }
  details:      { kind: 'single'; scope: 'session'; props: DetailsProps }
} }
ctx.slots.define('sidebar', { kind: 'single', scope: 'root' })  // declare=类型,define=落账
ctx.slots.register('conversation', ConversationRoot)            // 组件函数直接注册,FC<props> 编译期锁
```

- **三型**：`single` 独占（重复注册 throw）、`list` 多注册（id/order/label）、`keyed` 按 key 运行时分发（重 key throw）。register 到未 define 的 key=运行期 throw。
- **scope 轴**：`root`（无会话语境）/`session`（有）——决定注入面形态（§11）。
- **② inject 链即所有权链**：注册进谁的坑就 `inject:` 谁——没 inject 到 owner=装配期 fail loud；owner 卸载=下游注册级联收回（cordis 原生语义）。

**渲染侧没有全局组件**：owner 组件从 props 拿到白名单收窄的 `slots: ScopedSlots<'a'|'b'>`，用 `slots.renderSlot(key, props)` 渲染——能开哪些坑写在组件签名上（自己 define 的+被显式转授的），越权=编译错。渲染方供参与注册方组件签名来自同一条 SlotMap 条目，改契约两侧同时报错。

顶层坑位（layout 声明）：`sidebar`（左栏）、`conversation`（中栏）、`details`（右栏）。conversation 再开子坑：`conversation.views`、`conversation.statusline`。完整坑位留位表见 plugins.md §1。

## 11. React 面：完全外部注入

**组件文件对框架零 import；所需一切经 props 注入；唯一铁律=注入物引用稳定。**

```tsx
export function BashRow({ callId, block, useSession, actions, t }: ToolViewProps) {
  const running = useSession(s => s.runningCalls.some(c => c.callId === callId))
  const [open, opening] = useInvoke(() => actions.openDetails())
  // ...纯渲染,样式只用 var(--dsw-*)
}
```

props 三源合并（渲染基件做，owner 只写第一份）：

```
① owner 供参:     renderSlot 的 props 位——身份(sessionId/callId)/展示参数/frozen 切片
② scope 标配注入: session 坑自动获得 useSession(绑定正确的 Session 对象);root 坑没有
③ 注册方私有注入: register 的 inject 工厂——per-(注册项×session) 只调一次并缓存
     inject: (b) => ({ useMyStore: store.useSelector, actions: {...}, t: ctx.i18n.bind('ns') })
     b = SessionBinding{ sessionId, session, ctx } 或 RootBinding{ ctx }
       —— apply 世界的装配句柄,用完即弃,永不进 React
```

- **props 白名单五类**（其余禁止，尤其 class 实例/ctx/可订阅源）：branded 身份、纯展示参数、owner 已物化的 frozen 切片、框架注入的 hook/动作/文案（引用稳定）、罕见纯 UI 协调回调。判据：**props 传「定位你的已物化数据」，活数据自己用注入的 useXxx 订。**
- **hooks 的 uSES 契约四条**（防撕裂，新 hook 逐条自检）：getSnapshot 恒返缓存引用、调用中不计算；subscribe 引用稳定（实例常驻保证切换外零重订）；纯 CSR 不传 getServerSnapshot；双源一致（running 位同时在列表项与会话快照——同一帧驱动、同一微任务批 flush，单渲染周期内一致）。
- **跨层动作走转交链**：组件只调自己坑 owner 注入的动作；owner inject 别家 service 转调。范本=openDetails：工具行→（chat 注入面）→chat 视图→（inject conversation）→conversation 写 selection + 调 ctx.layout.openDetails()。组件永远不跨层认识非 owner 的 service。
- **SessionProvider（框架内建，开发者不写）**：订 `layout.current` → `sessions.binding(id)`（常驻恒等引用）→ Provider `key={id}` → 渲染 conversation+details 两坑。切会话=右侧子树重挂（数据在对象层保温）；不切=零刷新。全树只有这一个 Provider。

## 12. toolviews：具名的、按会话维度的工具渲染注册表

工具行渲染不走 SlotMap——它被 chat/trajectory/waterfall 多视图共同消费、且要按会话差异化，是独立的具名 service：

```ts
ctx.toolviews.register('bash', BashRow)                                    // 全局注册
ctx.toolviews.register('bash', SwarmBashRow, { scope: id => isSwarm(id) }) // 特定会话族专属形态
// 渲染方: resolve(tool, sessionId) —— scope 匹配 > 全局 > undefined(fallback GenericToolCard)
```

视觉形态（figma 定稿）：单行摘要行（16px 图标⇄chevron 槽+标题+摘要），5 变体（think/search/read/bash/others 兜底），无行内输出——完整输出走 details 面板。

## 13. 数据流全景与状态归属

```
SSE/RPC → 对象层(§5:Session/store,活对象,命令式) → ObservableSnapshot 面
   → frozen 快照(结构共享) → useXxx(selector) → 组件 → memo(shallow) → DOM
```

- **数据契约只有一个**：`ObservableSnapshot<T>`（getSnapshot/subscribe）。两种源同构满足：Session 类（§5，天然满足）与 `createSnapshotStore`（zustand vanilla + immer + subscribeWithSelector + rafFlush 中间件 + persist opt-in + dev freeze——插件自家数据与壳观看态用）。
- **相等性协议**：生产端=结构共享；消费端=selector 等值短路（Object.is 默认，选对象声明 shallowEqual）；React.memo shallow。深比较全链禁止。数据形态转换全链只有三次（wire JSON→类型化事件→内部可变态→frozen 快照）——组件/容器里 map/filter 出新引用即打穿 memo。
- **动作方向**：注入 actions 引用恒定；结果不回传——后果以事件回声从读方向回来（**无乐观插入**：自己的消息也等 log 回声，多端/刷新/重放零特判；乐观 UI 只准表达"发送中"按钮态与草稿乐观清空-失败回填）；useInvoke 只管 pending。
- **「状态住哪」决策树**：per-session 且要跨切换存续 → Session 对象/scope 挂账；单视图容器私有（滚动等瞬时）→ 组件 useState；壳级观看态（选中/面板/偏好/草稿）→ ctx.layout 与 conversation.drafts 的 zustand store；业务数据 → 永远对象层，永不进观看态 store。
- store 共享=export store 对象或放注入面（owner 给出口）；无全局 store；插件不开自己的 React Provider。
- **空态首发链**：无会话时 conversation 坑渲染 EmptyState（居中大输入框+project/cwd 下拉）；提交走 `conversation.startSession({cwd?, text, mode})`——service 内部编排 create→open→send 三连。

## 14. 布局与导航：ctx.layout

壳级观看态总归口（zustand+persist）：`current`（选中会话）、`viewFor`（每会话激活视图）、`sidebar`/`details`（open+width）。

三栏动态规则（全文 plugins.md §0.1）：两侧栏可拖宽+可开合（Handle=拖拽把手，折叠按钮在 Logo 行）；窗口过小自动缩两侧、优先缩 details（details→sidebar→中栏 min 640 兜底）；输入框随中栏对等缩（736/776 为上限）；details 收起=0 宽不 unmount；composer banner 堆叠不设上限；审批=composer 整体换新面板（非顶部加条）；空态→有内容=同一输入框组件位移；树深层 `...` 截断。

## 15. 样式与主题

- **token 唯一来源=cssdesign/ 两份文件**：`--dsw-static-*` 色阶层 + `--dsw-alias-*` 语义层 + 渐变/阴影/blur/字体。暗色=`body[data-ds-dark-theme]` 整段覆写；`theme.apply(id)`=切换该 body 属性——换肤是 CSS 级联，React 零渲染。两份 CSS 由 web 壳直接引入为 base 样式表；第三方主题=覆写同名 alias 变量。
- **工程约束**：CSS Modules + clsx，无组件库、无 tailwind；组件禁 hardcode 色值/阴影/渐变（一律 `var(--dsw-*)`）；字号不 token 化——组件里写 px 且成对写行高（常用对 16/24 气泡、14/22 UI 默认、12/18 辅助），间距用 4 的倍数；代码字体栈末位不放 `monospace`（防 Windows 中文回退宋体）。
- **i18n**：ns×locale 字典注册+fallback 链；`bind(ns)` 产物引用恒定可进注入面；locale 切换整树重渲染（低频可接受）。zh/en 起步。

## 16. 完整组件树

打开会话 S、chat 视图、一条消息带自定义 bash 行（■=框架件 □=插件件）：

```
■ <AppRoot>                      loading 页 → await loader.settled() → 整 UI
└─ □ <AppFrame>                  ui-layout;三栏 grid+两条拖拽把手
   ├─ (左列) renderSlot('sidebar')
   │  └─ ■ ErrorBoundary → □ <SidebarRoot useTree actions>      root 坑:无 useSession
   │     └─ □ <SessionRow …/>×N    props:父自己 map(普通 children,不过注册表)
   │          点击 → actions.open(id)             ← 注入③→ctx.layout.open
   ├─ ■ <SessionProvider key="S">                 订 layout.current;恒等 Session 引用
   │  ├─ (中列) renderSlot('conversation', {sessionId})
   │  │  └─ ■ EB → □ <ConversationRoot sessionId useSession slots>   ①+②+③
   │  │       ├─ □ <Header/> <ViewSwitcher/>      骨架自有 UI(views 清单+layout.viewFor)
   │  │       ├─ slots.renderSlot('conversation.views', {sessionId}, {only:'chat'})
   │  │       │  └─ ■ EB → □ <ChatView useSession useSelection actions>
   │  │       │       └─ □ <MessageItem node/>×N   props:frozen 切片,memo 短路
   │  │       │            工具块→ ■ <ToolViewOutlet tool="bash">    查 ctx.toolviews
   │  │       │              └─ ■ EB → □ <BashRow callId block useSession actions t>
   │  │       ├─ slots.renderSlot('conversation.statusline', {sessionId})
   │  │       └─ □ <InputBar draft running onSend onStop>   骨架自有;draft=conversation.drafts
   │  └─ (右列) renderSlot('details', {sessionId})
   │     └─ ■ EB → □ <DetailsPanel …>             订 selection,显示选中 call 的 args/result
```

读树四规律：跨插件边界=renderSlot（注册表+ErrorBoundary+注入合并），插件内部=普通 children/map；useSession 只在 session 坑自动合入；inject 注入只出现在声明了私有注入面的注册项上；全树 Provider 只有 SessionProvider 一个（值恒等），其余传递全走 props。

## 17. 渲染性能模型

| 场景 | 行为 |
|---|---|
| 流式 token 风暴 | 只有正在流式的气泡每帧渲染（对象层合批+partial 单块换引用）；历史 MessageItem memo 短路；统计行/列表/details 零渲染；未订阅 Session 只花一个脏标记 |
| 切换会话 | sidebar 零渲染（没订 current）；右侧重挂但数据在对象层保温（实例常驻），毫秒级 |
| 打开/拖宽 details | 布局列宽变化；组件不 unmount |
| 长对话 | 分页加载 + content-visibility + 工具行默认收起 |
| markdown | 已闭合块 memo，只重 parse 尾部未闭合块 |
| 换主题 | body 属性切换，CSS 级联，React 零渲染 |

hook 幂等五条（并发渲染安全的根）：getSnapshot 纯读+引用稳定；subscribe 稳定；selector 走等值短路位、不在组件体二次加工；invoke 稳定且 pending 不走 setState；render 体零副作用。

## 18. 测试体系（三层）

| 层 | 被测物 | 关键手法 | 位置 |
|---|---|---|---|
| 1 协议同构 | AbstractApiClient + toFetchHandler（双向数据/rpcId/zod/SSE 分帧/合批/超时） | **同构点全链**：`InProcessApiClient(toFetchHandler(脚本化 impl))`——零浏览器纯 node，真跑 wire 序列化 | apiproxy/tests |
| 2 对象层编排 | Session/Manager/Connection（缝合/去重/分页/乐观清稿/pendingBuffers/重连/退避） | 「事件序列进→快照出」金路径：可编程 fake + deferred 控时序 + fake timer 控退避 | runtime(sessions)/connection tests |
| 3 浏览器冒烟+插件链 | 构建产物×真浏览器（boot/装载链/一轮会话） | 裸 playwright chromium；fixture 级+真 host 级（无 key 自跳过） | web/tests e2e |

层间纪律：**各层测各层，上层不复测下层**——冒烟只证接线活着，交互细节归 verify 脚本（missions/scripts/），wire 语义归 1 层，数据语义归 2 层。纯函数层（lineage/partial/notifier/fold）零 fake 直测。**每修一个 bug 钉一条断言**（浏览器可见 bug 钉 verify 脚本回归段，数据层 bug 钉对应 spec）；**fixture 全绿不算完，真 host 必须过**（fixture 短路的恰是 wire 载体链——node:http 桥关闭语义、真网络时序，两次实证 bug 都藏在那）。插件化新增验收：装载链 e2e（__DSH_BOOT__→settled→单插件失败 fail loud）、toolviews 差异渲染、三栏拖宽让步、暗色切换、React Profiler 计数断言（流式期间统计行=0 等）。

## 19. 当前范围与预留

**本期交付**：装载链全通（__DSH_BOOT__→闭包 DI→settled 一次成型）+ 三栏壳（拖宽/开合/让步）+ sidebar 会话树 + conversation 骨架（Header/tabs/composer/空态）+ chat 视图（消息流+工具行 5 形态+统计行）+ details 极简（选中 call 的 args/result）+ selection 通道 + 双主题 + bash 自定义工具行样例（注册表全链实证）。

**预留位已留、实现后置**：审批 composer 换面板与追问队列（协议帧与 pending 语义已在 wire 层就绪，host pending 表未实现——`respond` 现为 stub 恒 not-pending，PendingCard 显示为主）；slash 命令注册表；Trajectory/Waterfall 真实现与锚点深链；details 三段（Input/Output/Metadata）与步进；附件上传；context 进度指示；toast 通知；HMR 与渐进渲染；unload 完整实现；双半边插件私有 wire 通道；agent 级隔离；虚拟化长列表；i18n 存量文案抽取。协议侧预留缝（实现即五步机械展开）：`session.fork`、`prompt.mode 'inject'`、`task.list`、`host.listModels`、describe 的 hostInstanceId。
