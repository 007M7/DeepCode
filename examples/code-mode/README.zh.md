# code-mode

[English](README.md) | 中文

在交付的 TUI 之上启用 Code Mode：模型不再每轮调用一个工具，而是为单一的 `run_code` 工具编写 TypeScript 程序，并在 worker 线程中执行。

本叶节点是一个 **overlay**，而不是配置树。`dsh --config` 会 include 共享的 [`apps/cli/base.cordis.yml`](../../apps/cli/base.cordis.yml)，应用 [`tui.cordis.yml`](../../apps/cli/tui.cordis.yml) surface overlay，再应用本文件——三者都是同一 include 层级上的平级 patch 列表。

## 运行

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm run demo:code-mode
```

`pnpm run demo:code-mode acp` 通过 ACP 传输启动同样的思路，配置位于 [`examples/acp-agent/code-mode.cordis.yml`](../acp-agent/code-mode.cordis.yml)。

## 该 overlay 改动了什么

| 配置项 | 改动 |
| --- | --- |
| `tools` | `mode: code`——线上注册表收敛为 `run_code`，外加其生成的 TypeScript SDK 提示词片段 |
| `system-prompt` | 指示模型把相关工具调用批量写进一个程序的 persona |
| `tui` | Code Mode 的欢迎行 |
| `code-runtime` | 新插入：`@deepseek-ai/dsh-code-runtime-worker`，即 `run_code` 的执行 worker 线程 |

其余部分——模型后端、执行器、文件系统工具、持久化、委派与前端入口——全部来自 base 与 TUI overlay。

配置 patch 会整体替换该配置项的 `config`，而非与其合并，因此上表每一行都必须重述自己拥有的全部键。若某个 patch 的 `id` 不再匹配任何配置项，Loader 只会告警并跳过它，所以在 base 或 surface overlay 中重命名配置项时必须同步更新本文件。

## Model Experience（模型体验）

模型看到的是一个工具，而不是完整的原生注册表。其请求携带 `run_code` 的 schema 以及一段生成的 TypeScript SDK 说明，用于描述可调用面。这会在前置阶段消耗更多提示词 token，但把多个单次调用的轮次压缩为一个程序——往返更少，transcript 中的中间工具结果也更少。由于工具目录属于被缓存的请求前缀，切换模式会使该会话的 KV 缓存失效。
