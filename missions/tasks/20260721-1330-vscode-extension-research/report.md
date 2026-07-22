# VS Code 扩展体系双边设计调研

> 调研目的：为 dsh web GUI 插件系统（React + cordis，浏览器 client + node host 双侧）提供参照。
> 源码：本地 VS Code 仓库（code-oss-dev 1.131.0），文件路径均相对 vscode 仓库根。
> 日期：2026-07-21。

## 1. 进程/宿主拓扑

### 1.1 三种 extension host

`src/vs/workbench/services/extensions/common/extensionHostKind.ts` 定义了封闭枚举：

```ts
export const enum ExtensionHostKind {
    LocalProcess = 1,   // 桌面版：独立 Node.js 进程（Electron UtilityProcess）
    LocalWebWorker = 2, // Web 版/桌面版均可：浏览器 Web Worker
    Remote = 3          // 远程开发：SSH/容器/WSL 那头的 Node.js 进程
}
```

三种宿主对应三套启动实现，目录即分层：

| 宿主 | 启动实现 | 运行环境 | 跑什么扩展 |
|---|---|---|---|
| LocalProcess | `services/extensions/electron-browser/localProcessExtensionHost.ts`（经 `extensionHostStarter.ts` 创建 Electron UtilityProcess） | 独立 Node.js 进程 | 桌面版所有 node 入口扩展 |
| LocalWebWorker | `services/extensions/browser/webWorkerExtensionHost.ts` | **iframe 里再套一层 Web Worker** | `browser` 入口的 web 扩展 |
| Remote | `services/extensions/common/remoteExtensionHost.ts`（走 WebSocket 连远程 agent） | 远端 Node.js 进程 | workspace 类扩展（语言服务等要贴近文件系统的） |

一个窗口可以**同时运行多种宿主**（桌面+远程场景下三种全有）。每个扩展跑在哪由 `determineExtensionHostKinds()`（同文件）根据扩展声明的 `extensionKind`（`ui` / `workspace` / `web`）、安装位置（本地/远程）和开发偏好裁决。扩展宿主实例由 `extensionHostManager.ts` 统一管理，每个宿主各持一条独立的 RPC 通道。

扩展入口进程侧的 main：node 版 `src/vs/workbench/api/node/extensionHostProcess.ts`，worker 版 `src/vs/workbench/api/worker/extensionHostWorkerMain.ts`，共享核心 `src/vs/workbench/api/common/extensionHostMain.ts`（`ExtensionHostMain` 类：建 RPC、建服务注入容器、扫描并激活扩展）。

### 1.2 renderer（workbench）侧跑什么

renderer 进程跑的是 **workbench 本体 + 每个扩展宿主的 `mainThread*` 适配器**（`src/vs/workbench/api/browser/mainThread*.ts`，约 90 个文件）。这些适配器不是扩展代码，而是 workbench 服务在 RPC 上的投影：把扩展的注册请求落到真正的 UI 服务（状态栏、树视图、诊断……），把 UI 事件转发回扩展宿主。

### 1.3 「renderer 里没有扩展代码」如何强制

这不是纪律约定，是**物理隔离**，三层机制：

1. **进程/环境边界**：扩展代码只在 UtilityProcess、Web Worker 或远程进程里 `require`/`import`。renderer 的模块加载器根本不会加载扩展的 `main`/`browser` 入口。扩展与 workbench 之间只有一条 `IMessagePassingProtocol` 字节流（见第 4 节），没有任何共享对象引用。
2. **Web Worker 天生无 DOM**：`LocalWebWorker` 宿主里连 `document` 全局都不存在，「不能碰 DOM」由 JS 运行时保证。
3. **iframe 源隔离再加一层**：web 版的 worker 宿主不是直接 `new Worker()`，而是先建一个**独立子域名的 iframe**（`services/extensions/worker/webWorkerExtensionHostIframe.html`），iframe 带严格 CSP（`default-src 'none'`），并用 sha-256(parentOrigin+salt) 编进子域名做**源校验**——防止恶意页面嵌套该 iframe 骗取 bootstrap 握手后注入 worker 代码。iframe 内再起 Worker 跑扩展。即使扩展代码想逃逸 worker，它面对的也是一个与主 workbench 不同源的空白 iframe，同源策略挡死。

对我们的对照：VS Code 的「扩展不碰 DOM」花了三层工程代价才守住；我们既然决定让 client 插件跑在浏览器主 context，等于主动放弃这道墙，换来的是插件直接注册 React 组件的表达力（详见第 5 节权衡分析）。

### 1.4 例外：真正在 renderer 里跑的「扩展代码」只有两类

- **Webview 内容**：扩展提供的 HTML 跑在 renderer 的 iframe 里，但那是扩展给的静态内容+其自带脚本，与 workbench 仍然 postMessage 隔离，且不同源。
- **Notebook renderer**：同理，沙箱 iframe。

即：任何扩展提供的可执行前端代码，一律装进不同源 iframe，永远拿不到 workbench 的 DOM 和 JS 堆。

## 2. 包结构与声明模型

### 2.1 manifest：`main` / `browser` 双入口

扩展就是一个带 `package.json`（manifest）的 npm 包，入口字段：

- `main`：Node.js 入口（LocalProcess / Remote 宿主加载）。
- `browser`：Web Worker 入口（LocalWebWorker 宿主加载）。
- 两个都没有 = **纯声明扩展**（主题、语法、语言包、代码片段），没有任何可执行代码，永远不会被激活，`implicitActivationEvents.ts` 里直接短路：`if (typeof desc.main === 'undefined' && typeof desc.browser === 'undefined') return [];`。

内置扩展样本（extensions/ 目录）：

| 扩展 | main | browser | 说明 |
|---|---|---|---|
| `theme-monokai` | — | — | 纯 contributes.themes，指向一个 JSON 文件 |
| `json` | — | — | 纯 contributes.languages+grammars（声明文件后缀/别名/TextMate 语法） |
| `typescript-language-features` | `./out/extension` | `./dist/browser/extension` | 双入口：桌面跑完整 tsserver，web 跑受限版 |
| `git` | `./out/main` | — | 只有 node 入口：依赖 spawn git 进程，web 下装不上 |

双入口是**同一份 API、两次打包**：源码里用条件导入隔离 node 专属依赖（`fs`、`child_process`），browser 打包裁掉这些路径。什么时候两个都有：逻辑本身平台无关（语言智能、markdown 渲染），只是外围 IO 不同。什么时候只有 main：核心能力依赖 node（spawn 子进程、原生模块）。

宿主选择还受 `extensionKind`（`ui`/`workspace`/`web`）控制；未显式声明时由 `extensionManifestPropertiesService.ts` 的 `deduceExtensionKind()` 推导：有 `main` → `workspace`；只有 `browser` → `web`；纯声明扩展 → 所有 kind 都行（谁需要谁消费），再按每个 contributes 点声明的 `defaultExtensionKind` 收窄。

### 2.2 contributes（静态声明）vs activate()（动态代码）的分工哲学

这是 VS Code 扩展模型的**核心设计决策**：manifest 的 `contributes` 是纯 JSON 数据，workbench **不激活扩展、不跑一行扩展代码**就能消费它。扩展点注册表在 renderer 侧（`src/vs/workbench/services/extensions/common/extensionsRegistry.ts`，`ExtensionsRegistry.registerExtensionPoint()`），每个扩展点自带 JSON Schema（供 manifest 编辑时校验补全）。`extensionPoints.json` 列出全部 ~60 个扩展点。

**纯声明可用（不激活扩展就生效）**：
- `themes` / `iconThemes` / `productIconThemes`——指向主题 JSON 文件路径；
- `languages`（文件后缀→语言 id 映射）、`grammars`（TextMate 语法文件）、`snippets`；
- `localizations`——语言包：`{ languageId, translations: [{ id: 'vscode' | 'publisher.ext', path }] }`，翻译文件按 NLS key 查表（`contrib/localization/common/localization.contribution.ts`）；
- `commands`（命令的 title/icon/category——**菜单里显示不需要激活**）、`menus`、`keybindings`、`submenus`；
- `configuration`（设置项 schema——设置界面能渲染、能存取，无需扩展在场）；
- `colors` / `icons`（注册新的主题颜色 id / 图标 id，纯数据）；
- `views` / `viewsContainers`（左侧栏容器和视图的**占位**：图标、标题、collapsed 状态都能渲染）；
- `statusBarItems`（静态状态栏项）、`problemMatchers`、`taskDefinitions`、`jsonValidation`。

**必须进 host 跑代码**：命令的**实现**、TreeDataProvider、语言服务 provider、调试适配器、文件系统 provider、webview 内容——一切「行为」。

衔接机制是**懒激活（activation events）**：manifest 声明 `activationEvents`（`onLanguage:x` / `onCommand:y` / `onView:z` / `workspaceContains:glob` / `onStartupFinished` / `*`）。workbench 先用静态声明把 UI 全部画出来（菜单项、视图占位、命令面板条目），用户真正触碰时才 `activateByEvent()`（`abstractExtensionService.ts:992`）唤起对应扩展跑 `activate()`。近年演进方向是**声明进一步吞掉激活样板**：`implicitActivationEvents.ts` 允许扩展点注册 generator，从 contributes 自动推导激活事件（声明了 `views` 就自动有 `onView:<id>`），扩展作者不再手写。

哲学总结：**「让 UI 骨架不依赖扩展代码存活」**。收益三层：① 启动性能——零扩展代码即可画完整 UI；② 可靠性——扩展崩溃不影响菜单/主题/布局；③ 可索引性——市场/设置页能静态展示扩展贡献了什么。代价是每新增一类 UI 贡献都要设计一个 JSON schema + renderer 侧消费逻辑，扩展点演进慢（要过 API 评审）。

### 2.3 主题与语言包的具体形态（我们有对应需求）

- **颜色主题**：`contributes.themes[].path` → 一个 JSON（`colors`: workbench 颜色 token 表，`tokenColors`: TextMate 着色规则）。关键点：**主题不是代码，是对预注册颜色 id 空间的赋值**。颜色 id 空间由 workbench 和扩展（经 `contributes.colors`）预先注册，主题文件只是 `id → 色值` 字典。运行时切换 = 换字典 + 重算 CSS 变量。
- **语言包**：`contributes.localizations[]`，每个翻译单元 `{ id, path }`，id 是 `vscode`（核心）或 `publisher.ext`（给别的扩展提供翻译）。同样纯数据查表，NLS key → 译文，缺失回退英文。语言包扩展可以给**任意其他扩展**提供翻译——翻译供给与被翻译方解耦。

## 3. 两边差异化能力与相同能力

### 3.1 extension host 侧 API 面（`vscode` 名字空间）

扩展代码 `import * as vscode from 'vscode'` 拿到的不是一个真实 npm 模块，而是**宿主注入的 API 对象**：`src/vs/workbench/api/common/extHost.api.impl.ts` 的 `createApiFactoryAndRegisterActors()` 返回一个工厂，**按扩展逐个实例化** API 对象（`function (extension, extensionInfo, configProvider): typeof vscode`）——这样每个 API 调用都自带调用方扩展身份（权限检查、遥测归因、proposed API 门禁都靠它）。模块注入靠 require/import 拦截器（`extHostRequireInterceptor.ts`；worker 版干脆用 `new Function('module','exports','require', source)` 包住扩展源码，喂一个假 `require`，见 `api/worker/extHostExtensionService.ts`）。

**能干什么**：命令注册/执行、工作区文件访问（经 FileSystemProvider 抽象）、语言特性 provider、诊断、配置读写、各类 UI 的**参数化遥控**（消息框、快速选择、进度、状态栏、树视图、webview——全部是「发数据给 renderer 画」）、终端、调试、任务、认证、SCM、测试、LM 工具。

**明确不能干什么**：
- **碰不到 DOM**。机制不是 lint 或审查，而是环境里根本没有：worker 宿主无 `document`；node 宿主是无 UI 进程。API 面上也没有任何方法返回 DOM 节点或接受回调渲染——UI 相关 API 全部只收**可序列化数据**（字符串、URI、ThemeIcon id、命令 id），唯一的「自由 UI」出口 Webview 也只收 HTML 字符串（`MainThreadWebviewsShape.$setHtml(handle, string)`），在 renderer 侧灌进沙箱 iframe。
- 不能同步访问 UI 状态：一切跨线，一切 `Promise`/`Thenable`。API 里没有任何同步读 UI 的方法。
- 不能任意改 workbench 布局/样式：只能在预留槽位（视图容器、状态栏、面板）里注册参数化条目。没有「注入 CSS」的 API。

### 3.2 UI 定制两大通道：TreeView（数据驱动）vs Webview（全量 HTML）

**TreeView**：扩展实现 `TreeDataProvider`（`getChildren`/`getTreeItem`），跨线传输的是 `ITreeItem` 纯数据 DTO（`src/vs/workbench/common/views.ts`）：label/description/icon(ThemeIcon 或 URI)/tooltip(Markdown)/collapsibleState/command/contextValue/checkbox——**没有任何自由渲染字段**。渲染完全由 workbench 做（虚拟滚动、主题、键盘导航、无障碍全部免费）。协议是拉取+失效通知：扩展 `$refresh`，workbench 回头按需拉子节点（`MainThreadTreeViewsShape` / `ExtHostTreeViewsShape.$getChildren`）。
`contextValue` 是个值得注意的小设计：树节点带一个字符串标签，菜单贡献用 `when: viewItem == 'x'` 声明式挂上下文菜单——数据驱动 UI 与静态菜单声明的组合拳。

**Webview**：扩展给全量 HTML 字符串，workbench 灌进**异源沙箱 iframe**；双向仅 `postMessage`（可带 VSBuffer）；本地资源必须经 `asWebviewUri()` 转成特殊 scheme 才能加载；不写 CSP 会被警告（`extHostWebview.ts:234`）。有 `retainContextWhenHidden`（贵）和序列化恢复两种生命周期策略。

**分界**：列表/树状、条目同质 → TreeView；任意自定义渲染（预览、图表、编辑器）→ Webview。中间地带没有——这是 VS Code 被抱怨最多的表达力鸿沟（想给树节点加个进度条都不行），近年靠给 TreeItem 缓慢加字段（checkbox、badge…）一点点填。

**参数化 UI 的 API 形态**（对应我们 statusline/左侧按钮需求）：
- StatusBarItem：`createStatusBarItem(alignment, priority)` 返回一个**属性包对象**，扩展设 `text`（支持 `$(icon)` 语法）/`tooltip`/`command`/`color`/`backgroundColor`（仅限预定义 ThemeColor id）后 `.show()`；跨线就是一条 `$setEntry(id, ...全部属性)`（`MainThreadStatusBarShape`），更新=整条重发。**颜色只能用主题色 id，不能任意 RGB**——保证任何主题下不破相。
- 视图容器/视图：`contributes.viewsContainers` + `contributes.views` 纯静态声明（id、title、icon 路径），运行时扩展只能往已声明的 id 上挂 provider。图标是 SVG 路径或 codicon id，不是组件。

### 3.3 web extension 少了什么、怎么声明兼容

- **声明**：有 `browser` 入口即 web 兼容；纯声明扩展（无 main 无 browser）天然 web 兼容；只有 `main` 的扩展 web 版直接不可用。`extensionKind` 可显式覆盖（`'-web'` 表示明确退出 web）。
- **少了的能力**（web worker 环境使然）：不能 spawn 进程（终端 shell、调试适配器、依赖 CLI 的一切）；不能加载原生模块；没有真实文件系统（一切经 FileSystemProvider RPC，虚拟工作区）；网络受浏览器 CSP/CORS 约束；`require` 别的 npm 包必须打成单 bundle（worker 里的 `require` 是假的，只认 `vscode`）。
- **API 面本身不变**——同一份 `typeof vscode`，但部分 API 在 web 下行为降级或返回空（如 task/debug 相关）。兼容性还有 `capabilities.virtualWorkspaces` / `untrustedWorkspaces` 两个正交声明轴。

## 4. 双边通信协议

### 4.1 分层结构

```
扩展代码 ── vscode API（extHost.api.impl.ts 工厂注入）
   │
extHost* 适配器（api/common/extHost*.ts，≈90 个）      ← ext host 侧
   │  getProxy(MainContext.MainThreadX).$method(...)
RPCProtocol（services/extensions/common/rpcProtocol.ts）
   │  IMessagePassingProtocol（字节流：MessagePort / 管道 / WebSocket）
RPCProtocol
   │  getProxy(ExtHostContext.ExtHostX).$method(...)
mainThread* 适配器（api/browser/mainThread*.ts，≈90 个）  ← renderer 侧
   │
workbench 服务（真正的 UI）
```

**proxy identifier 模式**（`services/extensions/common/proxyIdentifier.ts`）：每个跨线对象一个 `ProxyIdentifier<T>`，携带字符串 id（调试用）+ 自增数字 id（线上寻址，报文里只占 1 字节）。全部契约集中在一个文件 `api/common/extHost.protocol.ts`（4200 行）：`MainThread*Shape` 接口 + `ExtHost*Shape` 接口 + `MainContext`/`ExtHostContext` 两张 identifier 表（各 ~90 个）。**两边看到的是同一份 TS 接口文件**——协议契约单一来源，改协议必然两边同时编译报错。

**$ 前缀约定**：所有跨线方法名以 `$` 开头。RPC proxy 是 `new Proxy` 实现（`rpcProtocol.ts:251`）：只有访问 `$` 开头属性才生成远程调用桩——`$` 是「这个调用会跨线」的视觉+机制双重标记。类型层面 `Proxied<T>` mapped type 把所有方法签名改写成 `(...Dto<args>) => Promise<Dto<result>>`：**跨线即异步、跨线即失去类实例身份**，编译期就强制感知。

**成对文件结构**：功能 X = `mainThreadX.ts`（renderer，`@extHostNamedCustomer(MainContext.MainThreadX)` 装饰器注册，见 `extHostCustomers.ts`）+ `extHostX.ts`（ext host，构造时 `rpcProtocol.set(ExtHostContext.ExtHostX, this)`）。两个文件各自实现自己那侧的 Shape，各自持对方的 proxy。生命周期：mainThread customer 随扩展宿主启动实例化、随宿主关闭 dispose。

### 4.2 调用方向与序列化边界

- **双向对称**：同一 RPCProtocol 实例两边各一份，谁都能发起请求。语义上惯例：extHost→main 是「注册/请求做事」（`$registerCommand`、`$setEntry`），main→extHost 是「事件通知/拉数据」（`$acceptModelChanged`、`$getChildren`）。
- **报文格式**（`rpcProtocol.ts` `MessageIO`）：自定义二进制帧——1 字节消息类型 + 4 字节请求号 + 1 字节 rpcId + 短字符串方法名 + JSON 参数。12 种消息类型：Request(JSON/Mixed × 带/不带取消) / Acknowledged / Cancel / ReplyOK(Empty/VSBuffer/JSON/JSONWithBuffers) / ReplyErr(Error/Empty)。
- **能过线的东西**：JSON 可序列化值 + 三个特例：
  - **VSBuffer**（二进制）：不进 JSON，走 Mixed 参数编码或 `SerializableObjectWithBuffers`（JSON 里嵌 `$$ref$$: n` 占位符引用旁路的 buffer 数组）——大二进制零 base64 开销；
  - **URI**：`toJSON()` 成 `{$mid: 1, scheme, path...}` 组件对象过线，接收侧按需 `URI.revive()`；`$mid`（MarshalledId，`base/common/marshallingIds.ts` 有 ~30 种）是「可复活对象」的类型标签。remote 场景下 URI 还要经 `IURITransformer` 改写 scheme（本地 `file:` ↔ 远程 `vscode-remote:`）——**URI 转换内建在 RPC 层**，扩展无感;
  - **CancellationToken**：见下。函数过不了线（`Dto<T>` 把 Function 映射成 never，编译期拦截）；类实例过线变哑对象（只剩 toJSON 的产物）。
- **取消**：约定俗成——若调用最后一个参数是 CancellationToken，RPC 层摘掉它，改发 `RequestWithCancellation` 类型报文；调用方 token 触发时补发一条 `Cancel(req)` 报文；被调侧为每个在途请求存一个 `cancel()` 闭包（`_cancelInvokedHandlers`）。**token 本身不过线，过线的是取消信号**。
- **错误传播**：`SerializedError`（name/message/stack 三元组）过线，接收侧重建 Error 对象 reject 掉 pending promise。
- **可靠性细节**：每个请求先回一条 `Acknowledged`（与业务响应分离），3 秒无 ack 即标记宿主 unresponsive 并发事件（UI 显示「扩展宿主无响应」）——**探活内建在协议层**，不用额外心跳。协议 dispose 时所有 pending promise 以 canceled 结算。

### 4.3 状态同步模式

**事件推送为主、增量为纲**，不是快照拉取：
- **文档内容**（高频热路径）：renderer 是 single source of truth。打开文档时 main→extHost 推一次全量（`$acceptDocumentsAndEditorsDelta`），此后每次编辑推**增量 change event**（`ExtHostDocumentsShape.$acceptModelChanged(uri, ISerializedModelContentChangedEvent, isDirty)`），ext host 侧维护一份镜像文档（MirrorTextModel）自己 apply delta。扩展读文档 = 读本地镜像，**零 RPC**。写方向相反：扩展只能提交 edit 请求（`$tryApplyEdits`），由 renderer 裁决（乐观并发，版本号不匹配则失败）。
- **树视图**（低频冷路径）：拉取式——扩展 `$refresh` 打失效标记，workbench 可见时才 `$getChildren` 按需拉。
- **配置/主题/工作区**：变更时全量或分组快照推送（`$acceptConfigurationChanged`）。

结论：三档策略按频率与体量选型——高频大对象=一次快照+增量事件+双侧镜像；低频按需=失效通知+拉取；小全局状态=直接推快照。

## 4.5 案例研究：git 扩展——「数据面插件」如何绑定 scope 供数给 UI

git 扩展（extensions/git/）是 VS Code 体量最大的「纯数据面」内置扩展：**全部逻辑跑在 extension host（仅 node 入口，`main: ./out/main`，无 browser 入口），零自绘 UI，不写一行 HTML**。它是我们「statusline 显示 git branch / agent scope 状态」这条链路的最佳原型。

### 4.5.1 对外供数的通道

四条，全部是「数据出、命令回」：

1. **SCM 模型**：`scm.createSourceControl(id, label, rootUri)` → SourceControl + ResourceGroup（index/workingTree/merge/untracked 四组），扩展只填 `resourceStates` 数组（每项=uri+装饰+命令），SCM 视图由 workbench 渲染。
2. **statusBarCommands**：SourceControl 上的属性（见下），状态栏两个格子（分支名+同步状态）的内容。**注意：git 的状态栏条目不走全局 StatusBarItem API，而是挂在 SourceControl 上按 repo 供数**——这正是 scope 绑定的关键设计。
3. **FileDecorationProvider**（decorationProvider.ts）：文件树/tab 上的 M/U/A 徽标和颜色，拉取式 provider（workbench 按 uri 问，扩展答 `FileDecoration(badge, tooltip, ThemeColor)`）。
4. **API 导出**（api/）：给其他扩展（GitHub PR 等）用的 `git.API`，host 侧内部接口，不跨线。

### 4.5.2 scope 绑定模式：per-repo 模型对象 + rootUri 即 scope 键

- **发现与实例化**：`model.ts` 的 `Model` 是单例总管——`scanWorkspaceFolders()` 扫出所有 git 根，**每个 repo 一个 `Repository` 模型对象**（repository.ts，3500 行），持有该 repo 的全部状态（HEAD/remotes/resourceGroups/operations）和自己的 FS watcher、StatusBarCommands、AutoFetcher。多 repo = 多个 Repository 实例，互不知晓。
- **scope 键就是 rootUri**：每个 Repository 建自己的 SourceControl 时传 `rootUri`（repository.ts:984 `scm.createSourceControl('git', 'Git', root, ...)`）。这个 URI 过线后成为 renderer 侧一切路由的依据。Model 侧路由用同一把钥匙：`getOpenRepository(hint)` 接受 Uri/SourceControl/字符串，按路径前缀匹配到 Repository（model.ts:956）。
- **「当前该显示哪个 repo」由 renderer 裁决，扩展不参与**：`src/vs/workbench/contrib/scm/browser/scmViewService.ts:281` 用 observable 推导 `activeRepository`——active editor 的 uri → `scmService.getRepository(uri)`（按 rootUri 前缀匹配）→ 无命中时保持上一个值（`lastValue`，避免切到非文件 tab 时状态栏闪没）→ 再与「SCM 视图里聚焦的 repo」取最新变化者，用户还可手动 pin 覆盖。状态栏渲染只认 `activeRepository.provider.statusBarCommands`（`scm/browser/activity.ts:110-113`）。

分工一句话：**扩展侧为每个 scope 各算各的状态、全部推过去；renderer 侧持有「哪个 scope 当前可见」的 UI 语境，负责选片**。扩展永远不知道也不需要知道哪个 repo 正被显示——这让「切 tab 状态栏立刻换 repo」零 RPC 延迟（数据早就在 renderer 侧了）。

### 4.5.3 状态更新链路与节流合批

全链路（以文件改动为例）：

```
FS watcher (workspace.createFileSystemWatcher('**') + DotGitWatcher)
  → onFileChange 前置闸门（repository.ts:3171）：autorefresh 开关 / 巨库跳过 / 有操作在跑则跳过
  → @debounce(1000)（静默 1 秒才动手）
  → @throttle + whenIdleAndFocused()（等 git 操作空闲 && 窗口聚焦；完事再 timeout(5000) 冷却）
  → git status 子进程 → _updateModelState（可取消：新一轮直接 cancel 旧的 token）
  → 更新 Repository 内存状态 → _onDidChangeStatus.fire()
  → 两路扇出：
     a) statusBar.onDidChange → sourceControl.statusBarCommands = [...]（全量小数组）
        → extHostSCM.ts:783 setter 先 commandListEquals 判等，没变不发
        → RPC $updateSourceControl(handle, {statusBarCommands})
     b) group.resourceStates = [...]（扩展给全量数组）
        → extHostSCM.ts:473 排序快照 + diff 计算 splices
        → RPC $spliceResourceStates(handle, splices)（过线的是增量！）
```

节流合批的分层归属值得细看：
- **源头抑制**（debounce/throttle/idle-gate/冷却）在**扩展业务层**——只有它知道「git status 很贵」「操作中刷新无意义」；
- **判等去重**（statusBarCommands 没变不发）和 **diff 成增量**（resourceStates 全量进、splice 出）在 **extHost API 适配层**——对扩展隐形，扩展永远写「赋全量」的朴素代码，省流量是平台的事;
- renderer 侧无额外节流，来了就应用。

另有一个「乐观更新」细节：stage/unstage 等本地操作先立即用预测值刷 resourceGroups（`optimisticResourcesGroups`），随后真实 git status 覆盖——UI 零等待。

### 4.5.4 statusBarCommands 的数据形态与生命周期

- **形态**：`Command[]`——`{ command: string, title: string, tooltip: string, arguments: [sourceControl] }`。纯参数：图标是 `$(git-branch)` / `$(sync~spin)` 文本语法，忙碌态=把 `command` 置空串（不可点）+ spinner 图标。没有颜色、没有布局、没有组件。
- **状态组织**（statusbar.ts）：每个 Repository 一个 `StatusBarCommands` 聚合器，内部 CheckoutStatusBar + SyncStatusBar 两个小状态机，各自维护**不可变 state 快照**（`this.state = {...this.state, delta}` 触发 fire），`get command()` 是 state 的纯函数。事件驱动重算，无轮询。
- **更新频率归谁管**：扩展管（上面那串 debounce/throttle 已经把频率压到人类速度）；平台只兜底判等去重。
- **生命周期归谁管**：Repository.dispose() → StatusBarCommands.dispose() → 各 listener 释放；repo 关闭则 SourceControl unregister，renderer 侧状态栏条目随之消失。全程 disposable 链，无手工清理。

### 4.5.5 对我们 statusline/agent-scope 链路的映射

我们的链路「host 半边绑定 agent scope 算状态 → live 通道推 client → client 组件订阅渲染」与 git 扩展是同构的，三段式逐段对齐：

1. **per-scope 模型对象**：每个 agent scope（≈session/repo）一个 host 侧模型实例，持有自己的状态、自己的事件源订阅、自己的 disposable 集合；一个总管（≈Model）负责 scope 的发现/创建/销毁与按键路由。**不要做成一个全局单例内部 switch scope**——git 的 per-Repository 结构证明了实例化边界=scope 边界最干净，销毁一个 scope 就是 dispose 一个对象。
2. **事件驱动推送 + 分层节流**：源头抑制（「算这个状态贵不贵、现在算值不值」）写在插件业务层；判等去重和 diff 增量做进我们的 live 通道适配层，让插件放心写「每次赋全量」的朴素代码。git 的经验是这条分层线画对了，两边都简单。
3. **UI 侧纯参数消费 + 语境选片**：client 组件只订阅「当前语境对应 scope」的参数包（文本+图标+命令 id+忙碌态）。**「当前语境是哪个 scope」这个 observable 归 client 宿主own**（≈scmViewService.activeRepository：从 active tab 推导 + 无命中保持旧值 + 允许 pin），插件半边全 scope 供数、不感知选片。这样切 session tab 时 statusline 瞬时切换，不等 host 往返。

额外抄两个小件：忙碌态的表达（command 置空 + spin 图标，而不是另设 disabled 字段）；乐观更新（本地动作先推预测状态、真实计算回来覆盖）——agent 场景里「用户点了暂停，statusline 立即显示 pausing」正是这个模式。

## 5. 对我们的启示

### 5.0 总纲：VS Code 的「不碰 DOM」是为了什么，我们放弃它意味着什么

VS Code 坚持扩展不碰 DOM 的三个真实动因：**① 进程故障隔离**（扩展死循环/崩溃不冻结不搞脏 UI——这是 2016 年从 Eclipse/Atom 教训里学的头号目标）；**② 不可信第三方代码**（市场上十几万个扩展，DOM 即 XSS 即凭据窃取）；**③ UI 一致性与可演进性**（扩展只表达意图不控制像素，workbench 可以整体改版/换主题/做无障碍而不破坏任何扩展）。代价：TreeView 表达力受限（加个 checkbox 都要等官方开字段）、Webview 笨重（整 iframe、消息传递样板、样式两张皮）、每类 UI 贡献都要设计协议+两侧适配器的巨额工程成本（~90 对文件）。

我们的前提不同：**插件作者=我们自己/同仓贡献者（可信）**，规模小，不需要市场级防御。cordis client 插件直接注册 React 组件是合理的相反选择——我们买的是表达力和开发速度，卖掉的是故障隔离。但 VS Code 经验里**与「进程隔离」无关、纯属「大规模插件生态的秩序」的那部分纪律依然全部适用**，逐条见下。

### 5.1 需求逐条对照

| 我们的需求 | VS Code 对应物 | 它的取舍 | 对我们的建议 |
|---|---|---|---|
| 左侧面板插件 | `contributes.viewsContainers`/`views`（静态占位）+ TreeDataProvider/WebviewViewProvider（动态内容） | 容器/图标/标题纯声明，内容懒加载；视图 id 是全局命名空间 | 面板**槽位注册**（id、图标、标题、顺序）与**内容组件**分离：槽位元数据用纯数据注册（不 mount 组件就能画侧栏按钮），组件懒 mount。抄 activation 思想：面板首次展开才初始化插件重逻辑 |
| statusline 插件 | StatusBarItem：属性包对象（text/tooltip/command/color）+ `$setEntry` 整条重发 | 参数化到底：不给自由渲染，换来任何主题下不破相 + 对齐/优先级统一裁决 | 两档并存：默认给参数化 item（文本+图标+点击命令，颜色只准用主题 token）；确需自由渲染再开 React 组件档。**priority/alignment 由宿主统一排布**，别让插件自己定位 |
| session tab 插件 | 无直接对应（EditorTab 最近似：tab 本身参数化，内容是 editor/webview） | tab 条目永远是 workbench 的：标题/icon/dirty 状态是数据，内容区才是扩展的 | 同构照搬：tab 条目=数据（标题、图标、badge），tab 内容=React 组件。tab 状态（激活/关闭/持久化）归宿主管 |
| tool 卡自定义渲染 | 最近似 ChatOutputRenderer / notebook renderer（都是 iframe 沙箱）；TreeItem 的 `contextValue` 机制也相关 | 它被迫用 iframe 是因为不可信；渲染器按 MIME/viewType 路由 | 我们可信前提下直接 React 组件注册即可，但抄**按 tool 名/类型路由 + 必须有 generic fallback 渲染器**的结构：没有对应插件时卡片降级为通用 JSON/文本渲染，这是 VS Code notebook output 的既有模式 |
| 详情页 tab | Webview panel / custom editor 的 `viewType` 注册 | viewType 全局唯一 id + 序列化恢复协议（revive） | tab 注册带 `viewType` 样式的稳定 id；如果详情页要跨刷新恢复，学 WebviewPanelSerializer：插件提供 serialize/deserialize 状态钩子，宿主管持久化 |
| 主题单槽 | `contributes.themes`：主题=对预注册颜色 id 空间的 JSON 赋值，运行时=CSS 变量重算 | 主题非代码、颜色 id 先注册后引用，保证主题作者与功能作者互不认识也能协作 | **最值得整体照抄的一块**：先建颜色 token 注册表（插件可 `contributes.colors` 式登记新 token+light/dark 默认值），主题=token→值字典→CSS variables。插件组件里禁止 hardcode 色值、只引 token——这条纪律与进程隔离无关，纯为主题可换性，必须从第一天执行 |
| i18n fallback | `contributes.localizations`（语言包扩展给任意扩展供翻译）+ NLS key 查表缺失回退英文 | 翻译与被翻译方解耦；key 是稳定契约 | 抄 key 查表+链式回退（zh → en → key 本身兜底）。若要允许语言包插件给其他插件供翻译，学它的 `{ id: 目标插件, path }` 归属声明 |

### 5.2 与隔离无关、依然适用的 VS Code 纪律（教训清单）

1. **契约单一来源**：所有跨 host/client 的接口集中一个 protocol 文件、两侧共同编译。我们 client/host 双侧 cordis 插件同样需要：service 契约放共享包，两边 import 同一份类型。
2. **跨界调用视觉标记**：`$` 前缀 + 一律 Promise。我们 client↔host 的 RPC 也应该有命名或类型上的强制标记，让「这行代码要过网络」在读代码时零成本可见。
3. **Disposable 纪律**：VS Code 每个注册都返回 Disposable，扩展 deactivate 时宿主兜底清理 `context.subscriptions`。这与 cordis 的 `ctx.effect()`/register-returns-disposer 完全同构——我们已有此约定，插件系统里必须一以贯之：**每个 UI 注册（面板/statusline/卡渲染器/主题/翻译）都走 effect，插件卸载即 UI 消失**。VS Code 证明了这是插件可热插拔的充分基础。
4. **id 命名空间纪律**：视图 id、命令 id、颜色 token、viewType 全部是带 publisher 前缀的全局字符串。我们插件的槽位 id/token 也从第一天带插件名前缀，避免后期撞名迁移。
5. **静态声明与动态注册的分界**（对应问题「contributes 有没有值得抄的」）：**值得抄一半**。抄的部分——凡是「宿主不运行插件代码就该能画/能列」的信息走纯数据：面板图标+标题、statusline 占位、主题、翻译、tool 卡路由表。这让 GUI 能做「插件管理页」列出每个插件贡献了什么，也让骨架先画内容后到。不抄的部分——VS Code 用 JSON manifest 是因为代码在另一个进程且懒加载；我们插件与宿主同进程同语言，**用 TS 对象字面量当「声明」即可**（cordis 插件导出一个 `contributes` 常量），不必发明 JSON schema 层。判据一句话：**数据性贡献（颜色/图标/菜单项/路由表）走声明注册，行为性贡献（组件/回调）走 effect 注册；声明先于行为可用**。
6. **参数化优先，自由渲染兜底**：VS Code 的痛苦在于只有两极（TreeItem 太死、Webview 太重）。我们能做中间态（React 组件），但**默认通道仍应参数化**——参数化 UI 免费获得主题一致、布局统一、未来改版不破插件；自由组件是逃生舱不是正门。
7. **生命周期与懒加载**：activation events 的本质是「UI 骨架不等插件」。React 场景照搬为：槽位声明同步注册，组件 `lazy()` + 首次可见才 mount + Suspense 占位。插件多了以后这决定首屏性能。
8. **探活与故障降级**：我们没有进程边界兜底，插件异常=React 树异常。VS Code 的 unresponsive 探活我们用不上，但**每个插件贡献的组件必须包 ErrorBoundary**（等价物：插件崩溃只黑掉自己的卡片/面板并显示错误占位，不许拉倒整个 GUI）——这是放弃进程隔离后唯一可行的故障半径控制，属于必需品不是可选项。
9. **序列化边界迟早要面对**：我们「带 host 逻辑」的插件谱系一头已经跨网络（browser↔node）。VS Code 的教训：**从第一天规定跨界数据只有 JSON+二进制附件两种形态**（它的 VSBuffer 旁路 + `$mid` revive 是成熟做法），不要让「恰好能 structured-clone」的对象溜过线，否则后续加序列化层是全量破坏性改造。
10. **取消与错误是协议一等公民**：跨界请求从第一天带取消语义（哪怕实现是简单的 signal 转发）和结构化错误（name/message/stack 过线重建），事后补远比先做贵。

### 5.3 一句话总结

VS Code 用三层物理隔离买「不可信生态的安全与秩序」，我们不需要买安全，但它为「秩序」发明的那套纪律——契约单源、声明先于行为、参数化优先、id 命名空间、disposable 到底、主题 token 化、跨界即异步即可序列化——与进程隔离零耦合，全部适用于同进程 React 插件系统，且大多与 cordis 现有约定（effect/register-disposer/显式 seam）天然同构。
