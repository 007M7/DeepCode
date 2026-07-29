# examples/：开箱可运行的演示组合包

[English](README.md) | 中文

预先组合的插件 bundle（组合包），供轻量叶节点 `cordis.yml` 加载，无需手工组装主干和前端入口。这些是 **演示／参考** 包（package）；npm 名称的 `-demo` 后缀把每个包标为非产品表层，直接查看包名即可辨认。仓库根目录 [`examples/`](../../examples/AGENTS.md) 下的可运行叶节点与 [Python SDK 运行时](../../python/sdk-runtime/README.md) 是消费方；每个消费方都只包含可替换后端和一个组合包入口。

| 包 | npm 名称 | 角色 |
|---|---|---|
| `agent-spine-demo/` | `@deepseek-ai/dsh-agent-spine-demo` | 不含执行器和 UI 的 agent（智能体）主干，打包为一个组合包插件，带后备会话标题和可选择启用的持久化目标栈 |
| `tui-demo/` | `@deepseek-ai/dsh-tui-demo` | 全屏终端应用组合包：主干 + 持久化目标 + `/goal` 命令 + JSONL 持久化 + `dsh-tui` + 预创建的 `main` agent；没有 bin，由 [`dsh`](../../apps/cli/README.md) CLI（命令行界面）启动 |
| `cli-demo/` | `@deepseek-ai/dsh-cli-demo` | 无头单次应用：主干 + JSONL 持久化 + 预创建的 `main` agent，提供文本和 DSH 原生 JSON 输出 |
| `acp-demo/` | `@deepseek-ai/dsh-acp-demo` | ACP（Agent Client Protocol）自动化服务器应用：主干 + 持久化目标 + JSONL 持久化 + [`acp`](../acp/acp/README.md) 桥接层（无 stdout logger），带启动 `bin` |
| `jsonrpc-demo/` | `@deepseek-ai/dsh-jsonrpc-demo` | 只有 bin 的运行时，用于启动外部 `cordis.yml`，供 stdio JSON-RPC SDK 客户端使用 |

`agent-spine-demo` 是共享组合包；`tui-demo`、`cli-demo` 和 `acp-demo` 分别将它与全屏终端、无头单次和 ACP 自动化前端入口组合。`cli-demo` 与 `acp-demo` 拥有各自的启动 bin；`tui-demo` 只交付组合包插件，产品 [`dsh`](../../apps/cli/README.md) CLI 是它的终端前端入口。`jsonrpc-demo` 自身不挂载任何组合，而是启动部署的 `cordis.yml` 所指名的任意插件树；Python SDK 运行时会启动它。

这些 **不是** 产品 API。它们打包的主干组件位于 [`core/`](../core/README.md)，人类／SDK 通道和启动粘合代码位于 [`ui/`](../ui/README.md)，自动化传输位于 [`acp/`](../acp/README.md)，可替换后端位于各自能力组；演示组合包只选定其中一种具体组合。可以自由替换或 fork。

不要将此组与仓库根目录的 [`examples/`](../../examples/AGENTS.md) 混淆：该目录存放可运行的 `cordis.yml` **叶节点**；此组存放这些叶节点加载的 **组合包**。

## jsonrpc bin／exe 名称是历史遗留

`jsonrpc-demo` 已像同级包一样重命名，但其 bin 仍为 `dsh-jsonrpc-agent`，单文件可执行程序仍为 `dsh-jsonrpc-agent-pkg`（在 [Python 分发](../../python/sdk-runtime/README.md)各处被引用）。这些名称属于 SDK 的运行时启动表层；只有 SDK 统一该启动流程时才会协调它们，而不会在此次移动中处理。
