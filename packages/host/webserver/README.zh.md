# @deepseek-ai/dsh-host-webserver

[English](README.md) | 中文

Web HTTP 与 upgrade route 注册插件（默认导出 `HttpServerService`，配置为 `{host, port, distIndex}`）：一个在激活时开始监听的 `node:http` 服务器，提供 `ctx.httpServer`。`register(route)` 添加具名的 `exact`／`prefix` HTTP route；`registerUpgrade(route)` 添加精确 pathname 的 upgrade route；同一张表内的重复路径会抛错，因为 route 模式是组合层契约，冲突即配置错误；两者返回的 disposer 都会移除注册。`tapIndex(transform)` 添加按注册顺序应用的 index.html 转换，`port` 读取正在监听的端口（当 `port` 为 0 时读取 OS 分配的值），`host` 读取配置的绑定宿主（这些是其他插件据以自适应的组合期事实，例如 directory-picker 选择器）。HTTP 匹配顺序固定不变：先在整张表中匹配精确 route，再匹配最长前缀，最后回退到静态 dist，并遵循固定语义：越出 dist 根目录的遍历返回 403，任何未命中项都以 HTTP 200 回退到 `index.html`（SPA 路由），未知扩展名按 octet-stream 提供，GET／HEAD 之外的方法返回 405。upgrade 只做精确匹配，未命中连接直接关闭；注册顺序不承载任何面向请求的语义。

该包不了解任何 harness 概念：`/api` HTTP 桥接与下行 WebSocket 是 connection 插件的 route，插件 bundle 与 HMR（热模块替换）事件流则是 modules／hmr 插件的 route。upgrade handler 拥有协议握手与连接内容；webserver 只交付原始 socket 与 request。`host` 只接受 `127.0.0.1`（默认姿态）和 `0.0.0.0`（有意向网络开放）；`distIndex` 是由组合应用解析并注入的组装事实，绝不会自行解析，因为 dist 位置属于应用的工作区知识。该服务器只服务 Web（浏览器）形态；Electron 通过 `file://` 加载 dist，并经 IPC 桥接承载 fetch，而不使用本服务器。该包从不打印内容；URL 行属于 shell。

监听失败（EADDRINUSE……）会从激活过程抛出，以 bind 诊断使 Loader 组合 reject；失败的候选 fiber 会被 dispose（资源释放）。处理 HTTP 请求时抛错（例如格式错误的百分号转义传入 `decodeURIComponent`，或客户端在请求体传输中途断开）时，服务器会响应 400；若响应头已经发出，则销毁 socket，并记录 warning，但绝不会退出进程。upgrade handler 抛错或升级 socket 出现传输错误时，会记录 warning 并销毁对应 socket。资源释放会启动 `close()` 与 `closeAllConnections()`，销毁所有受跟踪的升级 socket，并仅在 HTTP server 与这些 socket 均已关闭后返回。

在开发环境中，客户端插件注册表会在返回前同步捕获每个已构建 bundle 的 stat 基线，随后轮询这些基线，并在内容变化后重新计算哈希。每次重新扫描都会先暂存候选表、图和监听 map，再统一发布，因此基线失败会保留先前的图。这样，即时重建不会消失在异步建立的监听基线中；重命名窗口会把路径标记为脏，保留最近一次成功基线，并在 bundle 重新出现时强制重新计算哈希，即使其元数据完全相同也不例外。

## 模型体验

无。该包只是浏览器与其他插件所注册 HTTP／upgrade route 之间的 Web 载体，其中没有任何内容会进入模型请求。

#### KV 缓存影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

- **不提供 TLS、认证或来源策略**：绑定非回环地址会向对应网络公开服务器；面向部署的加固措施（或在前方放置真正的反向代理）有意不纳入面向开发环境的 v1。
- **初始 MIME 表很精简**：Vite 输出集合以外的扩展名会回退到 `application/octet-stream`；实际发布新的资产类别时再扩展该表。
- **Socket 选项固定不变**：配置只选择绑定宿主与端口；在具体部署产生需求前，backlog 和其他 socket 设置仍保持内部实现。
