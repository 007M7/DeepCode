# RFC：用于工具调用展示的标签化 render-intent 联合类型

Status: implemented

[English](2026-07-02-tool-render-intent-union.md) | 中文

## 问题

工具通过 `ToolDefinition` 上的两个回调 `presentCall`/`presentResult` 声明其调用在 UI（编辑器的工具调用卡片）中的渲染方式，返回 `ToolCallPresentation` / `ToolResultPresentation`，并带有可选的 `ToolTerminal` 子结构。这些类型在增量演进中变成了一个**可选字段的大杂烩**：调用侧有 `title`、`kind`、`rawInput`、`content`、`locations`、`terminal`；结果侧有 `title`、`content`、`terminal`；`ToolTerminal` 上有 `cwd`/`output`/`exitCode`/`signal`。职责划分含混不清：

- 调用侧和结果侧的 `terminal` 字段重叠，bridge 需要将一个 `content` 块、一个 `terminal` 块和 `rawInput` 按调用拼接在一起，靠临时条件逻辑缝合。
- 哪些组合是*合法的*没有文档：一个设置了 `terminal` 的调用如果同时设置了 `content`，含义是「卡片上方的描述」；一个 generic 调用如果设置了 `terminal`，毫无意义但类型允许。类型允许无意义的状态。
- 无法表达编辑器最需要的文件工具能力：**diff 卡片**（`{path, oldText, newText}`，Zed 将其渲染为内联 diff / 新文件预览）。`ToolCallPresentation.content` 是 *LLM* 的 `ContentBlock[]` 词汇（text/image），工具字面上无法请求一个 diff。

`packages/core/tools/src/index.ts` 中现有的 `FIXME(tool-presentation)` 指明了修复方向：「重新设计类型，让工具一次性声明其渲染意图（例如按卡片种类的标签联合类型），而不是一堆可选字段由 bridge 拼接。」被否决的 RFC [Collapse tool-owned UI presentation](../../rejected/simplification/2026-06-20-generic-tool-rendering.md) 明确推迟了此事：富渲染「应当在至少有两个真实工具和两个真实消费方来验证词汇之后，以标签化 render-intent 联合类型的形式回归」。这个门槛现已达到：两个生产方族（`dsh-tool-bash`、`dsh-tool-fs`）和两个消费方（ACP bridge 实时路径 + snapshot-golden 回放路径）。

## 决策

用一个**以 `card` 为标签的可辨识联合类型**替代可选字段大杂烩。工具为每次调用/结果声明一个渲染意图；bridge 按标签分发。

```ts ignore-check
type FileLocation = { path: string; line?: number }
type FileDiff = { path: string; oldText: string | null; newText: string } // oldText null ⇒ new file

// presentCall → ToolCallView
type ToolCallView = GenericCallView | TerminalCallView | DiffCallView
interface GenericCallView { card: 'generic'; title: string; kind?: ToolCallKind; rawInput?: unknown; content?: ContentBlock[]; locations?: FileLocation[] }
interface TerminalCallView { card: 'terminal'; title: string; description?: string; cwd?: string }
interface DiffCallView { card: 'diff'; title: string; diffs: FileDiff[]; locations?: FileLocation[] }

// presentResult → ToolResultView
type ToolResultView = GenericResultView | TerminalResultView
interface GenericResultView { card: 'generic'; title?: string; content?: ContentBlock[] }
interface TerminalResultView { card: 'terminal'; title?: string; output?: string; exitCode?: number; signal?: string }
```

`card` 在每个变体上都是**必填**的：一个真正的判别字段，而非可选默认值。bridge 执行 `switch (view.card) { case 'generic': … case 'terminal': … case 'diff': … default: assertNever(view) }`。该联合类型是**封闭的**（遵循 [switch 穷举约定](../../../../AGENTS.md)）：第四种渲染意图（表格、图表）无论如何都需要新的 bridge 代码来渲染，因此一个插件添加的变体如果被 bridge 静默丢弃，比编译错误更糟。添加变体会在 bridge 的 switch 处中断编译——这正是我们想要的信号。

### 为什么标签联合类型优于字段大杂烩

- **无效状态变得不可表示。** generic 卡片不能携带终端输出；terminal 卡片不能携带 diff。旧的大杂烩允许所有这些组合。
- **bridge 按分支分发，而非拼接。** 每种卡片一个分支，各自精确产出该卡片所需的协议格式（wire format），而非协调五个交互关系未文档化的可选字段。
- **`diff` 成为一等意图。** `dsh-tool-fs` 的 write/edit 声明 `card:'diff'`；bridge 发出 ACP `{type:'diff', path, oldText, newText}` `ToolCallContent`（已存在于 SDK 的 `ToolCallContent` 联合类型中，此前 bridge 未使用）。这是本次重设计解锁的能力。

### 生产方映射

- `dsh-tool-fs` read → `generic`（`kind:'read'`，附带一个 follow-along `location`）；write → `diff`（`oldText:null`）；edit → `diff`（`oldText:old_string || null`，`newText:new_string ?? ''`）。这与 `claude-agent-acp` 的 `toolInfoFromToolUse` Read/Write/Edit 分支逐字段对应。
- `dsh-tool-bash` foreground → `terminal` 调用 + `terminal` 结果；`run_in_background` 和 `bash_output`/`bash_kill` → `generic`。
- `dsh-tool-todo` → `generic`。

### 终端回退的归属

`TerminalResultView` 只携带 `output`/`exitCode`/`signal`。不具备终端能力的 UI 需要一个围栏 ` ```console ` 文本回退；该推导移至 **bridge**（bridge 在无能力路径上将 `output` 包裹为围栏代码块），而非由工具双重编码。这使 bash 工具的结果保持单一结构化形状，并逐字节保留既有的 capability 门控行为。

### 纯函数性保持不变

`presentCall`/`presentResult` 仍然是 `args`（以及 `presentResult` 的 result）的纯函数——它们在实时流式输出和会话日志回放中都会运行，因此必须具备回放确定性。每个 view 仅从 args 推导：write 的 diff 是新文件样式（`oldText:null`），因为工具在调用时没有旧内容；edit 的 diff 是 `old_string`→`new_string`。

## 相对路径显示标题

`claude-agent-acp` 将文件卡片的标题路径相对于会话 cwd 做相对化处理（`toDisplayPath`）：显示 `Read src/foo.ts` 而非 `/abs/proj/src/foo.ts`，同时保持 `locations[]`/`diff.path` **原始**（编辑器打开真实路径）。我们的 `presentCall` 是纯函数/仅依赖 args，无法看到会话 cwd，因此相对化发生在 **bridge**——bridge 已经将会话 cwd 传入工具调用渲染（与它用于解析 terminal 卡片标题的 cwd 相同）。bridge 仅对标题做相对化，通过对已知 `locations[0].path`/`diffs[0].path` 子串的精确结构化替换实现——对文件卡片类型通用，从不特判工具名。

## 曾考虑的替代方案

- **完全删除工具自有的展示**：即[被否决的 collapse 提案](../../rejected/simplification/2026-06-20-generic-tool-rendering.md)；其结论明确推迟到两个真实工具和两个真实消费方存在后再做这个联合类型，而该门槛现已达到。
- **可合并扩展的联合类型**（`ContentBlockMap` 模式）：否决。新的渲染意图无论如何都需要新的 bridge 代码来渲染，因此一个插件添加的变体如果被 bridge 静默丢弃，比封闭联合类型在 bridge 的 `assertNever` switch 处引发的编译错误更糟。
- **保留可选字段大杂烩**：即「问题」一节所剖析的现状：无效状态可表示、字段交互未文档化、且完全无法请求 diff 卡片。

## 后果

新的渲染意图是 bridge switch 处的编译中断变更——这是有意为之：渲染代码必须在卡片种类存在之前就位。无效的卡片/字段组合现已不可表示，bash 回退推导归 bridge 所有，工具只返回一个结构化形状。第四种卡片（表格、图表）的门槛是在同一个变更中编写其 bridge 分支。

## 非目标

- **实时增量 `terminal_output_delta` 流式输出**与**命令分类**：终端渲染 RFC 自身推迟的后续工作，本 RFC 不涉及。

## 相关

- 取代 [Collapse tool-owned UI presentation](../../rejected/simplification/2026-06-20-generic-tool-rendering.md)（已否决——「等两个真实工具和两个真实消费方，然后做标签化 render-intent 联合类型」）中的推迟决定。该门槛现已达到；本 RFC 即是那个联合类型。
- 由 [Result-time applied-hunk diffs](2026-07-02-result-time-applied-hunk-diffs.md) 扩展：该 RFC 增加了一个持久化的 `meta` 通道，使 write/edit 在结果时发出 `DiffResultView`（应用后的变更：带上下文行的 contextual hunk / 每个 `replace_all` 站点一个，或新建文件的整文件 diff），叠加在本联合类型的调用时 diff 卡片之上。
- 将 `ToolTerminal` 折入 [ACP terminal and tool-call rendering](../feature/2026-06-18-acp-terminal-and-tool-rendering.md) 所描述的 `terminal` view（`_meta` terminal 卡片约定和 capability 门控不变；仅 harness 侧的展示类型改变）。
- ACP SDK 的 `Diff` / `ToolCallContent` 类型支撑新的 `diff` 卡片。
