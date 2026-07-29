# Agent Note: Web terminal card — the bash render intent reaches the browser

Status: implemented

[English](2026-07-28-web-terminal-card.md) | 中文

## Problem

bash 工具的调用与结果都声明 `card: 'terminal'`（[渲染意图联合类型](../architecture/2026-07-02-tool-render-intent-union.md)）：调用视图携带命令、一段可选的模型撰写描述以及工作目录，结果视图携带输出、退出码与终止信号。该视图早已抵达浏览器——host、connection 与 runtime 把它投递到 `ConversationSnapshot` 的 `callView`/`resultView` 上——TUI 也早已把它渲染为带 `$` 提示符的卡片，附退出行与首尾高度上限。

Web client 却对它视而不见。`packages/client/ui-conversation/src/client/contract/tool-call-model.ts` 仅从原始工具参数推导每一行，`skeleton/DetailsPanel.tsx` 则把所有工具的内容块压平进一个 `<pre>`，样式为 `white-space: pre-wrap; word-break: break-word`。软换行加上没有高度约束，带来两个缺陷：多列输出（`ls`、表格、制表符绘图）被折成一段文字，丢掉了这类输出赖以存在的列对齐；而单列的长列表会把详情面板拉长到与列表等长。

## Decision

`TerminalBlock` 是 `ui-primitives` 中把 shell 命令渲染为终端表面的组件，bash 调用在 Web 侧的两个渲染点都经由它消费 terminal 渲染意图：聊天工具行展开后的正文，以及详情面板的 Output 区。`ui-conversation/src/client/contract/terminal-card-model.ts` 是把快照上的 `callView`/`resultView` 这一对转换为该组件 props 的唯一位置，因此两个渲染点不可能在命令、cwd 或退出状态上产生分歧。当两侧都不声明 `card: 'terminal'` 时它返回 null，即走 generic 路径——包括本 client 版本不认识的 `card` 取值；当一个已落定调用的结果视图是 generic 时同样返回 null，这正是 bash 工具的执行错误与后台启动得以保持既有渲染的方式。渲染意图契约交给 UI 桥接层的两项职责也落在这里，而不在工具侧：已落定结果的 `title` **替换**待定标题；工作目录针对会话 workspace 解析——视图给出的绝对路径原样使用，相对路径在 workspace 之下拼接，省略则**就是** workspace，而这正是不带 `workdir` 的 bash 调用的常见情形。纯 presenter 看不到会话 cwd，因此该解析属于这道接缝；两个渲染点各自从会话列表行取出 cwd 传入。解析后的路径还会归一化其 `.`／`..` 段，因为 bash 执行器在运行前就已解析 workdir：相对 `/w/app` 的 `..` 实际运行在 `/w`，因此提示标签必须读作 `w` 而不是 `..`。调用视图的 `description` 走同一处推导，因为契约把它渲染在卡片上方，且它必须优先于该行由参数推导出的摘要。

该组件的契约：

- **提示符行，每条命令行一行。** 命令的每一行各占一行：标签，其后原样跟随该行。因此一个在两行上承载两条 shell 命令的 `command` 就读作它本身的两条命令，而不是被压成一行并省略号截断。标签取 cwd 的最后一段路径，当 cwd 等于 `home` prop 时取 `~`——浏览器没有 `$HOME`，因此由调用方提供绝对家目录，不提供时该折叠不生效。视图不带 cwd 时渲染一个纯 `$`。末尾换行是终止符，不是一条空的末命令。只有**第一行**携带该标签：视图只知道一个工作目录——调用开始处的那个——而后面的行完全可能在别处运行，命令里一个 `cd` 就足以改变它。把标签在各行重复，等于陈述一个此处无人知晓的逐行目录，这与运行状态点只出现一次是同一个理由。其余行保留一个裸 `$`，因此它们仍读作提示符。
- **整次调用一枚运行状态点，位于第一行。** 它是 `StateDot` 四种状态中的三种：运行期间为追逐动画，与渲染状态徽章相同的退出状态为红色，干净落定为绿色——与工具行行首图标使用同一个指示器，因此一行与其自身的卡片不可能对同一条命令产生分歧。该状态点存在的理由是：读者对一条 shell 命令的第一个问题就是它是否仍在运行；没有它时，这一点只能从「没有输出」推断，而一条落定后无输出的命令看起来也一样。它以脱离文档流的方式落在卡片表面左侧预留的落区里，因此既不会缩进其命令，也不依赖命令自身的文本度量来与之对齐。无论有多少行，都只有一枚：视图携带的退出状态属于整次调用，而 bash 不报告逐条命令的状态，因此每行一枚状态点就等于在断言——一条在失败调用中其实成功了的命令行自身失败了。那一处视觉隐藏的文本标签具有相同的作用域，因为 `StateDot` 是 `aria-hidden`，而每行一个标签会被辅助技术读成好几个各自独立的结果。
- **不软换行。** 输出行使用 `white-space: pre`，置于横向滚动的容器内。列对齐得以保留；长行滚动，而非折行。
- **高度上限与展开控件。** 输出超过 `DEFAULT_TERMINAL_MAX_LINES`（16）行时，显示 `ceil(max/2)` 行首部加余下的尾部行数，中间是一个按钮，报告被隐藏的行数并可展开。计数针对的是剥除输出末尾终止符之后解析出的行，因此以换行结尾的 N 行输出就是 N 行。切分算法与 TUI transcript 折叠态工具卡片（`packages/ui/tui/src/components/transcript.ts`）完全一致，因此同一条命令的首尾切片在两个前端之间吻合。
- **ANSI 颜色。** `anser` 切分 SGR 分段；`ui-primitives/src/ansi.ts` 把每段解析为内联样式，渲染成 React span。只设前景色的分段把基本 16 色映射到 `--dsw-*` 主题 token，使作者指定的颜色在两种主题下都可读；自行绘制背景的分段则前后景都保留 anser 给出的字面 rgb，以保住它意图中的对比度，256 色板、truecolor 以及本设计系统没有对应 token 的两种基本色同样如此。不承载颜色的转义序列（OSC 串、非 CSI 转义、无显示意义的 C0 控制符）在解析前被剥除，因此绝不会以字面字符抵达 DOM。两种光标移动在该剥除之前先行结算，因为它们对可见文本的作用必须先落地，之后才能丢弃表达它们的那些字符：回车把所在行归约为最后一次重绘，退格覆盖它前面的字符——于是 `abc` 后接两个退格再接 `XY` 读作 `aXY`，与终端的绘制一致。两者都按行结算，因此都不会跨越换行。
- **退出状态与复制。** 非零退出码或信号渲染一枚状态徽章，与 bash 工具自身渲染器所作的退出状态区分一致；干净退出不渲染徽章，落定后的空输出渲染一处变暗的占位文字。复制控件复制的是原始输出文本而非渲染后的树，因此提示符行与徽章不会进入剪贴板。

几何尺寸、圆角与字体沿用 `CodeBlock`，因此终端卡片与围栏代码块在视觉上一致；`white-space: pre` 加横向滚动是有意的分歧。两个组件都需要的剪贴板写入从 `CodeBlock` 中提取到包内部的 `src/clipboard.ts`，不对外导出，因此它仍是这两个块的实现细节。

### 聊天行内嵌输出推翻了一条既有约定

`chat/ToolRow.tsx` 与 `contract/tool-call-model.ts` 都断言过「绝不内嵌输出——完整结果在详情面板」。在行内显示终端块推翻了这一点，依据是 owner 的明确决定。

这次推翻成立的理由：对 shell 命令而言，输出**就是**用户要读的结果，把它专门收进面板会让最常见的情形变成两步交互。行内一个有界、限高、不换行的终端块，正是让 bash 密集的 transcript 一遍读完的条件。旧规则真正担心的是行高不受输出长度约束，而高度上限加展开控件正是防止其复现的机制。

余下的约束：行内上限为 `CHAT_TERMINAL_MAX_LINES`（8），是组件默认值的一半，而面板沿用默认值——消息流是跨多次调用阅读的摘要表面，面板才是单次调用的阅读表面。只有 terminal 意图内嵌渲染；generic 工具的内容依旧只在面板中。

这一划分的一个前提此后被削弱了：[工具行已不再是详情面板的点击目标](2026-07-28-tool-call-file-open-in-os.md)，且没有任何手势接替它，因此该面板在组装后的应用中当前不可达。于是行内上限成为读者实际拥有的唯一长输出表面，由展开控件承担。恢复面板入口属于那次改动的后续，而非本次改动——但在它落地之前，「面板仍是查看完整输出的地方」并不成立，行内的展开控件独自承担了这一职责。

## Alternatives considered

**只在详情面板渲染终端块。** 这样保留既有的「不内嵌输出」约定，也不需要记录任何推翻。已被 owner 的明确决定否决：shell 命令的输出正是用户来读的东西，把它挪到一次点击之外，代价高于该约定带来的收益。此处记录的是 owner 的裁决，而非从代码库推导出的结论。

**复用 `CodeBlock` 并传入 `console` 语言，而不新建组件。** 已否决：`CodeBlock` 会软换行，而软换行正是本次要修的缺陷，且它没有退出状态、没有 cwd 提示符行、没有高度上限、也不处理 ANSI。把四项终端专属关注点加进共享的代码围栏组件，等于把它们强加给每一个 markdown 围栏。两个组件改为共享几何与字体 token，那是唯一一处「一套实现对两者都正确」的部分。

**手写 SGR 解析器。** 已否决：SGR 解析器恰是[优先采用维护良好的依赖而非手写](../process/2026-07-26-dependencies-over-hand-rolling.md)所指明不该自持的那类实现——它的边界情形（256 色板与 truecolor 形式、`reverse`、多参数分段、未终止的序列）各自只在没人会写进测试的输出上失效，因此手写版本会在很长时间内一直微妙地出错。对照那条策略的门槛如实陈述：`anser` **并未**删除任何既有自持代码。它是一次能力增补，而那条 Agent Note 把这与净删除式的简化区分开来；它清过的是健康度与边界契合这两半门槛。`anser` 未覆盖而仍由我们手写的部分是：主题 token 的颜色映射、非 CSI 序列的剥除、回车重绘，以及供高度上限切片的逐行 span 折叠。

## Consequences

`anser` 成为 `packages/client/ui-primitives` 的一项新运行时依赖，因此该包的每个消费方都为它支付一次。Web 聊天中的 bash 行现在承载输出，相比只有摘要的行，这是有意提高的信息密度；上限是维持其有界的机制，而调紧上限是改一个 prop，不是重新设计。

`TerminalBlock` 只读取 terminal 视图携带的字段，因此它始终是渲染意图内容的纯函数——不查会话状态，与产出该视图的 presenter 一样可安全回放。不具备终端能力的 UI 仍从桥接层拿到围栏式回退；工具的结果形态未作任何改动。

在当前已交付的 wire 上，`run_code` 子派发不会得到终端卡片：`session.ts` 把 `tool/code-dispatch(-start)` 折叠为 `callView: null`／`resultView: null`，而 host 的 `viewFor` 只呈现顶层的 `tool/call`／`tool/result`，因此嵌套的 bash 调用保持通用的压平形式。两条分支都已钉住——注入视图后的解析路径，以及 wire 实际投递的无视图形态——因此这个缺口是被记录下来的，而非暗含的。把 presenter 视图贯穿 code-dispatch wire 属于那道接缝自身的改动。

内嵌渲染的许可仅授予 terminal 意图。将来想要内嵌的意图需要有自己的边界与自己的决定，且需针对此处记录的理由来论证，而不是仅针对「只在面板」这条约定本身。

## Testing

`packages/client/ui-primitives/tests/ansi.spec.ts` 固定解析层：基本色的 token 映射、无对应 token 取值的字面 rgb、带背景分段的前后景配对、每一项装饰以及其中两项之间的 `textDecoration` 冲突、OSC 串与非 CSI 转义及无显示意义控制符的剥除、逐行的回车重绘与退格覆盖（含退格停在行首、以及退格在重绘之后结算），以及 CRLF 的保留。`packages/client/ui-primitives/tests/terminal-block.spec.tsx` 固定组件：cwd 缩短、运行中／空／已落定三条分支、信号优先于退出码、末尾终止符规则、首尾高度上限及其 `aria-expanded` 开关、运行状态点全部三种可达状态及其位于提示符标签之前的位置、每条命令行一行的提示区及其位于第一行的单枚状态点，以及复制控件在剪贴板接受与拒绝两条路径上都断言原始输出，另有对 `writeClipboard` 的直接固定。

`packages/client/ui-conversation/tests/terminal-card.spec.tsx` 固定每个渲染点上的接线：`terminalCardModel` 的推导及其每一处 null 分支、结果标题替换待定标题、cwd 针对会话 workspace 解析的全部四种情形、切换选中调用时面板重置卡片展开态、对话行受展开控制的输出体与面板的全高输出体的对比、`BashRow` 的常驻卡片及其与自身摘要行状态点的一致性，以及面板 Output 区段（含 run_code 子派发与超出窗口的调用头）。该文件在没有门禁压力的情况下写成——`packages/client/ui-conversation/src/*` 位于 `vitest.config.ts` 的覆盖率 `exclude` 列表中，因此覆盖率运行不会统计其中任何文件。

`apps/web/tests/terminal-card.snapshot.ts` 在构建后的客户端产物上固定组装完整的应用：同一渲染意图在两个对话渲染点、以及两种对话行形态下的表现——因为 bash 调用只有经由带键的 `BashRow` 注册才得到常驻卡片，而其他任何声明 terminal 的工具名都落到渲染点兜底行上，其输出体受展开控制。fixture 第 65 轮改名为 `bash`、第 60 轮保留 `fx-bash`，于是一份 fixture 覆盖两种形态，并把第 60 轮的命令改为两行，使构建产物快照钉住逐行提示区及其单枚状态点（`dotsPerPromptRow: [1, 0]`）。该终端轮有意排在 todo 轮**之前**：站立计划会在下一次 `turn/start` 时退役，若追加在其后就会让 dock 的计划条变空，并连带毁掉 todo 表面自身的覆盖；该轮还承载第 60 轮三行干净输出无法覆盖的部分——解析到 `--dsw-*` token 的 SGR 分段、超出对话上限的输出、嵌套 cwd，以及从末尾标记还原出的非零退出码。

`apps/web/tests/navigation-panes.e2e.ts` 在其既有的 `echo NAVIGATION_OK` bash 调用上新增真实浏览器场景，断言 jsdom 无法计算的部分：把输出面板挤压到窄于内容宽度后，行仍保持单行且面板产生横向溢出；运行状态点解析为绿色的 success token，而不是字面颜色（没有真实主题样式表时，`--dsw-*` 变量根本不产生计算值），且其起点位于卡片表面本身的左侧；复制控件走的是页面自身的异步 Clipboard API，而非 `execCommand` 兜底路径。其 `terminal-card.expected.md` 基准记录了提示行中已解析的 workspace——这正是不带 `workdir` 的 bash 调用应当显示的内容，而非一个裸 `$`。

## Related

- [Tagged render-intent union for tool-call presentation](../architecture/2026-07-02-tool-render-intent-union.md)——本次消费的 `card` 标签词汇；Web client 现在是 `terminal` 分支的完整消费方，而不再只消费参数。
- [Web client syntax highlighting](../process/2026-07-26-web-syntax-highlighting-shiki.md)——它拥有 `CodeBlock` 及其 shiki 分支，并记录了工具输出为何有意不做语法高亮；这里的 ANSI 颜色是作者指定的颜色，不是猜出来的语法。
- [Web client architecture](../architecture/2026-07-19-gui-web-client-architecture.md)——两个渲染点所处的 slot 与快照分层。
