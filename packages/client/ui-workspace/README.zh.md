# @deepseek-ai/dsh-client-ui-workspace

[English](README.md) | 中文

共享 Workspace 选择器插件。`WorkspaceBrowser` 注册到侧边栏的 `sidebar.workspaces` slot，`WorkspacePicker` 注册到页面局部 Session Intent 主视觉区的 `conversation.hero.workspace` slot，因此两个表层使用同一菜单和创建流程。

该选择器通过全局 `useWorkspaces` hook 列出真实的 Host Workspace 实体。选择 Workspace 会调用 slot owner 的 `onPick` 回调，重新定位前端 Session 对象。平铺显示的 **打开本地文件夹…** 操作按 Host 广播的选择器交互形态分支（`host.describe.directoryPicker`，每次菜单打开时读取；未知 kind 隐藏该入口）：在 `dialog` 下委托 Host 的原生单目录选择器，在 `browse` 下打开应用内目录浏览器（figma 802-56979）——面包屑以本地化的"主目录"crumb 为根、面包屑右侧空白区点击进入路径编辑态（Enter 导航、Escape 还原）、宿主打标的隐藏条目在客户端过滤、内联新建文件夹行、"打开"接纳当前列出的目录。两条路径的接纳都经由对象层，并等待 Workspace 列表投影刷新后才选中已提交的 Workspace；取消操作不会显示提示，发生错误后仍可重试。浏览器对话框的文案经 `ctx.locale` 本地化（命名空间 `workspace`），插件在 `locale/change` 时重新注册其条目。**创建新工作区** 操作保留名称对话框，并禁用列表中已有的名称，而 Host 对并发或非 UI 调用方仍具有最终决定权。运行时 Session 与 Workspace 服务负责物化。Workspace 行内的 Delete 操作会打开确认框，说明保留边界、阻止重复提交，并在失败时保持打开；成功后，该分组会被移除，其 Session 则留在 Ungrouped 下。

两个目标 slot 都由其他插件声明，因此 `apply` 通过声明感知的延迟机制完成注册，并在声明该 slot 的插件恢复后重新注册。

## 模型体验

无。选择器属于浏览器 chrome；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **没有 Session 删除控件**：现有 Session 菜单行仍仅提供视觉效果；删除 Workspace 注册记录不会删除 Session。
- **原生文件夹选择依赖本地 Host 载体**：在 `dialog` 组合下，仅使用 fixture（测试前置数据）的部署或远程浏览器部署无法打开本地操作系统对话框；模态框会显示平台故障，并允许重试。已发布的默认组合为 `browse`，没有此依赖。
- **尚无"显示隐藏目录"开关**：Host 打标隐藏条目、浏览器无条件过滤；该开关是延期的纯客户端改动。
