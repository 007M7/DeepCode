# hostruntime 拆包 + dsc 双命令 · 实现级设计（v2）

> 2026-07-20 v2：按用户五问裁决（Q1–Q5）+ 分层原则补钉 + Electron 载体澄清 + acp 前瞻整体重写。v1→v2 变更记录见文末。
> 读者：编码 teammate + apiproxy-design（review §③）。现状基线：step2 后工作树（apps/dsc/src/bin.ts 122 行、apiproxy 三层 api/+fetch/+impl/+index.ts 内 bootHost）。
> 范围红线：Electron/acp 不做（各留接缝一节）；api/ 与 fetch/ 内容零改动；GUI 期不遵循仓库门禁。

## ⓪ 包结构总纲（用户裁决，全文档的宪法）

1. **分层原则：`packages/host/*` 与 `packages/client/*` 按「能力支持方」分层**——host/ 包只提供 host 侧能力，client/ 包只提供 client 侧能力，每包单边不混；**多种支持方的混合一律放 `apps/`**（哪个 app 要混，拼装写在那个 app 里）。
2. **消费面唯一经 ApiProxy（Q1，精确化）**：所有**消费型 client**（web / Electron / headless）走 apiproxy，不同接入只是「fetch 形函数的伪造方式不一样」（HTTP / 进程内注入 / IPC 桥）。**协议桥前门**（ACP 这类把 core 暴露给外部生态的）不属消费型 client——直接挂 core ctx，不套 fetch。两类东西，不是例外。
3. **apiproxy = 前置层**：契约 api/ + 载体 fetch/，做简单，所有接入方都要（现状已是，只做摘除）。
4. **hostruntime = 后置装配层 / 应用实体**：配哪些插件、装哪些东西的装配入口；host 级配置的归属地——defaults、persistenceRoot，**将来的用户 profile（~/.dsc 一族）也归这里**。
5. **每个接入方 = 自己一个拼装包/拼装模块**：web 形态 = `host/webserver` 包（HTTP+静态+SSE 桥）+ `client/web-runtime`（已有）；headless = apps/dsc 内部模块（混合体不建包，见 ⓪-1）；Electron 将来 = `apps/electron` 自己拼装。
6. **进程模型（Q3）**：Electron 走 sidecar（spawn 独立 host 进程）；本轮只保证 startHost 返回形状可被 sidecar 入口 bin 复用，不实现。
7. **命名规则（用户定死）**：`packages/host/*` 与 `packages/client/*` 下的包，npm 包名**必须含目录组前缀**——host/runtime → `dsh-host-runtime`、host/apiproxy → `dsh-host-apiproxy`、client/web-runtime → `dsh-client-web-runtime`、client/web-ui → `dsh-client-web-ui`。目录名不重复组前缀（host/ 已表达）；因此这些包名尾段≠目录名，tsconfig.base.json 的 dsh-* 通配（按目录名解析）命不中，**每包需显式 paths 条目**。2026-07-20 02:0x 已全量改毕（含存量三包，与 session-design 的统一改名合流）。

### 已锁实现结论

- 新包两个：`packages/host/runtime`（`@deepseek-ai/dsh-host-runtime`）、`packages/host/webserver`（`@deepseek-ai/dsh-host-webserver`）。
- `dsh-host-apiproxy` 退化纯契约+载体；impl/ 与 bootHost 迁出到 hostruntime。
- apps/dsc 瘦身：bin.ts 只剩 loadEnv + parseArgs 粗分发；`dsc web`（唯一起 HTTP 的形态）与 `dsc -p "task"`（零 HTTP、零端口、ApiProxy 同构直调、跑完打印退出）。
- `-p` 是协议第二个真实消费者：`new InProcessApiClient(host.handler)` 全程真跑载体链（类体系后写法，commit 893421d50）。

## ① 依赖方向图（拆分后）

```
apps/dsc ── bin.ts 分发 ── web.ts / headless.ts 两拼装模块
  │ deps：dsc-web（dist 解析，web 用）· dsh-host-webserver（web 用）
  │       dsh-host-runtime（两命令共用）· dsh-host-apiproxy（-p 的 client + 类型）
  ▼
packages/host/webserver     零 workspace 依赖（node:http + 注入的 fetch 形 handler）
packages/host/runtime ──► dsh-host-apiproxy（契约+载体）
  │ ctx.plugin(...)                 ▲ /api /client 子路径（type-only + AbstractApiClient 子类）
  ▼                                 │
harness core 各包            packages/client/web-runtime（不变）
```

- 方向纪律：hostruntime → apiproxy 单向；apiproxy 零 harness 运行时依赖；client 侧包永不 import host 侧包；**webserver 不依赖 hostruntime**——它收 `{ fetch }` 形 handler（结构 typing，全局类型零 import），「webserver → hostruntime」只是运行时注入关系，不是包依赖。
- webserver 定位（用户澄清后收窄）：**web 形态（浏览器访问）专用承载**；Electron 不复用它（renderer HTML 走 file://，fetch 走 IPC 桥，§⑧）。

### 各包职责一句话

| 包 | 拆分后职责 | 变化 |
|---|---|---|
| `@deepseek-ai/dsh-host-apiproxy` | 前置层：TS 契约（api/）+ fetch 载体（fetch/）；Node/浏览器皆可 import | impl/、bootHost 迁出；deps 16→6 |
| `@deepseek-ai/dsh-host-runtime` | 装配层/应用实体：bootHost（core spine 组合）+ createApiProxy + startHost；host 级配置归属地（defaults/persistenceRoot/将来 profile） | 新建（迁入+新增 start.ts） |
| `@deepseek-ai/dsh-host-webserver` | web 形态 HTTP 承载：静态服务 + /api→handler 桥 + SSE 写出 + close 语义 | 新建（从 bin.ts 4–7 段抽出） |
| `@deepseek-ai/dsc` | 命令行入口：分发 + 两命令拼装模块（混合体属地，⓪-1） | bin.ts 拆三文件 |
| `@deepseek-ai/dsc-web` / client 两包 | 不变 | 无 |

## ② startHost（hostruntime 的启动接缝，Electron/acp 前瞻的唯一权威）

语义：「boot core → 装配 ApiProxy → 装配 fetch handler」收为一步。返回物按「壳自选承载」设计，四类消费共用：node:http（dsc web）、进程内直调（dsc -p、测试）、IPC 桥（将来 Electron sidecar）、**前门插件挂载（将来 dsc acp）**。

```ts
// packages/host/runtime/src/start.ts
export interface StartHostOptions {
  /** 透传 bootHost（BootHostOptions 全量：persistenceRoot 必填 + provider?/model?）。将来 profile/日志开关在此 additive。 */
  boot: BootHostOptions
}

export interface RunningHost {
  /** 契约实现（进程内消费者直调；IPC 适配层的输入）。 */
  api: ApiProxy
  /** WHATWG fetch 形载体（web 壳桥到 node:http；Electron IPC 桥的 host 侧终点）。 */
  handler: { fetch: typeof fetch }
  /** host 级默认路由（describe 与各壳共用同一来源）。 */
  defaults: HostDefaults
  /**
   * 根上下文——**正式接缝**（不是逃生舱）：①协议桥前门插件的挂载点
   * （`dsc acp` = startHost() → ctx.plugin(uiAcp, config)，⓪-2 的第二类消费）；
   * ②headless 的 session 事件订阅。纪律：消费型 client 不得经 ctx 绕开 api；
   * 壳不得用 ctx.plugin 改«装配»（挂前门 ≠ 改装配：前门是壳形态本身）。
   */
  ctx: Context
  /** 停机单一出口（ctx.fiber.dispose()）。幂等：二次调用返回同一 promise。 */
  dispose(): Promise<void>
}

export async function startHost(options: StartHostOptions): Promise<RunningHost> {
  const host = await bootHost(options.boot)
  const api = createApiProxy(host.ctx, host.defaults)
  const handler = toFetchHandler(api)
  let disposing: Promise<void> | undefined
  return { api, handler, defaults: host.defaults, ctx: host.ctx, dispose: () => (disposing ??= host.dispose()) }
}
```

结论注记：

- **handler 收进返回物**：多壳共用装配；将来 handler 装配长参数（zod dev 开关、日志 tap）收在这一处。
- **stdout 纪律（acp 前瞻牵出）**：bootHost 现装配**零 stdout 写手**——十一个插件里没有 logger-console（与 acp-demo 同理：其 peers 刻意无 logger-console，stdout 留给纯 JSON-RPC）。打印是壳的事（web 壳的打印行在 web.ts）。**将来任何给装配加日志/诊断输出的改动，必须走 StartHostOptions 可关**（如 `logSink?: (line)=>void`，缺省丢弃）——写死这条纪律，quiet 开关本轮不做（现状无写手，无可关之物）。
- **dispose 幂等**：信号竞态与正常收尾共用。
- 不设生命周期钩子/事件：无现消费者，additive 空间在 StartHostOptions。

## ③ dsh-host-apiproxy 退化（迁移属地清单——apiproxy-design review 对象）

### 文件动向

| 现路径 | 去向 | 备注 |
|---|---|---|
| `src/api/**`（14 文件） | **不动** | 契约属地仍归 apiproxy-design |
| `src/fetch/handler.ts` / `client.ts` | **不动** | 载体=契约孪生面，零 harness 运行时依赖 |
| `src/impl/api-proxy.ts` | **迁** hostruntime `src/api-proxy.ts` | 整文件平移；头部相对 import 改 `@deepseek-ai/dsh-host-apiproxy/api` 与 `@deepseek-ai/dsh-host-apiproxy/api/rpc`；TODO(step2) 注释群随文件走 |
| `src/index.ts` 的 bootHost 一族 | **迁** hostruntime `src/boot.ts` | BootHostOptions/HostDefaults/HostHandle/bootHost 原样平移 |
| `src/index.ts` re-export 段 | 改写 | 退化版见下 |

### apiproxy 退化后出口

`src/index.ts`：re-export api/index.ts 全部 + `toFetchHandler` + `AbstractApiClient`/`InProcessApiClient`/`IApiClient`（迁移当时为 createApiClient；893421d50 换类体系），别无他物。package.json exports 保留 `.` / `./api` / `./client` / `./src/*` / `./package.json`，**新增 `"./api/*": "./src/api/*.ts"`**（hostruntime 迁入文件要 import `../api/rpc.ts` 的对等物；比 `./src/api/...` 深路径干净）。deps 收缩为：`dsh-brand`、`dsh-llm`、`dsh-session`、`dsh-user-approval`、`dsh-user-interaction`（api/ 的 type-only 上游）+ `zod`；删去 cordis、plugin-timer、agent、agent-loop、bash-local、llm-deepseek、session-persistence-jsonl、system-prompt、tasks、tools。tsconfig references 同步收缩。
已核实安全：全仓只有 apps/dsc 用 apiproxy 根入口；web-runtime 只吃 `/api` `/client` 子路径，零影响。

### hostruntime 包

`packages/host/runtime/`：package.json 照 apiproxy 现形状（`main`/`types` 指 lib、`./src/*` 通道、private、全平铺 deps）；deps = apiproxy 删去的十项 + `@deepseek-ai/dsh-host-apiproxy`；tsconfig references = core 十包 + vendor(cordis/timer) + apiproxy。src 四文件：`boot.ts`（迁入）、`api-proxy.ts`（迁入）、`start.ts`（§②）、`index.ts`（barrel：bootHost 一族 + createApiProxy/ApiProxyDefaults + startHost/StartHostOptions/RunningHost 全出口）。

## ④ dsh-host-webserver 包（web 形态承载）

从现 bin.ts 4–7 段抽出成包。**零 workspace 依赖**（node:http/path/fs + 结构 typing 的 handler 参数），host 组内最底层。

```ts
// packages/host/webserver/src/index.ts —— 出口面全文
export interface WebServerOptions {
  /** 监听端口。 */
  port: number
  /** 静态根内 index.html 的绝对路径（调用方解析好传入——dist 定位是 dsc 的 workspace 知识，不属本包）。 */
  distIndex: string
  /** fetch 形 API 载体；/api/* 前缀请求桥给它（含 SSE 流式写出）。 */
  apiHandler: { fetch: typeof fetch }
}

export interface RunningWebServer {
  /** 实际监听端口（供打印；本轮恒等于 options.port）。 */
  port: number
  /** 停机：close + closeAllConnections（SSE 长连接强制断，防 close 挂死）。幂等。 */
  close(): Promise<void>
}

/**
 * 起 web 形态 HTTP server：listen(port, '0.0.0.0')。
 * 路由三段：/api/* → apiHandler 桥（node:http↔WHATWG，req close→abort，SSE 逐 chunk 写出）；
 * GET/HEAD 之外 405；静态 = step1 锁定语义（MIME 六项/403 穿越判定/未命中 SPA 回退 200）。
 * listen 失败（EADDRINUSE 等）reject——壳决定退出方式；listen 后的 server error 走 onError。
 */
export function startWebServer(options: WebServerOptions, onError: (err: Error) => void): Promise<RunningWebServer>
```

实现细节（编码 teammate 指引）：

- 文件布局：`src/index.ts`（startWebServer + 桥）+ `src/static.ts`（MIME 表 + serveStatic 纯函数——现 bin.ts 5 段整体平移）。
- `/api/*` 桥、静态逻辑、403/SPA 语义**逐行平移现 bin.ts 51–95**，行为零改动（step1/step2 验收锁定）。
- `listen` 包 Promise：`listening` 事件 resolve、首个 `error` 事件 reject；resolve 后的 error 转 onError（现 bin.ts 101–104 的 disposeAndExit(1) 语义由壳在 onError 里做）。
- `close()`：`server.close()` + `server.closeAllConnections()` 包 Promise（close 回调 resolve），`??=` 幂等。
- **不打印**：`dsc web: http://127.0.0.1:<port>` 打印行归壳（web.ts）——sidecar/测试复用本包时不带 dsc 词汇。

package.json：`@deepseek-ai/dsh-host-webserver`，形状照 hostruntime（lib 入口 + `./src/*`），**dependencies 空对象省略**。tsconfig：references 为空数组（零依赖），其余同形。

## ⑤ apps/dsc 改造（混合体属地，⓪-1）

```
apps/dsc/src/
  bin.ts        ← loadEnv + 粗分发（全文见下）
  web.ts        ← runWeb(argv)：web 形态拼装 = startHost + resolveDist + startWebServer + 打印 + 信号
  headless.ts   ← runHeadless(argv)：-p 拼装 = startHost + InProcessApiClient 同构 + 事件消费（§⑥）
```

（v1 曾设 static.ts——静态逻辑已随 §④ 入 webserver 包，dsc 不再持有。）

### bin.ts 全文级

```ts
#!/usr/bin/env node
import { loadEnv } from '@deepseek-ai/dsh-app-boot'

loadEnv('dsc')
const argv = process.argv.slice(2)
if (argv[0] === 'web') {
  const { runWeb } = await import('./web.ts')          // 动态 import：形态互不加载
  await runWeb(argv.slice(1))
} else if (argv.includes('-p') || argv.includes('--prompt')) {
  const { runHeadless } = await import('./headless.ts')
  await runHeadless(argv)
} else {
  process.stderr.write('usage: dsc web [--port N] | dsc -p "task"\n')
  process.exit(1)
}
```

细命令 parseArgs 在各模块内（web 收 --port，headless 收 -p/--prompt），bin 层不聚合 options。

### web.ts 动线（相对现 bin.ts 的重排）

```
parseArgs --port（默认 3080，非法 stderr+exit 1；positional 已被 bin 层剥掉）
→ const host = await startHost({ boot: { persistenceRoot: './.sessions' } })
→ resolveDist：createRequire(import.meta.url).resolve('@deepseek-ai/dsc-web/dist/index.html')
    catch → stderr「先跑 pnpm --filter @deepseek-ai/dsc-web build」→ exit 1（dist 定位知识留在 dsc，§④ 结论）
→ const server = await startWebServer({ port, distIndex, apiHandler: host.handler },
    err => { stderr; void shutdown(1) })
    listen reject（EADDRINUSE）→ stderr + await host.dispose() + exit 1
→ console.log(`dsc web: http://127.0.0.1:${server.port}`)
→ shutdown(code)：exiting 门闩 + try { await server.close(); await host.dispose() } finally { process.exit(code) }
   SIGTERM→0 / SIGINT→130（jsonrpc-demo 样板不变，close 顺序：先 server 后 host）
```

## ⑥ `dsc -p "task"` 动线（headless.ts）

**确认：不 import webserver/node:http，不监听端口，不解析 dist。**同构注入 = 协议第二真实消费者（wire 序列化/zod/SSE 帧全被真实运行）。

```ts
import { parseArgs } from 'node:util'
import { startHost } from '@deepseek-ai/dsh-host-runtime'
import { InProcessApiClient } from '@deepseek-ai/dsh-host-apiproxy'

export async function runHeadless(argv: string[]): Promise<never> {
  const { values } = parseArgs({ args: argv, options: { prompt: { type: 'string', short: 'p' } }, allowPositionals: false })
  const task = values.prompt
  if (task === undefined || task === '') { /* usage stderr + exit 1 */ }

  const host = await startHost({ boot: { persistenceRoot: './.sessions' } })
  const api = new InProcessApiClient(host.handler)         // 同构点

  const abort = new AbortController()
  const created = unwrap(await api.sessions.create({ rpcId: mint(), payload: {} }))   // !ok → stderr+dispose+exit 1
  const frames = api.events.mux({ rpcId: mint(), payload: {} }, abort.signal)
  const done = consumeUntilTurnEnd(frames, created.sessionId)                          // 先开流
  unwrap(await api.sessions.prompt({ rpcId: mint(), payload: { sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: task }] } }))
  const outcome = await done

  process.stdout.write(outcome.text + '\n')
  abort.abort()
  await host.dispose()
  process.exit(outcome.reason === 'completed' ? 0 : 1)
}
```

`consumeUntilTurnEnd(frames, sessionId)`（headless.ts 私有；照 cli-demo runOneShot 三步判定，cli.ts:252-262 先例，输入换 `RpcRequest<MuxFrame>`）：

```
targetTurn?: number；text=''；reason?: string
for await frame：只取 payload.type==='session/event' && sessionId 匹配，event=payload.event
  1. targetTurn 未定 && event.type==='turn/start' && event.data.trigger.kind==='message' → targetTurn=event.data.turn（启动注入 turn 被跳过）
  2. event.type==='assistant/message' && event.data.turn===targetTurn → text=其 content 的 text block 拼接（后写覆盖，「最后一条为准」）
  3. event.type==='turn/end' && event.data.turn===targetTurn → reason=event.data.reason.kind；return {text, reason}
payload.type==='stream/error' 或 for-await throw → stderr + return {text, reason:'error'}
```

边界结论：

- 先开 mux 后 prompt：帧不丢；同进程无竞态仍保持此序——换远程 HTTP 时代码零改（同构纪律）。
- mint = `RpcId(randomUUID())`；unwrap = RpcResponse 拆封，`!result.ok` 打 stderr（`error.code: error.message`）+ dispose + exit 1。
- 退出码：completed→0，其余（aborted/error）→1；boot 失败（缺 key）顶层 rejection fail-loud 非零。
- Ctrl-C 走 Node 默认（无 server 可关；持久化由 core turn 边界 flush 保证）——台账 §⑨-3。
- 审批/问答：现装配无审批 provider 不会挂等；将来加装配走 StartHostOptions additive——台账 §⑨-2。

## ⑦ 迁移步骤（顺序执行，每步 typecheck 可绿）

1. **建 hostruntime**：目录+package.json+tsconfig；src/boot.ts（apiproxy/src/index.ts:1-52 平移）、src/api-proxy.ts（impl/api-proxy.ts 平移，import 改 `@deepseek-ai/dsh-host-apiproxy/api` 与 `/api/rpc`）、src/start.ts（§② 新写）、src/index.ts（barrel）。
2. **apiproxy 摘除**：删 src/impl/；index.ts 重写退化版；package.json 补 `"./api/*": "./src/api/*.ts"` export、deps 删十项；tsconfig references 收缩。
3. **建 webserver**：目录+package.json（零 deps）+tsconfig（references []）；src/index.ts（startWebServer：现 bin.ts 51-104 平移改造成 §④ 签名）、src/static.ts（MIME+serveStatic）。
4. **apps/dsc 改造**：package.json deps 换列（dsc-web、dsh-host-webserver、dsh-host-runtime、dsh-host-apiproxy、dsh-app-boot、dsh-session）；tsconfig references（app-boot、host/runtime、host/apiproxy、host/webserver、core/session、vendor/cordis）；src 拆三文件（§⑤）。
5. **验证**：pnpm install → §⑩ 验收逐条。
6. **不动**：api/ fetch/ 内容、client 三包、根四配置（`packages/*/*` glob 已覆盖两新包）。

## ⑧ Electron / acp 接缝（只写约定，不实现）

### Electron（用户已澄清口径）

将来 Electron = `apps/electron` 自己的拼装（⓪-1 混合归 apps）；进程模型 sidecar（Q3）：spawn 独立 host 进程，其入口 bin 复用 startHost——RunningHost 形状即 sidecar 入口的全部所需（api/handler/dispose）。

| 面 | 承载 | 约定 |
|---|---|---|
| renderer HTML/静态资源 | **file:// 或自定义协议加载 dist，不走 web server** | webserver 包 Electron 不复用（§① 定位）；dist 解析知识在 apps/electron 自理 |
| fetch 载体 | **IPC 桥**（第三种承载：HTTP / 进程内注入 / IPC 桥） | renderer 侧 AbstractApiClient 的 IPC 子类（doFetch=IPC 序列化往返）；契约类型 `/api` type-only import |
| host 侧终点 | sidecar 进程内 `host.handler.fetch` | IPC 桥 main 侧收到序列化 Request → 转 sidecar（或同进程直调）→ Response 序列化回 |
| 停机 | `app.on('before-quit')` → sidecar dispose | dispose 幂等保证多触发安全 |

**留待 Electron 轮设计**（本轮只标注载体位）：IPC 桥版 fetchLike 的 Request/Response 序列化边界、SSE 流在 IPC 上的对等物（如 MessagePort 流式推送）。判据不变：以上皆为「fetchLike 的伪造方式」，apiproxy/hostruntime 零新接口。

### acp（用户前瞻，⓪-2 第二类消费的第一个实例）

- `dsc acp` = apps/dsc 又一混合拼装模块（acp.ts），**不新建包**：动线 = `startHost()` → `ctx.plugin(uiAcp, config)`（复用 packages/ui/acp 前门插件）→ 编辑器拥有生命周期（照 acp-demo：正常运行无信号处理）。
- ACP 不过 fetch 模型（双向 JSON-RPC/权限回路/编辑器生命周期，与四象限不同构）——走 RunningHost.ctx 正式接缝，不是绕 Q1：apiproxy 是投影消费面，ACP 是 core 前门，两类东西（⓪-2）。
- stdout 纪律已由 §② 保证：现装配零 stdout 写手；将来日志走 StartHostOptions 可关。
- 开放问题（标注不展开）：ACP 与 web 可否同 host 并跑（同一进程既 ctx.plugin(uiAcp) 又 startWebServer）——事件扇出与审批路由的多壳仲裁没想清，留 acp 轮。

## ⑨ 妥协台账（三段式：妥协 → 触发条件 → 返工点/预埋）

1. **ctx 在 RunningHost 上同时服务两类消费**（前门挂载=正式接缝；headless 事件订阅=本可走契约面 mux 流，§⑥ 实际就走的 mux——ctx 对 headless 纯备胎）。触发：消费型 client 出现绕 api 摸 ctx 的用法。返工点：ctx 文档注释收紧为「仅前门挂载」；预埋=§② 注释纪律已写。
2. **startHost 无配置面**（boot 全透传；handler 装配无参数；无 quiet/logSink——现装配零 stdout 写手，无可关之物）。触发：zod dev 开关/请求日志/审批 provider/acp 要 logSink。返工点：StartHostOptions additive，RunningHost 形状不动。
3. **-p 无信号处理**（Ctrl-C 走 Node 默认死）。触发：headless 长任务要优雅中断（130+半途结果）。返工点：headless.ts 加 SIGINT → api.sessions.cancel + 打印已聚 text，契约面能力已够，纯 additive。
4. **-p 每次新建 session**（无 --resume）。触发：要接续会话。返工点：parseArgs 加 --resume <id>，create 换 list+校验。
5. **webserver 的 onError 回调形**（listen 后错误经回调而非事件/AbortSignal）。触发：壳需要区分错误类别或多监听者。返工点：换 EventEmitter 或 signal 形——现单壳单错误出口，回调最小。
6. **新包零测试**（GUI 期门禁豁免）。触发：首个 tagged release 前门禁回收。返工点：webserver 静态语义单测（403/SPA/mime）+ startHost 三形态冒烟 + -p e2e（echo 模型）。
7. **apiproxy type-only 上游仍在 deps**。触发：apiproxy 发布给外部 client（浏览器包不该拉 harness）。返工点：类型下沉或 peer 化——归 apiproxy-design 裁量。
8. ~~存量包名未含目录前缀~~ **已消解**（2026-07-20 02:0x）：host/client 目录前缀命名规则落地时，存量三包（apiproxy→dsh-host-apiproxy、web-runtime→dsh-client-web-runtime、web-ui→dsh-client-web-ui）与两新包在同一窗口一次性改毕（package.json name+全部 import+tsconfig paths+pnpm install），未再留债。留档原因：改名期间与在途工作并发撞车过一次（两处独立加 paths 条目），结论=将来再有全仓 rename 一律走冻结窗口（暂停其他工作一次改完）。

## ⑩ 验收清单（实现完成后逐条）

| # | 命令 | 期望 |
|---|---|---|
| 1 | `pnpm install` | 退出 0；hostruntime/webserver 软链出现 |
| 2 | `pnpm run demo:web` 后 step1 验收 3–7 抽测 | 打印行/GET / 200/assets mime/403（编码变体）/SPA 回退全部与拆包前一致 |
| 3 | web 起着时 RPC 面板/左栏 session 列表 | step2 现状不回归（/api 桥经 webserver 后行为不变） |
| 4 | `node --import tsx apps/dsc/src/bin.ts -p "Reply with exactly: SPLIT-OK"` | stdout 尾行 `SPLIT-OK`，退出码 0；期间 `ss -ltn` 无 3080 监听 |
| 5 | `-p` 后 `ls .sessions/cwd-*/` | 新增 session jsonl（headless 会话已持久化） |
| 6 | `node --import tsx apps/dsc/src/bin.ts` | usage 两命令，退出码 1 |
| 7 | `grep -rn "impl/" packages/host/apiproxy/src` 空；`pnpm run typecheck` 范围内 client 三包不动即绿 | 摘除干净、契约面零影响 |
| 8 | SIGTERM/SIGINT 对 `demo:web` | 0 / 130（shutdown 先 server.close 后 host.dispose） |

## ⑪ 属地与 review 交接

- §③ 动 apiproxy 属地（impl 迁出/index 重写/exports 补行/deps 收缩）——交 apiproxy-design review；TODO(step2) 注释群随 api-proxy.ts 迁入 hostruntime，其补全工作（W2）落点随之改变，先后顺序 team-lead 排。
- webserver 平移的 bin.ts 51-104 是 step2 W3 产出——纯平移不改行为，W3 无需 review，但迁移期间 W3 若有在途改动需协调。

## v1 → v2 变更记录

- **新增 webserver 包**（Q5）：v1 静态服务留 apps/dsc static.ts → v2 独立 `host/webserver` 包（含 /api 桥与 close 语义），dsc 的 web.ts 变纯拼装。
- **-p 属地定案**（Q4+分层补钉）：混合体（host boot + client 消费）→ apps/dsc 内部模块，不建包、不做 ui/ 谱系论证。
- **ctx 升格**：逃生舱 → 正式接缝（acp 前门挂载点）；连带 stdout 纪律入 §②。
- **Electron 口径更换**：v1「protocol.handle 挂 handler.fetch、SSE 同码路」→ v2 用户澄清版（HTML 走 file://、fetch 走 IPC 桥、webserver 不复用、sidecar 进程模型）。
- **总纲新增**（⓪）：能力支持方分层原则、两类消费边界（消费型 client vs 协议桥前门）、apiproxy 前置层/hostruntime 后置装配层世界观、profile 归属 hostruntime。
- 妥协台账 6→7 条（新增 webserver onError 回调形）；验收 6→8 条（新增 step2 UI 不回归、SIGTERM/SIGINT）。
