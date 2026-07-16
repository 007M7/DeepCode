# RFC：移除 `GenerateOptions.prefill` 与 `ToolSchema.strict`——无可用端到端路径的请求旋钮

[English](2026-07-04-drop-inert-request-knobs.md) | 中文

Status: implemented

## 问题

两个请求契约旋钮贯穿了整条请求流水线，但都无法产生任何效果：

- **`prefill`**（`packages/llm/llm/src/types.ts`）没有生产环境的赋值方：agent loop（智能体循环）组装的只有 `model`/`system`/`tools`/`messages` 加 `sessionId`/`signal`，上下文压缩（context compaction）后端只追加 `maxTokens`；而且**两个**适配器都拒绝它：`packages/llm/llm-deepseek/src/serialize.ts` 和 `packages/llm/llm-pi-ai/src/adapter.ts` 各自在 `prefill` 非 undefined 时抛出 `LlmError('UNSUPPORTED')`。该字段全部可观测行为就是两个 throw，各由一个适配器测试固定。DeepSeek 的 chat-prefix completion 是一个 Beta 功能，使用的 base URL 两个适配器都未指向。
- **`strict`**（`ToolSchema`，同一文件）贯穿了 `DefineToolOptions`/`defineTool`（`packages/core/tools/src/schema.ts`）、注册表的 `schemas()` 白名单（`packages/core/tools/src/index.ts`）、deepseek 协议格式（wire format）映射（`packages/llm/llm-deepseek/src/serialize.ts`，其 wire-type 注释记录了 strict 模式需要适配器未使用的 `/beta` base URL）、`packages/llm/llm-pi-ai/src/adapter.ts` 中的逐工具 payload 修补，以及 tool-catalog 渲染器（`scripts/gen-tool-catalog.ts`）中的条件 `Strict:` 行。没有任何已发布的工具设置过它：在所有 `tool-*` 包 src 和 `examples/` 中 `rg` 搜索，`strict:` 的生产方为零；唯一的赋值方是 dsh-tools 单元测试。

两个旋钮在适配器间是对称的，因此移除时两个孪生适配器一并清理——[孪生适配器设计](../architecture/2026-06-13-twin-llm-adapters.md)不受影响。

## 决策

- 从 `GenerateOptions` 中移除 `prefill`，同时移除两个适配器的 UNSUPPORTED 守卫、固定这些 throw 的测试、[core.md](../../../core-data-structures/core.md) 中的粘贴行，以及适配器 README 中记录拒绝行为的行。实操手册（Cookbook）中的 UNSUPPORTED 指导（[adding-an-llm-adapter.md](../../../cookbook/adding-an-llm-adapter.md)）改为泛化表述——你的提供方无法兑现的 `GenerateOptions` 字段应抛出 `LlmError(..., 'UNSUPPORTED')`——而不再以 prefill 为例。[内容块词汇 RFC](../architecture/2026-06-11-content-block-vocabulary.md) 的后果部分将 prefill 记录为「受生产方门控」而非「已有归属」，遵照 [implemented/AGENTS.md](../AGENTS.md)。
- 从 `ToolSchema`、`DefineToolOptions`、`defineTool`、`schemas()` 白名单、deepseek 序列化器分支及其 wire-type 字段、以及 tool-catalog 渲染器的 `Strict:` 行中移除 `strict`。pi-ai 的 payload 修补简化为无条件擦除 pi-ai 自身的逐工具 strict 默认值（pi-ai 在每个序列化工具上打 `strict: false`；手写的孪生适配器不发送此字段，因此擦除逻辑为保持协议格式对等而保留，由其序列化器测试固定）。赋值测试和 core.md 粘贴行已移除；`GenerateOptions` 与 `ToolSchema` 在 `scripts/type-equiv.manifest.json` 中保留各自的行，因为两个类型本身仍然存在，只是少了一个字段。

本 RFC 有意**不**触及 `temperature`、`stop` 或 `maxTokens`：这些字段被两个适配器端到端地兑现，是 `agent/request` 上请求变更钩子插件的自然首选目标。

## 曾考虑的替代方案

### 为什么不保留？

「显式的 UNSUPPORTED throw 是诚实的契约行为」——但一个旋钮在两个孪生适配器中的唯一实现都是拒绝，它什么也不承诺；删除它反而升级了失败模式：意外的赋值从运行时 throw 变为编译错误。「strict schema 遵循是官方文档记录的提供方功能，且管道完整」——但一个旋钮在有已发布工具设置它**且**有端点兑现它之前，都不是产品表面；今天两者都不成立。二者各自随其第一个真实生产方回归：`prefill` 随实现了 chat-prefix completion 的适配器（以及对不支持它的适配器的明确策略）一起回来，`strict` 随需要它的工具和 beta 端点方案一起回来。

## 验证

`rg prefill` 仅返回 RFC 记录（本文与[内容块词汇 RFC](../architecture/2026-06-11-content-block-vocabulary.md) 的 producer-gated 后果）；在 tool-schema 范围内 `rg strict` 仅返回本 RFC、保留的 pi-ai 擦除逻辑，以及无关行文（如 `strictEqual`）。两个适配器的契约测试在移除守卫后通过，pi-ai 修补仍然擦除库的 strict 默认值——协议格式对等由其序列化器测试固定。

## 后果

已发布的钩子桥接不设置任何请求字段，而请求变更插件（`agent/request` waterfall（瀑布式事件）监听器）使用的是 `temperature`/`stop`（保留且可用），而非适配器拒绝的字段。如果 chat-prefix completion 或 strict 模式成为产品功能，重新添加将随适配器/端点工作一起落地，届时契约能说明实际发生了什么，而非「所有人都 throw」。
