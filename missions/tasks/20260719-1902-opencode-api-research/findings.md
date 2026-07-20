# opencode「统一 API 层」调研（fetch 同构 / SSE 事件流 / OpenAPI 类型链）

调研对象：`/weka-hg/prod/deepseek/permanent/ys/private/workspace/github/opencode`（HEAD `f5573281`，2026-07-19）。下文 file:line 均相对该仓库根。

**先纠正一个背景认知**：TUI 已不是 Go。Go/Bubbletea TUI 于 2025-11-02 被删（commit `f68374ad2` "DELETE GO BUBBLETEA CRAP HOORAY"），现 TUI 是 TypeScript + solid-js（opentui 渲染，`packages/tui`），与 server 同进程不同线程（Bun Worker）。全仓已无 `.go` 文件。

## 1. server 定义

**框架不是 Hono，是 Effect 的 `effect/unstable/httpapi`**（声明式 HttpApi DSL）。Hono 只在 `enterprise`、`function`（云端/SST 部分）用到（`packages/enterprise/package.json:25`、`packages/function/package.json:17`），本地 server 完全不用。

- 入口：`packages/opencode/src/server/server.ts`
  - `import { HttpRouter, HttpServer } from "effect/unstable/http"`、`OpenApi from "effect/unstable/httpapi"`（server.ts:6-7）。
  - 监听：`Server.listen(opts)`（server.ts:73）→ `listenEffect` → `listenerLayer`（server.ts:100-116）用 `HttpRouter.serve(...)` + `NodeHttpServer.layer(() => createServer(), {port, host})`（server.ts:199-214，node:http 的 createServer）。端口回退：显式 0 时先试 4096 再随机（server.ts:118-123）。
  - 谁调 listen：`serve` 命令（`packages/opencode/src/cli/cmd/serve.ts:19`）；TUI worker 仅在用户给了 `--port/--hostname/--mdns` 时调（`packages/opencode/src/cli/tui/worker.ts:56`）。
- 路由声明与实现分离，全部在 `packages/opencode/src/server/routes/instance/httpapi/`：
  - `groups/*.ts` = API 形状声明（路径、params、payload/success/error Schema、OpenAPI 注解），如 `groups/session.ts`、`groups/global.ts`、`groups/event.ts`。
  - `handlers/*.ts` = 实现（`HttpApiBuilder.group(Api, name, handlers => ...)`），如 `handlers/session.ts`、`handlers/event.ts`。
  - `api.ts` 组装：`RootHttpApi`（control/control-plane/global）+ `InstanceHttpApi`（config/file/session/provider/... 15 组）→ `OpenCodeHttpApi`（api.ts:56-80）。
- **分层关系**：handler 是薄壳，业务在 Effect Service 里。如 session handler 注入 `SessionPrompt.Service` 后 `promptSvc.prompt(...)`、`promptSvc.cancel(...)`（handlers/session.ts:52、233、301）；server.ts 只负责把几十个 service Layer（Session、Provider、Permission、MCP、LSP……见 routes/instance/httpapi/server.ts:8-57 的 import 清单）组进 HttpApi 运行时。

## 2. API 契约与类型：OpenAPI codegen（@hey-api/openapi-ts），非 hono/client

- SDK 在 `packages/sdk/js`，生成链（`packages/sdk/js/script/build.ts`）：
  1. `bun dev generate > openapi.json`（build.ts:15）——即 CLI `generate` 命令调 `Server.openapi()`（`packages/opencode/src/cli/cmd/generate.ts:10`），后者 `OpenApi.fromApi(PublicApi)` 从 Effect HttpApi 声明直接导出 OpenAPI 文档（server/server.ts:67-69）。**单一事实源是 server 端的 Effect Schema 声明**。
  2. `createClient({input: openapi.json, output: src/v2/gen, plugins: [@hey-api/typescript, @hey-api/sdk(instance: OpencodeClient, paramsStructure: flat), @hey-api/client-fetch]})`（build.ts:19-72）。产物：`types.gen.ts`（全部请求/响应/事件类型）+ `sdk.gen.ts`（OpencodeClient 方法树，如 `sdk.session.prompt(...)`）+ `client/`（fetch 客户端）。
- **自定义 fetch 注入**：`createOpencodeClient(config)` 的 `config.fetch` 就是 @hey-api client 的标配选项。v1 版 `packages/sdk/js/src/client.ts:33-42`（不传 fetch 则用包一层 `req.timeout=false` 的全局 fetch）；v2 版 `packages/sdk/js/src/v2/client.ts:50-61`，另支持 `baseUrl`、`headers`、`directory`（转成 `x-opencode-directory` header，再由 request 拦截器改写成 query 参数，v2/client.ts:18-48、69-76）。
- SDK 还提供 `createOpencodeServer()`：spawn `opencode serve` 子进程、等 stdout 打出 "opencode server listening" 再解析 URL（`packages/sdk/js/src/v2/server.ts:23-60`）；`createOpencode()` = server + client 一把梭（v2/index.ts:10-20）。

## 3. fetch 同构：`Server.Default().app.fetch` 直调，零网络

server.ts 导出一个**不监听端口的 app 对象**：`Server.Default()`（lazy 单例，server.ts:56-65）——`HttpApiApp.webHandler().handler` 包成 `{fetch(Request): Promise<Response>}`，即 WHATWG Request→Response 纯函数。所有同构点都是把它塞进 SDK 的 `fetch` 选项：

| 场景 | 位置 | 做法 |
|---|---|---|
| `opencode run`（非交互 CLI）| `packages/opencode/src/cli/cmd/run.ts:943-955` | `fetchFn = (input, init) => Server.Default().app.fetch(new Request(...))`，`createOpencodeClient({baseUrl: "http://opencode.internal", fetch: fetchFn})`——baseUrl 是假域名，仅用于构造 URL |
| `run` 交互本地模式 | run.ts:905-917 | 同上，传给 `runInteractiveLocalMode` |
| 插件运行时 | `packages/opencode/src/plugin/index.ts:141-146` | 给插件的 `client`：有真 server 时用 `Server.url`，**没有则 `fetch: (...args) => Server.Default().app.fetch(...args)`**——插件代码不感知区别 |
| TUI（默认模式）| 见下 | 跨 Worker 线程 RPC，仍不走网络 |

**TUI 连接方式**（`packages/opencode/src/cli/cmd/tui.ts`）：主线程起 `new Worker(worker.ts)`（tui.ts:210），server 核心跑在 worker 线程里。
- 默认（无 `--port/--hostname/--mdns`，tui.ts:234）：**不起 HTTP server**。transport = `{url: "http://opencode.internal", fetch: createWorkerFetch(client), events: createEventSource(client)}`（tui.ts:245-249）。`createWorkerFetch` 把 Request 序列化成 `{url, method, headers, body}` 经 Worker RPC 发过去（tui.ts:24-40）；worker 端 `rpc.fetch` 还原成 Request 后 `Server.Default().app.fetch(request)`（worker.ts:31-49）。即**同构面是 fetch 签名，传输是 structured-clone RPC，非 socket**。
- 显式要求网络暴露时：worker 端 `Server.listen` 起真 HTTP（worker.ts:54-57），TUI 改用真 URL + 默认 fetch + SSE（tui.ts:238-244）。
- `opencode attach <url>` 连远端：纯 HTTP，`createOpencodeClient({baseUrl: args.attach, headers: auth})`（run.ts:349-355）。
- desktop（Electron）：renderer 通过 IPC 拿 server URL（`packages/desktop/src/main/ipc.ts:53-54`），走真 HTTP，不做 fetch 直调。

## 4. 事件流：单一全局 SSE 总线 + 实例级过滤流，重连靠全量 bootstrap

两个 SSE 端点，都是 GET、`text/event-stream`：

- **`GET /global/event`**（`groups/global.ts:85-92`）——**全局单总线**，TUI/桌面默认订阅这个。handler（`handlers/global.ts:33-52`）把进程级 `GlobalBus`（Node EventEmitter，`src/bus/global.ts:12-22`）的所有事件 + 10s 心跳推给客户端。事件从核心到总线的路径：Effect 内部 `EventV2.publish` → `EventV2Bridge` 监听后 `GlobalBus.emit("event", {directory, project, workspace, payload:{id,type,properties}})`（`src/event-v2-bridge.ts:36-46`），即事件自带 directory/workspace 归属，**由客户端按需过滤**，不分 session 订阅。
- **`GET /event`**（instance 级，`groups/event.ts:7-28`）——按当前 instance directory/workspace **服务端过滤**（`handlers/event.ts:34-40`），首包发 `server.connected`，10s 心跳 `server.heartbeat`，实例销毁时发 `server.instance.disposed` 后终止流（handlers/event.ts:60-66、70）。
- 事件类型全集在 `packages/schema/src/event-manifest.ts`（`Definitions` 聚合 30+ 模块，:64-82）。主要类别：
  - v1 UI 面（TUI store 实际消费的，`packages/tui/src/context/sync.tsx` switch，:171-441）：`message.updated`、`message.removed`、`message.part.updated`、**`message.part.delta`**、`message.part.removed`、`session.updated`、`session.deleted`、`session.status`、`session.diff`、`permission.asked/replied`、`question.asked/replied/rejected`、`todo.updated`、`lsp.updated`、`vcs.branch.updated`、`server.instance.disposed`。
  - v2 内核事件（`session.next.*`，schema/src/session-event.ts）：`session.next.text.delta/started/ended`、`tool.called/success/failed/input.delta`、`reasoning.*`、`step.*`、`compaction.*`、`prompt.admitted` 等 ~40 种。
- **断线重连 = 全量重取，无 cursor**。TUI SDK 层：SSE 断开后指数退避（1s→30s 封顶）无限重连（`packages/tui/src/context/sdk.tsx:82-117`）；状态恢复不靠事件回放，而是收到 `server.instance.disposed` 时整体 `bootstrap()`（sync.tsx:172-173）——并行重拉 providers/agents/config/session.list/messages 等十几个 REST 端点重建 store（sync.tsx:445-541）。事件 payload 里有 `id`（ascending 标识，bus/global.ts:15-17）和 durable 事件的 `seq`（event-v2-bridge.ts:47-60，"sync" 通道），但那是给实验性 workspace 同步用的（`sdk.sync.start()`，sdk.tsx:99），主 UI 路径不做 cursor 续传。

## 5. 命令面：session 创建 / prompt / abort

路径常量集中在 `groups/session.ts:79-104`（`SessionPaths`），全部带 `?directory=`（workspace 路由 query，middleware 解析）：

- **创建**：`POST /session`，body 可空或 `Session.CreateInput`（parentID/title 等），返回 `Session.Info`（groups/session.ts:203-214；handler `handlers/session.ts:155-175`，空 body 走 `create({})`）。
- **发消息（同步）**：`POST /session/:sessionID/message`，body = `PromptPayload`（`SessionPrompt.PromptInput` 去掉 sessionID：parts、model、agent 等），**响应是阻塞到整轮 agent 循环结束后一次性返回的 message+parts JSON**（groups/session.ts:316-328；handler 里 `promptSvc.prompt(...)` 完成后 `HttpServerResponse.stream(Stream.make(JSON.stringify(message)))`，handlers/session.ts:295-309——用 stream 包装只是让连接保持，不是增量协议）。
- **发消息（异步，TUI 实际用法）**：`POST /session/:sessionID/prompt_async`，同 payload，**立即 204**，prompt 在服务端 fork 执行，错误也转成 `session.error` 事件发总线（groups/session.ts:329-342；handlers/session.ts:311-329）。
- **中止**：`POST /session/:sessionID/abort`，无 body，返回 boolean；handler 调 `promptSvc.cancel(sessionID)`（groups/session.ts:253-264；handlers/session.ts:232-234）。
- 相邻端点：`GET /session`（list，支持 start/search/limit）、`GET /session/:id/message`（历史，limit/before 分页）、`POST .../fork`、`POST .../command`、`POST .../shell`、`POST .../revert`、`permissions/:permissionID` 回复等（groups/session.ts:111-433 逐个声明）。
- **token 级增量不走 prompt 响应，全走事件总线**：处理器在生成过程中发 `message.part.delta`（字段级 append：`{sessionID, messageID, partID, field, delta}`，schema/src/v1/session.ts:632-641）和 `message.part.updated`（整 part 替换）；TUI 收到 delta 后往 store 里对应 part 的 field 追加字符串（sync.tsx:392-441）。即“命令走 REST、数据走 SSE”的 CQRS 形态：prompt_async 只负责触发，渲染完全由事件驱动。

## 对 DSH 统一 API 层的可借鉴点（简评）

1. **同构面选在 WHATWG fetch（Request→Response）**是整个设计的支点：server 框架只要能产出 `fetch(Request): Promise<Response>` 纯函数（Effect httpapi 的 webHandler、Hono 的 app.fetch、我们未来的 dsc web server 均可），SDK 就能通过 `fetch` 选项零改动切换 in-process / Worker RPC / 真 HTTP 三种传输。
2. **类型打通靠 server-first OpenAPI**：路由声明用带 Schema 的 DSL → 导出 openapi.json → @hey-api codegen 出客户端。契约测试只需盯 openapi.json diff。
3. **事件设计取舍**：全局单 SSE 总线 + 事件自带归属字段 + 客户端过滤，简单但重连无 cursor，恢复靠 REST 全量 bootstrap——请求面与事件面正交，客户端 store 是唯一 join 点。
