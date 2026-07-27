# HTTP 服务器

[English](http-server.md) | 中文

[dsh-host-webserver](../../packages/host/webserver) 是 GUI 宿主 web 形态的 HTTP 载体：单个提供 `ctx.httpServer` 的 `node:http` 插件，由具名路由注册表加 index.html 转换挂点组成，兜底是静态 dist 回退。它不属于 agent loop（智能体循环）主干，也不是能力 seam：它不了解任何 harness 概念，每个功能表面（`/api` 桥接、插件 bundle、HMR（热模块替换）事件流）都是由其他插件注册的一条路由（[分层说明](../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)）。仅限 web（浏览器）形态：Electron 通过 `file://` 加载 dist，并经 IPC 桥接承载 fetch，不经过本服务器。

源码：[`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

## 路由

```ts type-equiv
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
type WebRouteKind = 'exact' | 'prefix'
```

```ts type-equiv
/** One named route registration. */
interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
```

匹配顺序固定：先查 exact 表，再取最长匹配前缀，最后落到静态 dist 回退。注册顺序不携带任何面向请求的语义：具名路由在组合上互不相交，启动窗口期内尚未被认领的请求全部由回退应答。回退遵循固定语义：非 GET/HEAD 返回 405，越出 dist 根目录的遍历返回 403，任何未命中都以 HTTP 200 回退到 `index.html`（SPA 路由），未知扩展名按 octet-stream 提供（[`static.ts`](../../packages/host/webserver/src/static.ts)）。

## 配置

```ts type-equiv
/** Gateway config: listen address plus the static dist anchor (injected by the composing app, never self-resolved). */
interface Config {
  /** Listen host; the two supported values are loopback and all-interfaces. */
  host: '127.0.0.1' | '0.0.0.0'
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /** Absolute path of index.html inside the static root (dist location is workspace knowledge of the app). */
  distIndex: string
}
```

`host` 只接受 `127.0.0.1`（默认姿态）和 `0.0.0.0`（刻意的网络暴露）；没有 TLS、认证或 origin 策略，因此绑定到非回环地址会把服务器暴露给该网络。`distIndex` 是组合应用解析后注入的组装事实。

## 服务

`HttpServerService`（`ctx.httpServer`）在激活时立即监听；监听失败（EADDRINUSE 等）会从 init 抛出，形成一个 FAILED fiber，由启动的大声失败 sweep 上报。`register(route)` 添加一条具名路由并返回其 disposer；重复的 `(kind, path)` 抛出异常，因为路由模式是组合层契约，冲突即配置错误。`tapIndex(transform)` 添加一个纯的 html 到 html 转换，按注册顺序应用于每个 index 响应（`/` 和每次 SPA 回退）；[dsh-client-modules](../../packages/client/modules) 用它注入启动 manifest（元数据清单）。`port` 读取监听端口，`config.port` 为 0 时读到的是操作系统分配的值。

处理过程中抛出异常的请求（畸形的 % 转义撞上 `decodeURIComponent`、客户端在请求体中途断开）会记录为警告并应答 400（响应头已发出时则销毁 socket），绝不导致进程退出。dispose（资源释放）把 `close()` 与 `closeAllConnections()` 配对使用，因为处理器可能像 SSE（Server-Sent Events）那样保持响应打开，而这类连接永远不会自行结束；没有强制关闭，拆卸就会挂起。该包（package）从不打印输出：URL 行归 shell 所有。逐包运维细节（含开发模式的 bundle 监视流水线）留在 [README](../../packages/host/webserver/README.md) 中。
