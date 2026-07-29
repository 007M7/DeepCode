# code-runtime/：代码执行能力家族

[English](README.md) | 中文

代码执行能力 seam（参见[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)）：一个抽象运行时接口，用于针对宿主提供的异步绑定执行一段模型编写的程序，并捕获程序打印和返回的内容。消费方是工具注册表的 [Code Mode](../core/tools/README.md)（`tools: { mode: code }`，即 `run_code` 工具与生成的 TypeScript SDK）；设计记录在 [Code Mode Agent Note（agent 决策记录）](../../.agents/notes/implemented/feature/2026-06-15-code-mode.md) 中。这些都是**产品**包（package）。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `code-runtime/` | 抽象代码执行 seam（接口 + 词汇） | `ctx.codeRuntime` |
| [`code-runtime-worker/`](code-runtime-worker/README.md) | worker 线程后端：每次运行使用全新 worker，由宿主侧剥离 TypeScript 类型（类型注解仅供参考，绝不执行类型检查）、端口桥接绑定、预算／堆限制 | 注册 `ctx.codeRuntime` |

接口位于 `code-runtime/code-runtime/`，随附的后端位于 `code-runtime/code-runtime-worker/`。不同后端可以采用不同执行基底（worker 线程、进程、容器）与源语言；二者都是服务上的只读描述符。后端注册 `ctx.codeRuntime`，无需修改接口或消费方；正是这种拆分，使未来可以直接换入加固后端。
