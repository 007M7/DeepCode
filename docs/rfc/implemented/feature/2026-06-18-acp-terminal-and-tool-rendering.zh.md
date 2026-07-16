# RFC：丰富的 ACP bash 渲染——通过 `_meta` 约定实现终端卡片

Status: implemented

[English](2026-06-18-acp-terminal-and-tool-rendering.md) | 中文

## 问题

ACP 桥接层允许每个工具通过 `presentCall`/`presentResult` 自行控制调用渲染（见[工具调用 UI 展示](../../implemented/feature/2026-06-14-acp-agent-client-protocol.md)与 `packages/core/tools`）。对于 `bash`，我们将确切命令作为 `tool_call` 标题呈现，模型的 `description` 作为内容文本块，`kind: 'execute'`，完成后的输出包裹在 ` ```console ` 围栏文本块中。

参考编辑器将终端元数据渲染为一张专用卡片，包含 cwd、命令、实时风格输出和退出状态；纯文本丢失了这些结构。命令之所以作为标题，是因为执行卡片隐藏了原始输入，而人类可读的描述保留为卡片上方的独立块。

## 关键发现：agent 执行的终端使用 `_meta` 约定，而非 `terminal/create`

ACP 规范有一个*客户端侧*终端子协议：agent 调用客户端的 `terminal/create`，传入 `{ command, args, cwd, env }`，由**编辑器**执行进程，然后 agent 读取 `terminal/output` / `wait_for_exit`。这个模型不适合我们：我们的 harness 通过 `dsh-bash` 自行执行 bash（沙箱化的环境变量清洗、后台任务所有权、按会话的 cwd）。把执行路由到编辑器会绕过所有这些机制，并将执行分裂为两个后端。

研究两个参考 agent（2026-06-18）发现，二者都没有为自己的 shell 工具使用 `terminal/create`——**两者都保持 agent 侧执行，并发出一套 `_meta` 约定**，由 Zed 特殊处理：

- **`claude-agent-acp`**（`tools.ts`、`acp-agent.ts`）：以 `clientCapabilities._meta.terminal_output` 为门控。`tool_call` 携带 `content: [{ type: 'terminal', terminalId }]` 和 `_meta.terminal_info.{ terminal_id, cwd }`；输出/退出通过 `tool_call_update` 的 `_meta.terminal_output.{ terminal_id, data }` 和 `_meta.terminal_exit.{ terminal_id, exit_code, signal }` 到达。
- **`codex-acp`**（`CodexToolCallMapper.ts`、`TerminalOutputMode.ts`）：调用上同样携带 `terminal_info`；输出通过 `_meta.terminal_output`（完整）或 `_meta.terminal_output_delta`（增量）发送，由同一个 `_meta.terminal_output` 能力选择。

Zed 侧（`crates/agent_servers/src/acp.rs`，已验证）：收到 `ToolCall` 且其 `_meta.terminal_info.terminal_id` 已设置时，注册一个**仅展示**的终端（header = `terminal_info.cwd`，label = `tool_call.title`）；收到 `ToolCallUpdate` 时，`_meta.terminal_output.data` 写入该终端，`_meta.terminal_exit.{exit_code,signal}` 设置状态。它将能力声明为 `clientCapabilities._meta.terminal_output = true`。`_meta` 本身是 ACP 规范认可的扩展点（在 `ToolCall`/`ToolCallUpdate` 上类型为 `{[k]: unknown} | null`）；这里的*具体键*（`terminal_info`/`terminal_output`/`terminal_exit`）是 Zed 约定，不属于 ACP 规范——但它们是 Zed 集成的事实契约，也是在保持 agent 侧执行的前提下获得终端卡片的唯一途径。

## 决策

保持 `dsh-bash` 的 agent 侧执行；通过 `_meta` 约定渲染终端卡片，以能力声明为门控，以 ` ```console ` 文本块作为保底回退。

1. **能力声明。** `initialize` 读取 `clientCapabilities._meta.terminal_output`，桥接层按连接记住它。
2. **提供方无关的展示词汇。** `dsh-tools` 新增一种终端形态的展示结构，工具可以返回它——提供方无关（`cwd`、输出 `data`、`exitCode`/`signal`），不含 ACP 类型。`dsh-tool-bash` 为 `bash` 返回该结构（cwd 来自解析后的工作目录；输出 + 退出从运行结果解析）。
3. **桥接映射。** 当客户端声明了该能力时，桥接层将展示结构映射为：在 `tool_call` 上，`content:[…, {type:'terminal', terminalId}]`（工具的任何 `content`，如描述，渲染在终端块之前）+ `_meta.terminal_info.{terminal_id,cwd}`；在 `tool_call_update` 上，`_meta.terminal_output.{terminal_id,data}`（捕获的输出）+ `_meta.terminal_exit.{terminal_id, exit_code|signal}`（解析的退出），且 update 的文本 `content` 被省略（ACP 的 `tool_call_update.content` 会**替换**调用的 content 集合，因此重发围栏块会覆盖终端内容块）。`terminalId` 由 harness 的 `callId` 派生（稳定、每次调用唯一）。当能力未声明时，桥接层在调用上发送描述内容块，在 update 上发送既有的 ` ```console ` 文本内容——行为不变。
4. **退出标记从渲染输出中解析；无新执行路径，无实时流式传输。** 输出在完成时附加（来自 agent 自身的 `tool/result`），不逐 token 流式传输。退出状态标记（`_meta.terminal_exit.{exit_code,signal}`）会被发出：纯 `presentResult(args, result)` seam 只能看到内容块，因此 `dsh-tool-bash` 通过解析 `renderResult` 追加的状态标记（`[exit code: N]` / `[killed by signal: …]`）来恢复结构化退出——解析是标记发出的精确逆操作，二者在同一文件中共同演进，一个往返测试守护这对关系。dispose 不受影响：没有新资源需要清理，因为桥接层从未创建客户端侧终端。

## 曾考虑的替代方案

- **ACP 客户端侧终端子协议（`terminal/create`）**：明确否决。编辑器将执行进程，绕过 `dsh-bash` 的环境变量清洗、后台任务所有权和按会话的 cwd，并将执行分裂为两个后端。两个参考 agent 以同样的方式否决了它（见上述关键发现）；agent 侧执行加 `_meta` 约定是在保持 harness 执行策略的同时获得终端卡片的唯一形态。
- **通过事件 schema 透传结构化退出**：否决，改用标记往返方案。纯 `presentResult(args, result)` seam 只能看到内容块，而解析是标记发出的精确逆操作，在同一文件中共同演进并由往返测试守护。

## 后果

- **Zed 约定的 `_meta` 键。** 终端卡片依赖 Zed 特有的键（`terminal_info`/`terminal_output`/`terminal_exit`），位于 ACP 规范认可的 `_meta` 扩展点内，而非 ACP 终端子协议。不识别这些键的客户端仍然获得文本回退（能力门控确保我们只在客户端通过 `_meta.terminal_output` 声明支持时才发出这些键），因此非 Zed 客户端永远不会变差。如果 ACP 日后标准化了 agent 执行的终端，迁移到该标准并移除约定键。
- **能力诚实。** 仅在客户端声明了 `_meta.terminal_output` 时才发出终端元数据；文本回退是对所有其他客户端的契约，绝不能退化。由一个无能力测试覆盖，断言 ` ```console ` 路径。
- **terminalId 冲突。** 从每次调用的 `callId` 派生，保证在会话内唯一且在 call/result 对之间稳定；绝不跨调用复用。
- **退出从渲染文本中解析。** 退出标记通过解析 `renderResult` 的状态标记来恢复 `exit_code`/`signal`，而非通过事件 schema 透传结构化退出（纯 `presentResult` seam 看不到结构化退出）。解析是标记发出的精确逆操作，位于同一文件中；一个往返测试固定了这对关系，标记格式的变更如果破坏了解析就会使测试套件失败。如果标记将来需要与退出标记的需求分歧，改为在 result 事件上暴露结构化退出。
- **提供方无关词汇的蔓延。** 终端展示结构扩大了 `dsh-tools` 的接口面；保持其中立性（不让 ACP 类型泄漏到 `dsh-tools`），且只提供第二个 UI 消费方也会需要的丰富度。

## 不在范围内 / 非目标

文本块基线仍是无能力声明时的默认行为。两个后续工作有意不在此处构建，各自需要独立 RFC：**实时增量流式传输**（`_meta.terminal_output_delta`，在分片到达时发送，需要 `dsh-bash` 上的增量输出 seam），以及**命令分类**（将 `cat`/`sed` 解析为带文件位置的 `read` 卡片、将 `grep` 解析为 `search` 等，回退到终端卡片——仅展示，绝不改变实际执行的内容）。
