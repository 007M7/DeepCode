# Subagent

[English](subagent.md) | 中文

subagent seam：一个 agent（智能体）将工作委派给子 agent。与 [bash](bash.md) 一样，它是**一项可选能力**，不属于 agent loop（智能体循环）主干，因此其词汇定义在此而非 [core.md](core.md) 中。但它在一个维度上与其他所有 seam 不同：**同一上下文中可共存多个提供方实现**，按名称注册（`ctx.subagents`），而 bash 只允许一个执行器。注册表的形状参照 [LLM 适配器注册表](llm-streaming.md)，而非单服务的 bash 执行器。

接口：[dsh-subagent](../../packages/subagent/subagent)（`ctx.subagents` + 下文词汇）。实现为兄弟包（`dsh-subagent-spawn`、`-fork`、`-acp`）；面向模型的消费方是 [dsh-tool-subagent](../../packages/subagent/tool-subagent)。提案与设计动机见 [subagent RFC](../rfc/implemented/feature/2026-06-21-subagent-capability-seam.md)。

源码：[`packages/subagent/subagent/src/types.ts`](../../packages/subagent/subagent/src/types.ts)

## 两类能力，两种发现方式

提供方通过一个静态描述符公布其**启动时**特性，服务在 run 存在之前即行检查；如果请求依赖提供方不具备的特性，会被大声拒绝（`SubagentError('UNSUPPORTED_CAPABILITY')`），绝不会被接受后静默忽略。**运行时**特性（steering（中途引导）、resume）则是 [`SubagentRun`](#a-live-run-subagentrun) 上的可选方法——方法的存在即为能力，TypeScript 的类型收窄即为发现机制。

```ts type-equiv
interface SubagentCapabilities {
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}
```

## 启动请求

工具层根据模型输入和自身配置构建此请求；服务在 `start` 之前针对指定提供方进行校验。必填的 `parent` 提供会话 cwd、谱系与委派深度。可选的 output schema、depth、tool filter 和 persona 需要对应的能力 flag 匹配。不支持的 schema 在启动时即失败；进程内后端将 filter 和 persona 的作用域限定在子 agent 创建阶段，并通过强制 capture tool 实现所支持的 object-rooted schema。

```ts type-equiv
interface SubagentStartRequest {
  readonly prompt: ContentBlock[]
  readonly parent: Agent
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptions
  readonly outputSchema?: StructuredOutputSchema
  readonly maxDepth?: number
  readonly toolFilter?: ToolRestriction
  readonly persona?: string
}
```

`signal` 是就绪前后唯一的取消通道。[subagent 组合控制 RFC](../rfc/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md) 负责 persona、运行时全局工具过滤、绝对深度以及「可见性而非权限」的设计理由。

## 终态结果：`SubagentResult`

一次 run 的最终产出，由 `SubagentRun.result` resolve。`structured` 仅在请求了 `outputSchema` 且成功满足时才存在；请求 schema 不保证一定能得到它，当子 agent 失败或结束时未产出有效 capture 时，提供方可能返回 `stopReason: 'error'`。非 `completed` 的 `stopReason` 意味着 `output` 可能不完整——消费方将其映射为 `isError` 的工具结果，而非将部分输出报告为成功。

```ts type-equiv
interface SubagentResult {
  readonly output: ContentBlock[]
  readonly structured?: unknown
  readonly stopReason: SubagentStopReason
}
```

`SubagentStopReason` 是一个[可合并扩展的派生联合类型](core.md#the-map--derived-union-pattern)——后端可以添加变体，因此消费方应对已知 case 分支处理，将未知的终态原因视为失败：

```ts type-equiv
interface SubagentStopReasonMap {
  completed: 'completed'
  aborted: 'aborted'
  error: 'error'
  'max-tokens': 'max-tokens'
  refusal: 'refusal'
}
```

<a id="a-live-run-subagentrun"></a>

## 活跃 run：`SubagentRun`

`SubagentRun` 是消费方持有的、指向一个就绪子 agent 的句柄。消费方 await `result` 并始终 dispose（资源释放）该 run，直至其完全停稳。子 agent 失败时以非 completed 的 stop reason resolve；只有不可表示的基础设施故障才会 reject。可选的 `sendMessage` 和 `resume` 方法通过自身的存在来公布运行时能力。

```ts type-equiv
interface SubagentRun {
  readonly id: AgentId
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
  sendMessage?(content: ContentBlock[]): void
  resume?(content: ContentBlock[]): Promise<SubagentRun>
}
```

## 提供方 seam：`SubagentProvider`

每个提供方是一个具名的子 agent 传输层，多个提供方可以共存。服务在 `start()` 之前校验请求的启动时能力。`inheritsParentContext` 仅描述对话种子注入（`fork`：true；`spawn` 和 `acp`：false），使消费方能生成准确的面向模型的措辞，而不暗示继承了工具、服务或权限。

```ts type-equiv
interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  start(request: SubagentStartRequest): Promise<SubagentRun>
}
```

`start()` 仅在 run 就绪时 fulfill。服务观察其 result、发出 `subagent/start`，并返回同一个 run；rejection 意味着提供方已自行清理，不发出生命周期配对事件。进程内子 agent 可通过 `ctx.agents` 发现，远程子 agent 则不必如此。`subagent/end` 报告最终输出或基础设施故障。两个事件均为仅观察事件；每个监听器异常都会被独立隔离。

## 进程内后端：深度与种子

spawn 和 fork 后端通过 `parent.ctx` 创建一个普通 agent，将取消信号传入核心创建流程，并通过 `AgentHandle` 进行 dispose。移除提供方会阻止新的 start，但不会撤销已接受的 run。每个子 agent 获得一个新的扁平作用域，而非继承父级注册。深度与 fork 种子注入复用既有的 agent 和会话词汇：

- **委派深度**是一个可合并扩展的 `AgentOptions.subagentDepth` 字段（顶层 agent 为 `0`，子 agent 为 parent + 1）。只有 `undefined` 表示顶层；所有已存储的值必须是非负安全整数。该字段归 seam 所有——循环既不设置也不读取它——因此嵌套 spawn 会校验父级的已存储深度，拒绝超出安全整数域的派生子深度，并在定义了绝对 `request.maxDepth` 上限时将其施加于子 agent。
- **Fork 种子注入**使用 `CreateAgentOptions.seed`（一个 `SessionEvent[]` 前缀，经由 `AgentLoop.createAgent` → `ctx.sessions.prepare({ seed })` 传递，与 `resume` 使用的原语相同）。fork 后端传入父级日志的一段*平衡的已完成轮次前缀*——父级事件直到并包括其最后一个 `turn/end`——因此种子从 0 连续，[invariants](../../packages/support/invariants) 回放可以接受它（进行中的、未平衡的轮次被排除在外）。
