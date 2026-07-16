# RFC：以两个 LLM 适配器作为设计验证孪生

Status: implemented

[English](2026-06-13-twin-llm-adapters.md) | 中文

## 问题

`dsh-llm` 拥有一套提供方无关的流式输出词汇：`StreamChunk` 协议（`block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta`、`block-end`、`usage`、`finish`）以及内容块类型（[内容块词汇](2026-06-11-content-block-vocabulary.md)）。如果词汇只针对单一适配器定义，就有把该适配器的怪癖烘焙进「中立」契约的风险：那个唯一实现碰巧做了什么，就会变成事实上的规范；而抽象在第二个提供方到来之前都无法被验证——届时泄漏已经代价高昂。

## 决策

从一开始就针对同一份契约交付**两个**适配器，刻意基于不同的内部实现：

- `dsh-llm-deepseek`：手写 `fetch` + SSE 解析，直连 DeepSeek API。
- `dsh-llm-pi-ai`：通过 `@earendil-works/pi-ai` 库（有自己的事件词汇）访问同一端点。

它们强制执行的规则是：**凡是 StreamChunk 词汇无法同时为两个实现表达的东西，都是核心词汇的 bug**——立即暴露，而非等到下一个提供方才发现。这对孪生确定了现已记录在 `dsh-llm/src/types.ts` 中 `StreamChunk` 上的约定：usage 在 finish 之前发出、finish 之后不再有任何事件、工具调用的 `arguments` 全程为原始 JSON 字符串，以及消费方必须在两侧都处理的两条合法错误路径（从 `stream()` 抛异常，*或*以 `finish {kind:'error'|'aborted'}` 结束）。后一项分歧正是由库封装的适配器暴露出来的，单一手写适配器会将其掩盖。

## 曾考虑的替代方案

- **单一适配器**：代码更少、e2e 成本减半，但「提供方无关」的声明无法验证；词汇会默默编码 DeepSeek-via-fetch 的假设。
- **mock 第二适配器**：更便宜，但不会触及真实提供方的协议格式（wire format）怪癖，因此证明力有限。孪生是真实对真实。

## 后果

孪生使适配器和需要密钥的 e2e 维护量翻倍——两者都覆盖 V4 Flash 和 Pro 在各代表性推理模式下的表现——换来的是对 seam 中立性的持续验证和第二份实现示例。两者都使用 `apiKey`、`baseURL` 和 `models`；手写适配器暴露 `thinking`/`reasoningEffort`，pi-ai 适配器暴露一个 `reasoning` 级别。未来的一致性测试套件可以通过一份取代性 RFC 来论证退役其中一个适配器。
