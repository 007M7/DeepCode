# @deepseek-ai/dsh-tool-subagent

[English](README.md) | 中文

基于一个已配置 `ctx.subagents` 提供方、面向模型的委派工具。更换提供方只会改变传输，不会改变执行契约。

## 提供方选择与生命周期

每个插件实例把一个 `provider` 绑定到一个 `toolName`；模型不会收到提供方选择器。如需公开另一种传输，请加载另一个名称不同的实例。工具只在其提供方存在时注册，从而避免对同级加载顺序和提供方重新加载的依赖。工具描述遵循 `provider.inheritsParentContext`：全新子 agent（智能体）需要独立提示词，而 fork 子 agent 已能看到父级已完成轮次。

前台调用会让执行信号贯穿启动和执行，等待 `run.result`，并且在返回前总会等待 `run.dispose()`。只有 `completed` 会返回规范值 `{ kind: 'foreground', runId, output: JsonValue[] }`，并渲染为相同的最终文本；中止、拒绝、token 上限和其他失败都会变成出错的工具结果，不包含局部输出。

设置 `run_in_background: true` 后，工具会在启动提供方前注册父级拥有的任务，并返回规范值 `{ kind: 'background', taskId }`，渲染为 `started background subagent task <id>`。任务拥有的信号覆盖待处理的启动阶段，以及启动调用返回后的子 agent。`task_kill` 和所有者 dispose（资源释放）会中止它。结算会等待启动回滚或子 agent dispose，然后把完成的最终文本映射为完成、中止映射为 `killed`、其他失败映射为 `failed`。任务不提供增量读取；通用任务工具负责后续状态、收集、取消和通知。见[后台 subagent Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-background-subagent-tasks.md)。

`toolFilter` 会改变子 agent 的全局工具层，但不是从父级派生的权限上限。见 [agent 作用域的安全非目标](../../../.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md#security-and-authority-are-non-goals)。

## 配置

| 键 | 含义 |
|---|---|
| `provider`（必填） | 提供方名称（`spawn`、`fork`、`acp` 等）。 |
| `toolName` | 面向模型的名称，默认 `subagent`；每个已加载实例必须不同。 |
| `enableRunInBackground` | 公开后台模式，默认 `true`；禁用时也会拒绝强制后台调用。 |
| `agentOptions` | 传给具体 provider 的子 agent `provider`、`model` 和正整数 `maxTokens`；进程内 provider 会用显式值覆盖继承的父级选项。 |
| `persona` | 每个子 agent 独立的 persona；要求提供方具备 `persona` 能力。 |
| `toolFilter` | 每个子 agent 独立的全局工具限制；要求提供方具备 `toolFilter` 能力。 |
| `maxDepth` | 绝对委派深度上限，默认 `3`（`0` 禁止委派）；数值上限要求 `depthLimit` 能力，缺失时挂载失败。对于预算由子 harness 拥有的进程外提供方，`'provider-managed'` 不发送上限。工具在达到上限时仍然可见；每次尝试启动都会检查调用 agent 的当前深度，被拒绝时返回出错的工具结果。 |

## 并发

前台调用与后台调用互斥。子 agent 可能共享父级工作区或外部资源，一元分类器无法证明同级委派的效果彼此不相交。见[并行工具调用 Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md)。

## 模型体验

### 工具 schema

#### 模型看到的内容

当提供方存在时，以当前实例配置的名称公开已生成的默认 [`subagent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent)。提供方是否继承上下文会改变工具描述和提示词描述；启用后台模式会添加 `run_in_background`。

#### Token 影响

每个父级请求支付固定 schema 成本；每个提供方实例增加一个 schema。

#### KV Cache 影响

只要提供方实例、名称、描述和 schema 不变，前缀就保持稳定。提供方注册生命周期可能从首个变化的工具定义开始，使父级复用失效。

### 前台结果

#### 模型看到的内容

调用会保留描述和提示词。成功时只包含子 agent 的最终文本；其他结果变为 `Error: <message>`。子 agent 中间步骤不会进入父级。

#### Token 影响

提示词和结果会留在父级历史中，直到上下文压缩（compaction）；子 agent 工作上下文留在子 agent 中。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 后台任务结果

#### 模型看到的内容

启动时精确返回 `started background subagent task <id>`。通用任务接口提供后续状态、最终输出、取消响应和通知。

#### Token 影响

确认消息会被保留；最终输出只在收集或注入时进入父级历史。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与延期工作

- **后台运行只公开最终输出**：子 agent 中间步骤留在子 agent 会话中。
- **等待中实例的重复名称发现较晚**（`TODO(subagent-dup-toolname)`）：若要阻止提供方注册回滚，需要一份预期名称注册表。
- **每个实例的子 agent 策略固定**：其他模型、persona、工具过滤器或深度上限都需要另一个名称不同的工具。
