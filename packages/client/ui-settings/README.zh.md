# @deepseek-ai/dsh-client-ui-settings

[English](README.md) | 中文

设置外壳插件：一个纯组合表层。它以触发控件和模态设置面板占用 `sidebar.settings`，并声明由注册方填充的 slot：`settings.trigger`／`settings.header`／`settings.close`（界面框架内容）、`settings.section`（每项功能一页）和 `settings.onboarding`（由各功能持有、覆盖在空白 Hero 之上的浮层）。外壳不自带文案：所有文本都来自注册方（ui-settings-general 拥有界面框架和「通用」分区；各功能拥有各自的分区、行和首次使用浮层）。导航 label 可以是跟随语言的 thunk，因此导航投影经 `resolveSlotLabel` 解析，并在分区账本更新或 locale revision 变化时重新渲染（`ctx.get('locale')` 可选读取，无硬 locale 依赖）。

外壳只向首次使用注册方提供两个导航事实：当前会话界面是否为空白 Hero，以及一个 `openSection(id)` 回调；后者会打开设置面板并切换到已注册的指定分区。能力就绪状态、浮层关闭、文案和变更操作均由注册方持有，因此外壳不会成为第二个配置事实来源。

## 模型体验

无。设置外壳为浏览器 UI 提供组合能力；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包（package）既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **面板仅涵盖浏览器偏好设置**：宿主侧设置表层（权限模式、工具调用模式）尚无 RPC 支撑；其骨架位于 ui-settings-general。
