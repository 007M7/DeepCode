# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

协议消费层：客户端插件的 apply 会挂载 `ctx.connection`（共享 API 客户端 + 单消费方流循环启动器）；导出表层携带协议契约类型、`AbstractApiClient` seam，以及循环的 sink／配置类型。node 半侧持有两条面向浏览器的前缀——`/api` 承载 RPC，`/f` 承载工作区文件读取——共用同一道信任 fence。`/api` 路由让特权方法集（`host.pickDirectory`、`host.openPath`，以及整个配置面——`settings.describe`/`update`/`replace`/`mutate` 与 `credentials.describe`/`set`/`unset`，读取也在内，因为 describe 会返回已暴露的配置，而探测任意引用会报出某条凭据来自何处）以空信任表过信任 fence，从而钉在回环——已声明的 `trustedHosts` 授权可达其余全部方法，而这些方法在真正的认证层出现之前仍只限回环本机。平台子类（WebApiClient/FixtureApiClient）、ConnectionController 循环和 fixture 数据源都属于包内部：apply 负责选择并驱动它们，测试则通过 src 访问。契约：api-contracts v3 §3。

## /api 浏览器信任栅栏

node 半侧在桥接前守卫 `/api` 下的每个请求（`src/api-request-trust.ts`）。每个请求——无论是否带浏览器标记——`Host` 都必须是回环地址权威，或与某个 `trustedHosts` 条目匹配：带端口的 `host:port` 条目精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化后比较（DNS rebinding 防御）。刻意不为无浏览器标记的请求开捷径：明文 HTTP 下浏览器的读取（EventSource、图片、导航——这些头只发给可信目标）既不带 `Origin` 也不带 Fetch-Metadata，因此无标记请求仍可能是被重绑页面发起的、响应可被读走的读取，而 Host 是重绑唯一伪造不了的请求头；非浏览器客户端经由回环地址、CLI 推导的 LAN IP 字面量或已声明的权威通过同一道栅栏。当标记存在时，`Origin` 必须与 Host 权威完全一致；显式的 `sec-fetch-site: cross-site` 标记一律拒绝。不是纯的、规范形 `host[:port]` 权威的 `trustedHosts` 条目——即 WHATWG 解析读回后与原文不完全一致的——会让插件加载大声失败：否则解析会悄悄授权 `harness.internal/path` 这类笔误里的 hostname，或把悬空冒号、补零端口放大成任意端口授权。失败在任何 RPC 分发之前以纯 403 应答。因此非回环（`--host 0.0.0.0`）部署需要让自己的服务权威被信任：dsh CLI 会自行推导本机的 LAN IP 字面量，其 `--trusted-host` flag 用于声明具名权威，所以 cordis.yml 中的 `trustedHosts` 面向 CLI 不参与引导的组合。这道栅栏刻意不承担认证职责——可达性策略归 webserver 绑定配置，认证仍是延期工作。决策记录：[api 浏览器信任边界 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md)。

## /f 工作区文件读取

node 半侧还会在 `/f/<sessionId>/<segments…>` 下逐个提供某个 Session 工作区里的文件，让产出的交付物能从报告它的那个页面直接抵达——`http` 页面无法跟随 `file://` 链接，而不在 Host 机器上的浏览器本来也没有那条路径。段落走 URL 而非查询参数，是为了让所服务文档的相对引用能解析到它的同级文件。请求指名一个 Session，由网关指名该 Session 的目录（`ApiProxy.workspaceRootOf`，它从活跃 agent 的 header 或持久化存储作答，绝不会为了提供一个文件而恢复 agent）；本包读取这个权威来源而不去够核心服务，因为持有它们的 host 侧 Context 声明会把它们盖到浏览器运行时自己的声明之上。URL 形状本身与其余浏览器可导入的契约面放在一起，位于 [`@deepseek-ai/dsh-host-apiproxy/api`](../../host/apiproxy/README.md)，因此构造 URL 的浏览器半侧与解析 URL 的这一半共享同一个编码决定。cwd 与解析出的目标在比较前都要过 `realpath`，因此工作区内指向工作区外的符号链接会因其目标而被拒绝，而不是因其名字；穿越写法拒得更早，在解析期、任何文件系统调用之前。读取是流式的（没有请求会把文件缓冲起来），只应答 `GET`／`HEAD`，并带上 `nosniff` 与 `no-store`。所服务的内容类型表之外的扩展名一律按 `text/plain` 定型而非作为下载给出，因为工作区读取本就是一个“让我看看这个文件”的请求。

能执行脚本的文档——`.html`、`.htm`、`.xhtml`、`.svg`——还会额外带上 `Content-Security-Policy: sandbox allow-scripts allow-popups allow-modals allow-forms`，让它们运行在不透明源中。工作区文件未必由 agent 撰写：一条 read 行就能让 clone 下来的仓库里任何文件变得可打开，因此与 `/api` 同源提供的活动文档，其脚本会带着浏览器信任 fence 通行到每一个方法，包括那些正因会改动设置与凭据而被钉在回环的方法。代价由预览承担——其中无法使用 `localStorage`、cookie 与同源 `fetch`，因此一个会记住主题的生成页面在预览里记不住——而 `host.openPath` 仍是在 Host 机器上以完整能力打开同一文件的方式。要在不重新打开这个洞的前提下取回那些能力，需要的是一个独立的源，而不是一个更弱的头。这条前缀由同一道信任 fence 把守，因此配置了 `trustedHosts` 的部署提供工作区文件的范围，与它提供普通读取的范围完全一致。

## 无密钥 fixture

fixture 载体没有 `/f` 路由，而 `IWorkspaces.fileUrl` 无论载体为何都在浏览器侧推导 URL，因此在 `fixture=` 下点击文件路径行会打开一个 404 的标签页，而此处从前是 Host 打开器的静默空操作。今天的 fixture 页面并不含文件行；若某个 fixture 场景要加上它们，应当把这段推导打桩，而不是教这个内存载体去提供字节。

任何 `fixture` 查询参数都会选择内存载体。`fixture=empty` 启动时不含 Workspace 或 Session；`fixturePrompt=reject` 在接受前拒绝提示词；`fixtureAttach=fail` 发布 Session 但拒绝将其附加到 Workspace；`fixtureSessionCreate=drop-response` 在丢弃创建响应前发布 Session 并为其发出帧；`fixtureFrames=workspace-first` 则反转默认的 Session 优先创建帧顺序。按名称／路径创建 Workspace 以及由调用方预先分配 SessionId，均具有足够的确定性，组装后的 Web 测试可以据此协调列表与帧的到达。fixture 内容搜索会保留面向生产环境的 `unicode61` 式大小写、变音符号和 token／短语行为，并返回以匹配位置为中心、最多包含 120 个 Unicode 码点的 snippet。

## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **history 的隐式恢复存在争议**：在未附加的会话上打开 history，会在主机侧拉起 agent；纯持久化读取的替代方案记录在 rt-core 协调账本中，P-I 不作改变。该包的消费方会在首次打开时感受到这段延迟。
- **计划移除 `ToolEventView`／`ToolCallView`／`ToolResultView` 的重新导出**：当 toolview 迁移删除主机 `viewFor` 行时，它们会一并移除（呈现属于客户端）；在此之前，fixture 保留一份局部 `viewFor` 镜像。
