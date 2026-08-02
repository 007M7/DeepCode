# Agent Note: Code Mode 语言分发与 Python SDK 渲染器

Status: implemented

[English](2026-07-31-code-mode-language-dispatch.md) | 中文

## 问题

Code Mode 只生成一种 SDK 形态：TypeScript。`ToolRegistry` 为 `tools:sdk` 段硬编码了 `renderToolsSdk`，且 `requireCodeRuntime` 会拒绝任何 `ctx.codeRuntime.language !== 'typescript'`。引入 CPython 后端后，程序的源语言不再固定：同一个可见工具注册表在加载 Python 运行时时必须投射出 Python SDK，而面向模型的 `run_code` schema 字符串（"Execute a Python program …"）也必须与 SDK 段的语言一致，模型才不会在 Python 运行时下看到 TypeScript 指令。

这是多语言 Code Mode 拆分中面向工具的那一半；[代码运行时 seam](../../../../packages/code-runtime/code-runtime/README.md) 已经携带 `CodeRuntime.language`。本 Note 只负责 `dsh-tools` 如何在该字段上分发。实现 `language: 'python'` 的后端由它自己的 Note 负责，单独交付。

## 决策

语言选择就是对 `ctx.codeRuntime.language` 的查表，在 prompt 装配时惰性解析，查 `dsh-tools` 里两张平行的表：

- `SDK_RENDERERS`（index.ts）把语言映射到它的 `tools:sdk` 渲染器——`typescript → renderToolsSdk`、`python → renderToolsSdkPy`。`tools:sdk` 段读取所加载运行时的语言并选出渲染器；`requireCodeRuntime` 拒绝其语言不在表中的 `mode: code`/`both` 运行时，并列出已知语言。
- `RUN_CODE_FLAVORS`（code-mode.ts）把语言映射到它那两条面向模型的 `run_code` 字符串（工具 `description` 与 `code` 参数描述），使一种语言的 SDK 段与它的传输 schema 始终一致。

两张表在使用前都以 `Object.hasOwn` 读取，这样名为 `toString`/`constructor` 的语言不会把继承自 `Object.prototype` 的成员解析成渲染器。两个守卫的可达性不同：`SDK_RENDERERS` 的段内守卫不可达，因为 `requireCodeRuntime` 已在同一回调更早处校验过同一张 `const` 表（它带 `/* v8 ignore */`）；而 `RUN_CODE_FLAVORS` 的守卫是主要的、可公开到达的拒绝路径——在语言有渲染器却无 flavor 表项的运行时下读 `ctx.tools.schemas()` 即到达，且有测试覆盖。schema 发射通过 `peekRuntime()` 而非 `requireRuntime()` 读取运行时：`undefined`（无运行时，即永不喂给模型的 doc-catalog schema 采集）降级到 TypeScript flavor，而挂载了未知语言则 fail loud——这不是下方被否决的静默回退，那指的是为真实运行时发出错误语言的 SDK。新增一门后端语言就是两条表项加它的渲染器——不动 `agent-loop`，也不动注册表结构。

`code-mode.ts` 只依赖运行时 seam（`@deepseek-ai/dsh-code-runtime`），绝不依赖具体后端；分发在运行时按 `runtime.language` 进行。因此工具层独立于协议和后端 PR 落地——它只需要 seam 的 `language` 字段，而该字段已在 master 上。

### Python SDK 渲染器

`py-types.ts` 渲染 `jsonSchemaToTs` 所覆盖的同一套统一工具 schema 词汇，目标为 Python：`jsonSchemaToPy` 为每个 JSON-schema 节点发出一个类型表达式，`renderToolsSdkPy` 为每个可见工具的参数与规范输出装配具名 `TypedDict`，再加一个带用法说明的 `tools` 对象，与 TypeScript 形态等价。不支持的原始构造在装配时降级而非抛错，与 TypeScript 渲染器的契约一致。输出是确定性的——工具按字典序排列，工具集不变时文本逐字节相同——因此 prompt 保持 prefix-cache 友好。

`renderType` 先用 `assertSupportedJsonSchema` 整树校验一次、随后信任它，用单个 `try/catch` 把整个遍历兜住并降级为 `Any`——与姊妹渲染器 `ts-types` 在这个 typed 同进程 seam 上采取的「校验后信任」姿态一致（[Trust TypeScript at typed same-process seams](../../../../AGENTS.md)）。它有意不设任何针对「访问器在多次读取间变值」的防御（校验后成环、`const`/`enum` 的 TOCTOU、自引用函数）：输入是第一方注册（`defineTool` 字面量或 raw 注册）或从 wire 桥接而来的纯 JSON——前者按 AGENTS.md 受信任，后者是 `JSON.parse` 产物、物理上不可能携带访问器，且每次调用 `renderType` 都会整树重新校验——这类输入不可达，而在此加逐形态守卫会为静态接口所禁止的值破坏与 `ts-types`（没有这类守卫）的对称。`jsonSchemaToPy(schema: unknown)` 接受 `unknown` 并对畸形 schema 返回 `Any`——TypeScript 形态 `unknown` 的对应物——但它的契约是「降级不支持的 schema」，而非「扛住对抗性的可变 schema」。

## Alternatives considered

- **在 `ToolRegistry` 上加一个 `language` 配置字段。** 那样部署方就会有两处命名语言（所加载的运行时与 tools 配置）且可能相互矛盾；所加载的运行时是唯一真相来源，故注册表读取它而不复制它。
- **把 Python 后端 import 进 `code-mode.ts` 来检测它。** 那会把工具层耦合到具体后端，并迫使协议/后端 PR 先落地。按 `language` 运行时分发使该层保持后端无关、可独立发布。
- **为未知语言提供默认渲染器。** 静默回退会在比如 Ruby 运行时上发出 TypeScript SDK——模型会看到错误语言的指令。在装配处 fail loud 是本仓库对错误配置的立场。

## Consequences

新增一门后端语言就是两条表项——一个 `SDK_RENDERERS` 渲染器加一个 `RUN_CODE_FLAVORS` 表项——再加渲染器本身，不动 `agent-loop`，也不动注册表结构。两张表（`SDK_RENDERERS`、`RUN_CODE_FLAVORS`）必须同步：某语言只在其一而不在另一是潜在的不一致，`Object.hasOwn` 守卫会把它变成一次 loud failure，而不是错误语言的 prompt。工具层不依赖任何具体后端，因此它能先于 Python 协议和后端在 master 上落地并可测；代价是在该后端发布前无法真正端到端跑一个 `python` 运行时，故本 PR 的覆盖是 unit 级（渲染器输出与分发/拒绝路径），而非真实的 Python 运行。
