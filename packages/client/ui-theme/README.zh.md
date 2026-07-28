# @deepseek-ai/dsh-client-ui-theme

[English](README.md) | 中文

主题插件：基于 --dsw-* token 基础样式表（静态尺度 + 别名语义层）的 ThemeService。该服务拥有主题偏好（`light`／`dark`／`system`，以 `dsh.theme` 为键持久化），将 `system` 通过 `prefers-color-scheme` 解析为实际主题，并发布不可变的 `ThemeSnapshot`，通过 `theme/change` 事件通知变化；它绝不接触 DOM：ui-layout 的呈现器会应用解析后的快照（`html { color-scheme }`、`body[data-ds-dark-theme]`，以及主题的别名 token 内联变量）。契约：api-contracts v3 §8。

`src/styles/` 下有五张样式表，全部由 web 壳的 `base.css` 导入：`base.css`、`design-platform.css`、`scrollbar.css`、`gradient-shadow-text.css` 与 `shiki.css`。`scrollbar.css` 是 `--dsw-alias-scrollbar-*` token 的唯一消费方，必须排在声明这些 token 的 `design-platform.css` 之后。

滚动条重新绑定契约：`scrollbar.css` 在 `body` 上把 `--dsh-scrollbar-thumb` 与 `--dsh-scrollbar-thumb-hover` 绑定到 l1（基础表面）token，标准属性 `scrollbar-color` 与 `::-webkit-scrollbar-thumb` 规则都读取这一组变量。抬升表面（菜单、浮层、对话框）在自己的容器上设置 `--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2)` 与 `--dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2)`；一次重新绑定即可为两种渲染同时换色。推理过程与实测计算值见[滚动条 Agent Note](../../../.agents/notes/implemented/bug-fix/2026-07-28-themed-scrollbars-and-reserved-gutter.md)。

## 模型体验

无。主题服务管理浏览器偏好；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **第三方主题是表层，不是产品**：注册主题意味着覆盖同名别名变量；目前不会验证一组覆盖是否完整。
- **token 样式表是颜色的唯一权威**：不会追加 cssdesign 中缺失的值（例如设计中的 #4176E6 标签页蓝色）；应使用最接近的语义 token（裁定于 2026-07-22）。
