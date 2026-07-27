# compact/：压缩能力家族

[English](README.md) | 中文

一个压缩（compaction）能力家族（见[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)）：抽象接口、摘要后端、不依赖模型的工具结果剪枝配套组件，以及暂缓实现的面向模型消费方。这些全是**产品** 包。

| 包 | 职责 | ctx key |
|---|---|---|
| `compact/` | 抽象压缩 seam（接口 + `compact/*` 事件 + `CompactionResult`） | `ctx.compact` |
| `compact-basic/` | 后端：`ctx.tokenMeter` 压力 + token 预算保留 + `llm.stream()` 摘要生成 | （注册 `ctx.compact`） |
| `compact-tool-result-prune/` | 可选的不依赖模型的头／中／尾重写，在摘要压缩之前运行 | `ctx.toolResultPrune` |
| `tool-compact/`（暂缓） | 面向模型的 `/compact` 工具，基于 `ctx.compact` | （注册到 `ctx.tools`） |

接口位于 `compact/compact/`，后端位于 `compact/compact-basic/`，确定性剪枝位于 `compact/compact-tool-result-prune/`。与 bash seam 不同，该接口依赖 `dsh-session` 和 `dsh-llm`，因为它的动词基于 `Session` 定义，输出则使用 `ContentBlock`。这项偏差记录在[压缩能力 seam Agent Note](../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md) 中。token 测量仍是可复用的 LLM 家族服务；模板或模型支持的压缩器可以替换 `compact-basic`，而无需更改计量器、剪枝器或调用方。
