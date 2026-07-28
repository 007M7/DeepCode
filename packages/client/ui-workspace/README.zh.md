# @deepseek-ai/dsh-client-ui-workspace

[English](README.md) | 中文

共享 Workspace 浏览器与选择器插件。`WorkspaceBrowser` 填充侧边栏的 `sidebar.workspaces` slot，`WorkspacePicker` 则填充页面局部 Session Intent 主视觉区的 `conversation.hero.workspace` slot；两个表层使用同一套 Workspace 菜单和创建流程。

该浏览器通过全局运行时钩子将 Session 行渲染为分组或扁平形式，并负责 Workspace 创建／重命名和 Workspace 内的重排序流程。非空白查询会以单一扁平结果列表替代任一浏览模式：不区分大小写的标题和 Workspace 子串匹配项会立即显示，经 250 ms 防抖的 Host 请求则会加入经过排序的当前对话内容匹配项及其摘要片段。英文搜索输入框及其防御性请求路径会移除 NUL，将查询限制在传输 schema 规定的 500 个 UTF-16 code unit 内且不会拆分 surrogate pair，并保留现有的防抖与取消行为。每次新查询都会中止前一个请求；内容搜索失败时，元数据匹配项仍会显示，同时给出警告。列表最多显示 20 条结果，并会在查询过宽时提示用户缩小范围；打开所选 Session 时既不会清除查询，也不会跳转至特定事件。

该选择器通过全局 `useWorkspaces` hook 列出真实的 Host Workspace 实体。选择 Workspace 会调用 slot owner 的 `onPick` 回调，重新定位前端 Session 对象。平铺显示的 **打开本地文件夹…** 操作会委托 Host 的原生单目录选择器，通过对象层接纳返回的路径，并等待 Workspace 列表投影刷新后才选中已提交的 Workspace；取消操作不会显示提示，发生错误后仍可重试。**创建新工作区** 操作保留名称对话框，并禁用列表中已有的名称，而 Host 对并发或非 UI 调用方仍具有最终决定权。运行时 Session 与 Workspace 服务负责物化。Workspace 行内的 Delete 操作会打开确认框，说明保留边界、阻止重复提交，并在失败时保持打开；成功后，该分组会被移除，其 Session 则留在 Ungrouped 下。

两个目标 slot 都由其他插件声明，因此 `apply` 通过声明感知的延迟机制完成注册，并在声明该 slot 的插件恢复后重新注册。

## 模型体验

无。选择器属于浏览器 chrome；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **没有模糊内容搜索或事件深链接**：内容后端采用字面 token／短语匹配，选择结果会打开 Session，而不是匹配的事件。
- **没有 Session 删除控件**：现有 Session 菜单行仍仅提供视觉效果；删除 Workspace 注册记录不会删除 Session。
- **原生文件夹选择依赖本地 Host 载体**：仅使用 fixture（测试前置数据）的部署或远程浏览器部署无法打开本地操作系统对话框；模态框会显示平台故障，并允许重试。
