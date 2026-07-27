# @deepseek-ai/dsh-client-locale

[English](README.md) | 中文

locale 插件：LocaleService 包含浏览器 locale 偏好（`zh`／`en`，以 `dsh.locale` 为键持久化；提供 getter／setter，并生成 `locale/change` 快照），以及 ns×locale 字典注册表（`bind(ns)`→t 的函数标识稳定；查找链为 active → zh → key）。

## 模型体验

无。locale 注册表为浏览器 UI 文案提供服务；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **只有设置界面完成翻译**：其他页面仍保留内联文案；将全仓文案提取到字典的工作暂缓。
- **切换 locale 只重新渲染已订阅的消费方**：未接入 `locale/change` 的分区会保留已渲染文本，直到重新挂载。
