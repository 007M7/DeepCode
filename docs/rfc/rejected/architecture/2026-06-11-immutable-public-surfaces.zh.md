# RFC：深度只读的公开接口

[English](2026-06-11-immutable-public-surfaces.md) | 中文

Status: rejected — the pervasive `DeepReadonly<T>` type flip is replaced by source-owned runtime immutability in `Session` plus relational development assertions. See [source-owned session immutability and dev-mode invariants](../../implemented/architecture/2026-06-11-dev-invariants-over-deep-readonly.md).

## 问题

被否决的提案针对的是一个所有权漏洞：仅靠 `readonly SessionEvent[]` 类型无法封堵该漏洞，因为数组元素在运行时仍然可变，一次类型断言或纯 JavaScript 就能改写嵌套的历史记录。最终实现的设计在 `Session` 中通过物化并深度冻结每个已接受的事件、返回冻结的数组快照来封堵该漏洞。进行中的 prompt waterfall（瀑布式事件）被有意保留为可变，因此不可变性是一条所有权边界，而非一条覆盖全局的类型规则。

## 提案

> **实际实现方式不同——见 Status 行与 [source-owned session immutability and dev-mode invariants](../../implemented/architecture/2026-06-11-dev-invariants-over-deep-readonly.md)。** 下文的 `DeepReadonly<T>` 设计已被否决：它仅在编译期生效、对消费方噪音大、且可被 cast 绕过。`Session` 改为在每次组合中对已接受的事件和公开日志快照进行快照与深度冻结；`deriveMessages()` 返回分离的冻结投影；开发插件检查跨记录与跨 seam 的关系约束。

在类型层面将不可变性施加于「变异即腐败」的位置：

- `SessionEvent` 数据在从会话**输出**时（`events`、`session/event` 监听器）变为 `DeepReadonly`；`append()` 仍接受普通可变输入。一个 `DeepReadonly<T>` 工具类型放入 dsh-llm，与 brand/never 辅助类型并列。
- `deriveMessages()` 返回深度只读的消息；agent loop（智能体循环）在将可变请求交给 `agent/request` waterfall 之前先克隆一份（在 waterfall 中变异是被允许的——克隆使边界显式且廉价，每步仅一次）。
- `PromptAssembly` 在其 waterfall 流程中保持可变（被允许），但注册表的内部 section 列表在每次组装时被克隆（已有此行为）。

## 计划

引入 `DeepReadonly`，翻转会话的读取路径，并修复消费方由此产生的编译错误。

## 风险

`DeepReadonly` 类型会在 waterfall 边界处产生噪音错误——因为变异在那里正是 API 的一部分。应将可变/只读边界严格限定在「已记录 vs 进行中」，并在会话 README 中加以说明。

<!-- rfc-format: alternatives-not-recorded (pre-format RFC) -->
