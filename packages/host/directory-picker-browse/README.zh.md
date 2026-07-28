# @deepseek-ai/dsh-host-directory-picker-browse

[English](README.md) | 中文

[目录选择 seam](../directory-picker/README.md) 的**应用内浏览后端**：`BrowseDirectoryPicker` 以 `browse` 能力注册 `ctx.directoryPicker`——基于 Node 标准库（跨 OS 适配本就由它承担）提供单层目录列举与子目录创建。宿主屏幕上不渲染任何东西，因此该后端能服务 native 后端无法触及的远程客户端。

行为事实：列举**只返回目录**、按名称排序，指向目录的符号链接会被跟随（断链／循环链接被跳过——探测 `stat` 失败即"不可进入"），并携带宿主判定的 `hidden` 标志（POSIX 点前缀约定），展示决策留给客户端；`crumbs` 是从根到目标的祖先链，根 crumb 以完整路径标注（`/`、`C:\`）；`list` 不带路径即列举宿主账户的家目录。`createDirectory` 不递归（父目录缺失是真实失败，不是要补造的层级），且即便被直接调用也把名称校验为单个非空段，与协议 schema 的栅栏一致。两个原语都拒绝非完全限定的显式路径——相对形态，以及 Windows 上 `isAbsolute` 会放行的无盘符有根形态（`\foo`、`/foo`）与不完整的 UNC 前缀（`\\`、`\\server`）——报 `directory-unreadable`／`directory-create-failed`，而不是任由 `resolve` 把它重定位到宿主进程 cwd 或当前盘符之下。单次 `list` 至多返回 `maxEntries` 行（配置项，默认 1000——GitHub 网页端对目录列举采用的同一上限），且层级以流式方式经过一个有界窗口，无论目录有多少子项内存都保持 O(maxEntries)：被截断的层级保留按名排序的头部、隐藏行计入上限、只探测窗口内候选，并报告 `truncated: true`，供客户端提示层级不完整（窗口内的断链符号链接不会从窗口外回填——发生过驱逐本身已把层级标记为截断）；窗口插入为二分查找、满窗尾部单次比较即拒绝，且 `list` 透传调用方的 `AbortSignal`，断连或超时会停止扫描而不是让它在调用方离开后继续。失败抛出 seam 的类型化 `DirectoryPickerError`。策略依据：[目录选择能力 seam Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.md)。

**双面包**：browser half（`./client`）以应用内 **选择工作区目录** 对话框（figma `Harness` 813-23126 家族——Miller 双列视图、带点击即编辑路径区的面包屑、嵌套新建文件夹对话框）填入 [ui-workspace](../../client/ui-workspace/README.md) 的两个目录流洞，驱动 `host.listDirectory`／`host.createDirectory`，并注册自己的 locale 命名空间（`directory-browser`，zh 默认／en）。因此一行 cordis.yml 同时组合浏览交互的两侧；client 侧不含任何能力 kind 分支，挂载第二个流程包会在加载期失败（洞为 `single` kind）。

## 模型体验

无。该后端服务于 GUI 宿主的目录选择；这里没有任何内容进入模型请求。

#### KV 缓存影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

- **不读取 Windows 隐藏属性**——Node 的 dirent 不暴露 `FILE_ATTRIBUTE_HIDDEN`，因此在所有平台上 `hidden` 都意味着点前缀，直到原生探测值回其成本为止。
- **不枚举盘符根**——Windows 上祖先链止于盘符根；跨盘依赖浏览器 UI 的路径输入入口，而不是这里的枚举原语。
- **全盘可浏览**——没有按部署限定的浏览根；`workspace.create` 今天就接受任意路径，这里的根只会是 UX 范围而非边界——等到有部署需要时再做。
