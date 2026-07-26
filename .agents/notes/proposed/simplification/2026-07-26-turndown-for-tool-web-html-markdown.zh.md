# Agent Note: 用 turndown 替换 tool-web 的正则 HTML 转 markdown 转换器

Status: proposed

[English](2026-07-26-turndown-for-tool-web-html-markdown.md) | 中文

## 问题

`packages/web/tool-web/src/html.ts`（约 86 行，另有约 40 行专属测试）用正则表达式把抓取到的 HTML 转成 markdown：剥离 script、style、noscript 标签与注释，转换 `<a>`/`<h1-6>`/`<li>`，解码数字实体外加一张 12 项的命名实体表，并折叠空白。该模块自身的 JSDoc 写明「A richer converter can replace it without changing the seam or tool schema」，README 的 Known Limitations 章节也把它记载为「a minimal regex converter, not an HTML parser — tables, images, and nested formatting are lost」。[web 能力 seam 决策记录](../../implemented/architecture/2026-06-24-web-capability-seam.md)把 HTML 转 markdown 作为呈现职责划归本包（package），因此替换点恰好就在这里。每个抓取到的 HTML 页面上，该转换器的输出都对模型可见；当前没有任何无密钥快照执行到 `web_fetch`，因此没有预期输出固定它的行为。

## 提案

用 `turndown` 替换 `htmlToMarkdown`（`new TurndownService().turndown(html)`），可选择配合 `turndown-plugin-gfm` 支持表格。`fetch.ts` 中的消费方分支与状态头、截断页脚的格式化保持不变。把调用包在 try/catch 中，失败时回退到原始文本路径：正则版本从不可能抛异常，而 turndown 处理病态 HTML 时可能抛出。删除 `html.ts` 及其转换测试；保留回退路径与外围格式化的测试。更新 README 的 Known Limitations 章节，移除正则转换器的警示说明。

如果更倾向于「刻意保持最小回退实现」的立场，最小变体仍能删掉最糟的部分：用零依赖的 `entities` 包（已通过传递依赖存在于 lockfile 中）替换文件中占三分之一的实体解码部分（约 30 行：`decodeEntities`、`NAMED_ENTITIES`、`safeFromCodePoint`），以近乎为零的风险抹掉文档记载的「about a dozen entities」限制。

## 曾考虑的替代方案

- **`@mozilla/readability` 加一个 DOM。** 它解决的是另一个问题（内容提取，而非格式转换），还会拖入更重的 DOM 依赖；这个 seam 只要求把抓取返回的内容渲染成 markdown。
- **保留正则转换器。** 按其自身 JSDoc 的说法，它本来就是明确的 v1 占位实现；保留它意味着模型可见的质量（表格、图片、嵌套格式）继续缺失，代价还是维护一套自制实体表。
- **仅引入 `entities` 的最小变体。** 已作为退守方案保留在提案中；它删得更少，但完全避开了依赖体积问题。

## 验收标准

- `web_fetch` 经由 turndown 渲染表格与嵌套格式（或在最小变体下：解码全部命名实体），README 中的限制说明同步更新。
- 单元测试覆盖回退路径；该包的 `pnpm run test` 通过。
- 按测试政策补充一个执行 `web_fetch` markdown 渲染的无密钥快照（缺失的快照覆盖是本变更的一部分，它同时固定新输出）。

## 风险

- 模型可见的输出在每个抓取到的 HTML 页面上都会变化：预发布阶段的 transcript（文本记录）漂移可以接受，且当前没有任何东西固定旧输出。
- 依赖体积：turndown 的唯一依赖（`@mixmark-io/domino`）是一个约 200 KB 的 DOM 实现，若 tool-web 进入单文件可执行文件，它会一并进入闭包（[single-exe 决策记录](../../implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md)）；若闭包体积是决定因素，最小的 `entities` 变体可以避开这一点。
