# RFC：ACP subagent 后端（进程外委派）

Status: implemented

[English](2026-06-22-acp-subagent-backend.md) | 中文

## 问题

subagent seam（见 [seam RFC](2026-06-21-subagent-capability-seam.md)）的设计使得多个后端可以按名称共存于 `ctx.subagents` 上。进程内后端（`-spawn`/`-fork`）将子 agent 作为同一个 Cordis 上下文上的第二个 `Agent` 运行——开销低，但子 agent 与父 agent 共享进程、模型客户端和工具。seam 的核心意义正是还要支持通过协议到达的进程外子 agent，以证明这层抽象能跨越进程边界泛化。本 RFC 添加第一个此类后端：一个 ACP（Agent Client Protocol）客户端。

## 决策

`@deepseek-ai/dsh-subagent-acp` 注册一个 `SubagentProvider`，将每个子 agent 运行在一个**派生的子进程**中，以 ACP *客户端*身份驱动。它是现有服务端桥接 `@deepseek-ai/dsh-acp`（ACP *agent*）的方向反转孪生体：桥接**应答** `initialize`/`newSession`/`prompt`；本后端**调用**它们并**实现** `Client` 回调（`sessionUpdate`、`requestPermission`）。将配置的 spawn 命令指向 `acp-agent` 示例，即可让 harness 与自身进程对话。

### 每次运行启动新进程

每次 `start` 都 spawn 一个新子进程，运行恰好一个 ACP 会话（`initialize` → `newSession` → `prompt`），`dispose` 杀死子进程并等待其退出。这是最简单的生命周期，与进程内「每次运行一个子 agent」的形态一致。

### 最小客户端桩

客户端不声明任何可选能力（无 `fs`、无 `terminal`）：子 agent 在自己的进程中自行处理文件/终端访问。`session/update` 通知被消费——后端累积 `agent_message_chunk` 文本作为结果输出，在本次实现中忽略其余内容（思考、工具调用卡片），仅呈现子 agent 的最终回答。`session/request_permission` 由配置的策略自动应答（`reject` 拒绝每个提示，`allow` 通过第一个 allow 形态的选项批准）——本次实现不将任何提示呈现给人类。将 `fs`/`terminal` 代理回父进程（共享工作区模式）仍是未来工作，如 seam RFC 所述。

### 无启动时能力

提供方的 `capabilities` 全部为 `false`。进程外子 agent 无法遵守父 agent 的 `maxDepth`（它无法访问 `parent.options.subagentDepth`）或 `toolFilter`（它拥有自己的工具注册表），且本次实现未实现 `outputSchema`。服务在 `start` 运行之前就会拒绝需要上述任何能力的请求。后端仅注入 `subagents`（而非 `ctx.agents`），并忽略 `request.parent`。

### StopReason 映射

ACP `StopReason` → harness `SubagentStopReason`：`end_turn`→`completed`、`max_tokens`→`max-tokens`、`refusal`→`refusal`、`cancelled`→`aborted`、`max_turn_requests`→`error`（无对等语义——任务未完成）、未知→`error`。spawn/传输/RPC 失败解析为 `error`（如果已请求取消则为 `aborted`）；按 seam 契约，`result` 永远不会因子 agent 级别的失败而 reject。

### 安全：清洗子进程环境

子 agent 是独立进程，因此会继承环境变量。凭证形态的环境变量（`/KEY|SECRET|TOKEN/i`）默认**不**转发——父 harness 自身的密钥不得隐式泄漏到派生进程中（与 bash 执行器采用的策略相同）。子 agent **自身**的凭证（它需要模型密钥）通过 `config.env` **显式**提供，在清洗之后叠加，因此有意传入的 `DEEPSEEK_API_KEY` 得以保留，而偶然存在的 `AWS_SECRET_ACCESS_KEY` 不会。子进程 stderr 继承到父进程的 stderr（诊断信息自然浮现）；spawn 级别的 `error` 事件（如命令不存在时的 ENOENT）被捕获并与 ACP 驱动竞争，使错误命令解析为 `error` 而非以未处理错误崩溃父进程。

## 测试

- **无需密钥的单元/集成测试：** 一个脚本化的 ACP 子进程通过真实 stdio 测试 prompt/output 流、所有 stop-reason 映射、信号与 dispose 取消（包括 pre-abort、pre-session 竞态和管道断裂场景）、两种权限策略、被忽略的非消息更新、命令缺失时的清理、提供方重载，以及命名空间导出。
- **需要密钥的 e2e 测试：** 后端 spawn 真实的 ACP 示例；其模型回答 `PONG`、写入 `proof.txt`，父进程验证该文件。
- **快照缺口：** 每个 ACP 子 agent 是独立进程、拥有自己的回放会话，不同于进程内的按会话回放。确定性 mock-server 覆盖已有；`TODO(acp-subagent-replay)` 跟踪父 agent 对回放中子 agent 的回放支持。

## 曾考虑的替代方案

### 为何继续使用 SDK 0.25.1？

后端仅需 `ClientSideConnection`、`ndJsonStream`、`PROTOCOL_VERSION` 和客户端协议类型，0.25.1 均已支持。0.28 的 fluent API 需要在 ACP 层同时迁移客户端和服务端连接类，但不会改善本后端，因此升级作为独立变更保留。

### 为何不使用持久子进程？

持久进程池（跨运行复用热子进程）是一项性能优化，推迟到未来工作——它引入会话生命周期和崩溃恢复的复杂性，本次实现不需要；每次 `start` spawn 新子进程与进程内「每次运行一个子 agent」的形态一致。

## 后果

每次运行都要付出一个新子进程的开销（spawn + `initialize` + `newSession`）。父 agent 仅呈现子 agent 的最终回答：`session/update` 中的思考和工具调用卡片被消费后丢弃，权限提示永远不会到达人类——由配置的策略应答。子进程环境默认经过凭证清洗，因此其自身的模型密钥须通过 `config.env` 显式提供。

## 未来提供方

同样的进程外 spawn/prompt/stream/cancel 形态可泛化到 seam RFC 中列出的其他传输方式——A2A、Codex app-server 和 Claude Code Agent SDK——每个都是按名称注册的兄弟提供方。ACP 后端证明了 seam 支持跨进程边界；其余在机制上类似。
