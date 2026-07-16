# RFC：由 dsh-llm 持有的提供方无关内容块词汇

Status: implemented

[English](2026-06-11-content-block-vocabulary.md) | 中文

## 问题

harness 需要一套统一的内部消息语言，供 agent loop（智能体循环）、会话日志和所有插件共同使用。

## 决策

自行持有词汇：消息是类型化内容块（`text`、`reasoning`、`tool-call`、`tool-result`）的数组，其联合类型派生自可合并扩展的 `ContentBlockMap`，插件通过声明合并添加新的块类型。同一套可合并扩展映射模式也用于所有「字符串化」字段的类型定义（`MessageSource`、`FinishReason`、`TurnTrigger`、`TurnEndReason`）。流式输出是原始分片协议；`BlockAssembler` 是唯一的共享组装实现。适配器负责转换为各提供方的协议格式（wire format）：映射成本留在适配器中，这正是它该待的地方。

会话内上下文注入（`context/message`、`steering/message`）渲染为带标签的 user-role 信封（system-reminder 模式），而非引入新 role，因此适配器零负担。真实适配器验证已确认该渲染方式在当前 DeepSeek 行为下有效；如果未来某个提供方出现不匹配，应在该适配器内处理，而非引入新的规范 role。

## 曾考虑的替代方案

- **镜像 DeepSeek/OpenAI chat-completions 的结构**：对第一个提供方零映射成本，但对富内容（推理（reasoning）、作为结构化块的工具结果）处理起来别扭。
- **原样采用 Anthropic Messages 的块结构**：经过实战检验，但规范类型将镜像一个 harness 并非首要对接的第三方 API。

## 后果

- 推理（reasoning）在核心层有了归属，无需依赖提供方特有的结构。
- 多模态块只有在适配器、UI 与上下文压缩（context compaction）三方协同支持时才会回归；见[移除 image 内容块 RFC](../simplification/2026-07-04-drop-image-content-block.md)。
- 缓存提示与 assistant prefill 在有实际适配器能兑现之前保持缺席；见[无生产者的变体](../simplification/2026-07-04-prune-producerless-vocabulary-variants.md)与[惰性请求旋钮](../simplification/2026-07-04-drop-inert-request-knobs.md) RFC。
- 每个适配器都要承担翻译成本；首批真实适配器已验证了流式输出协议，后续新适配器应继续在适配器本地测试中证明其提供方特有的映射。
- 跨包边界的 ID 使用品牌类型（`CallId`、`SessionId`、`AgentId`）：零运行时成本的名义类型。
