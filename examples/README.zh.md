# 示例

[English](README.md) | 中文

<<<<<<< HEAD
展示 harness 如何组装的可运行演示（不是 workspace）。每个示例都是一个 **轻量叶节点**：一份选择可替换后端、加载一个应用包（package）并可添加可选产品工具的 `cordis.yml`。组合和启动粘合代码位于 [`@deepseek-ai/dsh-tui-demo`](../packages/examples/tui-demo)、[`@deepseek-ai/dsh-cli-demo`](../packages/examples/cli-demo)、[`@deepseek-ai/dsh-acp-demo`](../packages/examples/acp-demo) 及它们共享的 [`@deepseek-ai/dsh-agent-spine-demo`](../packages/examples/agent-spine-demo) 组合包中。没有 `start.ts`；终端 `demo:*` 脚本通过 [`dsh`](../apps/cli/README.md) CLI（命令行界面）启动（该 CLI 挂载 `tui-demo` 组合包），无头／ACP（Agent Client Protocol）脚本则调用 `cli-demo`/`acp-demo` bin。
=======
展示 harness 如何接线的可运行演示（不是 workspace）。每个示例都是一个 **轻量叶节点**：要么是一份选择可替换后端、加载一个应用包（package）的 `cordis.yml` 配置树，要么是一个 **overlay**——由 `dsh --config` 叠加到交付组合（[`apps/cli/base.cordis.yml`](../apps/cli/base.cordis.yml) 加一份 surface overlay）之上的 patch 列表。成组的组合位于 [`@deepseek-ai/dsh-cli-demo`](../packages/examples/cli-demo)、[`@deepseek-ai/dsh-acp-demo`](../packages/examples/acp-demo) 及它们共享的 [`@deepseek-ai/dsh-agent-spine-demo`](../packages/examples/agent-spine-demo) 组合包中；`dsh` 的各 surface 则改用平铺 config tree。没有 `start.ts`；终端 `demo:*` 脚本通过 [`dsh`](../apps/cli/README.md) CLI（命令行界面）启动，无头／ACP（Agent Client Protocol）脚本则调用 `cli-demo`/`acp-demo` bin。
>>>>>>> a1c6a2c3f (refactor(cli)!: one shared base config with per-surface overlays)

## headless-agent

非交互式 agent（智能体）演示：接受一个位置参数形式的任务，在 `@deepseek-ai/dsh-cli-demo` 应用上运行一个完整模型／工具轮次，持久化新会话，打印 `text`、`json` 或 `stream-json`，然后退出。

运行：`pnpm run demo:headless "task"`（需要 `DEEPSEEK_API_KEY`）。输出契约、安全边界和快照套件详见 [headless-agent/README.md](headless-agent/README.md)。

## code-mode

叠加在交付 TUI 之上的 **overlay**：把面向模型的注册表收敛为 `run_code` 这一个传输，使模型把工具工作批量写进 TypeScript 程序，而不是每轮一次调用。

运行：`pnpm run demo:code-mode`（需要 `DEEPSEEK_API_KEY`）。详见 [code-mode/README.md](code-mode/README.md)。交互式 agent 本身不再是示例：`pnpm run demo:tui` 在共享 base 之上启动 [`apps/cli/tui.cordis.yml`](../apps/cli/tui.cordis.yml)，其 PTY 与快照场景位于 `apps/cli/tests/`。

## jsonrpc-agent

通过 Python SDK 驱动的无人值守编码 agent：JSON-RPC stdio、仅前台 `bash`、`read`/`write`/`edit`、一个前台 `subagent`、`todo_write`、JSONL 持久化和压缩。它不包含终端 UI、stdout 日志、批准、skill（技能）和后台任务控制。详见 [jsonrpc-agent/README.md](jsonrpc-agent/README.md)。

## web-cordis

**自指** 演示：编码主干加 [`@deepseek-ai/dsh-tool-cordis`](../packages/cordis/tool-cordis)，其三个工具（`cordis_inspect`/`cordis_mount`/`cordis_unmount`）使 agent 可以检查当前 DSH 进程、挂载模型编写的临时插件（事件监听器、一个全新工具，或一个供另一个临时插件注入的服务），并再次卸载它们。这些插件只存在于内存中，共享一个内部 `cordis-dynamic` fiber 子树；`ctx.fs`/`ctx.web` 仅作为它们可用的能力提供方。

<<<<<<< HEAD
使用 `pnpm run demo:cordis` 运行 TUI，使用 `pnpm run demo:cordis web` 在 `http://127.0.0.1:3081` 启动浏览器 UI，或使用 `pnpm run demo:cordis acp` 启动 ACP 服务器（三者均需 `DEEPSEEK_API_KEY`）。分阶段演示脚本详见 [cordis-agent/README.md](cordis-agent/README.md)，设计与沙箱注意事项详见[工具集 Agent Note（agent 决策记录）](../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)。
=======
使用 `pnpm run demo:cordis` 在 `http://127.0.0.1:3081` 启动浏览器 UI，或使用 `pnpm run demo:cordis acp` 启动 ACP 服务器（两者均需 `DEEPSEEK_API_KEY`）。设计与沙箱注意事项详见[工具集 Agent Note](../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)。
>>>>>>> a1c6a2c3f (refactor(cli)!: one shared base config with per-surface overlays)

## acp-agent

一个通过 JSON-RPC stdio 公开、作为 **Agent Client Protocol (ACP)** 自动化服务器运行的 agent，由 [`@deepseek-ai/dsh-acp-demo`](../packages/examples/acp-demo) 提供。程序化客户端可以创建新会话、发送文本提示词、消费已提交的 assistant 文本、回答一次性权限请求并取消工作。它拥有 ACP 无密钥快照套件。

运行：`pnpm run demo:acp`（需要 `DEEPSEEK_API_KEY`）；`pnpm run demo:code-mode acp` 通过 `code-mode.cordis.yml` 覆盖以 Code Mode 启动同一服务器。协议与快照测试契约详见 [acp-agent/README.md](acp-agent/README.md)。

默认 `cordis.yml` 组合 [`@deepseek-ai/dsh-sandbox-local`](../packages/sandbox/sandbox-local)、[`@deepseek-ai/dsh-bash-sandbox`](../packages/bash/bash-sandbox) 和 [`@deepseek-ai/dsh-user-approval`](../packages/ui/user-approval)。`workspace-write` 将 bash 和文件系统变更限制在每个会话 workspace 中；请求更广泛沙箱权限的重试会通过 ACP 触发一次性的机器权限请求。
