# @deepseek-ai/dsh-client-ui-schedule

[English](README.md) | 中文

用于渲染持久 Schedule 提醒回执的纯浏览器插件。插件在会话拥有的 `conversation.chat.eventview` slot 中注册持久事件类型 `schedule/change`。通用 runtime 继续携带持久事件身份与 Host 计算的 JSON sidecar；本包只拥有 Schedule 卡片。

卡片显示提醒原文、Session 内的 Schedule ID、精确 UTC 发生时刻，以及 `session-local` 交付边界。若 sidecar 损坏或版本不兼容，组件会显示受控的不可用回执，而不会让会话崩溃。卸载插件只会移除该键控 renderer；`ui-conversation` 随后仍会为同一个持久事件显示通用且可见的 JSON fallback。

## 模型体验

无，因为这个纯浏览器 renderer 不注册模型 surface；Schedule 工具与提醒 framing 由 `@deepseek-ai/dsh-tool-schedule` 拥有。

#### KV Cache 影响

无。renderer 只在持久事件提交后消费浏览器侧 presentation sidecar。

## 已知限制与暂缓事项

- **仅提供回执 UI**：创建、列出和删除提醒仍由模型通过 Schedule 工具完成；本包不增加管理页面。
- **仅在 Session 内交付**：卡片记录的是原 Session 中的回执，并不表示系统、浏览器、邮件或其他外部通知。
