# RFC：Subagent 能力 seam

Status: implemented

[English](2026-06-21-subagent-capability-seam.md) | 中文

> 完整 seam 已交付：`dsh-subagent` 接口、`dsh-subagent-mock` 测试后端与 `dsh-tool-subagent` 消费方；两个进程内后端（`dsh-subagent-spawn`、`dsh-subagent-fork`）；嵌套 agent 快照基础设施（[按会话快照回放](../testing/2026-06-22-subagent-snapshot-replay.md)）；以及进程外 `dsh-subagent-acp` 后端（[其 RFC](2026-06-22-acp-subagent-backend.md)）。

## 问题

harness 有一个长期搁置的 subagent seam：一个 agent 将工作委派给另一个 agent。意图已在 `Agent`/`AgentLoop` 接口中勾勒（[packages/core/agent/src/types.ts](../../../../packages/core/agent/src/types.ts)、[packages/core/agent-loop/src/index.ts](../../../../packages/core/agent-loop/src/index.ts)）：创建选项引用父 agent（fork = 用父会话的事件日志为子会话播种；spawn = 全新会话），子 agent 以 `Agent` 句柄返回，使 steering（中途引导）和事件订阅统一工作。本 RFC 实现该 seam；上方横幅列出了已交付的内容。

决定整体设计走向的核心需求是：**多种 subagent 实现必须在运行时共存**。一个父 agent 可能在同一个会话中既需要一个廉价的进程内子 agent 处理有限范围的子任务，又需要一个隔离的进程外子 agent（通过 ACP）。我们预见的传输方式：

- **进程内**：在同一个 `Context` 上创建子 `ReactLoopAgent`（最廉价，且鉴于已有的 agent 工厂几乎零成本）；
- **ACP**：作为 ACP *客户端*驱动另一个 agent 进程（可以是自身的另一个实例）；
- 后续：**A2A**、**Codex app-server** 与 **Claude Code Agent SDK**——每种都与 ACP 后端相同的进程外「启动子 agent、发送提示词、流式更新、取消」形态。

## 曾考虑的替代方案

### 为什么不用 bash seam 的形态

bash seam（[能力 seam](../../implemented/architecture/2026-06-13-capability-seams.md)）在每个 context 中只注册一个 `BashExecutor`；加载第二个会抛异常。这对 bash 是正确的（一台机器、一种执行命令的方式），但对这里是错的：共存才是需求。因此 subagent 服务是一个**命名提供方注册表**：每个实现以唯一名称注册，调用方按名称选取。这与 **LLM 适配器注册表**（`LlmService.registerAdapter`）同构，而非单服务的 bash 执行器。seam 仍然是三包结构（接口 / 实现 / 消费方）；唯一不同的轴是「单实现 vs. 多实现」。

## 决策

### 三包 seam

新增包组 `packages/subagent/`：

| 包 | 角色 |
|---|---|
| `@deepseek-ai/dsh-subagent` | 接口：`SubagentService`（`ctx.subagents`）、`SubagentProvider`、`SubagentRun`、请求/结果/能力词汇表、`subagent/*` 事件 |
| `@deepseek-ai/dsh-subagent-spawn` | 实现：通过 `ctx.agents.create` 创建全新的进程内子 agent |
| `@deepseek-ai/dsh-subagent-fork` | 实现：以父会话日志快照为种子的进程内子 agent |
| `@deepseek-ai/dsh-subagent-acp` | 实现：作为 ACP 客户端驱动已配置的子进程 |
| `@deepseek-ai/dsh-subagent-mock` | 支撑：脚本化的提供方，用于通过真实加载路径测试 seam |
| `@deepseek-ai/dsh-tool-subagent` | 消费方：基于 `ctx.subagents` 的面向模型的 `subagent` 工具 |

### 基本原语：异步 `start → SubagentRun`

提供方暴露 `start(request) → Promise<SubagentRun>`。完成后发布一个就绪的子 agent 并将其运行句柄转交给调用方。一个信号覆盖就绪前后的取消；`dispose()` 取消剩余工作并等待静默。启动失败时清理部分资源，不发出生命周期事件。`start` 是传输无关的；`spawn` 仅命名全新进程内后端。

### 两类可选能力，两种发现方式

- **启动时特性**（`outputSchema`、`depthLimit`、`toolFilter`、`persona`）挂在静态 `provider.capabilities` 描述符上。服务在委派之前检查每一项请求的特性，若提供方不支持则**大声拒绝**（`SubagentError('UNSUPPORTED_CAPABILITY')`），绝不「接受后静默忽略」。它们必须在 run 存在之前被检查，这就是为什么不能做成运行时方法。
- **运行时特性**（通过 `sendMessage` 进行 steering、通过 `resume` 进行后续交互）是 `SubagentRun` 上的**可选方法**。方法的存在即是能力，TypeScript 窄化即是发现机制：消费方不经窄化就无法调用不存在的方法，因此不存在静默降级路径，也不需要一个单独的 flags 对象来保持同步。

### Fork 与 fresh 是独立后端，而非一个 flag

全新子 agent 和 fork 子 agent 是独立的提供方，而非请求上的 flag。`dsh-subagent-spawn` 启动隔离的子 agent；`dsh-subagent-fork` 以仅包含已完成父轮次的平衡前缀为种子。进行中的轮次被排除，因为其 subagent 调用尚无结果，无法构成有效的回放历史。

### 子 agent 隔离与父日志

每个 subagent 运行在自己的 **`Session`** 中（独立 id、`parentSession` 谱系），独立持久化。父日志仅记录 spawn 的 `tool/call` 及其 `tool/result`（子 agent 的最终输出）；子 agent 的内部步骤和工具调用留在子 agent 自己的会话中，从不注入父日志。这是唯一在所有传输方式下行为一致的设计：ACP 子 agent 的内部事件物理上无法注入我们的父日志，因此让进程内行为保持一致，使 seam 保持传输无关。

### 同步收集（第一版）

`dsh-tool-subagent` 将其执行信号传给 `start()`，等待子 agent 结果，并在 `finally` 中 dispose 该 run。非完成态的结果变为错误结果，而非成功的部分输出。这个前台消费方不使用 run 的可选 steering 方法。

### 提供方选择是配置，不面向模型

`dsh-tool-subagent` 绑定到恰好一个提供方名称（`Config.provider`）；模型只看到 `{ description, prompt }`。若要暴露多种传输方式，多次加载该工具插件，每次绑定不同的提供方和不同的 `toolName`（工具注册表拒绝重名）。*服务*持有多提供方注册表；*工具*选取其中一个。本版 schema 中没有 provider/type 参数。

## 测试

seam 通过真实的 Cordis Loader/export 路径测试，这能捕获 [postmortem 0001](../../../postmortem/0001-acp-default-export-drops-inject.md) 中描述的 export 形状失败。注册表测试覆盖重载安全性、重名和启动时能力拒绝；嵌套 agent 场景通过[按会话快照回放](../testing/2026-06-22-subagent-snapshot-replay.md)进行无密钥回放；进程内后端还有真实循环的单元测试和带密钥的 e2e。

## 后果

- **递归。** 若无限制，进程内子 agent 能看到委派工具并递归。进程内后端实现了可选的绝对深度限制和有作用域的实时全局 `toolFilter`；ACP 声明这两项能力为关闭并拒绝此类请求。[subagent 组合控制 RFC](2026-07-12-subagent-persona-tool-filter-and-depth.md) 拥有它们的确切语义和安全限制。
- **阻塞父轮次。** 同步收集在子 agent 的整个持续期间保持父 agent 的 `runStep` 打开。这对第一版是可接受的；**后台 / 轮询 / 溢出语义推迟到未来的重新设计，该重新设计将统一 subagent 与 bash 的长时运行工具处理**（一个 sub-agent 和一个长时间运行的 `bash` 后台任务面临相同的「模型启动了一个慢操作，之后如何收集结果」问题，应共享一套机制而非各自发明）。
- **实时进度。** 本版仅暴露生命周期事件和最终结果；逐分片的子→父更新流推迟到后台重新设计。
- **ACP 客户端接口。** 将 ACP 子 agent 的 `fs`/`terminal` 代理回父 agent（共享工作区模式）是后续工作；第一版不声明这两项能力，子 agent 在自己的进程中自给自足。
