# @deepseek-ai/dsh-client-ui-settings-general

[English](README.md) | 中文

设置界面无特定功能归属的文案与产品引导插件：在设置界面注册所有不属于单一功能的内容，包括外壳的触发器、标题栏与关闭控件内容，「通用」分区及其 `settings.general.item` slot、`settings` 字典，以及第一个有序欢迎步骤。归具体功能所有的行（「权限」、「语言」、「外观」）、分区（「模型」）和条件式首次使用引导步骤仍由各自的功能包提供。

`src/onboarding-copy.ts` 是完整通知文案和 `WELCOME_NOTICE_VERSION` 的唯一可编辑来源；GUI 支持的两种 locale 都有意渲染同一份中文文案。宿主端在 user-settings seam 中注册 `ui-onboarding`；浏览器比较 `welcomeNoticeVersion` 是否精确相等，仅在「继续」操作成功后写入当前值。该路径变更在不同标签页间幂等，并会保留同级设置；`host/settings-changed` 则让页面在通知被外部确认后，无需重新加载即可推进。版本不同时，系统会有意重新显示通知。欢迎页保留原文的每个段落，仅强调最后一段中指定的句段，初始焦点落在标题上，并且没有关闭操作、Escape、点击遮罩或次要操作路径。其文案和确认状态均不会进入会话日志或模型请求。通知明确以 `DSH_TELEMETRY_DISABLED=1` 作为遥测关闭方式。

## 模型体验

无。该插件渲染浏览器设置 UI；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- 「通用」分区没有内置行；每一行仅在其所属功能插件挂载时出现。
