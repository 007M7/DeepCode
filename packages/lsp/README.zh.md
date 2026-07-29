# lsp/ - LSP 能力家族

[English](README.md) | 中文

语言服务器能力 seam：抽象 LSP 接口、通用 stdio 提供方，以及面向模型的 `lsp` 工具。这些全是**产品**包。

| 包 | 职责 | ctx key |
|---|---|---|
| `lsp/` | 抽象 LSP seam（按品牌化 id + 扩展名映射组织的提供方注册表、逐查询选择、词汇、`LspError`） | `ctx.lsp` |
| `lsp-local/` | 通用多服务器本地后端（spawn、JSON-RPC、查询时临时打开文档） | （在 `ctx.lsp` 上注册提供方） |
| `tool-lsp/` | 面向模型的 `lsp` 工具（四种操作、从 1 开始的 UTF-16 光标坐标） | （注册到 `ctx.tools`） |

接口位于 `lsp/lsp/`。该 seam 恰好公开四种语义操作：`goToDefinition`、`findReferences`、`goToImplementation`、`hover`，且不提供通用 JSON-RPC 逃生口；因此，替换提供方不会改变模型请求导航的方式，也不会让协议载荷或未经评审的修改进入模型契约。提供方注册的是**能力**而非工具；`tool-lsp` 是面向模型名称、schema、提示词指引和呈现的唯一 owner。

设计原理见 [LSP 能力 seam Agent Note（agent 决策记录）](../../.agents/notes/implemented/architecture/2026-07-15-lsp-capability-seam.md)，其中也解释了文档为何在每次查询时临时打开、本地主机为何通过 Node API 而非 `ctx.fs` 读取，以及扩展名归属为何在同一运行时内互斥。
