# Agent Note: Dim tool-result output inside TUI tool cards

Status: implemented

[English](2026-07-28-tui-dim-tool-result-output.md) | 中文

## Problem

[固定的 `Tool / <name>` 表头](2026-07-27-tui-tool-card-header.md)把每一项工具专属的细节都移入卡片正文后，正文成为使用终端默认前景色的扁平文本块：presenter 标题、终端的 `$` 命令及其 cwd，以及工具自身的输出都成了一段无法区分的文本。包含多次调用的 transcript（文本记录）无法在视觉上区分卡片框架到哪里结束、工具实际产生的内容从哪里开始；而且命令输出较长时会与周围的对话争夺注意力，尽管它只是供读者扫读而非细读的参考资料。

## Decision

下文所述的框架/输出划分已由[整个卡片正文统一使用一种暗色调](2026-07-28-tui-uniform-dim-card-body.md)取代：后者保留输出的暗色样式，并将其扩展到框架行；当前规则以及这种划分为何呈现为颜色散乱，均由该说明负责记录。本文仍然有效的是工具输出为何需要弱化，以及两篇说明共同保留的 diff 卡片和空白行例外。

在工具卡片中，工具自身的输出使用调色板的 `dim` 角色渲染，而卡片框架保留既有颜色。框架包括 presenter 标题、终端卡片的 `$` 命令行与 cwd 行，以及 diff 卡片各文件的路径表头和 `+`/`-` 行；输出包括终端卡片捕获的 stdout/stderr，以及 generic 卡片的结果文本。

`ToolCardComponent.renderBody` 在 `packages/ui/tui/src/components/transcript.ts` 中返回 `CardBody`，其内容为 `{ prelude, lines }`，而非单一的扁平字符串数组。`prelude` 保存已设置样式并按原样渲染的框架行；`lines` 保存工具文本。终端卡片通过 `dimOutput` 将输出行变暗；该函数会把空白行保留为空字符串，使此分支既有的空白行过滤逻辑仍会丢弃它，而不会保留一个带 ANSI 包装的空值。diff 卡片将其变更块与变更页脚全部作为 `prelude` 返回：`+`/`-` 的颜色已经承载了 diff 的含义，再将它们变暗会干扰这一信号。

对于 generic 卡片，标题与结果作为同一个 Markdown 文档渲染，再由 `dimPastPrelude` 仅将标题之后的行变暗。以相同宽度单独渲染标题即可得到它的行数，因此即使发生折行，也能正确划分两部分，同时文档仍可保留自身的块间距，尤其是 pi-tui 的 Markdown 在开头段落与后续标题之间插入的空白行；拆成两个文档会丢失该空白行。仅含空白字符的行不会添加样式包装，因此 Markdown 的行填充不会进入样式范围。Markdown 的角色颜色（标题、内联代码）仍会叠加于暗色基础样式之上，因此变暗的结果仍保留内部结构。

退出和信号标记保留既有角色（`dim [exit N]`、`error [signal …]`），折叠预览标记也保持变暗，因此此变更没有新增调色板角色或配置。

## Alternatives considered

**将整个卡片正文变暗。** 已否决：这会削弱 diff 卡片中 `+`/`-` 的绿色和红色，而这里的颜色承载的是含义而非强调；同时还会把读者用来确认所运行命令的 `$` 命令变暗。

**更改 generic 卡片的 Markdown 基础颜色，并将标题留在同一个文档中。** 已否决：`DefaultTextStyle.color` 会统一应用于每一行，因此标题会随结果一起变暗。改为把标题拆成单独的文档，又会丢失 Markdown 在标题前插入的空白行，从视觉上消除 `run_code` 和 `cordis_inspect` 卡片中标题与结果之间的间隔。

**引入专用的 `toolOutput` 调色板角色。** 已否决：没有消费方需要将其与 `dim` 区分，而调色板的角色集合是其他组件读取的契约；新增一个解析为相同 SGR 组合的角色没有收益。

**在 `dimOutput` 中无条件将每一行变暗。** 已否决：包装空字符串会得到一个非空的 ANSI 值，使终端分支的 `filter(Boolean)` 失效，并为输出以换行符结尾的每张卡片都增加一个空白行，而几乎每条真实 bash 结果都以换行符结尾。

## Consequences

卡片现在一眼就能看出框架与输出，包含大量调用的 transcript 也呈现为一列表头，每个表头下方是弱化的细节。代价是 `dimPastPrelude` 每帧会渲染 generic 卡片的 Markdown 两次：第一次只渲染 prelude 以统计行数，第二次渲染整个文档；在卡片规模下，这一开销可以接受，并能在折行时保持正确的行划分。由于变暗效果是 SGR 属性而非颜色，结果中的 Markdown 角色颜色仍能在其下保留，因此变暗的正文仍有结构，而不是统一的灰色。此处理仅限 TUI：ACP 和 JSON-RPC 桥接层保留各自的工具调用呈现方式，所有 presenter 与 `presentation.ts` 类型均未改变。

## Testing

`packages/ui/tui/tests/tui.spec.ts` 在启用颜色的情况下固定了空白行守卫，此时正是 dim 包装层使空白行成为非空值；如果 `dimOutput` 无条件包装，该断言就会失败。`packages/ui/tui/tests/snapshots/` 与 `examples/tui-agent/tests/snapshots/` 下的无密钥终端快照已重新录制，并加入新的 `dim` 样式范围，覆盖 bash 输出、read 输出、`run_code`、`workflow`、`subagent`、`todo_write` 和 `cordis_*` 结果，同时 diff 卡片的 `+`/`-` 范围与 `$` 命令行保持不变。
