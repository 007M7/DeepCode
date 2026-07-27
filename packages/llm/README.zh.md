# llm/：LLM 能力家族

[English](README.md) | 中文

LLM seam 及其提供方适配器。接口包（`llm`）拥有抽象服务、内容块词汇和流分片组装器；适配器是在 `ctx.llm` 上注册的具体实现。这些全是**产品** 包。

| 包 | 职责 | ctx key |
|---|---|---|
| `llm/` | 抽象 LLM 服务 + 内容块词汇 + 分片组装器 | `ctx.llm` |
| `token-meter/` | 感知回放的请求与表层 token 测量 | `ctx.tokenMeter` |
| `llm-retry/` | 有界的暂时性请求重试策略 | （监听 `agent/request-error`） |
| `llm-deepseek/` | DeepSeek API 适配器（直接 fetch + eventsource-parser SSE） | （注册到 `ctx.llm`） |
| `llm-pi-ai/` | 通过 `@earendil-works/pi-ai` 实现的多提供方适配器 | （注册到 `ctx.llm`） |

接口位于 `llm/llm/`；适配器、重试策略和可复用的 token 计量器都是该分组下的扁平兄弟包。请求按 `provider` 路由，而 `model` 会原样传给选中的适配器。拥有路由的适配器可以解析精确的提供方／模型上下文容量；token 计量器仍与模型无关。新的提供方适配器只需在 `ctx.llm` 上注册一个或多个提供方路由，无需改动接口或消费方。两个已交付实现见[双生 LLM 适配器](../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md)，测量归属见[回放 token 计量器 Agent Note](../../.agents/notes/implemented/architecture/2026-07-15-replay-token-meter-service.md)，容量与压缩策略归属见[路由模型上下文 Agent Note](../../.agents/notes/implemented/architecture/2026-07-20-routed-model-context-and-compaction-policy.md)。
