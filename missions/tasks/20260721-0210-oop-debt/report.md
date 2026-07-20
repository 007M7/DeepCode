# OOP 债务清查（GUI 分支七属地，零改码纯清单）

- **时间**：2026-07-21 02:10（arch-carrier）
- **口径**：扫描当前 GUI 相关代码的闭包工厂 / plain-object 面 / 散函数组；判断标准——**有状态生命周期或多方法共享内部状态 = 该 class 化；纯数据/纯函数/单入口闭包 = 不该，不为 OOP 而 OOP**。架构红线见 missions/conventions.md 14（store 无业务对象 + OOP 对象层）。
- **范围**：apps/cli、apps/web、packages/client/web-runtime、packages/client/web-ui、packages/host/apiproxy、packages/host/runtime、packages/host/webserver。
- **已是 class 的不列**（清点确认合规）：ConnectionController、SessionManager、Session、Notifier、PartialAccumulator、FoldAdapter、AbstractApiClient、InProcessApiClient、WebApiClient、FixtureApiClient、FxInbox、FrameQueue。

## 清单

### 该 class 化（2 处）

| # | 文件:行 | 现形态 | 判断依据 | 建议时机 |
|---|---------|--------|----------|----------|
| 1 | `packages/host/runtime/src/api-proxy.ts:221` `createApiProxy` | **闭包工厂**：206 行工厂体返回 plain-object ApiProxy；闭包态 `resumes` 去重表（:224）、`agentOptions`；内嵌 `assertServable`/`agentFor`（:233/:240）；mux 流内再挂 `openCalls` 表（:367） | 有状态生命周期（resume 去重、per-stream call 表）+ 多方法共享闭包态，且 respond 落地还要加 pending registry（:421 TODO）——状态只会更多 | **已排期**：R7 台账绑 respond 实施窗口（progress.md P1-5「审批 respond + 顺势 createApiProxy 升 class」）。升级时：`paginate`/`viewFor`/`backscanArgs`/`summarize*` 保持纯函数；`FrameQueue` 保持独立类；`SessionNotFound`、`resumes`、未来 pending registry 收进 class |
| 2 | `packages/client/web-runtime/src/fixture.ts:236` `createFixtureApi` | **大型闭包工厂**（~240 行工厂体）：闭包态 `sessions`/`logs`/`nextTurn`/`nextRpc`/`replays`/`muxConns`/`hostConns`/`streamBreakers`/timing 标志（:237-301）；timing hooks 经 globalThis 后门外挂（:329） | 状态最重的一处：十余项可变闭包态被 list/create/history/prompt/cancel/两条流/timing hooks 共享，完全符合「该」标准 | **绑既有计划，不单开窗口**：fixture.ts:480 注释已锁定去向——迁移同构管道（InProcessApiClient over toFetchHandler(fixtureImpl)）时重组；届时把工厂重写为 `FixtureHost` class（fake 域状态 + timing hooks 成员化，去 globalThis 后门），FixtureApiClient 子类整体删除。fixture 非产品面，优先级低于 #1 |

### 不该 class 化（判断留档，防止后续「顺手 OOP」扩大化）

| # | 文件:行 | 现形态 | 不改依据 |
|---|---------|--------|----------|
| 3 | `packages/host/apiproxy/src/fetch/handler.ts:145` `toFetchHandler` | 闭包工厂返回 `{fetch}` | 无闭包态（仅捕获 `api` 引用），纯适配器；`UNARY_ROUTES`/`sseResponse`/`handleUnary` 均纯函数或常量表 |
| 4 | `packages/host/webserver/src/index.ts:49` `startWebServer` | 闭包工厂返回 plain-object `RunningWebServer`；闭包态仅 `closing` 幂等档 | 生命周期只有 listen→close 两拍、单一 close 方法，class 化零收益；将来若加连接管理/重启再议 |
| 5 | `packages/client/web-runtime/src/rpc-log.ts:34` `createEnvelopeIngest` | 闭包工厂：`nextId`+`inflightMethods` 相关性状态 | 单入口（只返回一个 listener 函数），闭包即实例；per-instance 隔离（audit C4）闭包已保证 |
| 6 | `packages/client/web-runtime/src/intents.ts:5` 模块级 `let api` + `bindIntents`/散函数 intent 组 | 模块单例 + 命令函数面 | intent 即命令面，设计如此（选中态不进 store、导航归容器）；web-cordis 迁移时并入 `ctx` 体系（events.ts 已预置 WEB_EVENTS 词表），现在 class 化是反向工程 |
| 7 | `packages/client/web-runtime/src/boot.ts:25,33` `bootWebRuntime` + 模块级 `prevHandle` | 装配函数 + HMR 防重入档 | 一次性装配（挑 api→接 tap→绑 intent→起 controller）；`prevHandle`（audit C8）在 cordis 迁移后由 ctx dispose 自然取代 |
| 8 | `packages/client/web-runtime/src/session/manager.ts:255-275` 模块单例 `instance` + `initSessionManager`/`getSessionManager` | 模块级单例存取器 | 文件头已裁定「module-level Manager singleton is legitimate」；fail-loud 存取符合门禁口径 |
| 9 | `packages/client/web-runtime/src/store.ts:38` zustand vanilla 单例 | plain store（rpcLog/ui/connection 三 slice） | 正是红线 14 的合规形态：纯呈现 slice、无业务对象；不动 |
| 10 | `packages/client/web-runtime/src/session/lineage.ts:24`、`conversation.ts`、`partial.ts:82`、`api.ts:31,41` | 纯函数 + 纯类型层 | flattenLineage/toAssistantBlocks/resultOf/transportError 全部无状态纯函数；ConversationNode 族是快照数据契约（红线 16 的 props 面），plain object 是设计而非债 |
| 11 | `packages/host/apiproxy/src/api/*`（rpc.ts、sessions.ts、events.ts、*.schema.ts、rpc-map.ts） | 类型契约 + zod schema + 常量表 | 契约层零运行时状态；`RpcId()` 品牌构造是既定精工（brand 惯例） |
| 12 | `packages/host/runtime/src/boot.ts:83` `bootHost`、`start.ts:52` `startHost` | 装配函数返回 plain-object handle；`disposing ??=` 幂等档 | 一次性组合（装插件→拼 ApiProxy→拼 handler），无持续内部状态；handle 形状（api/handler/ctx/dispose）是跨 shell 契约，class 化不增义。#1 升 class 后 startHost 仍是工厂，不连坐 |
| 13 | `packages/host/webserver/src/index.ts:87` `bridge`、`static.ts:28` `serveStatic` | per-request 散函数 | 每请求一次性执行，无跨调用状态 |
| 14 | `apps/cli/src/bin.ts`、`web.ts:13` `runWeb`、`headless.ts:68` `runHeadless`；`apps/web/src/main.ts` | 进程入口散函数（runWeb 内 `exiting`/`shutdown` 闭包） | 进程级一次性脚本，闭包幂等档足够；shell 按约不承载装配逻辑 |
| 15 | `packages/client/web-ui/src/components/**`（全部组件）+ `hooks/*` | 纯 props 组件 + 逻辑层 hooks | 红线 16：组件是耗材，展示面无 OOP 诉求；hooks（useConversation/useSessionList）是对象层→React 的既定桥形态 |
| 16 | `packages/client/web-ui/src/components/conversation/toolCardRegistry.ts:20` 模块级 Map registry | plain 模块注册表（get/register 两函数共享一张 Map） | 文件头已锁定去向：future cordis tool-ui registry 的挂载点（toolcard-wire 设计 deferred 行 1）；迁移时换成 ctx.effect 注册表，现在 class 化白做一遍 |
| 17 | `packages/client/web-ui/src/utils/theme.ts` 散函数组 | resolveInitialTheme/applyTheme/toggleTheme | 状态在 DOM 属性 + localStorage，模块自身无状态；Settings 页面落地时随迁 |

## 改造优先序建议

1. **专门窗口（已排期，照旧执行）**：#1 `createApiProxy` 升 class——唯一的产品面真债，绑 respond 实施窗口（P1-5），pending registry 一起进 class，一次到位。
2. **绑既有计划顺势做（不单独排期）**：
   - #2 `createFixtureApi` → fixture 同构管道迁移刀（fixture.ts:480 既定去向）里重组为 class，顺带消 globalThis timing 后门；
   - #6/#7/#16（intents 模块态、boot prevHandle、toolCardRegistry）→ web-cordis 迁移窗口自然消解，迁移前不动。
3. **不值得改（防扩大化定论）**：#3-#5、#8-#15、#17——纯函数/纯契约/单入口闭包/一次性装配/纯 props 组件，全部维持现形态；后续若有人提「顺手 class 化」，以本表依据挡回。

**总结**：七属地 OOP 纪律整体良好——对象层（Session/SessionManager/ConnectionController/Notifier/FoldAdapter/PartialAccumulator）和载体层（AbstractApiClient 族）已全部 class 化，store 保持纯呈现 slice。真债只有 2 处且均已有归宿：产品面 1 处（createApiProxy，已排期），fixture 面 1 处（绑迁移计划）。
