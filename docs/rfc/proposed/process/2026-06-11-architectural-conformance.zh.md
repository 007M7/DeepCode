# RFC：架构一致性——依赖规则与适配器套件

[English](2026-06-11-architectural-conformance.md) | 中文

Status: proposed

## 问题

两项架构保证目前仅存在于行文中：（1）任何包不得依赖具体的 loop 包（[微内核承诺](../../implemented/architecture/2026-06-11-microkernel-event-taxonomy.md)）；（2）每个 LlmAdapter 都正确地遵循 chunk 协议。两者都应当机械化（[质量门禁原则](../../implemented/process/2026-06-11-quality-gates.md)）。

## 提案

**dependency-cruiser** 配合以下规则：

- `packages/*`（agent-loop 自身的测试和 examples/ 除外）禁止导入 `@deepseek-ai/dsh-agent-loop`。
- 禁止跨包深层导入（`@deepseek-ai/dsh-*/src/...` 路径）——只允许使用公开入口点。
- packages/ 内禁止任何导入循环。
- `vendor/*` 禁止从 `packages/*` 导入。
- 分层：dsh-llm 不导入其他 dsh 包；dsh-session 只导入 dsh-llm；以此类推（即 packages/README.md 中的依赖表，强制执行）。

**适配器一致性套件**位于 dsh-llm（`@deepseek-ai/dsh-llm/conformance`）：一个可复用的 vitest 套件，以适配器工厂为参数，断言 chunk 协议契约——每个 block 的 index 单调递增、`block-end` 之后该 index 不再有 delta、恰好一个 `finish`、usage 至多出现一次、每个 `tool-call-delta` 携带 call id、abort 被及时响应。当前对 mock 运行；DeepSeek V4 适配器从第一天起继承该套件。可选地提供一个 dev 模式的 `strictAdapter()` 包装层，在 debug flag 下于运行时强制执行相同约束（与 [dev 模式不变式](../../implemented/architecture/2026-06-11-dev-invariants-over-deep-readonly.md)配对）。

## 计划

先落地 dependency-cruiser 配置与 CI 步骤（约一小时工作量，永久保证）；一致性套件随其首个消费方测试（针对 MockAdapter）一起落地，并作为 V4 适配器阶段的前置条件。

## 验收标准

- dependency-cruiser 在 CI 中运行上述规则族；违规导入导致构建失败。
- 一致性套件对 mock 适配器和两个正式适配器运行通过；新适配器包通过调用该套件并传入自己的工厂即可继承测试。

## 风险

随着包的增加需要维护 dep-cruiser 规则——应保持规则基于模式（`dsh-*`）而非逐一枚举。

<!-- rfc-format: alternatives-not-recorded (pre-format RFC) -->
