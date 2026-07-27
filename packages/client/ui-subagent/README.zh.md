# @deepseek-ai/dsh-client-ui-subagent

[English](README.md) | 中文

Web subagent 功能 owner：向 `conversation.session.header.actions` 贡献可懒加载展开的目录树，向会话编辑器链贡献 parent 不可用时的替代呈现，并保留注册到 `ctx.slash` 的既有 `@` 引用 source。

页头操作通过标准 `useSessions` 钩子读取 `subagentsByParent` 与会话摘要。非空目录到达后，它会显示健康的直接 child 数量，并按服务顺序显示一棵紧凑树。每个健康行都组合其持久化 label、`running`／`inactive` 活动状态（分别呈现为「正在处理」／「已完成」）、由日志支撑的可选 title 与会话摘要中的活动时间；损坏、不受支持或不可用的行仍保持可读但禁用。展开某一行时，会懒加载该 child 的直接目录，并向运行时报告每个可见分支，使成员帧只在树正被消费的位置触发去抖动刷新。选择任意深度的条目都会使用该行的确切地址 `{parentSessionId, childSessionId}` 调用 `SessionsService.openSubagent()`。组件局部状态负责树的可见性、已展开分支与键盘焦点。ArrowRight／ArrowLeft 展开和折叠分支；ArrowUp／ArrowDown、Home、End 与 Escape 用于导航或关闭树；关闭后焦点返回触发器。样式只使用 token。

已寻址 child 没有确切的存活 parent 时，会选中只读编辑器配置项并说明恢复路径。parent 存活时，child 保留普通输入 chrome，其 Session 会通过 `subagent.prompt` 路由；本包绝不接收宿主 context，也不调用面向模型的工具。目录与编辑器行为由 [Web subagent 对话 Agent Note](../../../.agents/notes/implemented/feature/2026-07-27-web-subagent-conversations.md)规定。

`@` source 仍然刻意保持独立且惰性。候选是从 `ctx.sessions.list` 零 RPC 得到的运行中 child；pick 会插入字面文本 `@label `，codec 投影为 `@label`。它不参与命令裁决，也不会把 label 解析成继续执行地址。

## 模型体验

### 用户提示词中的 subagent label 文本

#### 模型看到的内容

只有旧有 `@` 引用 source 会影响模型输入：pick 的候选以字面文本 `@label` 进入普通用户消息，没有专用内容块或宿主侧解析。浏览目录、导航 child、查看持久化 transcript 与用户继续交互 UI 都不会添加提示词 section；继续交互内容会经宿主 subagent 适配器成为普通 user-role 事件。

#### Token 影响

有条件且仅追加：字面 `@label` 或用户后续消息只会向对应的新用户消息增加 token。目录与 transcript 操作增加零模型 token。

#### KV Cache 影响

仅追加。本包绝不改写更早的请求 token。

## 已知限制与暂缓事项

- **目录只有粗粒度存活状态**：它不能显示持久化结果、耗时、确切的 Activation 状态或正确的取消按钮。
- **侧边栏仍包含 child Session**：完全去重需要可扩展的持久化分类器，且不得误隐藏普通 fork。
- **`@` 引用仍是显示标题文本**：重复或改名后的 label 会有歧义，因此它们刻意不获得继续执行语义。
