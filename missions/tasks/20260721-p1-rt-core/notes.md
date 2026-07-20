# rt-core 实现计划（connection + runtime + host 侧刀）

> 开工前档案（2026-07-21）。契约=api-contracts v3 §0.3/§3+§3.1/§4/§9.1/§9.2；等「T0 完成」广播后动 packages/。

## 0. 范围回述

1. **connection**：T0 把 web-runtime 的 wire 消费层 git mv 过来，接口零变化对账，导出清单附 v3 §3 尾；§3.1 纯度对账清单（见 §2）。不 import cordis（运行时值层面；类型 `import type` 允许）。
2. **runtime**：SlotsService / SessionsService（list store+scope 树+binding/ancestry/create）/ Session 两行加法 / scopeOf / ClientLoader（实现归我，boot 挂载归 ui-shell）。
3. **host 侧刀**：HostWebPluginRegistry（webserver 属地）+ GET /plugins/&lt;id&gt;/client.js + GET / 注入 __DSH_BOOT__；全新实现，不看其他 worktree。

## 1. connection 对账（预勘，T0 落地后按实际盘面修订）

### 1.1 迁入文件与导出面草稿（= 附到 v3 §3 尾的清单底稿）

| 文件 | 导出 | 处置 |
|---|---|---|
| api.ts | 类型 re-export（ApiProxy/SessionsApi/SessionSummary/HostApi/EventsApi/MuxFrame/HostFrame/ApprovalResponsePayload/QuestionResponsePayload/HistoryEntry/ToolEventView/ToolCallView/ToolResultView/Rpc* 族/IApiClient/SessionId/SessionEvent/ContentBlock/StreamChunk）+ 值导出 RpcId/AbstractApiClient + `resultOf`/`transportError` | 原样 |
| connection.ts | ConnectionController/ConnectionConfig/ConnectionSinks/ConnectionState | 原样（契约文字写的 "connect/ConnectionHandle" 是旧稿措辞，现状实体即此四件，对账清单按实际写） |
| web-api-client.ts | WebApiClient | 原样 |
| fixture.ts | createFixtureApi/FixtureApiClient | 原样 |
| events.ts | WEB_EVENTS/WebEventName | 原样（cordis 迁移的事件名锚点，零 cordis 运行时依赖） |
| intents.ts | **不留在 connection**：rpc-log 五 intent 随 D18 死；pingHost 死（面板供数）；refreshSessions/createSession 被 SessionsService 吸收。文件不迁入 connection 导出面 | 溶解 |
| store.ts / rpc-log.ts / boot.ts | 不属 connection（store 随迁 runtime 评估并入 sessions；rpc-log D18 删；boot 迁 runtime/kernel 改造） | — |

注：ConnectionSlice（connection 状态可见性）原挂 zustand store；新去处=runtime 侧（connection 状态进 SessionsService 伴生 store 或 ctx.connection 挂载面），实现时定，不进 connection 包（connection 保持纯 wire 层）。

### 1.2 ctx.connection 服务（architecture §8）与「不 import cordis」的相容

connection 包源码（lib 面）零 cordis；其 client 半边（src/client/index.ts 的 apply）只用 `import type { Context }` + 运行时经 loader require 表拿实体，apply 内用 `ctx.set('connection', handle)` 挂载（不继承 cordis Service 类，避免值依赖）。若实现中发现必须要 Service 类，改从 require('cordis') 取（DI 表有 cordis 实体）。

## 2. §3.1 纯度对账清单（初稿；判据=换个消费面还需要吗）

盘点位置：`packages/host/runtime/src/api-proxy.ts`（存量全在此，apiproxy 包本体只有契约+fetch 胶水，干净）。

| 存量 | 位置 | 判决（v3 §3.1） | 执行 |
|---|---|---|---|
| `agentFor`（隐式 resume-on-prompt/history + in-flight 表去重 + assertServable 门） | api-proxy.ts:243 | **下沉 host 能力位** | P-I 原样用；TODO(P-II)：下沉到 agents/host 能力层（如 `ctx.agents.resolveOrResume`），api-proxy 只留窄形胶水 |
| `summarizeCold`（cold 列表合并 + mtime 兜底） | api-proxy.ts:123 | **下沉 host 能力位** | P-I 原样用；TODO(P-II)：归 persistence/sessions 能力层 |
| `paginate`（消息边界分页，sourceEventSeqs 组界） | api-proxy.ts:31 | **留**（wire 契约的读投影） | 不动 |
| `viewFor` / `backscanArgs`（ToolEventView 呈现计算，含 events.mux 内 openCalls 配对表） | api-proxy.ts:167/195 + mux 流内表 | **P-I 随 toolviews 迁移整体删除**（呈现归 client） | ⚠涉 wire 面：HistoryEntry.view / session-event 帧 view 字段 / ToolEventView 类型族都要随删——wire 契约定义面=三不改，此刀需 main 协调排期（toolviews 真实现落地=触发点）；client 侧我这边的 api.ts re-export（ToolEventView/ToolCallView/ToolResultView）搬家时先保零变化，wire 面删时同步删 |
| history 隐式 resume（看历史拉起 agent） | agentFor 被 history 调用 | **可议项，P-I 不改**：应改纯持久化读（cold 历史不该实例化 agent；隐式 resume 只该留给 prompt） | 记清单待 P-II 裁决 |

语义边界重申：隐式 resume 保留（cold→live 是 host 内政）；**永不隐式 create**。

## 3. runtime 设计

### 3.1 SlotsService（小件）

`class SlotsService extends Service`（provide='slots'，cordis 真 Service），内持 `new SlotCore()`（ui-slots），构造时 `core.onMutate(k => this.ctx.emit('slots/changed', k))`；define/register/entries/spec/subscribe/getVersion 纯代理。declare merge Events['slots/changed'] + Context.slots。T0 后先对桩编码，T1 ui-slots 真实现落库换真。

### 3.2 SessionsService + scope 树

- `manager: SessionManager` 现有类原样迁入（runtime/src/sessions/）。
- `list: SnapshotStore<SessionListState>`（{ids, byId}）：createSnapshotStore（web-react），数据源=订 manager（list RPC 快照+host 流增量已在 manager 内闭环，重连重拉=handleConnected 现有路径），manager 通知 → 映射进 store.update。**title 字段 wire 无供数**：P-I 派生占位（cwd basename 或 id 短形），记台账。
- `create(opts)` → manager.create(cwd)。
- `ancestry(id)`：list store 内沿 parentId 回溯，含自身，根在前；断链（父不在表）即止。
- **scope 树**（dsh-scope mintScope 模式客户端照搬，不 import 服务端包）：`ctx.plugin(noop)` 得 Fiber + `fiber.ctx.extend({[kScope]: id})`；`scopeOf(ctx)` 读 symbol。
  - 惰性建：首次 `scope(id)`/`binding(id)` 解析时建；实例表 Map&lt;SessionId, {fiber, ctx, binding}&gt;。
  - frozen 保留：host 死（running 停/host/session-removed 未到）≠ scope 死。
  - removed 拆：list 增量出 removed 且**无人观看**才 fiber.dispose。观看侦测方案（runtime 不认识 layout，不能读选中态）：记「最近一次 binding(id) 解析的 id」为在看者；removed 时若非在看者→立拆；是在看者→挂起，等下一次 binding(其他 id) 解析时补拆。SessionProvider key={id} 重挂语义保证切走必有新解析，故不漏。此方案零新增 API，作为 P-I 实现口径写进 JSDoc。
- `binding(id)`：恒等引用缓存 {sessionId, session: {useSelector}, ctx: scopedCtx}；session 实例=manager.get(id)（常驻，天然恒等）。

### 3.3 Session 两行加法

`implements ObservableSnapshot<ConversationSnapshot>`（subscribe/getSnapshot 本就同形）+ 构造尾 `readonly useSelector = bindSnapshotSelector(this)`。其余核心逻辑零触碰（三不改）。

### 3.4 ClientLoader（最大新件；代码家=runtime，实例=web 壳静态持有）

消费面拆两半：**壳静态 import**（runtime 包常规入口导出 `createClientLoader(deps)`，vite 打进壳）；**runtime 自身的 client bundle**（dist/client.js）只含 slots/sessions apply，不含 loader 机件。

```
createClientLoader({ ctx, modules: seedTable, boot: window.__DSH_BOOT__ })
  ├ DSHClientProxy 单槽 handoff：window.DSHClientProxy = { loadPlugin(def) }
  │   pending: Map<id, resolve>；loadPlugin 按 def.id 对号入座；查无此 id=fail loud
  ├ start()：读 boot.plugins；分组 immediately / rest
  │   immediately 组：全组并行注 <script>（fetch 并行天然成立——script 执行只是把
  │   factory 存进 pending，apply 时机由 loader 控），组内按 inject 拓扑序逐个
  │   factory(require)→ctx.plugin(apply)→导出面登记模块表；全组就位（屏障）
  │   → rest 按 inject 拓扑逐个 load（依赖就绪即装，不整体串行）
  ├ load(id)：注 script → 等 handoff → factory(require) → ctx.plugin(exports.apply)
  │   → modules.set(包名, exports)（后装者 require 先装者）→ style 归属登记
  │   （bundle 执行时自注 <style data-plugin="<id>">，loader 按属性收账备 unload）
  ├ require(spec)：查模块表；查无=throw 明确报「<id> 缺依赖 <spec>」
  ├ unload(id)：P-I throw not-implemented
  ├ settled()：全清单 active 后 resolve；任一 failed → reject（AppRoot loading 页 fail loud）
  └ status: SnapshotStore<Record<id, 'loading'|'active'|'failed'>>
```

- 拓扑排序：inject 引用不在清单内=fail loud；环=fail loud。
- 模块表种子（壳递入）：react/react-dom/cordis/ui-slots/web-react/ui-primitives。
- 双模式验收：真 bundle（tsdown 产物过一遍）+ fixture 注入（手造 __DSH_BOOT__ + 假 bundle 脚本）。
- 与 ui-shell 对界：deps 形状（ctx、种子表、boot 对象）+「AppRoot await settled()」；对象由我定义类型导出，壳只管构造与挂 ctx.loader。

## 4. host 侧刀设计

### 4.1 Loader 订阅方案（vendor/loader 实勘结论）

vendor/loader（@cordisjs/plugin-loader）事件面：`loader/entry-init`（Entry 构造期，**早于 import/apply**）、`loader/partial-dispose`（option-diff/组禁用拆除）、`loader/config-update`；cordis 核心另有 `internal/plugin`（Fiber 创建与销毁各发一次；loader 自己的 handler 会把 fiber.entry 连上）、`internal/status`（状态迁移）。**没有「加载完成」单事件** → 采用契约预设的兜底：**registry 遍历 + update 事件重扫**——初扫 `ctx.loader.entries()`（entry.options.name=包名 specifier，entry.fiber!==undefined=已加载），订 `internal/plugin`（微任务去抖）触发全量重扫重建表。八条量级，重扫零成本；P-I 装/卸=重启生效，订阅只是保表新鲜的廉价保险。

### 4.2 装配缺口（要报 main 的对界问题）

现 `dsh web` 链=apps/cli/web.ts → startHost → bootHost：**纯 ctx.plugin 编程式装配，无 Loader 实例**，而契约 §0.3 说「host cordis.yml 全列八包」+ registry 订 host Loader。最小闭合方案（我拟实施）：host/runtime 装配层加一步 web 插件装载（挂 @cordisjs/plugin-loader + `loader.create({name})` × 八包，内存树），骨干 spine 保持编程式；cordis.yml 文件形态后置。备选=web 形态整体改 Loader boot（动静大，非我属地）。**待 main 拍板**：①内存 Loader 树是否满足「config 同源」P-I 口径；②apps/cli/web.ts 的接线改动（构造 registry 递给 webserver）按跨属地报备处理。

### 4.3 HostWebPluginRegistry（webserver 包内，类归属地、实例归装配）

- `new HostWebPluginRegistry(ctx)`（cordis 仅 `import type`；订阅走传入对象方法，webserver 保零 workspace 依赖）。
- 表构建：遍历 entries → 对每个已加载 entry 解析 `<name>/package.json`（createRequire 以 loader baseUrl/进程根为锚）→ 有 `dshClient` 且 platform==='web' → 入表 `{id=包名, inject, immediately?, clientPath}`；clientPath=解析 `exports["./client"]`（string 或 {default} 条件形都接）为绝对路径。无 dshClient=跳过（非 web 插件）；有声明但 exports 缺 "./client"=fail loud（误配置早爆）。
- 消费面：`snapshot(): { plugins: BootPluginEntry[] }`（生成 __DSH_BOOT__）+ `clientPath(id): string | undefined`（分发端点）。声明式，无 serve() 调用面。

### 4.4 webserver 两端点

- `GET /plugins/<id>/client.js`：id 含 scope 斜杠（@deepseek-ai/dsh-client-xxx），路由取 `/plugins/` 与 `/client.js` 之间整段 decode；查表 → readFile(clientPath)，content-type js；查无=404。
- `GET /`（含 SPA fallback 出 index.html 的路径）：读 index.html 后注入 `<script>window.__DSH_BOOT__={...}</script>`（JSON 序列化时 `<` 转义 `<` 防 `</script>` 截断）。
- startWebServer options 增可选 `webPlugins?: { snapshot(); clientPath(id) }` 形注入（不传=行为不变，现有测试零扰动）。

### 4.5 e2e 验收

真 host 起服 → GET / 断言 __DSH_BOOT__ 八包清单与 immediately 标志；GET /plugins/&lt;id&gt;/client.js 断言 200+js；未知 id 404。fixture 侧同协议注入由 loader 测试盖。

## 5. 实现顺序（T0 后）

1. connection 对账刀：导出清单实测（tsc 盘面）→ 附 v3 §3 尾 + 本文件 §2 清单定稿。
2. host 侧刀（不依赖 client 桩，可先行）：registry → 端点 → 注入 → 装配接线 → e2e。
3. runtime 服务：SlotsService（对桩）→ Session 两行 → SessionsService+scope 树 → 存量 spec 从 attic 捞回平移绿（connection/session/manager/notifier/partial/fold/lineage/fixture 族；boot-intents/preinit/rpc-log 退役记档）。
4. ClientLoader：核心态机+拓扑 → fixture 注入测试 → 真 bundle 冒烟（等 T0 tsdown preset 产物）→ 与 ui-shell 对接 deps 形状。

## 6. 台账 / 开问 main

- [问 main] §4.2 装配缺口两问（内存 Loader 树口径 + apps/cli/web.ts 跨属地接线报备）。
- [问 main] Context.sessions merge 冲突：v3 §4 的 client `sessions: SessionsService` 与 host dsh-session `sessions: SessionStore` 同名 merge 相撞（connection→apiproxy 类型链拉入 host d.ts）=TS2717。建议 a) client 侧改名；备选 c) P-I ctx.get('sessions')（现状实现，FIXME 在 runtime/src/index.ts）。
- [台账] SessionSummary.title wire 无供数，P-I 客户端派生占位。
- [台账] viewFor/backscanArgs 删除刀涉 wire 面，等 toolviews 迁移触发、main 排期。
- [台账] history 隐式 resume 改纯持久化读，P-II 议。
- [台账] scope「无人观看」= 最近解析 binding 者近似，口径写 JSDoc。
- [台账] intents.ts 溶解（rpc-log 五件+pingHost 死；refresh/create 归 SessionsService）。
- [规矩→全员] client 半边 bundle 要用 ctx.<service> 必须 `export const inject=[...]`——loader 以 object-plugin 整面递 cordis，fiber 依赖检查生效（apply-only 丢 inject=postmortem 0001 同型）。
- [规矩→全员] dist/client.js 是 build 产物不进 git；改 client/ 源码后必须重跑 tsdown，否则 loader e2e 吃旧产物。

## 7. 进度（冷启动锚点）

| 刀 | commit | 状态 |
|---|---|---|
| connection 对账（index 精确清单+intents 溶解+v3 §3.2 附录） | 3102c99a4+b4ce5c137 | ✅ |
| host 侧刀属地半（registry+分发端点+__DSH_BOOT__ 注入+11 测） | ba9768e90 | ✅ |
| spec 平移（connection 3+runtime 6+api-helpers 拆分） | dd8b37809 | ✅ |
| runtime 服务（SlotsService/SessionsService+scope 树/Session 两行/scopeOf/invariant×2） | e2ea1b99b | ✅ |
| ClientLoader（handoff/DI require/immediately 屏障/双模式验收/./loader 子路径） | be0261eb5+f94085878 | ✅ |
| 双入口拆分吸收（connection/runtime client 半边 apply+tsdown noExternal+双 specifier 回登记） | a05e28b5c | ✅ |
| host 装配刀（mountWebPlugins 内存 Loader 树×八包+invariant 伴生+built e2e） | 93b954c4d | ✅ |
| apps/cli/web.ts 接线（跨属地备案单独成刀） | e4661e7b0 | ✅ |
| 装配真链修缮（baseUrl 锚/tsdown preset lib 半/strip-only 内联/trajectory 空 apply） | 9c6f41c47 | ✅ |

真链验收实录（2026-07-22 02:26，apps/cli 语境 plain node）：mountWebPlugins→registry→startWebServer 起服→GET / 出 __DSH_BOOT__（plugins=8，immediately=4，序=connection,runtime,ui-theme,i18n,ui-layout,ui-sidebar,ui-conversation,ui-trajectory）→GET /plugins/@deepseek-ai/dsh-client-runtime/client.js 200 且含 DSHClientProxy.loadPlugin→未知 id 404。web-plugins.e2e 2/2 绿（lib 未构建自跳）。

排坑记录（后人别再踩）：①Loader 裸名 import 需 ctx.baseUrl 锚，否则静默失败全员 fiber-less；②包级 tsdown.config.ts 会整体替换根 workspace 形状——clientBundle preset 必须双 config（lib 半+client 半）；③apiproxy 浏览器子路径与 dsh-session/surface 的 runtime default 指 src/*.ts，plain-node 消费必须内联（strip-only 模式炸 parameter property）；④ctx.loader 每次访问是新 traced proxy，不可做恒等断言。
