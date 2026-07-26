# @deepseek-ai/dsh-client-ui-theme

[English](README.md) | 中文

主题插件：基于 --dsw-* token 基础样式表（静态尺度 + 别名语义层）的 ThemeService；apply(id) 会切换 `body[data-ds-dark-theme]` 属性，因此主题切换完全依靠 CSS 级联。契约：api-contracts v3 §8。

## 模型体验

无。主题服务切换浏览器 CSS；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **P-I 不提供主题切换控件**：服务表层（register/apply/current）已经完整，但没有 UI owner 挂载开关；切换通过编程方式完成。
- **第三方主题是表层，不是产品**：注册主题意味着覆盖同名别名变量；目前不会验证一组覆盖是否完整。
- **token 样式表是颜色的唯一权威**：不会追加 cssdesign 中缺失的值（例如设计中的 #4176E6 标签页蓝色）；应使用最接近的语义 token（裁定于 2026-07-22）。
