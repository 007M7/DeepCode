# Agent Note: 固定标题栏，sticky 编辑器位于 transcript 滚动容器内

Status: implemented

[English](2026-07-29-sticky-composer-conversation-scroll.md) | 中文

## Problem

活跃会话列把滚动拆成两段：聊天（以及 trajectory）视图自有 `overflow-y: auto`，编辑器栈则作为该滚动容器的兄弟节点坐在下方。指针落在统计行或输入区上时，滚轮打在不可滚动区域上因而毫无效果——只有指针在消息列表上时 transcript 才会移动。草稿变长时更糟：textarea 本身也是滚动容器，编辑器上的滚轮可能被截在那里。会话标题栏必须以普通 chrome 占据列顶（不能在滚动容器内 `position: sticky`），而编辑器必须与 transcript 贴在同一滚动容器底部，使页脚上的滚轮能带动内容流动。

## Decision

只要存在会话，`ConversationRoot` 就会始终提供 `wrapActiveBody` owner 回调，将视图环包进 `data-conversation-scroll` 主体，并用 `data-composer-seat` 包住整条 `'conversation.composer'` chain 输出（`overlay: true` 下的 fallback 与选举出的 overlay 兄弟节点）。活跃阶段 CSS 以 `position: sticky; bottom: 0` 钉住该 seat，使用户未贴底时 Question／Approval 接管仍可见；hero CSS 在滚动主体内居中 fallback 栈。`ConversationSession` 在 blank 时保留隐藏 chrome 的 header + body 壳，使首次发送时树座位不变。可见时会话标题栏仍是滚动容器之上的 `flex: none` 列 chrome。ChatView 与 Trajectory/Waterfall 仅在宿主之外挂载时（单元测试）保留本地 scroller；位于宿主下时设为 `overflow: visible`，并通过 `closest('[data-conversation-scroll]')` 解析贴底跟随与前置锚定。

会话统计挂在 `'conversation.composer.dock'`（位于 `'conversation.input.dock'` 之上）。InputBar 的 textarea 在宿主内以 `{ passive: false }` 链式处理 `wheel`：在限高 textarea 仍能沿该方向滚动时保留原生手势；仅在自身边缘才 `preventDefault` 并将 `deltaY` 施加到宿主。

Chat 历史前插通过稳定的已渲染 node／call 身份跟随读者意图，而不是使用整个滚动容器的高度差。分页开始时，`ChatView` 记录第一个可见的 `data-chat-anchor-key` 及其相对滚动容器的顶部位置；请求在途期间，每次读者滚动都会重新选择当前可见的稳定锚点；页面到达后则按该行矩形的前后差值补偿。到达底部或追加读者自己的消息会取消分页锚点，因此迟到的页面不能把视图从最新内容拉走。贴底跟随采用存储状态，而不是原始滚动几何状态。passive wheel 监听器以最近一次由主线程交付或由程序写入的 `scrollTop` 作为输入前基线，因为 Chromium 可能先推进合成器几何状态，之后才交付事件；当前使用的非负下限不会将并发的布局钳制计入读者移动。没有对应滚轮／触控板输入位移的滚动，在跟随状态下会重新贴底，在阅读状态下则只刷新语义位置。`ChatView` 的单个 `ResizeObserver` 只会在贴底所有权仍保持时跟随流式输出、工具展开与草稿尺寸变化，且每个 chunk 不会触发第二次滚动写入。

## Alternatives considered

**标题栏与编辑器都在同一列滚动容器内 sticky。** 标题栏否决：它必须作为固定布局 chrome 占据顶部，而不是参与滚动容器的 sticky 层。

**滚动容器下方 flex-none 固定编辑器并转发滚轮。** 否决：产品要求编辑器 sticky 在 transcript 滚动容器内，使页脚成为该滚动命中面的一部分，而不是仅转发增量的兄弟节点。

**把编辑器 portal 进 ChatView 的 scroller。** 否决：编辑器跨视图标签共享；包装目标是常驻壳拥有的 Session 主体。

**把 StatsLine 留在 ChatView 消息列下方。** 否决：落在 sticky 编辑器之外会随内容滚走，而输入区仍钉在底部。

**为每一种浏览器滚动输入来源建模。** 此次窄范围修复不采用：已复现的桌面端路径使用滚轮／触控板输入。指针／触控滚动、拖动原生滚动条、键盘滚动、焦点导航与嵌套 overflow 所有权仍不纳入输入来源模型，也不为此新增通用输入状态机。

## Consequences

在页脚上滚轮会滚动 transcript；可见布局是固定标题栏、可滚动 transcript 与 sticky 底部编辑器。统计出现在每一个活跃视图标签上。宿主下的嵌套视图 scroller 被抑制，因而 Trajectory 的 sticky Turn 标题贴在列宿主上。并发历史加载、流式输出、工具展开与编辑器重排会保留滚轮／触控板的滚动决定，包括 Chromium 先推进合成器几何状态再交付事件，以及流收尾阶段滚动位置受钳制后滚动容器重新增长的情况。在这条窄范围的输入来源规则下，其他浏览器滚动输入不会改变贴底跟随所有权。hero → active 保持同一 textarea DOM 节点（assembled slash-flow 快照）以及 InputHub 草稿。
