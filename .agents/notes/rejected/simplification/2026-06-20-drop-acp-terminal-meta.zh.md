# Agent Note: 移除 ACP（Agent Client Protocol）终端 `_meta` 渲染

Status: rejected — 在 ACP 仍是编辑器桥接层时，仅移除 Zed 终端元数据的方案被否决；后续仅面向自动化的 ACP 则移除了整个编辑器投影。

[English](2026-06-20-drop-acp-terminal-meta.md) | 中文

## 问题

原 ACP 编辑器桥接层通过 `_meta.terminal_info`、`_meta.terminal_output` 和 `_meta.terminal_exit` 实现了一套 Zed 特有的终端卡片约定。当前的 [render-intent 决策](../../implemented/architecture/2026-07-02-tool-render-intent-union.md)保留了底层规则：bash 执行属于 harness，terminal 卡片只用于展示。后续的[仅面向自动化 ACP 决策](../../implemented/simplification/2026-07-23-acp-automation-only-protocol.md)从 ACP 中移除了 `_meta` 投影、桥接状态、能力协商、终端 id、特殊 update 映射、文本回退测试和 exit-pill 解析。TUI 与 Web 宿主/客户端运行时保留带标签的展示契约，而 ACP 不再渲染编辑器卡片。

本提案提出时，回退路径已经存在：将工具调用和完成输出渲染为普通 ACP 内容块。当时，非 Zed 客户端依赖这条路径，但 Zed 终端卡片是目标客户端的功能特性，而非推测性装饰。

## 提案

忽略 `clientCapabilities._meta.terminal_output`，通过纯 ACP 内容路径渲染 bash 结果。执行仍由 agent 侧的 `dsh-bash` 完成；仅移除展示相关的终端元数据。如果 ACP 日后标准化了 agent 执行的终端，或产品决定 Zed 特有展示值得其维护成本，终端卡片可以再回来。

本提案比[收拢工具自有 UI 展示](2026-06-20-generic-tool-rendering.md)更窄：如果通用的 `presentCall`/`presentResult` 保留，本提案不影响它们，只移除终端子形态与 `_meta` 映射。

## 验收标准

- ACP 不再读取或存储 `_meta.terminal_output` 能力状态。
- `TerminalRendering`、终端 id、终端 cwd 解析与 `_meta.terminal_*` update 映射从 `@deepseek-ai/dsh-acp` 中消失。
- `ToolTerminal` 从 `@deepseek-ai/dsh-tools` 中消失，或在展示清理中因未使用而删除。
- Bash 结果展示不再为终端 pill 解析退出状态。
- [仅面向自动化 ACP 决策](../../implemented/simplification/2026-07-23-acp-automation-only-protocol.md)后来移除了 ACP 终端卡片，并吸收了其中有关执行归属的决策依据。

## 放弃的内容

如果采用本提案，Zed 用户会失去专用终端卡片：没有 cwd 头部、终端展示或 exit pill。但他们仍会以纯内容形式看到命令和输出。当时 ACP 桥接层尚未发布，且 `_meta` 键只是约定而非标准；在这种情况下，考虑这项简化是合理的。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
