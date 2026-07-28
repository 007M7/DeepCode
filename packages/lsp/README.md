# lsp/ - LSP capability family

English | [中文](README.zh.md)

The language-server capability seam: an abstract LSP interface, a generic stdio provider, and the model-facing `lsp` tool. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `lsp/` | Abstract LSP seam (provider registry by branded id + extension mapping, per-query selection, vocabulary, `LspError`) | `ctx.lsp` |
| [`lsp-local/`](lsp-local/README.md) | Generic multi-server local backend (spawn, JSON-RPC, transient-open queries) | (registers providers on `ctx.lsp`) |
| [`lsp-e2b/`](lsp-e2b/README.md) | Remote E2B backend (remote source reads and servers, byte-framed stdio bridge) | (registers providers on `ctx.lsp`) |
| `tool-lsp/` | Model-facing `lsp` tool (four operations, one-based UTF-16 cursor coordinates) | (registers on `ctx.tools`) |

The interface lives at `lsp/lsp/`. The seam exposes exactly four semantic operations — `goToDefinition`, `findReferences`, `goToImplementation`, `hover` — and no generic JSON-RPC escape hatch, so a provider swap does not change how the model asks for navigation and no protocol payload or unreviewed mutation reaches the model contract. Providers register **capabilities**, not tools; `tool-lsp` is the only owner of the model-facing name, schema, prompt guidance, and presentation.

See the [LSP capability seam Agent Note](../../.agents/notes/implemented/architecture/2026-07-15-lsp-capability-seam.md) for the protocol design and the [E2B extension note](../../.agents/notes/implemented/feature/2026-07-28-e2b-interactive-semantic-code-runtime-poc.md) for the remote process/filesystem boundary.
