# @deepseek-ai/dsh-client-ui-workspace

[English](README.md) | 中文

共享 Workspace 选择器插件。`WorkspaceBrowser` 注册到侧边栏的 `sidebar.workspaces` slot，`WorkspacePicker` 注册到页面局部 Session Intent 主视觉区的 `conversation.hero.workspace` slot，因此两个表层使用同一菜单和创建流程。

该选择器通过全局 `useWorkspaces` hook 列出真实的 Host Workspace 实体。选择 Workspace 会调用 slot owner 的 `onPick` 回调，重新定位前端 Session 对象。每个注册各自声明一个**目录流子洞**（`single` kind：`conversation.hero.workspace.directoryFlow`／`sidebar.workspaces.directoryFlow`），由组合的选择器包 client half 填入其选取交互——今天是 [`-native`](../../host/directory-picker-native/README.md) 后端的无渲染 OS 选择器驱动，`-browse` 组合下则是应用内浏览对话框。平铺显示的 **打开本地文件夹…** 操作仅在本表层的洞被占用时渲染（每次菜单渲染读取占用状态；洞为空意味着该组合没有选目录能力——seam 文档化的无流程默认行为）。本包持有触发与接纳：占用者经洞的 owner 会话（`open`/`busy`/`onPicked`/`onCancel`/`onError`）每次打开上报一个所选路径，owner 通过对象层接纳它，并等待 Workspace 列表投影刷新后才选中已提交的 Workspace；取消操作不会显示提示，错误落入可重试的文件夹对话框，其 **重新选择** 会重新打开流程。**创建新工作区** 操作保留名称对话框，并禁用列表中已有的名称，而 Host 对并发或非 UI 调用方仍具有最终决定权。运行时 Session 与 Workspace 服务负责物化。Workspace 行内的 Delete 操作会打开确认框，说明保留边界、阻止重复提交，并在失败时保持打开；成功后，该分组会被移除，其 Session 则留在 Ungrouped 下。

两个目标 slot 都由其他插件声明，因此 `apply` 通过声明感知的延迟机制完成注册，并在声明该 slot 的插件恢复后重新注册。

## 模型体验

无。选择器属于浏览器 chrome；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **没有 Session 删除控件**：现有 Session 菜单行仍仅提供视觉效果；删除 Workspace 注册记录不会删除 Session。
- **原生文件夹选择依赖本地 Host 载体**：在 `-native` 组合下，仅使用 fixture（测试前置数据）的部署或远程浏览器部署无法打开本地操作系统对话框；模态框会显示平台故障，并允许重试。可远程的选取是 `-browse` 组合的应用内流程。
