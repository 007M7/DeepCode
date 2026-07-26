# @deepseek-ai/dsh-client-ui-theme

[English](README.md) | 中文

主题插件：基于 --dsw-* token 基础样式表（静态尺度 + 别名语义层）的 ThemeService。该服务拥有主题偏好（`light`／`dark`／`system`，以 `dsh.theme` 为键持久化），将 `system` 通过 `prefers-color-scheme` 解析为实际主题，并发布不可变的 `ThemeSnapshot`，通过 `theme/change` 事件通知变化；它绝不接触 DOM：ui-layout 的呈现器会应用解析后的快照（依据当前配色方案设置 `body[data-ds-dark-theme]`，并将主题的别名 token 设为内联变量）。契约：api-contracts v3 §8。

## 模型体验

无。主题服务管理浏览器偏好；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **第三方主题是表层，不是产品**：注册主题意味着覆盖同名别名变量；目前不会验证一组覆盖是否完整。
- **token 样式表是颜色的唯一权威**：不会追加 cssdesign 中缺失的值（例如设计中的 #4176E6 标签页蓝色）；应使用最接近的语义 token（裁定于 2026-07-22）。
