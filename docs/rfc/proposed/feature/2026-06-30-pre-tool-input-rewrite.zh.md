# RFC：工具执行前输入改写——一致性设计

[English](2026-06-30-pre-tool-input-rewrite.md) | 中文

Status: proposed

## 问题

[拦截 seam RFC](../../implemented/feature/2026-06-30-interception-seams.md) 将 `tools/pre-execute` 定义为一道 allow/deny/ask 门禁，作用于身份已受保护、参数已被深度冻结的执行对象。Claude Code 的 `PreToolUse` 钩子还提供了 `updatedInput`，因此忠实的桥接需要一个显式的改写机制。改写不能是对现有执行对象的可变逃逸口：它必须保持持久化历史、审计记录、展示层与实际执行值之间的一致性。

## 问题本质：执行前参数的三个读取方

在 agent loop（智能体循环）中，工具调用的参数在工具执行之前就已被提交到日志并被活跃消费方读取：

1. **`assistant/message`** 在工具分发之前追加——它是 `deriveMessages()` 回放时的模型历史来源，因此携带的是模型自身生成的工具调用参数。
2. **`tool/call`** 是持久化的审计记录，在 `ctx.tools.execute()` 之前追加。
3. **展示层实时读取 `tool/call.arguments`**：ACP 桥接会记住这些参数并传给 `presentResult`；`dsh-tool-bash` 从中派生卡片标题、rawInput、cwd 以及终端/后台的处理方式。

如果只做执行层面的改写，UI 会展示一条命令而实际运行的是另一条，并且结果会对着错误的参数渲染。注册表目前阻止了这种失败模式：它对 `arguments` 做 structured-clone 并深度冻结，将执行身份属性设为不可写，且不暴露任何可替换它们的测试 shim 或监听路径。改写设计必须保持这一受保护的身份边界，而非削弱它。

## 提案

改写是一次「身份构造前的一致性事务」。当钩子提供 `updatedInput` 时，有效值必须在注册表构造不可变的 `ToolExecution` 之前确定，并原子性地反映到全部三个读取方：

- `tool/call` 审计事件记录**改写后**的参数（原始参数保留在一个 sidecar 字段中用于审计追踪——钩子改变了调用，原始参数和生效参数都是值得保留的事实）。
- 派生历史中的 `assistant/message` 必须与实际执行一致——待评估的选项：就地改写 assistant 消息中的工具调用块（改变模型「看到自己说过的话」），或记录一条单独的修正由下一次请求携带。CC 的模型是让模型看到改写已生效。
- 展示层（`presentCall`/`presentResult`）读取改写后的参数，UI 展示的是实际运行的内容。

在 `PreToolDecision` 当前的触发点上做扩展不够：此时两条持久化记录都已存在，执行身份已受保护。实现必须要么将相关决策移到日志提交之前，要么在待处理的模型调用上增加一个专门的更早期改写决策。当循环将生效参数提交到历史和审计之后，再按常规构造不可变执行对象，并照常运行现有的 allow/deny/ask 与工具流水线。

## 曾考虑的替代方案

### 为什么不直接修改执行对象？

允许 pre-execute 监听器赋值 `exec.arguments` 只能提供执行层面的改写，模型历史、审计和展示层不会跟着变。保持身份受保护使得这种局部行为无法被表达。在一致性事务实现之前，CC/Codex 桥接对 `updatedInput` 只做日志记录并发出警告，而非声称已兑现；循环分发处的 `TODO(pre-tool-input-rewrite)` 锚定了这个缺失的更早阶段。

## 验收标准

- 请求的改写在 `ToolExecution` 身份创建之前完成解析，并原子性地反映到全部三个读取方：`tool/call` 审计记录改写后的参数（原始参数保留在 sidecar 字段）、派生历史与实际执行一致、展示层渲染改写后的参数。
- 生效的 `ToolExecution.arguments` 在 pre-policy、guards、dispatch、post-policy 和最终观测的全过程中保持深度冻结且不可写；不引入任何可变 shim。
- CC/Codex 桥接兑现 `updatedInput`，不再输出忠实但降级的警告。

## 风险

- 改写 `assistant/message` 中的工具调用块会改变模型「看到自己说过的话」；是否有提供方在回放时拒绝这种改写，是一个必须在决策形态冻结前通过实验验证的开放问题。
- 更早期的改写阶段改变了 `assistant/message`、`tool/call`、钩子审计事件与执行之间的顺序关系；设计必须固定这一顺序，同时不削弱轮次封闭性或 call/result 邻接性。

## 开放问题

- 改写 `assistant/message` 中的工具调用块是否会破坏某些提供方在回放时的预期？还是记录一条单独的修正更安全？
- 原始参数是否应保留在 `tool/call` 事件（审计）上？如果是，放在哪个字段？
- 改写决策是移到日志提交之前，还是成为一个专门的更早期 seam？现有的 pre-tool allow/deny 钩子如何避免运行两次？
- 这与未来的权限 `ask` 流程（用户批准一个被改写的调用）如何交互？
