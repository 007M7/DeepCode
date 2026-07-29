# @deepseek-ai/dsh-client-ui-settings

[English](README.md) | 中文

设置外壳插件：一个纯组合表层。它以触发控件和模态设置面板占用 `sidebar.settings`，并声明由注册方填充的 slot：`settings.trigger`／`settings.header`／`settings.close`（界面框架内容）和 `settings.section`（每项功能一页）。外壳不自带文案，也不读取 locale 状态：所有文本都来自注册方（ui-settings-general 拥有界面框架和「通用」分区；各功能拥有各自的分区和行），因此只有分区账本更新会触发它重新渲染。

## 模型体验

无。设置外壳为浏览器 UI 提供组合能力；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包（package）既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **面板仅涵盖浏览器偏好设置**：宿主侧设置表层（权限模式、工具调用模式）尚无 RPC 支撑；其骨架位于 ui-settings-general。
