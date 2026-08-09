# @deepseek-ai/dsh-client-ui-deliverables

[English](README.md) | 中文

产物文件的功能属主：把"完成的一轮以其产出文件收尾"的产物行注册进 chat 视图的 `conversation.chat.turnTail` 空位。全部策略都在本包内；从 cordis.yml 中删去本插件那一行即可整体移除该交互面，属主视图以零成本渲染一个空的空位。

`producedForClosing` 从 tail 空位的 owner 通货——定稿的快照节点与收尾 assistant 的 seq——推导一轮产出的文件。词表是改写工具自身的跟随 `locations`，绝不是收尾正文：无论模型是否记得点名，产出文件都会被列出。改写按渲染意图识别而非工具名——diff 卡片，或 `kind` 为 `edit` 的 generic 卡片（即 `str_replace_editor` 的 insert 所呈现的形状）——因此新的改写工具靠声明自己做了什么加入。read、删除与失败的调用不贡献任何条目；同一路径在一轮内按首见顺序只出现一次；累积在 turn 边界重置，因此一轮若先改写文件、随后没有正文内容就结束，不会溢进下一轮的行里。

`ProducedFiles` 在收尾消息正文与其 IconActions 之间渲染该行：一个安静的标签、至多六枚 chip（文本为文件名，完整路径作为 `title`），超出上限则显示一个明确的剩余计数。每枚 chip 经由 owner 提供的 `openFile` 打开——与工具行相同的 Host 打开器，chat 视图会把相对路径按会话 cwd 解析。设计原理：[workspace 文件链接 Agent Note](../../../.agents/notes/implemented/feature/2026-07-31-web-workspace-file-links.md)。

收尾正文承载同一份词表。本插件提供 chat 视图按收尾消息查询的 `chatFileMentions` service：`producedFileMentions` 按精确路径解析行内代码 token，或当 token 恰好是且仅是一条产出路径的 basename 时解析——两条路径共享的 basename 保持死文本而不猜测，因此提及链接永远不会打开错误的文件或 404。解析成功的提及保留 code 胶囊并采用 markdown 样式表的链接语言——静止为链接蓝、悬停出下划线，与 URL 提升的行内代码完全一致——完整路径作为其 `title`；提及绝不会渲染在锚点内部或流式文本里。决策记录：[行内文件提及 Agent Note](../../../.agents/notes/implemented/feature/2026-08-07-web-inline-file-mentions.md)。

## 模型体验

无。该行是对已记录工具元数据的纯客户端派生，这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **提及匹配只认精确路径或唯一 basename。**后缀式提及（`out/index.html` 写作 `index.html` 可解析；`deep/out/index.html` 写作 `out/index.html` 则不行）保持死文本；放宽匹配器等真实的收尾消息形态需要时再做。
