# code-runtime/：代码执行能力家族

[English](README.md) | 中文

代码执行能力 seam（参见[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)）：一个抽象运行时接口，用于针对宿主提供的异步绑定执行一段模型编写的程序，并捕获程序打印和返回的内容。消费方是工具注册表的 [Code Mode](../core/tools/README.md)（`tools: { mode: code }`，即 `run_code` 工具与生成的 TypeScript SDK）；设计记录在 [Code Mode Agent Note](../../.agents/notes/implemented/feature/2026-06-15-code-mode.md) 中。这些都是**产品**包。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`code-runtime/`](code-runtime/README.md) | 代码执行 seam 与共享词汇 | `ctx.codeRuntime` |
| [`code-runtime-worker/`](code-runtime-worker/README.md) | worker 线程后端 | 注册 `ctx.codeRuntime` |

后端注册该 seam，无需改动消费方。语言、隔离与执行预算细节由子级 README 负责。
