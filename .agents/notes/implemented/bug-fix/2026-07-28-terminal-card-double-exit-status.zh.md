# Agent Note: terminal 卡片把非零退出状态报告了两次

Status: implemented

[English](2026-07-28-terminal-card-double-exit-status.md) | 中文

## Problem

失败的 `bash` 调用会把退出状态渲染两次：

```
● Tool / bash / Check merge lock and flock availability
$ … ; grep -n "merge.lock" .gitignore
/opt/homebrew/bin/flock
[exit code: 1]
[exit 1]
```

`renderResult` 会把 `[exit code: N]` 追加到面向模型的文本上，因为模型读到的是单个字符串，必须能看到退出状态。而 `presentBashResult` 随后把同一个字符串原样作为 terminal 卡片的 `output` 返回，同时又把该标记解析进 `exitCode`，TUI 则在 `output` 之后再渲染自己的暗色 `[exit N]` 徽标。于是每一次非零退出、每一次信号终止都会同时打印两种形式。

两个产出方各自都没有错：`TerminalResultView` 明确约定 `output` 是捕获的命令输出，`exitCode`/`signal` 是独立的结构化字段，正是为了让有能力的 UI 能显示徽标。缺陷在于 `presentBashResult` 把已被消费的标记同时放进了两个位置。TUI 自己的快照 fixture（测试前置数据）掩盖了它：手工构造的卡片 fixture 提供的 `output` 不含标记，而唯一真实录制的 bash 流程（`bash-terminal-card`）执行 `echo TERMINAL_OK`，退出码为 0，因此根本不会发出标记。

## Decision

`parseExitStatus` 现在返回 `{ body, …exit }`：它在自己锚定的标记处切分渲染后的文本，于是调用方拿到的输出正文不再包含它消费掉的那行状态。`presentBashResult` 把该正文作为卡片的 `output` 传出。只有退出／信号标记会离开输出；`[output truncated: …]`、`[timed out after Nms]` 以及沙箱拒绝与升权提示行仍留在正文中，因为它们携带的事实是退出徽标无法体现的。

切分逻辑放在 `render.ts` 中、紧邻它所反演的标记发出处。发出、解析与剥除本就必须在同一个文件里协同演进，一个往返测试把这三者钉在一起。

## Alternatives considered

- **在 TUI 中去掉 `[exit N]` 徽标。** 已否决：该徽标是可快速扫读的状态，其样式与位置独立于命令输出，而且对于由 `bash` 之外的工具产出的 `TerminalResultView`，它是卡片能拿到的唯一退出信号。
- **在 TUI 渲染器中剥除该标记。** 已否决：渲染器将不得不知晓 `dsh-tool-bash` 的标记词汇，而剥除应当与已经消费它的那次解析放在一起。工具的渲染意图应由工具自己定义。
- **不再从 `renderResult` 发出该标记。** 已否决：在单个文本结果中，该标记是模型唯一的退出信号，而且 `tool:bash` 提示词章节会教模型去检查它。
- **让 `execute` 在文本之外一并返回结构化的退出状态。** 已否决：`presentResult(args, result)` 刻意设计为对内容块的纯函数，从而可以从会话日志回放，而日志只保留渲染后的文本。

## Consequences

卡片正文不再以标记结尾，因此从日志回放的会话与实时运行渲染出同样的单个徽标。既有的仅影响展示的残留问题现在稍微扩大，并已记录在包（package）的 README 中：如果输出的最后一行恰好正是 `[exit code: N]` 或 `[killed by signal: …]`，它会被读成标记，既显示错误的徽标，也会把该行从卡片正文中丢掉。

[工具卡片标题 note](../feature/2026-07-27-tui-tool-card-header.md) 中的刻意处理保持不变：terminal 的退出状态仍沿用既有的暗色 `[exit N]` 行，而不是并入统一的页脚。

## Testing

`tools.spec.ts` 针对非零退出、信号终止与正常运行三种情形钉住不含标记的正文；断言超时标记会与被剥除的退出标记并存；并扩展 `renderResult`/`parseExitStatus` 往返测试，断言正文中不再残留被消费的标记。

该缺陷对所有既有快照都不可见，因此 `tui-keyless-smoke.e2e.ts` 新增了一个真实 PTY 场景：脚本化适配器以 `printf …; exit 3` 调用真实的 `bash` 工具，测试断言终端输出包含该命令的 stdout 与 `[exit 3]`，但绝不出现 `[exit code: 3]`。若回退 presenter 的修复，它能复现重复渲染。
