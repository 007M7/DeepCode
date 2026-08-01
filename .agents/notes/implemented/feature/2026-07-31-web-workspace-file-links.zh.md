# Agent Note：从 web UI 打开产出的文件

Status: implemented

[English](2026-07-31-web-workspace-file-links.md) | 中文

> 范围：web 传输层上的 `/f` 工作区文件路由、其背后的 `IWorkspaces.fileUrl` 推导，以及会话中打开文件的交互改指向它。不在范围内：产物注册表、版本、实时重载，或任何面向模型的声明。

## 问题

一个产出了文件的 web 会话，没有办法看到那个文件。agent 写出了 `deepseek-homepage.html` 并如实告知，而用户唯一的办法是把 `/private/tmp/dsh-client-hotplug.ygPvsm/workspaces/plugin-hotplug/deepseek-homepage.html` 这样的绝对路径复制进终端。

零件几乎都在，只是指错了目标。`ToolRow` 早已把改写行或读取行的路径渲染成一个真正的按钮，`ui-conversation` 早已把它的点击经由 `openFile` 转发，`workspaces.openPath` 也早已把它送到 Host 的系统打开器。但那个打开器运行在 Host 机器上，而 `host.openPath` 被 `/api` 信任 fence 钉在回环，所以这个交互对经 LAN 访问的浏览器什么都答不了，即便在本机也是隐形的（路径的样式就是普通文本，只有 hover 时才有下划线）。与此同时 `MarkdownText` 会剥掉每一个非 `http(s)` 的 URL，因此模型写进收尾消息里的路径根本不可能成为链接；而 `ToolCallView.locations`——文件工具早已填好的跟随文件词汇——在客户端没有任何消费方。

## 决定

**在已有的传输层上加一条前缀路由，而不是加一项能力。** `client-connection` 持有两条面向浏览器的前缀：`/api` 承载 RPC，`/f/<sessionId>/<segments…>` 承载工作区文件读取。它本来就是持有 `httpServer`、`trustedHosts` 配置和浏览器信任 fence 的那个包；单开一个包会把 fence 和配置各复制一份，并逼着 `AppCLIEntry` 为一个 `--trusted-host` 标志去 patch 两行。webserver 自己的契约——每个特性面都是别的插件注册的一条路由——让这条路由本身就是全部机制。段落走路径而非查询参数，是为了让所服务文档的相对引用能解析到它的同级文件。

**请求指名 Session，由网关指名权限边界。** `ApiProxy.workspaceRootOf` 回答某个 Session 的文件位于何处——先看活跃 agent 的 `session.header.cwd`，再看持久化存储，绝不恢复会话——它是会话摘要早已携带的那个 `cwd` 的第二副面孔，只是不带信封。路由读取它而不是直接够 `ctx.agents`，因为 `client-connection` 注册在 client 程序里，而引入核心服务包会把它们 host 侧的 `sessions: SessionStore` 声明盖到浏览器运行时自己的 `sessions: SessionsService` 之上——这正是 `tsconfig.host.json`／`tsconfig.client.json` 分立所要防的那种冲突。cwd 与解析出的目标在前缀比较前都要过 `realpath`，因此工作区内指向工作区外的符号链接会因其目标而被拒绝；穿越写法在解析期就被拒，早于任何文件系统调用。读取经 `pipeline` 流出，因此客户端离开即销毁描述符，任何请求都不会把文件缓冲起来。

**URL 形状落在 `dsh-host-apiproxy/api`，与其余浏览器可导入的契约面同处一地。** 两端必须就同一套编码达成一致，但客户端 bundle 不允许值导入另一个插件的包：`packages/client/tsdown.client.ts` 里的纯度 gate 只放行平台模块与 `INLINE_SAFE` 协议层，而 apiproxy 正是其中之一。把 `api/files.ts` 放在那里，才使构造 URL 的浏览器半侧与解析它的服务半侧共用单一来源，而且没有新增任何包依赖边——两侧本来就依赖 apiproxy。

**所服务的文档不带任何隔离头。** 最初的做法是给能执行脚本的文档加 sandbox，理由是 `/api/events.mux` 是一条同源可读的 `GET` 流，离模型写的页面只有一次 `window.open` 之遥。实测把这个问题判向了另一边：在 `CSP: sandbox` 之下，报告中那份产物自己就会在 `localStorage` 上抛 `SecurityError`，主题切换当场变死；而 sandbox 所拒绝的那项能力，对这个页面的作者——一个已经握着本用户 shell 的 agent——而言从来就不需要经由浏览器取得。那道 sandbox 立在一条它早已越过的信任边界之后。被否掉的折中方案（`connect-src 'none'` 加上对两个 SSE `GET` 拒绝 `Sec-Fetch-Dest: document`）确实能救回预览，但它是唯一必须去改 RPC 网关的方案，而它依赖的那个头在明文 HTTP 的 LAN 上根本不发送。当工作区内容不再属于观看者本人时，隔离预览才成为一个真问题；那时的答案是一个独立的源，而不是一个头。

**客户端靠推导决定，而不是靠探测。** `IWorkspaces.fileUrl(sessionId, cwd, path)` 把工具报告的路径表达为 session cwd 之下的段落并返回相对于源的 URL，路径离开工作区时返回 `undefined`。`undefined` 恰好就是回退到 `openPath` 的信号，因此工作区外的文件行为与以往一致，也不需要任何能力协商。

## 考虑过的替代方案

- **产物能力族（RFC #268 / PR #272）**——一条带 id、版本、快照存储、自有 HTTP 服务器、SSE 实时重载与浏览器自动打开器的 seam。它的评审给出了七个 critical，而每一个都来自那套机械结构：未监听的打开器 spawn 会让 harness 崩溃、打开器继承 `DEEPSEEK_API_KEY`、进行中的 publish 活过 dispose、`readFile` 先于大小上限、快照的 TOCTOU，以及未 dispose 的 agent 导致保留期泄漏。`dsh web` 本来就跑着一个 HTTP 服务器，用户本来就在浏览器里，那套机械结构在这里买不到任何东西。RFC 与其测试保留下来，作为真正出现跨会话或版本化产物需求那天的输入；届时这条路由就是那条 seam 的天然挂载点。
- **单开一个 `dsh-client-workspace-files` 包**——如果文件服务是一项独立能力，这才是诚实的 seam 形状。它不是：它需要与 `/api` 相同的 fence 和相同的 `trustedHosts` 值，拆分会把两者都复制一份，违背仓库自己的“不要预先拆分”。
- **把 URL 形状模块留在 `client-connection` 里、由 runtime 去导入**——最初就是这么写的，构建直接拒绝：向客户端 bundle 做跨插件值导入，要么内联出一份重复的运行时实例，要么落到冻结模块表答不出的说明符上。这道 gate 正是共享模块落在协议层、而非落在恰好持有该路由的那个包里的原因。
- **`/f/<绝对路径>`，好让 `openPath` 保持为唯一调用点**——这会把 sessionId 从 URL 里去掉，但所服务的权限边界随之变成 host 已知的全部工作区之并集。紧的权限边界只花掉一处调用点的改动，因为 `openFile` 本来就同时持有 sessionId 与 cwd。
- **用 `connect-src 'none'` 加一道导航栅栏，在保持隔离的同时保住 `localStorage`**——经实测确实可行（Chrome 对 `window.open` 发 `Sec-Fetch-Dest: document`、对 `EventSource` 发 `empty`，回环也在内），但仍被否：它是唯一要往 RPC 网关里加规则的方案，而它依赖的那个头在明文 HTTP 的 LAN 上并不发送。机制的分量超过了它移除的威胁。
- **把路径在助手的收尾消息里链接化**——这是用户开口要的形状（“在结尾附上链接”），但它让渲染取决于模型是否把路径拼写得可识别。工具调用已经把 `locations` 作为结构化事实携带；消费它才是可靠来源，作为这条路由解锁的后续留下。

## 影响

现有的每一处文件交互都同时换了目标：write、edit、read 与通用单文件卡片都汇到 `openFile`，因此一处调用点的改动就让产出的文件在浏览器里可打开，LAN 客户端也在内。三个断言旧 `openPath` 去向的测试被改写为新的去向；工作区外的回退保留了旧断言。这条路由对着真实 HTTP 服务器与真实临时工作区做覆盖，因为收敛、内容定型与 sandbox 头都是协议事实；而组装后的 web 通道（`apps/web/tests/workspace-file-open.e2e.ts`，在冷播种会话上无密钥运行）证明了产品路径：点击读取行的路径会在第二个标签页打开 `/f/<sessionId>/a.txt` 并提供那个工作区文件，而穿越写法应答 404。预览保有自身的能力，因此把主题持久化到 `localStorage` 的生成页面，按其作者的意图正常工作。仍然暂缓：由 `locations` 推导的回合末交付物行，以及助手 Markdown 内部的任何链接化。
