# Agent Note: 固定标题栏，sticky 编辑器位于 transcript 滚动容器内

Status: implemented

[English](2026-07-29-sticky-composer-conversation-scroll.md) | 中文

## Problem

活跃会话列把滚动拆成两段：聊天（以及 trajectory）视图自有 `overflow-y: auto`，编辑器栈则作为该滚动容器的兄弟节点坐在下方。指针落在统计行或输入区上时，滚轮打在不可滚动区域上因而毫无效果——只有指针在消息列表上时 transcript 才会移动。草稿变长时更糟：textarea 本身也是滚动容器，编辑器上的滚轮可能被截在那里。会话标题栏必须以普通 chrome 占据列顶（不能在滚动容器内 `position: sticky`），而编辑器必须与 transcript 贴在同一滚动容器底部，使页脚上的滚轮能带动内容流动。

## Decision

只要存在会话，`ConversationRoot` 就会始终提供 `wrapActiveBody` owner 回调，将视图环包进 `data-conversation-scroll` 主体，并用 `data-composer-seat` 包住整条 `'conversation.composer'` chain 输出（`overlay: true` 下的 fallback 与选举出的 overlay 兄弟节点）。活跃阶段 CSS 以 `position: sticky; bottom: 0` 钉住该 seat，使用户未贴底时 Question／Approval 接管仍可见；hero CSS 在滚动主体内居中 fallback 栈。`ConversationSession` 在 blank 时保留隐藏 chrome 的 header + body 壳，使首次发送时树座位不变。可见时会话标题栏仍是滚动容器之上的 `flex: none` 列 chrome。ChatView 与 Trajectory/Waterfall 仅在宿主之外挂载时（单元测试）保留本地 scroller；位于宿主下时设为 `overflow: visible`，并通过 `closest('[data-conversation-scroll]')` 解析贴底跟随与前置锚定。

会话统计挂在 `'conversation.composer.dock'`（位于 `'conversation.input.dock'` 之上）。InputBar 的 textarea 在宿主内以 `{ passive: false }` 链式处理 `wheel`：在限高 textarea 仍能沿该方向滚动时保留原生手势；仅在自身边缘才 `preventDefault` 并将 `deltaY` 施加到宿主。

## Alternatives considered

**标题栏与编辑器都在同一列滚动容器内 sticky。** 标题栏否决：它必须作为固定布局 chrome 占据顶部，而不是参与滚动容器的 sticky 层。

**滚动容器下方 flex-none 固定编辑器并转发滚轮。** 否决：产品要求编辑器 sticky 在 transcript 滚动容器内，使页脚成为该滚动命中面的一部分，而不是仅转发增量的兄弟节点。

**把编辑器 portal 进 ChatView 的 scroller。** 否决：编辑器跨视图标签共享；包装目标是常驻壳拥有的 Session 主体。

**把 StatsLine 留在 ChatView 消息列下方。** 否决：落在 sticky 编辑器之外会随内容滚走，而输入区仍钉在底部。

## Consequences

在页脚上滚轮会滚动 transcript；可见布局是固定标题栏、可滚动 transcript 与 sticky 底部编辑器。统计出现在每一个活跃视图标签上。宿主下的嵌套视图 scroller 被抑制，因而 Trajectory 的 sticky Turn 标题贴在列宿主上。hero → active 保持同一 textarea DOM 节点（assembled slash-flow 快照）以及 InputHub 草稿。
