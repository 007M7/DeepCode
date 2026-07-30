# Agent Note: Web diff 卡片 —— write/edit 渲染意图抵达浏览器

Status: implemented

[English](2026-07-30-web-diff-card.md) | 中文

## Problem

`write` 和 `edit` 工具为其 call 和 result 都声明了 `card: 'diff'`（[render-intent union](../architecture/2026-07-02-tool-render-intent-union.md)）：call view 携带从参数推导的预期改动，result view 携带已应用的上下文 hunk（`FileDiff[]`，由 `packages/fs/tool-fs/src/diff.ts` 计算，并持久化在 result `meta` 中以便回放重建）。该视图早已抵达浏览器 —— host、connection、runtime 将它作为 `callView`/`resultView` 投递到 `ConversationSnapshot` —— TUI 也已将其渲染为按文件分组的 `+`/`-` 块加 `+A -R · N file(s)` 页脚。

Web 客户端忽略了它。write/edit 调用落到 `GenericToolCard`，其行从原始工具参数推导，详情面板把 result 的 content block 摊平进一个 `<pre>`。`diffs` 载荷 —— result 的全部意义 —— 被丢弃，于是一次文件改动读起来只是一行确认、看不到任何改动。

这是把 [terminal 卡片](2026-07-28-web-terminal-card.md) 对 `diff` 这一支重做一遍：那次改动让 Web 客户端成为 `terminal` 渲染意图的消费者；这次让它成为 `diff` 渲染意图的消费者，复用同一套四层结构。

## Decision

`DiffBlock` 是一个 `ui-primitives` 组件，把文件改动渲染为内联 diff 表面，write/edit 调用的两个 Web 渲染点都通过它消费 diff 渲染意图：chat 工具行的行体和详情面板的 Output 区。`ui-conversation/src/client/contract/diff-card-model.ts` 是唯一把快照的 `callView`/`resultView` 对转成组件 props 的地方，因此两个渲染点不会对一次改动产生分歧。当两侧都未声明 `card: 'diff'` 时它返回 null —— 走通用路径 —— 包括本客户端版本不认识的 `card` 值，以及已结算调用的 result view 是 generic 的情况（write/edit 的执行错误正是这样留在通用路径上的）。调用结算后 result 侧是权威：已应用的 hunk 替换仅从参数推导的 call 时 diff。分页窗口丢弃了 call 头也仍能渲染，因为 result view 携带完整改动。

组件的契约遵循 TUI 的 `diffLines`（`packages/ui/tui/src/components/transcript.ts`），使 diff 在两个前端读起来是同一形态：

- **每个文件一个路径头。** 新文件开启一个粗体路径头；同文件的第二个 hunk（分散编辑，或 `replace_all`）以一个 `⋯` gap 开启，而非重复路径。`N file(s)` 页脚在两个前端都统计**去重后的路径数** —— 本 PR 把 TUI 页脚从 `diffs.length` 改为去重路径计数，因此同文件两个 hunk 在两端都读作 `1 file`。
- **改动用 diff 自身的颜色。** 删除行是 error token 上的 `- `，新增行是 success token 上的 `+ `，在横向滚动的盒子里以 `white-space: pre` 逐字绘制 —— 源码行靠缩进阅读，所以滚动而不折行。新建（`oldText: null`）没有删除侧。
- **高度上限带展开控件。** 长于 `DEFAULT_DIFF_MAX_LINES`（16）的 diff 显示 `ceil(max/2)` 个头部行加剩余尾部行，中间一个按钮报告隐藏行数。分割算术与 `TerminalBlock` 和 TUI 的折叠卡片一致，因此长 diff 的头尾切片在两个前端一致。
- **行终止符。** 每一侧的内容按 `TerminalBlock` 的终止符规则在 `\n` 上切分：空文本是零行（整文件删除的 `newText`、新建缺失的 `oldText` 侧），单个结尾换行终止其最后一行而非新增一条幻影空行，内部空行保留。本 PR 把同一规则应用到了 TUI diff 分支，因此对于真实 write/edit 调用携带的以换行结尾的内容，两个前端的 `+A -R` 页脚计数一致。
- **页脚与复制。** 暗色 `└ +A -R · N file(s)` 页脚概括改动；`+A -R` 是新增/删除行数，与 TUI 页脚绘制的每侧计数相同。复制控件复制带前缀的 diff 文本（路径头、`- `/`+ ` 行、`⋯` gap），使多文件复制保持可归属。

几何、圆角、字体镜像 `CodeBlock`/`TerminalBlock`，使 diff 卡片、terminal 卡片、代码块读起来是一家；`white-space: pre` 加横向滚动是刻意的分歧。复制控件浮在卡片右上角，而非占据自己的 banner 行，因为只放一个复制按钮的 banner 会在第一行 diff 上方画出一条空带 —— TUI 的 diff 卡片也没有 banner，只有页脚。

chat 行把 diff 常驻渲染在路径链接摘要之下，上限 `CHAT_DIFF_MAX_LINES`（8），对应面板的 16 —— 与 [terminal 卡片](2026-07-28-web-terminal-card.md#inline-output-in-the-chat-row-reverses-a-stated-convention)记录的内联输出决策、以及流内表面对单调阅读表面的同一划分一致。write/edit 行是单文件的，所以它的摘要既是可打开的路径链接，其 diff 卡片又展开；两者共存，因为卡片不是路径的参数体。

## Alternatives considered

**并排（双栏）diff。** owner 目前拒绝：它更密但不适合狭窄的 chat 行，目标是与 TUI 单栏统一形式对齐。详情面板里的双栏模式是后续的 props 改动，不是重设计。

**git 式行号槽。** `FileDiff` 契约只携带 `{ path, oldText, newText }` —— `structuredPatch` 的 hunk 起始行在 `diff.ts` 里被丢弃，所以没有行号抵达客户端。渲染行号槽需要后端契约改动（携带 `oldStart`/`newStart`）并同步升级 TUI 以保持一致；推迟，使本 PR 保持为对既有契约的纯 Web 消费。

**复用 `CodeBlock`。** 因与 terminal 卡片相同的理由拒绝：`CodeBlock` 会折行，且没有每行 `+`/`-` 角色、没有路径头、没有页脚。两者共享几何与字体 token，那是唯一一处一个实现对两者都正确的部分。

## Consequences

`DiffBlock` 只读 diff view 的字段，因此它是渲染意图所携带内容的纯函数 —— 与产出该视图的 presenter 一样回放安全。没有 diff 能力的 UI 仍得到 bridge 的通用回退；工具的 result 形状没有任何改变。无新增运行时依赖：不同于 terminal 卡片的 `anser`，diff 不需要解析器。

`DiffBlock` 的多文件支路（一张卡、多个路径头）今天没有生产者：`write`/`edit` 每次调用各改一个文件，所以真实卡片显示一个文件带一个或多个 hunk。该支路为将来的多文件改动工具而构建并测试，不是为当前消费者。

## Testing

`packages/client/ui-primitives/tests/diff-block.spec.tsx` 钉住组件：新建支路（只有新增、无删除侧）、编辑支路（删除在新增之上）、同文件 `⋯` gap 对比新文件自己的头、空 diffs 的 null 渲染、页脚计数及其单复数、头尾上限及其 `aria-expanded` 切换、以及复制控件在接受与拒绝两条剪贴板路径上断言带前缀的 diff 文本。Per-file 100%。

`packages/client/ui-conversation/tests/diff-card.spec.tsx` 钉住每个渲染点的接线：`diffCardModel` 的派生及其每个 null 支路、result hunk 替换 call 时 diff、窗口截断的 call 仍从 result 渲染、chat 行的 diff 体、`FileMutationRow` 的常驻卡片及其路径链接经 host 以 cwd 解析打开、其在 `write` 与 `edit` 下的注册、以及面板的 Output 区。

fixture（`packages/client/connection/src/client/fixture.ts`）携带三个 diff turn，使 `?fixture` 服务与 per-package 接线测试套件在两个渲染点演练全部三个支路：单 hunk 编辑（turn 62，keyed `FileMutationRow`）、新建/写入（turn 63）、多 hunk 编辑（turn 67，一个文件内两处分散 hunk 之间的 `⋯` gap）。built-boot snapshot（`apps/web/tests/built-boot.snapshot.ts`）是启动装配 smoke，只断言图挂载并抵达 chat 内容（`data-sample="bash-global"`）；按其自身契约它不带 diff 行为断言，那由接线套件负责。

## Related

- [Web terminal 卡片](2026-07-28-web-terminal-card.md) —— `terminal` 支路的同一套四层结构；本 note 复用其内联输出决策与头尾上限算术。
- [工具调用呈现的标签化 render-intent union](../architecture/2026-07-02-tool-render-intent-union.md) —— 本改动消费的 `card` 标签词汇；Web 客户端现在也是 `diff` 支路的消费者。
- [Web 客户端架构](../architecture/2026-07-19-gui-web-client-architecture.md) —— 两个渲染点所处的 slot 与快照分层。
