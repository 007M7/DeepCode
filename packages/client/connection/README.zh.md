# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

协议消费层：客户端插件的 apply 会挂载 `ctx.connection`（共享 API 客户端 + 单消费方流循环启动器）；导出表层携带协议契约类型、`AbstractApiClient` seam，以及循环的 sink／配置类型。平台子类（WebApiClient/FixtureApiClient）、ConnectionController 循环和 fixture 数据源都属于包内部：apply 负责选择并驱动它们，测试则通过 src 访问。契约：api-contracts v3 §3。

## 无密钥 fixture

任何 `fixture` 查询参数都会选择内存载体。`fixture=empty` 启动时不含 Workspace 或 Session；`fixturePrompt=reject` 在接受前拒绝提示词；`fixtureAttach=fail` 发布 Session 但拒绝将其附加到 Workspace；`fixtureSessionCreate=drop-response` 在丢弃创建响应前发布 Session 并为其发出帧；`fixtureFrames=workspace-first` 则反转默认的 Session 优先创建帧顺序。按名称／路径创建 Workspace 以及由调用方预先分配 SessionId，均具有足够的确定性，组装后的 Web 测试可以据此协调列表与帧的到达。

## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **history 的隐式恢复存在争议**：在未附加的会话上打开 history，会在主机侧拉起 agent；纯持久化读取的替代方案记录在 rt-core 协调账本中，P-I 不作改变。该包的消费方会在首次打开时感受到这段延迟。
- **计划移除 `ToolEventView`／`ToolCallView`／`ToolResultView` 的重新导出**：当 toolview 迁移删除主机 `viewFor` 行时，它们会一并移除（呈现属于客户端）；在此之前，fixture 保留一份局部 `viewFor` 镜像。
