# 工作流

[English](workflow.md) | 中文

工作流 seam：由 agent（智能体）运行一段模型编写的编排脚本（SCRIPT），向外扇出 subagent。与 [subagent](subagent.md) 一样，它是**一项可选能力**，不属于 agent loop（智能体循环）主干，因此其词汇定义在此而非 [core.md](core.md) 中。与 subagent 注册表不同，它采用 bash 形态：每个上下文只有一个引擎实现提供 `ctx.workflows`；没有命名提供方注册表（第二个引擎是插件替换，而非共存）。

接口：[dsh-workflow](../../packages/workflow/workflow)（`ctx.workflows` + 下文词汇）。实现为 [dsh-workflow-workerthread](../../packages/workflow/workflow-workerthread)（基于 `node:worker_threads` 的引擎：每次运行一个 worker，脚本的 vm 上下文在其中执行）；面向模型的消费方是 [dsh-tool-workflow](../../packages/workflow/tool-workflow)。提案与设计理由见[动态工作流 RFC](../rfc/implemented/feature/2026-07-05-dynamic-workflows.md)。

源码：[`packages/workflow/workflow/src/types.ts`](../../packages/workflow/workflow/src/types.ts)

## 启动请求

调用方启动一次运行时发出的请求。工具层根据模型的 `{ script, meta, args }` 调用加上发起调用的 agent 构建此请求；`meta` 和 `args` 是纯 JSON 数据（引擎在任何代码运行之前对 `meta` 做形状校验，不通过则大声拒绝——永远不会为了获取 meta 而执行脚本文本）。`parent` 是必需的：脚本 spawn 的每个子 agent 都归属于它（cwd、血统和深度通过 [subagent seam](subagent.md) 流转）。

```ts type-equiv
interface WorkflowStartRequest {
  script: string
  meta: WorkflowMeta
  args?: unknown
  parent: Agent
  signal?: AbortSignal
}
```

## 工作流的身份标识：`WorkflowMeta`

作为数据附在启动请求上的身份块（工具的 `meta` 参数；字段词汇与 Claude Code 动态工作流的 meta 块一致）。`phases` 仅为进度词汇：`phase()` 调用与标题匹配供观察者使用；不暗示任何执行结构。

```ts type-equiv
interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowPhase[]
}
```

## 终态结果：`WorkflowResult`

一次运行的结果，由 `WorkflowRun.result` resolve。`value` 是脚本的物化返回值——纯宿主域 JSON 数据（脚本无返回值时为 `null`）——仅在 `completed` 时有意义。`stopReason` 是一个封闭联合类型（引擎拥有；消费方可穷举）：`completed` | `cancelled` | `error`。非 `completed` 的原因在 `error` 中携带失败信息，消费方将其映射为 `isError` 工具结果，而非把部分输出当作成功上报。

```ts type-equiv
interface WorkflowResult {
  value: unknown
  stopReason: WorkflowStopReason
  error?: string
  agentsStarted: number
}
```

## 活跃运行：`WorkflowRun`

脚本执行期间消费方持有的句柄。消费方 await `result`，可在运行中途 `cancel`，且必须在每条路径上调用 `dispose`。`result` 不会 reject：脚本失败以 `stopReason: 'error'` resolve；一旦运行被取消，即使脚本本身永不 settle，它也会在引擎的有界宽限期内 settle（引擎强制以 `cancelled` settle；worker-thread 引擎随后终止脚本的 worker），因此消费方 await `result` 不会在取消后永远卡住。`dispose()` = cancel + 有界 settle + 子 agent 静默；它不会因脚本卡死而挂起。

```ts type-equiv
interface WorkflowRun {
  readonly id: WorkflowRunId
  readonly meta: WorkflowMeta
  readonly result: Promise<WorkflowResult>
  cancel(reason?: string): void
  dispose(): Promise<void>
}
```

## 失败纪律：`WorkflowError.fatal`

脚本内部的钩子误用——错误参数、未知或延迟的 `agent()` 选项、超出[结构化输出子集](../../packages/core/tools/README.md)的 schema、触发的上限、seam 启动失败、取消——会抛出 `fatal: true` 的 `WorkflowError`。`parallel()`/`pipeline()` 组合器对 fatal 错误执行重新抛出，而非将该项映射为 `null`：一个拼写错误的选项必须大声杀死脚本，绝不能消融为看似普通子 agent 失败的东西。逐项的 `null` 保留给子运行失败（非 `completed` 的 stop reason）和阶段内的普通脚本错误。

## 事件

`workflow/*` 事件（`workflow/start`、`workflow/phase`、`workflow/log`、`workflow/agent-start`、`workflow/agent-end`、`workflow/end`——见[事件目录](../cordis-catalog/events.md)）是**仅供观察**的 emit，携带数据快照：每个 payload 以 `WorkflowRunInfo`（id + meta）开头，从不暴露活跃的 `WorkflowRun`，因此订阅者无法获得 `cancel`/`dispose`；`workflow/end` 刻意省略 result value（观察结果的监听器不得收到调用方 result 的可变别名）。每次 emit 对每个监听器隔离：抛异常的订阅者被记录但不传播，不会饿死其后注册的监听器；每个监听器收到自己的 payload 克隆，因此修改它既不会损坏引擎也不会影响其他监听器。这种隔离与 `subagent/start`/`subagent/end` 一致。
