# Agent Note：web GUI 宿主的能力可辨识目录选择 seam

状态：已实现

[English](2026-07-28-directory-picker-capability-seam.md) | 中文

## 问题

web GUI 的"打开本地文件夹"流程被焊死在一种交互上：`host.pickDirectory` 调用编译进 `dsh-host-apiproxy` 的原生 OS 选择器（私有模块，仅测试注入缝）。这个形态服务不了远程部署——没有任何 OS 对话框能弹到另一台机器的浏览器里——而计划中的应用内目录浏览器（Figma `Harness` 802-56979）需要列举／创建原语，那是**另一种交互契约**，不是同一契约的另一种实现。想换交互只能改网关源码，违背仓库"一切皆插件"的立场。

## 决策

在 `packages/host/` 落一个三包能力 seam——`directory-picker`（接口）、`directory-picker-native`、`directory-picker-browse`（后端）——唯一契约方法 `capability()` 返回**可辨识联合**：`{ kind: 'native', pick(signal) }` 或 `{ kind: 'browse', list(path?), createDirectory(path, name) }`。网关（`dsh-host-apiproxy`）注入 `directoryPicker`，提供对应的 RPC，另一种 kind 的调用以 `directory-picker-unavailable` 应答。联合之所以可辨识，是因为后端差异在**交互形态**——压平成统一方法集会逼每个后端伪装另一方的形态。

**client 侧靠 slot 组合，而非按广播分支。** ui-workspace 的两个触发表层各自声明一个 `single` 目录流洞（`conversation.hero.workspace.directoryFlow`／`sidebar.workspaces.directoryFlow`；之所以是两个 key，是因为一个洞只有一个声明它的 slot entry——owner 契约相同、占用者相同）。后端包是**双面包**：browser half 把匹配的交互注册进两个洞——`-native` 是驱动 `host.pickDirectory` 的无渲染占用者，`-browse` 是应用内的选择工作区目录对话框。洞的 owner 会话（`open`/`busy`/`onPicked`/`onCancel`/`onError`）承载整个交换：ui-workspace 保留触发（菜单入口仅在洞被占用时渲染）与接纳（`createWorkspace({path})`、冲突／错误对话框、重新选择），占用者持有从 `open` 到所选路径之间的一切。因此一行 `cordis.yml` 同时切换宿主能力与 client 流程；错配在构造上不可能，同时挂两个流程包会在 client 加载期失败（`single` 洞）。早先的 `host.describe.directoryPicker` 广播与客户端 kind 分支被删除——组合已经接好两侧后，供客户端分支用的 wire 事实不再有任何消费者。洞注册表（`ctx.slots.entries`）取而代之，成为每次打开菜单的占用读取。

并入本决策的位置与策略裁决：

- **不用 `ctx.fs` seam。** `packages/fs/` 是面向模型／会话的存储栈（policy 事件、sandbox 可换后端）。骑上去会把 GUI 浏览耦合进模型的限制后端——为模型换 `fs-sandbox` 绝不能改变 GUI 行为——而 OS 事实（home 锚定、隐藏约定）也不是存储原语。picker seam 保持无展示、无模型；`packages/host/` 是它消费方域的家。
- **依赖调研（手写 vs 引入）。** Node 标准库本身就是维护中的跨平台 OS 层（`readdir(withFileTypes)`、`homedir`、路径语义）；调研过的替代品都过不了依赖门槛——文件管理器包（`node-file-manager`、`files-and-folders`、Syncfusion 的 provider）是整套 HTTP 应用（契合度不过），盘符工具（原生插件 `drivelist`、约七年未更的 `windows-drive-letters`）健康度／比例失当。browse 后端是标准库上的薄适配。
- **隐藏条目：返回并打标。** 宿主标注 `hidden`（POSIX 点前缀约定）并返回全部条目；客户端过滤。展示策略留在客户端，"显示隐藏"开关正是作为这一纯客户端改动落地：标签固定的 footer 开关，其状态由按下态呈现承载（`aria-pressed` + 勾选符号）；以点开头的路径草稿前缀会显出它所指名的隐藏条目；当前选中项则不受隐藏与前缀两种过滤影响（它锚定着双栏视图）。Windows 的 `FILE_ATTRIBUTE_HIDDEN` 不被 dirent 暴露——记为限制，直到原生探测值回其成本。
- **路径编辑器的取消范围：对话框卡片。** browse 客户端的路径编辑器在按 Escape 与焦点离开卡片时取消，两者都在卡片范围的包装层而非输入框上监听——Tab 把焦点停到某个过滤命中的行之后，输入框已不在事件路径上，但 Escape 仍须收起编辑器（而非对话框），其后的焦点离开也仍须取消。不取消的豁免：窗口／标签页失焦、卡片内焦点移动，以及指针路径（编辑期间行与开关在 mousedown 时抑制焦点夺取）。预填与草稿末段过滤所用的分隔符从宿主解析的根 crumb 读取（对该后端发出的每种根形态都精确：`/`、`C:\`、`\\server\share\`）；下文的线上字段替代方案记录了被延期的权威形态。编辑器与其过滤的列表之间的 combobox 语义（`aria-expanded`／`aria-controls`／active-descendant、结果播报）同样被延期——目前二者在辅助技术看来是彼此独立的控件。焦点停靠是卡片全域的不变量，而非编辑器独有：每次选取——无论是否处于编辑态，包括右栏推进与各列被替换的创建落地——提交后都把焦点重新停靠到选中项所在的行上，而其余所有会顶离焦点的退出（Enter、Escape、新层级已不含焦点所在行的导航落地、选取或创建失败后的重新列举，以及嵌套创建对话框的关闭）只要焦点确实落到了 body 上，就回落到 crumb 编辑区，而点击"显示隐藏"开关时若发现焦点落在行间，则把焦点同步停靠到开关自身。该保证的范围仅限对话框自身的节点替换——Modal 没有焦点陷阱，所以 Tab 越过卡片边缘属于正当离开，而 owner 的接纳窗口（其间 `busy` 把每个控件置为惰性，且对话框反正正在关闭）同样在此范围之外。
- **导航以选中项为锚、渐进落地。** 在展示根之外（与 crumb 头部渲染的是同一塌缩，因此 crumb 与分栏形态永不相左），browse 客户端的导航在目标层级到达的那一刻即提交它——这次首个落定即关闭编辑器并结束加载，因此 Enter 提交的导航绝不会为等待更多内容而被撤回——随后父层级这一程就地升级这次落地：重新选中目标在父层级中的实际条目（Windows 上按平台惯例折叠大小写），右侧展示其子项，因此 crumb 跳转读作后退一栏，而不是塌缩成单列。父层级这一程在落地的 supersession 范围下运行，任何较新的意图都会在线上将其中止；父层级这一程失败，或被截断的父窗口缺少目标时，都保留已提交的单栏落地——升级的存在正是为了锚定选中项，绝不能反而让它悬空。渐进形态的已知边界：指针按压若恰好落在单个 RTT 的升级窗口内，可能因所按行节点被替换而丢失点击（键盘焦点会重新停靠到重新选中的行上；指针的这段窗口则被接受）；斜杠平台（macOS）上仅末段的大小写偏差会错过父层级条目匹配，保留单栏落地，而祖先段的偏差仍能匹配——父层级条目路径继承键入的前缀——并落地双栏，代价是 Home 塌缩；且导航总是重新列举两程，哪怕目标就是当前展示的层级——crumb 点按兼作刷新手势，因此宁要新鲜度也不复用手头可能已陈旧的列举，代价是至多两次宿主扫描。
- **符号链接：为可进入性而跟随。** 用 `stat` 探测符号链接（断链／循环→跳过）；面包屑保留操作者导航的逻辑路径，`workspace.create` 在接纳时本就做 realpath 规范化。
- **线上只有一种规范路径形态。** 列举的 `path`、`crumbs[].path`、`entries[].path` 与 `home`——连同 `createDirectory` 返回的路径，客户端拿它与该子项下一次的 `entries[].path` 逐字比较以锚定创建落地——一律以宿主解析后的形态发出：词法 `resolve()`，绝不做 realpath（上文的符号链接裁决保持祖先链为逻辑路径）；homedir() 的输出也不例外，因为环境可能修饰 HOME，后端在标注前先行解析。客户端凭这一承诺逐字比较列举路径；browse 客户端仅剩的词法镜像服务于草稿一侧——用户键入的那一条路径，因而天然非规范。在源头做规范化，取代了客户端侧那份必须预判每种修饰（末尾与重复的分隔符、点段、UNC 根、正斜杠）的 resolve() 镜像，且这一承诺约束每一个 browse 后端。
- **列举层级有上限，且流式处理。** 单次 `list` 至多返回 `maxEntries` 行（配置项，默认 1000——GitHub 网页端目录列举的同一上限）。层级经 `opendir` 流入一个按名排序、容量 `maxEntries + 1` 的候选窗口，内存保持 O(maxEntries)，可进入性探测只触及窗口内候选；线上 `DirectoryListing` 携带必填的 `truncated` 标志，让客户端明示不完整而不是静默缺尾。窗口内的断链符号链接不从窗口外回填——发生过驱逐本身已把层级标记为截断。窗口插入为二分查找、满窗尾部单次比较即拒绝（超大层级不能为每个 dirent 付出一次全窗扫描），且 `list(path, signal)` 透传载体的请求信号，滞塞网络目录的扫描不会在调用方断连后继续存活——扫描中的每个 await（打开、每次读取、每次符号链接探测）都与信号赛跑，中止路径放弃而非等待 close（Node 会把 close 排在在飞读取之后），被放弃的 settlement 全部吞掉，清理不会以未处理拒绝的形式冒出。无上限的层级对超大或恶意构造的目录就是内存／响应性漏洞。
- **全盘可浏览，不做 roots 配置。** `workspace.create` 接受任意路径且 API 本就提供驱动 bash 的方法，浏览根只会是 UX 范围而非边界；没有消费方的可配置性过不了证据门槛。等到有部署需要再做。
- **native 后端保留。** 插件化正是目的：多方都能提供该 seam（Electron 壳可以经自己的对话框 API 提供 `native` 交互）。kind 命名：最初选了 `dialog` 后被放弃——browse 交互同样以对话框呈现（应用内弹窗），这个词起不到判别作用；`native` 命名的是选择器运行的位置。

## 曾考虑的替代方案

- **给 `ctx.fs` 增加浏览方法。** 否决：上述权限域耦合；且面向展示的列举契约（hidden 标志、面包屑、home 锚点）不属于存储 seam。
- **统一方法集的 seam（`pick(): path`）。** 否决：应用内浏览器无法藏在一次宿主侧调用后面——浏览循环在客户端，需要协议上的原语；而对话框实现不了原语。交互差异不可约，故用判别标签。
- **apiproxy 里直接调标准库（不建 seam）。** 否决：换装点仍是改网关源码，失去 fixture／测试后端，与促成这项工作的插件教义相悖。
- **引入文件管理器／盘符枚举依赖。** 按上文调研否决；依赖政策要求记录于此。
- **动作标签随状态翻转的"显示隐藏"开关（"隐藏隐藏文件"）。** 否决：会翻转的动作标签在状态与动作之间有歧义，还把否定叠了两层；固定标签加按下态呈现一次说清两者。
- **纯 relatedTarget 失焦取消（不做 mousedown 抑制）。** 否决：Safari 在指针按下时不给按钮聚焦，点击触发的 focusout 因而携带空 `relatedTarget`，会在点击落地前就取消编辑器；编辑期作用的 mousedown 抑制加上锚定卡片的 relatedTarget 守卫才能同时覆盖指针与键盘路径。
- **在 `DirectoryListing` 上增设线上 `separator` 字段（宿主标注 `path.sep`）。** 延期而非否决：它才是权威形态。客户端今天所用的根 crumb 读取对该后端发出的每种根形态都精确，但它仍是从路径文本推断平台事实，还把"链从根开始"从后端行为提升为客户端所依赖的不变量（`crumbs` 的 JSDoc 确实承诺了这一点），并在链为空时退化回旧的 home 文本启发式；线上字段则会原样随线传输，经得住空链与未来的后端。它触及 seam 类型与每个后端，因此 browse 客户端的 `separatorOf` 挂着指向本方案的 TODO，直到下次安排线上变更。

## 后果

- `cordis.yml` 决定交互形态；`apps/cli` 挂 `-browse`（随附默认——开箱即得可远程的选取），一行同时切换了后端与 UI；`-native` 仍是宿主屏幕方案。
- 协议新增 `host.listDirectory`／`host.createDirectory` 与四个错误码；connection fixture 提供确定性浏览树与确定性 `pickDirectory` 路径供无密钥组装测试使用。
- 未来的新交互（或提供 `native` 交互的 Electron 实现）只是一个双面后端包——无需网关手术，也不动 ui-workspace。
- `ApiProxyDefaults.pickDirectory`（仅测试注入）删除；测试像提供其他服务一样提供 stub `ctx.directoryPicker`。
