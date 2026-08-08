# acp/：Agent Client Protocol 自动化

[English](README.md) | 中文

ACP 组通过 Agent Client Protocol 把 harness agent 暴露给编程客户端。它是互操作传输层，不是展示或人机交互层；配对的进程外 subagent *客户端*在 [`subagent/subagent-acp`](../subagent/subagent-acp/README.md)，因为它实现的是 subagent 提供方接口。

| 包 | 职责 |
|---|---|
| [`acp/`](acp/README.md) | 仅面向自动化的 ACP 服务器。 |

服务器契约见 [`acp/README.md`](acp/README.md)。
