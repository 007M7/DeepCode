# RFC：重复工具调用守卫插件

Status: implemented

[English](2026-07-08-repeat-tool-guard.md) | 中文

## 问题

模型陷入循环时会反复发出参数逐字节相同的工具调用——重新运行一个失败的 grep、重新读取一个未变化的文件、轮询一个已经给出答案的命令——每一轮往返都消耗 token、挂钟时间和（对付费 API 而言）金钱，却不带来新信息。harness 目前没有任何机制能察觉这一点：循环没有步骤预算，没有插件追踪调用重复，模型只有在碰巧自行改变行为时才能脱困。这种失败模式真实存在且易于检测——[pi-repeat-tool-guard](https://github.com/Kingwl/pi-repeat-tool-guard) 正是将此作为 pi coding-agent 扩展发布的：统计连续相同调用次数，超过阈值后追加一条 `<system-reminder>` 告知模型停止重复、改变策略。

harness 已经具备 pi 扩展所用的全部 seam，且更好：[拦截 seam RFC](2026-06-30-interception-seams.md) 赋予 `tools/post-execute` 一种正式途径，可以在已完成的调用上附加面向模型的上下文；循环缓冲并注入该上下文，保持调用/结果的邻接关系；注入的上下文是一条已记录的 `context/message`——因此原生守卫无需新增会话事件即可满足「模型可见 ⟺ 已记录」规则。缺的只是插件本身。

## 决策

守卫是一个循环卫生插件，而非面向模型的工具。它统计对同一工具以相同规范化参数发起的连续调用次数，并在配置的阈值处注入建议性提醒。它从不延迟、阻塞或改写调用；模型自行决定是否换一种方式重试或结束。

该插件为 `@deepseek-ai/dsh-repeat-tool-guard`，位于 `packages/guard/repeat-tool-guard/`，开辟 `guard/` 分组用于循环卫生插件（单包分组有先例：[todo-write RFC](2026-06-29-todo-write-tool.md) 发布了 `todo/tool-todo`）。它注册三个监听器，所有状态保存在以 `AgentId` 为键的插件局部 map 中——工具注册表是 context 级别的单例，其 waterfall（瀑布式事件）交错所有 agent 的调用（subagent 运行在同一 context 上），因此按 agent 分键是正确性要求，而非锦上添花。

- **`tools/post-execute`（waterfall）**——唯一的检测点。监听器同时接收 `(exec, result)`，因此计数和提醒投递无需跨事件的 pending map（pi 扩展需要 pending map 仅因其 `tool_call`/`tool_result` 钩子是独立事件）。它始终通过 `next()` 委托，当命中阈值时，将提醒折叠到下游决策的 `additionalContext` 上——这正是[钩子桥接](2026-06-30-hook-bridges.md)已在使用的「观察并丰富」姿态，遵守 waterfall 契约。计数放在此处而非 `tools/pre-execute`，是因为 post-execute 也会为被拒绝的调用触发（`ToolRegistry.execute` 将 deny 路由到同一流水线），而模型反复锤击一个被拒绝的调用恰恰是值得打破的循环。
- **`agent/prompt-submit`（waterfall）**——纯重置钩子：通过 `next()` 委托，清除提交 agent 的链。用户介入改变了上下文；跨越介入的重复不是循环。
- **`agent/status`（emit）**——在 `disposed` 时丢弃该 agent 的状态，限制 map 在 harness 生命周期内的增长。

### 检测语义

链的键为 `(tool name, canonical arguments)`；与前一次被追踪的调用相同则递增该 agent 的连续计数器，不同则重置为 1。规范化方式为深度键排序加 `JSON.stringify`：`ToolExecution.arguments` 按构造即为循环中 `JSON.parse` 的输出（或参数 JSON 格式错误时的原始字符串回退，其本身也是可比较的值），因此 pi 原版对 bigint/循环引用/`undefined` 的处理在此没有输入，被有意去除。

两条刻意的规则，均记录在[包 README](../../../../packages/guard/repeat-tool-guard/README.md) 中，因为它们是读者不看文档会猜测的行为：

- **未追踪的调用对链透明。** 被 `include`/`exclude` 排除的调用既不递增也不重置计数器，因此 `grep X → todo_write → grep X` 在 `todo_write` 被排除时仍计为两次连续的 `grep X`。这正是排除有用的原因——夹在循环中的记账工具不得洗白循环——也是 pi 扩展的（未文档化的）语义，有意保留并写明。
- **没有 agent 的调用被忽略。** 直接调用 `ctx.tools.execute()` 的调用方（测试、非循环消费方）没有可提醒的模型，也没有可作键的 `AgentId`。

### 提醒投递

提醒使用 `additionalContext` 并标注插件来源，保留原始 `tool/result`。首次阈值发出简短提示；后续阈值包含工具名、计数和有长度上限的参数预览，而比较仍使用完整的规范化字符串。已有的下游上下文在守卫的 source 下拼接，因为 `HookContext` 支持单一 source。

### 配置

```yaml
- id: repeat-tool-guard
  name: '@deepseek-ai/dsh-repeat-tool-guard'
  config:
    thresholds: [3, 5, 8]        # default; consecutive counts that trigger a reminder
    include: []                  # tool-name patterns to track; empty ⇒ all tools
    exclude: [todo_write]        # tool-name patterns transparent to the chain
    argumentsPreviewChars: 500   # default; cap on arguments quoted in the detailed reminder
```

`thresholds` 在加载时校验，空列表、非整数、小于 2 的值或重复值都会抛出异常——配置错误大声失败，取代 pi 原版的静默回退到默认值。`include`/`exclude` 条目支持 `*` 通配符。模式是对调用时实际存在的工具名的谓词，而非对注册表条目的引用，因此匹配不到任何当前已注册工具的条目不是错误——与 `toolOrder` 的引用检查不同，`exclude: [mcp_*]` 在未加载 MCP 工具的部署中必须保持有效。

## 测试

- **单元测试：** 使用脚本化适配器的真实循环覆盖计数与重置规则、未追踪透明性、dispose 清理、按 agent 隔离、规范化参数键序、升级、被拒绝的调用、无 agent 执行、通配符转义、无效配置，以及下游阻塞或替换决策，达到逐文件 100% 覆盖率。
- **快照测试：** keyless 的 `repeat-tool-guard` 场景发出五次相同的 `todo_write` 调用，将第三次的温和提醒和第五次的详细提醒固定在 ACP 输出和会话日志中。该插件在实时示例中加载，但在其他场景中保持静默。
- **E2e：** 无；该插件是确定性的且与提供方无关，其 seam 契约由各自的所有者覆盖。

## 曾考虑的替代方案

- **将提醒追加到工具结果中**（`accept` 并替换 `content`——pi 扩展的机制，它修改结果内容是因为那是其 API 提供的唯一通道）：否决。这会让已记录的 `tool/result` 对工具实际返回的内容撒谎，而 `additionalContext` 正是为 post-execute 评注设计的独立正式通道，循环级缓冲保持了调用/结果的邻接关系。
- **在 `tools/pre-execute` 中计数并使用 pending-reminder map**（pi 的两阶段形态）：否决。post-execute 单独就能同时看到 `(exec, result)` 且也会为被拒绝的调用触发，因此一个监听器、无跨事件状态，以更少的机制覆盖严格更多的尝试。
- **在最高阈值升级为 `block`**：在初始范围内否决。阻塞调用会惩罚合理的相同重复（轮询长时间运行的终端、重新检查 agent 预期会变化的文件），而建议性提醒让模型保持控制权。待有证据后重新审视；决策形状（`PostToolDecision`）已支持此选项。
- **通过 CC/Codex 桥接的按部署外部钩子**（`PostToolUse` 脚本）：否决作为最终答案。它对单个部署有效，但一个已发布、有单元测试、可通过 `cordis.yml` 配置的插件才是 harness 原生形式，且无逐调用的子进程开销。
- **在 `agent-loop` 中设置循环级步骤或重复预算**：否决。「用插件，不改循环」；硬性步骤预算是更粗粒度的正交控制，需要单独的提案。
- **模糊/近似相同检测**（路径归一化、相似但不完全相同的参数）：否决。规范化后的精确匹配廉价、确定性强且可向模型解释；相似度阈值会引入误报，在复杂度得到证据支撑之前不应引入。
- **将包放在 `core/`**：否决。core 是产品主干；行为守卫是可选的叶子插件，`todo/` 先例表明每个插件家族用一个小型专属分组。

## 后果

- 提醒在设计上是建议性的：有意重复相同调用的幂等轮询模式在超过阈值后仍会收到提示，减压阀是配置（`thresholds`、`exclude`）加上提醒文本中明确允许「在已收集足够证据时结束」的措辞。每次触发在下一次请求中增加提醒 token 开销；阈值限制了触发频率。
- 链状态仅存于内存：从持久化恢复的会话以全新的链开始，因此跨越恢复的循环比实时循环更晚收到提醒——可接受，守卫是启发式提示而非已记录的不变式，持久化计数器状态带来的收益不值得其复杂度。
- 当多个 post-execute 生产者在同一次调用上附加上下文时，折叠在守卫的 `source` 下拼接；插件间的顺序遵循监听器注册顺序。该 seam 无法表示混合来源——这是继承自 `HookContext` 的限制，不属于本插件。

## 延后

- 上下文压缩（compaction）不重置链：压缩后的历史改变了模型所见，但重复风险通常在压缩后仍然存在。
- 在高阈值升级为 `block` 未实现；`PostToolDecision` 已支持此选项，待证据出现后可启用。
- subagent 的链按 agent 隔离；在出现具体需求之前不引入共享机制。
