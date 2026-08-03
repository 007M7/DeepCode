# Agent Note: Web search source card scrolls instead of collapsing

Status: implemented

[English](2026-08-03-web-search-source-scroll.md) | 中文

## Problem

`web_search` 结果卡片（`WebBlock`，`packages/client/ui-primitives/src/WebBlock.tsx`）此前用首尾折叠渲染它的来源列表：超过 `maxSources` 数量（详情面板为 16，聊天行经由 `CHAT_WEB_MAX_SOURCES` 为 8）时，它画出前 `ceil(max/2)` 条来源、一个 `… 其余 N 条来源` 展开按钮，再画出末尾 `max - ceil(max/2)` 条，与 `TerminalBlock` 的输出上限一致。用户阅读该卡片时看到 `来源列表已截断`，会以为前端丢弃了它正持有的来源。

其实并没有。seam（`capSources`，`packages/web/web/src/index.ts`）把 provider 的来源裁剪到工具的 `searchMaxResults` 上限（默认 8）并置位 `truncated`，而这一份被裁剪过一次的列表同时喂给面向模型的 render 文本与卡片的 `presentationMeta`。卡片持有的来源绝不会多于模型所见。因此这个折叠隐藏的正是用户本有权完整查看的来源——并且在默认上限为 8、面板上限为 16 时，它几乎从不触发，只留下 `truncated` 提示，却无从展开任何内容。

## Decision

`WebBlock` 的 search 分支把它收到的每一条来源都渲染进单个 `<ol className={css.sources}>`，不做首尾切片、不设展开按钮、也不带 `maxSources` prop。`.sources`（`WebBlock.module.css`）获得一个固定的 `max-height` 与 `overflow-y: auto`，因此长于卡片高度的列表在原地滚动，而非撑大卡片或隐藏行。该高度是卡片几何形状的一个设计常量，因此放在 CSS 里，而非插件配置字段。

模型侧不变：seam 仍在 `searchMaxResults` 处封顶来源，面向模型的 render 文本未动，`truncated` 标志及其 `来源列表已截断` 指示保留。模型所见与卡片所示仍是同一份列表——只不过卡片把它全部展示、可滚动，而非折叠中段。

`CHAT_WEB_MAX_SOURCES` 与该 primitive 的 `DEFAULT_WEB_MAX_SOURCES` 被移除：有了滚动，聊天行与详情面板展示同一份完整列表，仅以各自的容器高度区分。`<li value={ordinal}>` 仍钉住每条来源从 1 起算的引用序号；没有了折叠造成的间断，这些序号如今就是连续的。

## Alternatives considered

**提高 `searchMaxResults`（或让它无上限），使更多来源同时抵达模型与卡片。** 被用户否决：它改变了模型侧行为（每个请求的上下文纳入更多来源、更多 token），并打破了模型可见来源与前端可见来源相同这一不变量。指令很明确——保留上限与截断，加一个滚动条。

**保留首尾折叠，仅对展开区域加滚动。** 否决：一个关注点上两套重叠机制。一旦整份列表始终渲染，折叠的算术、展开/折叠状态与那个按钮都是死重；仅靠滚动即可约束高度。

**把滚动高度做成插件配置字段。** 否决：该高度约束的是卡片在屏幕上的几何形状，而非部署策略，因此依据 [web-card-model](2026-07-30-web-result-card.md) 对 `CHAT_WEB_MAX_SOURCES` 的先例，它作为设计常量属于 CSS。

## Testing

`packages/client/ui-primitives/tests/web-block.spec.tsx` 删去折叠相关用例（首尾切片、点击展开、折叠尾部编号、展开器不计入编号、仅首部、默认上限），并新增：一个 30 条来源的卡片渲染出全部 30 个 `<li>`，无 `[aria-expanded]`、无 `<button>`，每个 `<ol>` 子元素都是一条来源 `<li>`，且 `<li value>` 从 1 到 N 连续编号。`packages/client/ui-conversation/tests/web-card.spec.tsx` 删去 `CHAT_WEB_MAX_SOURCES` 上限断言；WebRow 展开测试仍断言卡片展示每一个来源字段。`packages/web/tool-web` 的测试不变——模型侧未曾移动。

## Related

- [Web result card](2026-07-30-web-result-card.md) —— 本卡片消费的 `card: 'web'` 渲染意图分支与 `presentationMeta` 路由；那份裁剪过一次的列表的来源。
