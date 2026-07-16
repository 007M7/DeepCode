# RFC：移除无消费方的 `llm/adapter-change` 事件

Status: implemented

[English](2026-06-20-drop-unconsumed-llm-adapter-change-event.md) | 中文

## 问题

`LlmService.registerAdapter()` 在注册和 dispose（资源释放）时发射 `llm/adapter-change`（[packages/llm/llm/src/index.ts](../../../../packages/llm/llm/src/index.ts)）。在 `packages/*/src` 和 `examples/*/src` 中 grep `llm/adapter-change`，只能找到声明、发射点、文档和测试；没有任何生产代码监听它。

这与 `tools/change` 和 `system-prompt/change` 不同。后两个事件目前同样无消费方，但它们是合理的注册表变更信号，未来的实时工具/提示词 UI 可能用到。LLM 适配器注册更像是启动时的实现细节：适配器不是用户可见的面板，真正的模型调用拦截 seam 是 `llm/stream`。保留一个没有监听者的 adapter-change 事件，是 [drop-the-dead-summary](../../implemented/simplification/2026-06-19-drop-mutable-session-summary.md) 模式在更小尺度上的重复。

这个事件并非零成本。`registerAdapter()` 在发射 `llm/adapter-change` 之前先 yield 回滚 disposer，这样抛异常的监听者会回退变更而不是泄漏一条适配器条目；包里还有测试覆盖这条监听者抛异常的路径。这种防御性排序所保护的失败模式，只有测试才能触发。

## 决策

只移除 `llm/adapter-change`：`dsh-llm` 的 `interface Events` 中的声明、`ctx.emit('llm/adapter-change')` 调用，以及 `LlmService.registerAdapter` JSDoc 中「在注册和 dispose 时发射 `llm/adapter-change`」的描述。`registerAdapter()` 的 effect generator 保留变更与回滚 disposer（用于 HMR（热模块替换）/dispose），但去掉仅为已移除事件而存在的监听者抛异常回滚排序。适配器 disposer 测试断言返回的 disposer 能移除适配器，不再订阅该事件；监听者抛异常的回滚测试随其主题一同移除。[docs/architecture.md](../../../architecture.md) 和 [packages/llm/llm/README.md](../../../../packages/llm/llm/README.md) 中的事件分类体系在同一个变更中更新。

## 曾考虑的替代方案

### 为什么不移除所有注册表变更事件？

一个注册表主动广播变更的微内核是一种自洽的约定。`tools/change` 和 `system-prompt/change` 在 UI 能实时刷新可用工具或提示词段落时可能变得有用。本 RFC 在有合理的面向用户消费方的地方保留该约定，仅裁掉当前和可预见未来都没有明确消费方的 adapter-change 事件。

如果将来需要 LLM 适配器浏览器或动态模型选择器，届时再连同消费方一起重新引入该事件，并给出比「something changed」更清晰的 payload。

## 验证

`llm/adapter-change` 及其发射点已移除，重新生成的 cordis catalog 是最新的；HMR 安全性保持（dispose 一个贡献 fiber 会移除对应适配器）；`tools/change` 和 `system-prompt/change` 仍有文档和测试；没有任何生产路径的可观测行为发生变化——ACP 快照 golden 和 echo-agent 冒烟测试逐字节不变。

## 后果

- **移除一个已文档化的发射事件属于公开接口变更。** 它出现在分类体系表中，读起来像是有意为之的 API。但「已声明并发射」不等于「有消费方」——这正是当初移除可变 summary 时所依据的同一区分。分类体系表在同一个变更中更新，因此文档不会漂移。
- **注册表变更约定变得不均匀。** 这是可以接受的，因为 LLM 适配器注册与工具或提示词段落不是同一层面的用户可见概念。不均匀但诚实，胜过统一但空转。

这是一个小裁剪，但它退役了一条守护着不存在的消费方的常设正确性不变式。
