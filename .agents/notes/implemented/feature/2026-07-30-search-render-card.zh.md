# Agent Note: Search render intent — grep and glob emit a structured search card

Status: implemented

[English](2026-07-30-search-render-card.md) | 中文

## Problem

`grep` 与 `glob` 返回结构化的规范值——`grep` 是扁平的 `{ matches: [{ path, lineNumber, line }] }`，`glob` 是 `{ paths: string[] }`——但每一个 UI 见到的只有它们面向模型的渲染文本：`grep` 把匹配按文件分组，文件头下是 `Line N:` 行；`glob` 打印换行连接的路径列表；当内联上限（{@link module:@deepseek-ai/dsh-tool-fs-search/grep} `grepMaxMatches`，默认 250；{@link module:@deepseek-ai/dsh-tool-fs-search/glob} `globMaxResults`，默认 100）把后续结果溢出到 spill 文件时，两者都追加一段溢出脚注。想把搜索结果渲染成可展开的按文件分组匹配、或渲染成可选择的路径列表的 web 前端，只能去重新解析这段文本。两个工具都已声明了调用期的[渲染意图](../architecture/2026-07-02-tool-render-intent-union.md)（`GenericCallView`，`kind: 'search'`），但没有结果期视图，于是已完成的调用回退到渲染原始文本的通用卡片。

结构化的规范值不过线：只有面向模型的渲染文本、以及当工具声明 `output.presentationMeta` 时的一段 JSON 元数据抵达客户端，二者通过 `tool/result` 事件穿线（[规范输出契约](../architecture/2026-07-20-canonical-tool-output-contract.md)）。因此携带结构化数据的结果期视图必须把该数据投射进 `presentationMeta`，再在 `presentResult` 里读回——正是 `write`/`edit` 的 diff 卡片所走的路径。

## Decision

`packages/core/tools/src/presentation.ts` 向 `ToolResultView` 联合类型加入 `card: 'search'`，即 `SearchResultView`：一个以 `kind` 区分的视图，表达两个工具的形状。`SearchMatchesResultView`（`kind: 'matches'`）以 `files: { path, matches: { lineNumber, line }[] }[]` 携带 `grep` 按文件分组的匹配；`SearchPathsResultView`（`kind: 'paths'`）携带 `glob` 的扁平 `paths: string[]`。两者都携带 `truncated: boolean` 与 `total: number`，以及可选的 `content?: ContentBlock[]`。

一个视图两种形状，而非两张卡片，因为两个工具是同一个视觉对象——一个搜索结果——web 消费方先在一个 `card` 值上分派，再在 `kind` 上分派行的形状。区分性的 `kind` 让每种形状各自的字段保持非可选（matches 视图恒有 `files`，paths 视图恒有 `paths`），而不是让所有形状相关字段都变成可选的单一接口。

卡片标签只在结果期。搜索调用仍是 `GenericCallView`（`kind: 'search'`）：pending 状态没有匹配或路径可展示，因此 `SearchCallView` 能携带的东西不会超出通用标题。这是与 terminal 卡片的不对称之处——terminal 的调用视图携带执行前就存在的命令、cwd 与描述；而搜索的结构化内容只在 `execute` 之后才存在。

`packages/fs/tool-fs-search/src/presentation.ts` 拥有投射与收窄。`grepSearchMeta`/`globSearchMeta` 把规范值投射为一段 `SearchMeta`，各工具将其声明为 `output.presentationMeta`；`presentGrepResult`/`presentGlobResult` 通过 `searchViewFromMeta` 把 `result.meta` 读回，并把面向模型的 `result.content` 作为视图的 `content` 附上。投射施加与面向模型渲染相同的内联上限与每行预览预算，并把 `total` 报告为搜索找到的全部结果（截断之前），当上限丢弃了结果时把 `truncated` 置为真。这就是截断诚实性的要点：模型看到的是被截断的内联结果加一段溢出脚注，因此卡片不得把保留的那一页当作完整结果呈现——UI 读取 `truncated`/`total` 去展示截断指示，而非宣称模型从未拥有的完整性。

`searchViewFromMeta` 防御性地收窄不透明的 `meta`，对任何畸形或缺失的 payload 返回 `undefined`，与 `diffsFromMeta` 完全一致，因此在较旧或手工编辑过的回放日志上运行的呈现器会回退到通用卡片而非抛错。`presentResult` 对失败结果、对缺失的 meta（嵌套 `run_code` 分发不计算 `presentationMeta`）、对另一个工具的 meta 形状（每个呈现器只收窄到自己的 `kind`）都返回 `undefined`。

`SearchMeta` 的成员形状是对象字面量 `type` 别名，而不是视图对外暴露的 `SearchFileMatches`/`SearchLineMatch` 接口。只有 type 别名可以赋值给 `presentationMeta` 返回的 `JsonValue` 索引签名；二者结构完全相同，因此投射出的值仍能读回为 `SearchResultView`。

TUI（`packages/ui/tui/src/components/transcript.ts`）无需专用分支：它的结果视图 switch 显式处理 `terminal` 与 `diff`，并落到一个渲染 `view.content ?? this.result?.content` 的通用分支。因为 `SearchResultView` 以 `content` 携带了面向模型的文本，TUI 渲染出的仍是它此前已展示的同一段文本。渲染结构化 `files`/`paths` 形状的 web 前端是后续独立的 PR；本 PR 是后端契约及其两个生产者。

## Alternatives considered

**单一扁平的 `SearchResultView` 接口，带可选的 `files?` 与 `paths?`。** 否决：它让两种形状相关字段在每个值上都成为可选，并允许一个畸形视图同时携带二者或都不携带。`kind` 区分符让每种形状的字段保持必填，并让消费方能穷尽分派。

**一个调用期的 `SearchCallView`，镜像 terminal 卡片两侧对称。** 否决：搜索调用在 `execute` 之前没有匹配或路径，视图只会携带 `GenericCallView` 已携带的标题。terminal 卡片的调用视图之所以配得上其标签，是因为命令、cwd 与描述在调用期就存在；而搜索的结构化内容不存在。

**用一个专门的通道而非 `presentationMeta` 携带结构化结果。** 否决：规范值是执行局部的、绝不抵达客户端，而 `presentationMeta` 是既有的接缝，它把工具的 JSON 呈现 payload 随 `tool/result` 持久化并穿线回 `presentResult`。再加一条通道只会重复这条路径。

## Consequences

`grep` 与 `glob` 现在在每次非嵌套的成功调用上计算 `presentationMeta`，这是对已解析的匹配或路径做的一次有界投射。投射重新施加渲染已施加过的保留上限，因此每次调用会计算两遍保留集；输入受原始输出上限约束，故这不是新的伸缩性问题。

没有搜索卡片的 UI 渲染附上的 `content` 文本，因此没有消费方回退。渲染结构化形状的 web 消费方读取 `truncated`/`total` 与按文件分组；因为视图只携带保留的那一页，想要完整结果的 UI 沿面向模型文本里的 spill 定位符去取，与模型的做法完全一致。

## Testing

`packages/fs/tool-fs-search/tests/presentation.spec.ts` 钉住纯函数层：`groupMatchesByFile` 的首见文件顺序，`grepSearchMeta`/`globSearchMeta` 施加上限后的投射与把 `total` 报告为截断前计数，投射出的匹配行上的每行预览预算，以及 `searchViewFromMeta` 对两种良态形状的收窄外加所有畸形情形（非对象/数组 meta、缺失或类型错误的 `truncated`/`total`、未知 `kind`、畸形 `files` 条目、非字符串 `paths`）。`packages/fs/tool-fs-search/tests/tools.spec.ts` 通过真实工具注册表钉住穿线：一次被截断的 `grep`/`glob` execute 在 `result.meta` 上产出 `SearchMeta`，且 `presentResult` 构建出附带 `content` 的搜索视图；嵌套 `run_code` 分发不计算 meta 于是 `presentResult` 回退；失败、跨形状或畸形结果回退到通用卡片。搜索包 `src` 上维持逐文件 100% 覆盖。

## Related

- [Tagged render-intent union for tool-call presentation](../architecture/2026-07-02-tool-render-intent-union.md) —— 本 PR 以 `search` 结果标签扩展的 `card` 标签词汇。
- [Canonical tool output contract](../architecture/2026-07-20-canonical-tool-output-contract.md) —— 本投射所乘的 value/render/`presentationMeta` 拆分；结构化值留在执行局部，卡片乘 `meta`。
- [Web terminal card](2026-07-28-web-terminal-card.md) —— 本 PR 在后端所镜像的先例：工具把结果投射进 `presentationMeta` 与一个 `presentResult` 视图；搜索卡片的 web 消费方是类似的后续工作。
