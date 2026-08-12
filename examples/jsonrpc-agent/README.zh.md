# jsonrpc-agent

[English](README.md) | 中文

面向 Python SDK 内置 JSON-RPC 运行时的无人值守编码 agent（智能体）组合。它有意不加载终端 UI、控制台日志记录器、批准界面或用户交互工具，因为 stdout 属于 SDK 协议，轮次由 SDK 驱动。

面向模型的工具为：

- `bash`，仅前台
- `read`、`write` 和 `edit`
- `subagent`，使用一个在进程内以前台方式运行的 spawn 提供方
- `todo_write`

周边运行时还加载 JSONL 会话持久化和自动上下文压缩（context compaction）。`maxTokensAsSuccess` 将受 token 上限限制的模型轮次保留为已接受的评估结果，同时保留其 `max-tokens` 原因。

## 运行时环境

| 变量 | 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | 传给 OpenAI 兼容宿主端点的凭据 |
| `DEEPSEEK_BASE_URL` | `dsh-llm-deepseek` 使用的宿主端点 |
| `DSH_CWD` | bash 和文件系统工具使用的 agent workspace |
| `DSH_CONTEXT_WINDOW` | 极简变体中为 `DSH_MODEL` 目录项记录的上下文容量 |
| `DSH_MAX_TOKENS_AS_SUCCESS` | `true`（默认）接受受 token 上限限制的结果；`false` 将其报告为错误 |
| `DSH_MODEL` | `minimal.py` 使用的默认模型；`--model` 优先 |
| `DSH_SESSION_ROOT` | JSONL 会话目录 |
| `DSH_SYSTEM_PROMPT` | 由部署提供的编码人格 |

通过 Python SDK 的 `cordis` 选项或 `DSH_CORDIS_CONFIG` 传入配置路径。内置可执行文件已携带此文件中指定的每个插件；目标机器无需 Node.js。

## 极简变体

[`minimal.cordis.yml`](minimal.cordis.yml) 是 Web `minimal` preset 的完整独立版本。`DSH_SYSTEM_PROMPT` 选择它的系统提示词，未设置时使用 `You are a helpful software engineer assistant.`，且不挂载上下文压缩插件。面向模型的工具严格只有：

- 所有者作用域内持久化的 `bash`
- 提供 `view`、`create`、`str_replace` 与 `insert` 的 `str_replace_editor`

它组合了内置运行时所需的本地 PTY、裸 `fs-local` 后端、供持久 Bash 使用的 danger-full-access 策略，以及未压缩的 JSONL 持久化。[`minimal.py`](minimal.py) 通过 Python SDK 运行该配置，并把 `DSH_MODEL` 作为默认模型；[Python SDK 教程](../../docs/user/guide/python-sdk.md)以此配置介绍设置方式、会话管理与安全边界。
