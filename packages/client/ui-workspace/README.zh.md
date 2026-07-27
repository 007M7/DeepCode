# @deepseek-ai/dsh-client-ui-workspace

[English](README.md) | 中文

共享 Workspace 选择器插件。`WorkspacePicker` 注册到侧边栏的 `sidebar.workspace` slot，以及页面局部 Session Intent 主视觉区的 `conversation.empty.workspace` slot，因此两个表层使用同一菜单和创建模态框。

该选择器通过全局 `useWorkspaces` hook 列出真实的 Host Workspace 实体。选择 Workspace 会调用 slot owner 的 `onPick` 回调，重新定位前端 Session 对象；使用现有文件夹和新建操作时，系统会先通过对象层创建真实 Workspace，再将其选中。新建操作会禁用列表中已有的名称，而 Host 对并发或非 UI 调用方仍具有最终决定权。运行时 Session 与 Workspace 服务负责物化。

两个目标 slot 都由其他插件声明，因此 `apply` 通过声明感知的延迟机制完成注册，并在声明该 slot 的插件恢复后重新注册。

## 模型体验

无。选择器属于浏览器 chrome；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **没有 Workspace 重命名／删除控件**：选择器仅支持选择和创建。
- **现有文件夹入口仅支持手动输入路径**：Host 创建失败会显示在模态框中。
