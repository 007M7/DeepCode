# Agent Note: Web result card — a structured render intent for web_search and web_fetch

Status: implemented

[English](2026-07-30-web-result-card.md) | 中文

## Problem

`web_search` 与 `web_fetch` 工具各自声明了一个 generic 待定卡片（`presentCall`，`kind: 'search'`/`'fetch'`），但没有 `presentResult`，因此一个已完成的 web 调用抵达 UI 时只剩下面向模型的 render 文本。对于想渲染引用列表或抓取摘要的 web 前端而言，该文本是有损的：`web_search` 的 render 把每个来源的 `title`、`snippet`、`publishedAt` 压进一行以 title 或 hostname 标注的自由文本 markdown（`packages/web/tool-web/src/search.ts` 中的 `formatSearchOutput`），因此重新解析 render 无法恢复各来源字段；`web_fetch` 的 render 也仅在一行 header 里携带 `url` 与 `statusCode`。渲染意图契约（[标签联合类型](../architecture/2026-07-02-tool-render-intent-union.md)）此前没有一个可供 web 工具声明、用以携带结构化结果的分支。

## Decision

向 `ToolResultView`（`packages/core/tools/src/presentation.ts`）新增一个 `card: 'web'` 结果分支，它是以 `kind: 'search' | 'fetch'` 字段作判别的联合 `WebResultView = WebSearchResultView | WebFetchResultView`，并附一个表示单个可引用来源的 `WebSource` 形状。两个工具现在都声明 `presentResult`。

采用一个标签加 `kind` 判别，而非两个标签。两个调用都是 web 检索，web 前端会用同一族组件渲染它们（一个检索卡片，正文按 kind 不同），因此共用一个 `card` 让每个 card 消费者的 switch 只需新增一个分支，并让前端在其内部按 `kind` 分岔。两个标签会迫使当前及未来每个消费者为本属同一视觉族的东西添加两个分支。这两个 `kind` 取值与两个工具既有的 generic 调用视图 `kind` 一致，因此一个调用与它的结果读起来是同一类别。

`presentationMeta` 在这里是必需的，而非便利手段。工具从 `execute` 返回的结构化结果对象**不会**经由 wire 抵达客户端——只有面向模型的 `render` 文本，以及（声明时）投影到 `tool/result` 事件 `meta` 上的 `output.presentationMeta` JSON 会。由于 render 文本对 `web_search` 的来源是有损的，经 `presentationMeta` 投影来源，是在消费端得到忠实 `{url, title?, snippet?, publishedAt?}` 的唯一途径。这照搬 write/edit 的 diff 模板（`packages/fs/tool-fs/src/diff.ts`）：一个 `*MetaFromValue` 投影器喂给 `output.presentationMeta`，一个 `*MetaFromResult` 收窄器读回 `result.meta`，并在失败时防御性回退到 generic 卡片。`web_fetch` 的 meta 只携带 `url`/`statusCode`/`truncated`；其正文已是结果内容中的 markdown，因此不重复写入 meta。

每个结果视图携带一个可选的 `content?: ContentBlock[]`，设为面向模型的结果内容。不具备 `web` 能力的 UI——包括其 transcript 渲染器没有 `web` 分支的 TUI——经由既有的 generic/默认路径渲染该内容（`packages/ui/tui/src/components/transcript.ts` 中 `renderBody` 的 `view.content ?? this.result?.content`），因此新标签无需专门的 TUI 分支，TUI 继续编译并渲染文本。

`presentResult` 在错误结果、以及 `meta` 缺失或畸形时返回 `undefined`（即 generic 卡片），因为 presentation 会在对任意已记录结果（可能来自旧 schema）的重放中运行，绝不能抛错。收窄器防御性地校验每个字段；空来源列表是有效 meta，而非畸形。

## Consequences

web 前端消费者是一个独立的后续 PR：本 PR 新增契约分支并让两个工具发出它，不含客户端渲染。任何做穷尽 switch 的现有 `ToolResultView` 消费者都必须新增一个 `web` 分支；TUI 并不穷尽 switch，无需新增。`apiproxy` 的会话 schema 已接受任意 `card` 字符串（`packages/host/apiproxy/src/api/sessions.schema.ts`），因此新视图无需 schema 变更即可跨 wire。

未来想用此卡片的 web 工具，声明一个返回带自有 `kind` 的 `card: 'web'` 视图的 `presentResult`；新增第三个 `kind` 是一次联合类型编辑加前端的分岔，而非一个新的 card 标签。

## Alternatives considered

**两个 card 标签（`web-search`、`web-fetch`）。** 否决：它在每个 card 消费者处为一个视觉族翻倍分支数，而两个形状已共享得够多（一个带回退内容的带标题检索卡片），`kind` 判别无需第二个标签即可表达差异。

**在 `presentResult` 里重新解析 render 文本，而非投影 meta。** 对 `web_search` 否决：render 的来源列表是有损的（title 或 hostname 标签，snippet 与日期拼进自由文本），因此重新解析无法忠实恢复结构化字段。`presentationMeta` 是唯一保留它们的途径。

**把抓取正文也放进 meta。** 否决：正文已是结果内容中面向模型的 markdown，把它复制进 meta 会为无收益的目的翻倍持久化载荷；视图让 UI 指向既有内容。

## Testing

`packages/web/tool-web/tests/tool-web.spec.ts` 覆盖以下内容，满足按文件 100% 的门禁：`searchMetaFromValue`/`fetchMetaFromValue` 投影，含对缺席可选字段的省略；`searchMetaFromResult`/`fetchMetaFromResult` 收窄，含一次往返与每种畸形形状的拒绝（非对象、字段类型错误、畸形来源条目）以及空来源列表的接受；`presentSearchResult`/`presentFetchResult` 类型化视图，含 truncated 信号、错误结果回退与畸形 meta 回退；以及两次真实注册表执行，断言工具把 meta 投影到 `result.meta` 上，其注册的 `presentResult` 推导出 `card: 'web'` 视图。

## Related

- [标签化的工具调用渲染意图联合类型](../architecture/2026-07-02-tool-render-intent-union.md) —— 本卡片以 `web` 分支扩展的 `card` 标签词汇表。
- [Web terminal card](2026-07-28-web-terminal-card.md) —— 把 bash `terminal` 渲染意图带到浏览器的先例；本分支的 web 前端消费者是它的对应物，推迟到后续 PR。
</content>
