# RFC：移除未被消费的 LLM 组装便利接口

Status: implemented

[English](2026-06-20-drop-unconsumed-llm-assembled-surfaces.md) | 中文

## 问题

`LlmService`（[packages/llm/llm/src/index.ts](../../../../packages/llm/llm/src/index.ts)）在模型之上暴露了三个调用接口：

- `stream()`：原始 `StreamChunk`，通过 `llm/stream` waterfall（瀑布式事件）分发。
- `streamBlocks()`：一个"便利视图"，将 chunk 送入 `BlockAssembler` 并按流顺序 yield 已组装完成的 `ContentBlock`（[index.ts:137-144](../../../../packages/llm/llm/src/index.ts)）。
- `generate()`：一个完整组装的 `GenerateResult`，通过第二个 `llm/generate` waterfall 分发（[index.ts:151-157](../../../../packages/llm/llm/src/index.ts)）。

LLM（大语言模型）服务唯一的生产消费方是 agent loop（智能体循环），它只使用 `stream()`：将原始 chunk 送入自己的 `BlockAssembler`，以便在并行组装的同时记录 chunk 用于回放保真（[packages/core/agent-loop/src/loop.ts](../../../../packages/core/agent-loop/src/loop.ts) 中的 `ctx.llm.stream(req)` 步骤）。在 `packages/*/src` 和 `examples/*/src` 中搜索 `streamBlocks` 与 `ctx.llm.generate`，找不到任何生产调用方。引用它们的只有服务方法定义、文档和测试；适配器测试用 `generate()` 作为便利驱动，但它们完全可以通过同一个 assembler 辅助函数手动消费 `stream()`，无需保留一个公开的生产 API。

这与 [drop-mutable-session-summary](../../implemented/simplification/2026-06-19-drop-mutable-session-summary.md) 是同一模式：拥有测试契约的组装视图 API，消费方只有测试而非生产代码。它们是为"不关心 token 级增量"的消费方预先构建的，但唯一的真实消费方恰恰需要增量，以便持久化高保真的回放数据。

`streamBlocks()` 拖带了 `BlockAssembler` 中一块专用逻辑：`flushReady()` 和 `flushRemaining()`（[packages/llm/llm/src/assembler.ts:138-168](../../../../packages/llm/llm/src/assembler.ts)）以及 `flushed` 游标字段，仅为支持按序增量 yield 而存在。`generate()` 拖带了 `GenerateResult`、`BlockAssembler.result()` 以及 `llm/generate` waterfall——在同一底层流之上多出的第二个拦截面。agent loop 对 assembler 的使用仅限 `push()` / `message()` / `usage` / `finish`，不涉及流式 flush 或一次性服务组装。

## 决策

`stream()` 是唯一的公开 LLM 调用接口。移除 `streamBlocks`、`generate`、其事件/结果类型，以及仅被该路径使用的 assembler 辅助方法。适配器测试通过本地辅助函数对公开的 stream 进行组装，`BlockAssembler` 只保留有生产消费方的操作。

## 曾考虑的替代方案

**保留 `generate()` 作为仅供测试的便利方法**：否决。适配器测试通过共享 assembler 手动消费 `stream()`，走的是与生产相同的流式路径；一个唯一调用方是测试的公开方法，正是[移除可变摘要先例](2026-06-19-drop-mutable-session-summary.md)所清退的死接口形态。未来如果有消费方需要不带增量的组装块，届时再引入一个有真实消费方的专用辅助方法。

## 验证

`streamBlocks`、`generate`、`llm/generate` 以及仅被它们使用的 assembler 辅助方法已全部移除，无新增死导出；两个真实适配器通过 `stream()` 加共享 assembler 得到充分测试；agent loop 行为不变（ACP 快照 golden 文件无变化）；README、架构文档与模块文档中不再提及被移除的接口。

## 后果

- **从一个核心词汇包中移除了公开方法。** 未来如果有插件需要不带增量的组装块，它需要直接调用 `stream()` 并使用 `BlockAssembler`，或在有真实消费方时重新引入一个专用辅助方法。鉴于预发布阶段「基础优先于投机性未来」的立场（[AGENTS.md](../../../../AGENTS.md)），现在正是清除仅供测试的公开形状的正确时机。
- **适配器测试变得更显式。** 它们失去了便利的 `generate()` 包装层，但这是有益的压力：测试走的是与生产相同的流式路径。
- **waterfall 使用方失去 `llm/generate`。** 不存在生产监听者。未来的缓存/重试/日志插件应包装 `llm/stream`，它仍是唯一的提供方调用路径。

变更规模不大，但它干净地从 LLM 包中移除了投机性的接口面积，为生产和测试留下唯一一份模型调用契约。
