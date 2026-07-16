# RFC：dsh-hooks-claude + dsh-hooks-codex——Claude Code / Codex 钩子桥接插件

Status: implemented

[English](2026-06-30-hook-bridges.md) | 中文

## 问题

harness 的扩展面是其类型化的拦截 seam（见[拦截 seam RFC](2026-06-30-interception-seams.md)）：所谓「原生钩子」不过是一个普通的 Cordis 插件，订阅 `agent/session-start`、`agent/prompt-submit`、`tools/pre-execute`、`tools/post-execute`、`agent/turn-continuation`、`subagent/start`、`subagent/end`。但用户带着**已有的** Claude Code（CC）和 Codex 钩子配置到来——一个 `hooks.json`（或设置文件中的 `hooks` 键）里满是 shell 命令钩子——并且希望它们原样运行。本 RFC 引入两个**桥接插件**，将外部 shell 钩子协议翻译到类型化 seam 上，基于共享的协议格式（wire format）库（见 [hook-protocol-lib RFC](2026-06-30-hook-protocol-lib.md)）构建。

贯穿整个设计的定位是：**桥接是兼容性适配器，不是高级工具。**桥接能做的事（阻止工具、注入上下文、强制继续、观察 subagent），原生 Cordis 插件都能更强力地完成——有类型化返回值、完整的 `ctx`、无序列化边界。桥接存在的理由是运行外部 CC/Codex 命令钩子中被明确支持的子集。这使每个桥接保持精简：解析配置、选择匹配模式、构建每事件的 payload、调用共享库的 `runHook` + `mergeHookOutputs`，再将中性结果映射到 seam 的 Decision。各 package 的 README 记录了当前相对官方协议的不支持事件与部分字段清单。

## 决策

`packages/hooks/` 分组下两个独立插件，各自为函数/命名空间插件（`name`/`inject`/`Config`/`apply`，无 default export——见 [postmortem 0001](../../../postmortem/0001-acp-default-export-drops-inject.md)），仅注入 `bash`：

- **`dsh-hooks-claude`**——CC 方言。Claude Code 当前钩子点中的七个：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`SubagentStart` 和 `SubagentStop`。拥有 CC 形状的每事件 stdin payload（基础字段为 `session_id`/`cwd`/`hook_event_name`，加上每事件特有字段）、`CLAUDE_PROJECT_DIR` 环境变量加 `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PROJECT_DIR}` 替换，以及字面量或正则匹配模式。CC 钩子的 stdin 带有**尾随换行**。
- **`dsh-hooks-codex`**——Codex 当前钩子点中的五个：`PreToolUse`、`PostToolUse`、`SessionStart`、`UserPromptSubmit` 和 `Stop`。使用始终为正则的匹配模式、Codex 形状的 snake_case payload（带 `turn_id`/`model`/`permission_mode` 额外字段），写入时**不带**尾随换行，不注入 Codex 插件环境变量，不做配置时占位符替换，也没有 pre-tool 审批或重写路径。工具调用的 payload 在桥接的精简 `tool_input: { command }` 形状中携带真实的 `tool_name`。

### 结果 → Decision 映射

每个桥接将共享库返回的中性 `MergedHookOutcome` 映射到 seam 的类型化 Decision：

| Seam | CC | Codex |
|---|---|---|
| `agent/session-start`（emit） | additionalContext → `agent.inject()` | plain-stdout 输出 → additionalContext → `agent.inject()` |
| `agent/prompt-submit` | `deny`→`block`；仅上下文→delegate+fold | `block`→`block`；仅上下文→delegate+fold |
| `tools/pre-execute` | `deny`→`deny`；`ask`→`ask` | `block`→`deny`（无 allow/ask） |
| `tools/post-execute` | `deny`→`block`+feedback；仅上下文→delegate+fold | 同上 |
| `agent/turn-continuation` | 阻塞式 Stop → `continue`（reason = 下一步 steering（中途引导）） | 同上 |
| `subagent/start`（emit） | additionalContext → 注入进程内活跃子 agent；远程子 agent 没有本地注入目标 | 本桥接不支持 |
| `subagent/end`（emit） | 仅观察 | 本桥接不支持 |

CC 桥接的 `ask` 结果是一条真正的权限路径，而非桥接的终态决策：`dsh-tools` 通过可选的[审批 seam](2026-07-06-approval-seam.md) 解析它。组合式 ACP 应答器会向拥有者编辑器会话发起提示，`allowed-once` 后继续执行；如果没有 ApprovalService 或应答器，调用以 `deny` 关闭。

### 上下文来源始终是插件（错标防护）

`agent.inject()` 在缺少 `MessageSource` 时默认为 `{ kind: 'user' }`，因此每个桥接的 `inject()` 和 `HookContext` 都传入 `{ kind: 'plugin', plugin: 'hooks-claude' | 'hooks-codex' }`。单元测试覆盖率固定了最终 `context/message.source` 为插件而非用户。

### 添加上下文不是否决——先 delegate，再 fold

仅含上下文的钩子必须调用 `next()` 然后将其 `additionalContext` 折入下游决策；直接返回 allow 或 accept 会绕过后续策略监听器。Post-tool 的 block 和 accept 决策都保留已添加的上下文。Prompt allow 保留上下文，而 prompt block 丢弃上下文，因为提示词从未到达模型。只有显式的钩子 denial 或 block 才会短路 waterfall（瀑布式事件）。

### CLAUDE_PROJECT_DIR 默认为会话工作区

Claude Code 始终导出 `CLAUDE_PROJECT_DIR`，常见的未修改钩子引用 `$CLAUDE_PROJECT_DIR` 来构造项目相对路径。显式的 `config.projectDir` 优先；当它被省略时（默认的 ACP 接线只配置 `configPath`），桥接将该环境变量按每次运行默认为 agent 的会话工作区——即钩子已经运行其中的 `session.header.cwd`——而不是留空。因此一个标准的项目相对钩子在默认配置下即可工作。

### 隔离

配置在加载时一次性解析；读取/解析失败时记录日志并不注册任何内容，而非崩溃启动（一个拼错的路径不得拖垮 agent）。CC 只运行 shell 形式的 `type: 'command'` 钩子；`http`、`mcp_tool`、`prompt` 和 `agent` 处理器被解析后跳过。Codex 只运行同步命令处理器，跳过 `async: true` 或非命令条目。emit 监听路径（`session-start`、`subagent/start`）以 detached 方式运行，其 `inject` 包裹在 `.catch` 中记录日志（抛异常的 inject 不得中断会话启动或循环）。

### 钩子的运行位置与配置来源

钩子在 agent 的会话工作区中运行，因此相对路径指向用户的项目。`configPath` 相对于进程启动 cwd 解析一次，适用于所有会话。按会话的项目本地发现仍推迟在 `TODO(per-session-hook-config)` 下。

## 推迟的兼容性缺口

- **工具输入重写。** CC/Codex 的 `updatedInput` 被记录日志并发出警告，但不生效——输入重写是一个推迟的一致性设计问题（见 [pre-tool-input-rewrite RFC](../../proposed/feature/2026-06-30-pre-tool-input-rewrite.md)），因为预执行参数被 `tool/call` 审计、`assistant/message` 历史和 ACP/tool-bash 展示共同读取，诚实的重写是一个设计单元，而非一个字段。
- **Stop 循环防护**（`TODO(stop-loop-guard)`）。Claude Code 提供 `stop_hook_active` 并在连续八次阻塞后覆盖钩子；Codex 提供 `stop_hook_active` 但文档中没有等效上限。两个桥接始终报告 `false`，因此一个无条件阻塞的 Stop 钩子会在每一步强制继续——钩子作者必须自行限制，直到状态追踪落地。
- **钩子 `continue:false`（硬停止）。** 钩子可以请求终止整个运行（CC/Codex `continue:false`）；共享 merge 将其折入 `MergedHookOutcome.stop`/`stopReason`，但没有桥接对其采取行动（`TODO(hook-continue-false)`）——拦截 seam 尚无「硬停止 agent」原语（Decision 阻塞/引导的是单个点，而非整个运行）。与循环防护工作一起推迟；停止请求记录在 `hook/result` 日志中，钩子在此期间保留其逐点效果（decision/上下文）。
- **配置发现。** 路径在 `cordis.yml` 中显式指定且为进程级（见上文）；完整的多层 CC/Codex 优先级遍历、按会话的项目本地发现以及信任/hash 模型均未重新实现（`TODO(per-session-hook-config)`）。
- **Session-start / subagent-start 上下文为尽力而为（`TODO(session-start-gating)`）。** 两个钩子以 detached 方式运行于启动之外，因此其上下文在就绪时注入，但可能错过第一个请求或短命子 agent。保证首请求送达需要一个 awaited 的启动 seam。

## 曾考虑的替代方案

**同一点的钩子并发执行。** 参考引擎对同一点匹配到的钩子并发运行并折叠结果。本桥接**串行**运行它们（匹配循环内逐钩子 `await`），并以相同的最严格合并策略折叠。串行是刻意的：它使每个钩子的 `hook/invoked`/`hook/result` 对在会话日志中相邻且顺序确定，而折叠对决策是顺序无关的（`deny > ask > allow`），因此结果一致。代价是延迟（钩子 *N* 等待钩子 *N−1*）且逐钩子超时不重叠——对真实配置使用的钩子数量而言可接受；如果某天配置扇出到足以影响挂钟时间，再重新审视。

## 后果

匹配语义、退出码处理与合并优先级位于 `dsh-hook-protocol`；每个桥接只负责解析配置、构建方言 payload 和映射结果。逐文件覆盖率包含配置分支加上通过真实循环、`dsh-bash-local` 和 shell 脚本的端到端映射，同时一个真实 Loader 冒烟测试守护 package 的导出形状。原生插件绕过协议格式，直接返回类型化决策。
