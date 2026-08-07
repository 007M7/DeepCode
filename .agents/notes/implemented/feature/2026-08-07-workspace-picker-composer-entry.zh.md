# Agent Note: 未选择 Workspace 时从编辑器打开现有选择器

Status: implemented

[English](2026-08-07-workspace-picker-composer-entry.md) | 中文

## 问题

[Session scope 决策](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md)会在 Workspace 存在前保留同一个常驻编辑器，但 textarea 处于禁用状态，只有较小的 Workspace chip 能打开选择器。用户首次点击最显眼、也最熟悉的输入区域时，界面不会响应，尽管同一界面已有继续操作的入口。

## 决策

新会话尚未归属任何 Workspace 时，常驻 textarea 为只读状态，并可通过鼠标点击、Enter 或 Space 激活现有的 `conversation.hero.workspace` 选择器。它通过 `aria-haspopup` 和 `aria-expanded` 暴露菜单展开状态。消息提交、命令、权限、模型及其他 Session 作用域控件会保持锁定，直到用户选择 Workspace 并创建或重新连接真实 Session。

Workspace 选择继续使用现有 owner 和流程。`ConversationRoot` 打开选择器，`WorkspacePicker` 列出或创建 Workspace；Session 到达后，同一个 textarea DOM 节点变为可编辑状态。

## 考虑过的替代方案

**保持 textarea 禁用并突出 Workspace chip。** 这样能保留原有控件边界，但首次操作时最主要的编辑器区域仍然没有响应。

**在 textarea 上方放置透明按钮。** 按钮具备直接的触发器语义，但它会在常驻 textarea 上方增加第二个可聚焦元素，并使保留焦点、输入法和草稿行为的 DOM identity 过渡更复杂。

**在选择 Workspace 前接收草稿。** 这需要由 client 拥有的草稿 Session 或另一条 Session 前状态轴。此功能只需要提供一个更容易发现的现有选择器入口。

## 后果

用户首次点击编辑器即可继续必要的设置流程，键盘用户也能激活同一路径。textarea 会如实报告只读状态，直到 Session 存在；相邻控件仍处于禁用状态。界面没有引入新的 Workspace 状态、传输或目录选择流程。

组件测试会固定鼠标和键盘激活、相邻控件锁定、选择器展开，以及同一节点变为可编辑 textarea 的过渡。组装后的 Web helper 会通过 textarea 开始全新 Workspace 设置，因此重放浏览器场景会覆盖实际交付路径。
