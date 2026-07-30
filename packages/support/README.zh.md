# support/：开发／测试／示例基础设施

[English](README.md) | 中文

这些包（package）用于开发、测试和示例，而非作为产品 API 发布。它们是实际的工作区包（具备类型、经过测试，并受覆盖率门禁约束），但具有**较低的兼容性预期**：当其背后的开发需求变化时，它们可以改变或被移除，无需像产品包那样谨慎执行弃用流程。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `acp-snapshot/` | ACP（Agent Client Protocol）测试工具包：共享子进程/客户端启动器、快照 harness、规范化器和套件工厂 | （库：由 ACP e2e 和 `*.snapshot.ts` 套件导入） |
| `agent-loop-testkit/` | 为验证具体 agent loop（智能体循环）的测试挂载共享先决条件 | （库：由 AgentLoop 集成测试导入） |
| `invariants/` | 用于开发诊断的运行时事件契约断言 | （监听 `session/*`、`agent/*`） |
| `loader-smoke/` | 共享的真实 Loader 子进程 harness，用于无密钥示例冒烟测试 | （库：由示例 e2e 套件导入） |
| `llm-mock-server/` | 可编程的 OpenAI 兼容 HTTP/SSE（Server-Sent Events）故障服务器与 CLI（命令行界面），用于 LLM（大语言模型）恢复测试 | （独立服务器和测试库） |
| `llm-replay/` | 录制/回放适配器：通过已记录的会话 JSONL 对 `llm/stream` 进行短路处理（无密钥快照测试） | （监听 `llm/stream`） |

`invariants` 是开发支持，但没有环境条件限制：无论在何处注册，它都会运行；默认 `dsh-agent-spine-demo` bundle 无条件挂载它。`agent-loop-testkit` 为手工构建的 AgentLoop 测试集中管理必需服务主干，而不负责其 agent loop 或场景。`llm-replay` 支撑演示和受逐文件覆盖率门禁约束的快照测试层，`llm-mock-server` 则通过确定性 HTTP/SSE 故障驱动真实提供方适配器。`acp-snapshot` 包含 ACP 子进程/客户端边界以及快照 harness、规范化器和套件机制，`loader-smoke` 负责无密钥示例 e2e 套件使用的并列真实 Loader 启动边界。只有当某个包获得文档记载的产品消费方时，它才会从 `support/` 转入产品分组。
