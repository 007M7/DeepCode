# Agent Note: 版本化 GUI 欢迎引导

Status: implemented

[English](2026-07-30-versioned-gui-welcome-onboarding.md) | 中文

## 问题

GUI 的凭据引导从 DeepSeek 专用的就绪状态检查开始，但内部测试通知适用于每位用户，即使凭据已经配置，也必须先于提供方设置显示。若把两者作为独立浮层处理，多个对话框可能同时出现；仅存于进程内的关闭标记既无法区分通知已完成确认还是窗口在确认前已关闭，也无法在文案有意修订后重新显示一次通知。

## 决策

**设置外壳协调有序步骤。** `settings.onboarding` 仍是根作用域 list，但 `ui-settings` 会把其中各条目的 id 和顺序投影到一个协调器中，并且只挂载第一个未完成的步骤。当前注册方会收到 `complete()` 和 `openSection(id)`；所有权转移前，不会挂载后续步骤。`ui-settings-models` 注册顺序为 `0` 的 DeepSeek 条件式就绪状态与凭据跳转步骤，自[移除首次启动内测声明](../simplification/2026-08-13-remove-first-run-beta-notice.md)起，它是当前唯一的注册方。

**产品欢迎步骤已移除。** 版本化通知、其文案所有者文件和确认 store 自本决策起随产品发布，直至[移除首次启动内测声明](../simplification/2026-08-13-remove-first-run-beta-notice.md)；移除理由由该 note 持有。`ui-settings-general` 不再注册任何引导步骤。

**持久化的 `ui-onboarding` 分节在通知移除后继续存在。** 宿主端在 user-settings seam 中注册它，存入当前 `$DSH_HOME/settings.yaml`；其中的 `welcomeNoticeVersion` 字段让已存储的确认记录保持有效，没有读取方。connection 插件通过 `ctx.connection.isLoopback` 统一发布当前页面是否使用 loopback authority；hostname 判定留在 connection 包内，其他客户端插件只消费服务状态，而不导入其实现。API Proxy 在可配置提供方 namespace 之外，通过封闭的允许列表暴露这一个产品 namespace，同时不会把它的变更视为模型目录失效事件。

**引导流程会暂时接管视口，形成一个连续阶段。** 纯色产品界面通过挂载到 `body` 的 portal 取代完整的应用视图，并将底层应用根节点标记为 inert；严格符合要求的遮罩仍挂载在该界面后方，并保留 `position:absolute`、left/right/bottom 偏移量为零、`top:80px`、`rgba(0, 0, 0, 0.24)` 和 `backdrop-filter: blur(2px)`。引导步骤在这一阶段中依次呈现，而不是各自作为独立的模态窗口，并复用 Web UI 的黑色 `BrandWordmark`；按条件显示的凭据设置页是当前唯一的页面。

## 曾考虑的替代方案

**浏览器本地存储**：不予采用，因为确认状态会跟随某个浏览器 profile，而不是 `$DSH_HOME`；全新的 Harness profile 可能错误继承此前的确认状态，外部 profile 编辑也没有权威更新流。因此，非 loopback 的回退保持为进程内状态，而不是浏览器 profile 状态。

**在 `ui-settings-general` 中再增加一个独立模态窗口**：不予采用，因为欢迎通知和凭据就绪状态同时为真时，list 注册方仍会堆叠。声明并渲染该 list 的外壳应当持有有序所有权。

**在渲染或窗口关闭时持久化**：不予采用，因为看见通知不等于确认，窗口关闭事件也无法可靠送达。只有显式提交「继续」才能阻止通知在下次启动时再次显示。

**通用的公开设置暴露标志**：不予采用，因为一个产品 namespace 不足以证明应当扩大每个 settings 注册方的公开配置面。该 API Proxy 保留显式的封闭允许列表。

## 后果

全新 profile 直接进入提供方专用引导：DeepSeek 步骤仅在其凭据缺失时挂载，凭据已配置时不会出现任何引导页面。针对性的 store 与 React 测试固化了协调器顺序、按条件移交 DeepSeek 步骤和 HMR（热模块替换）清理行为。真实 Chromium 场景会使用隔离的 harness 家目录启动随产品提供的 Web 组合，在凭据步骤占据视口时验证遮罩的精确几何尺寸和计算样式，继续进入凭据缺失设置流程，并检查浏览器控制台。
