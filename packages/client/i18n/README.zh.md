# @deepseek-ai/dsh-client-i18n

[English](README.md) | 中文

i18n 插件：I18nService（ns×locale 字典、bind(ns)→t 且函数标识稳定、locale store）。契约：api-contracts v3 §8。

## 模型体验

无。i18n 注册表为浏览器 UI 文案提供服务；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **zh/en 以空结构交付**：现有 UI 文案是内联中文；将其提取到字典中属于暂缓的全仓工作，因此 `bind(ns)` 消费方目前大多收到回显 key 的回退值。
- **切换 locale 会重新渲染整棵树**：这是低频操作，可以接受；没有逐 namespace 的订阅粒度。
