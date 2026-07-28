# @deepseek-ai/dsh-client-ui-trajectory

[English](README.md) | 中文

轨迹轮次列表 chrome（吸顶 Turn／Message·Step 分组／步骤单元格）及 Waterfall 占位符；这是纯消费方最小插件范例（向会话的 `'conversation.view'` slot 环注册两个视图标签页，不提供服务，也不声明 Context 合并）。契约：api-contracts v3 §8。

## 模型体验

无。轨迹视图在浏览器中渲染会话数据；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **进行中的 Time 保持空白**：`partial`／`runningCalls` 行在实时钟策略落地前渲染为 `—`；选中样式只在本地生效（未连接到聊天详情）；锚点深链接仍暂缓实现。
