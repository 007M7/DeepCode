# RFC：收紧 hook 协议契约——dialect、废弃字段、双重默认值与 lib 拥有的 `hook/result` 语义

[English](2026-07-04-tighten-hook-protocol-contract.md) | 中文

Status: implemented

## 问题

`dsh-hook-protocol`/bridge 契约中有四处遗漏了 [subagent-observe-enrich RFC](../feature/2026-06-30-subagent-observe-enrich.md) 所记录的纪律——该 RFC 因缺乏消费方而移除了 `agentType` 生命周期字段，以下四处未通过同样的检验：

1. **`HookDialect` 的 `'native'` 变体**（`packages/hooks/hook-protocol/src/types.ts`）没有任何生产者——bridge 只打 `'claude'` 和 `'codex'` 标记；唯一的 `'native'` 构造出现在 lib 自身的单元测试中。该字段自己的 JSDoc 将 `dialect` 定义为「执行它的 bridge」，而 native 不是 bridge：[interception-seams RFC](../feature/2026-06-30-interception-seams.md) 记录了 native 钩子不是一个 package，且「native 插件已经可以直接使用类型化的 Decisions」而无需持久化的 hook 日志；旗舰 native 插件的工作示例也正是如此断言的（完全没有 `hook/*` 事件）。
2. **`HookOutput.suppressOutput`**（同一文件）被 codec 解析后在所有路径上都被丢弃：没有 bridge 分支、没有 merge fold、没有 warn、没有 deferred-list 行——在所有「被解析但未兑现」的同类字段中，它是唯一没有明确延期声明的（`updatedInput` → 一条 warn 日志加 [pre-tool-input-rewrite 提案](../../proposed/feature/2026-06-30-pre-tool-input-rewrite.md)；`systemMessage` → 一条 warn 日志加 README deferred 行；`continue`/`stopReason` → 一个 `TODO(hook-continue-false)` 锚点加 `'stop'` decision 记录）。从结构上看根本没有什么可 suppress 的：hook 的 stdout 从不进入任何 transcript（文本记录）（上下文仅通过 `additionalContext` 流入；日志只记录 `decision`/`stderrSummary`），因此 hook 作者设置 `suppressOutput: true` 得到的是无声的空操作，连 warn 都没有。
3. **`defaultTimeoutMs` 在两个 bridge 配置中被双重默认，使用浮动字面量**——一个 schema `.default(600_000)` 加一个 `?? 600_000` 回退（`packages/hooks/hooks-claude/src/index.ts`、`packages/hooks/hooks-codex/src/index.ts`），每个 bridge 为同一个协议级常量提供两个归属，两个 bridge 可能在共享默认值上悄然分歧。*本提案最初的补救——彻底删除该配置项——被 no-hardcoded-tunables 审计取代，后者保留了该配置项作为 bridge 拥有的显式配置（并在旁边新增了 `stderrSummaryMaxChars`）；剩下需要修复的是字面量的归属。*
4. **`hook/result` 的语义存在于两个 bridge 中（各一份），而非拥有该事件的 lib。** `summarize()`——stderr 截断规则——在 `packages/hooks/hooks-claude/src/index.ts` 和 `packages/hooks/hooks-codex/src/index.ts` 中逐字节相同，decision 字符串规则 `output.decision ?? (output.continue === false ? 'stop' : 'pass')` 也是如此；然而 `dsh-hook-protocol` 声明了 `hook/result`、将 `stderrSummary` 文档化为「已截断」却不拥有截断逻辑，将 decision 值文档化却不拥有映射逻辑。如果某个 bridge 漂移（不同的上限、不同的回退），共享的持久化事件的语义就会悄然分叉。

## 决策

`HookDialect` 是封闭的 bridge 集合，`'claude' | 'codex'`；`HookOutput` 移除不受支持的 `suppressOutput`。`hook/result.durationMs` 保留为持久化的审计计时，仅在快照中做归一化。参考默认值各只存在一处：`DEFAULT_HOOK_TIMEOUT_MS` 和 `DEFAULT_STDERR_SUMMARY_MAX_CHARS`。`HookResultRecord` 与 `appendHookResult` 为两个 bridge 统一拥有 stderr 摘要化和 decision 推导逻辑。`BLOCKING_EXIT_CODE` 为 codec 内部常量。

## 曾考虑的替代方案

### 为什么不保留？

不受支持的词汇（vocabulary）可以在真正有消费方时回归。`durationMs` 保留，因为持久化的审计计时独立于当前是否有读取者而有价值。Bridge 特有的 payload 构造留在各自 bridge 中，而共享的持久化事件归一化属于协议库。

## 验证

`HookDialect` 只包含 Claude 和 Codex，`suppressOutput` 在源码、解析字段文档和归一化逻辑中均不存在。`durationMs` 保留在事件和 fixture（测试前置数据）中，回放时做擦除。`600_000` 和 `500` 默认值各只在协议库中出现一次，per-hook 超时覆盖仍然生效，两个 bridge 的测试套件都验证了库拥有的 stderr 截断和 decision 规则。

## 后果

`dialect`、`suppressOutput`、可调参数与语义变更在协议格式（wire format）和 golden 文件上不可见。代价是 `dsh-hook-protocol` 和两个 bridge 的代码变动——在预发布阶段这很廉价，且比让持久化事件语义的两份副本各自老化要廉价得多。
