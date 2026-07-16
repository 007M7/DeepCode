# RFC: 基于 AsyncLocalStorage 的 Agent 执行上下文

Status: implemented

[English](2026-07-15-agent-execution-context.md) | 中文

## 问题

Harness 中存在两种有用但不同的上下文概念。Cordis `Context` 负责选择服务、注册归属和生命周期；`agent.ctx` 是一个存活 Agent 所拥有的扁平注册作用域。Agent 与会话身份描述的则是异步操作主体。若把根 `ctx.agent` 改成「当前正在运行的 Agent」，就会混淆这两种含义，并在单进程并发驱动多个 Agent 时失效。

进程内深层基础设施仍需要可信的发起 Agent。能力传输层、追踪辅助函数、日志器和网关客户端可能位于显式 loop、工具及请求参数的下层。在每个私有辅助函数中传递 `agent` 会增加管道代码，而进程级可变槽会在 `await` 之间发生并发错误。模型可见参数同样不合适，因为模型不能选择可信的会话或路由请求头。

## 决策

`@deepseek-ai/dsh-agent-execution` 使用 Node `AsyncLocalStorage` 提供必载的 `ctx.agentExecution` 服务。该帧只包含准确的存活 Agent：

```text
export interface AgentExecution {
  readonly agent: Agent
}

export interface AgentExecutionService {
  current(): AgentExecution | undefined
  require(): AgentExecution
  run<T>(execution: AgentExecution | undefined, operation: () => T): T
}
```

`current()` 执行可选读取，`require()` 抛出 `no agent execution context is active`，`run()` 保留操作返回的准确同步值或 Promise。`run(undefined, operation)` 会建立真实的清空边界，供不得继承 Agent 的工作使用。会话仍通过 `execution.agent.session` 推导；轮次、步骤、工具调用、signal、模型、cwd、沙箱和授权继续由现有归属方管理。

`AgentLoop` 注入该服务，并用 `agentExecution.run({ agent }, ...)` 包裹每个具体驱动的完整 `runLoop` 生命周期。因此，并发驱动使用彼此独立的存储，子驱动会遮蔽父驱动，子边界结束后父存储得到恢复。创建、持久化加载和尚未发布的 `setup(agentCtx)` 位于子边界之外：由父 Agent 发起的创建使用父身份，而 `agentCtx.agent` 显式标识子 Agent。

隐式身份不会取代显式契约。`ToolExecution.agent`、`AssembleContext.agent`、`GenerateOptions.sessionId`、任务归属、父子请求、`ctx.agent`、`agentCtx.agent`、审批与 hook 主体、cwd 选择、取消、worker/进程消息、持久化记录及协议身份都保持显式传递。远程边界会把所需身份写入类型化请求，因为 ALS 只在进程内有效。

提供方使用有序复合 effect。teardown 会先拒绝新边界，再移除服务并等待 AgentLoop 等注入方排空，随后等待活动的返回 Promise 边界，最后调用 `AsyncLocalStorage.disable()`。排空期间，进行中代码可通过保留的服务引用继续调用 `current()` 和 `require()`；dispose 后，保留引用会抛出 `agent execution service is disposed`。根 Context dispose 可能并发启动同级 fiber 的 teardown，因此除 Cordis 依赖顺序外还必须统计活动边界。

在 `run()` 内创建的异步资源会继承其存储，即使返回的操作没有等待它们。Agent 所拥有的前台工作可以继承 `{ agent }`，但仍使用其执行 seam 的显式取消和 dispose 契约。无关的定时器、队列和部署基础设施在 `run(undefined, operation)` 下启动，并拥有显式停止操作。队列、worker、进程和协议边界必须序列化身份，不能期待 ALS 传播。

宿主感知的传输层可以从 `ctx.agentExecution.require().agent.session.id` 推导由部署方拥有的 `X-Harness-Session-Id` 等请求头；模型可见 schema 和参数中不包含该请求头。本决策不让现有生产 MCP 或 Web 传输层采用此请求头。测试替身传输层用于证明可信边界，而不会把宿主路由策略分配给现有的提供方无关 seam。

本决策扩展 [Agent 注册作用域契约](2026-07-08-agent-scope-contexts.md)及其[运行时设计](2026-07-12-agent-scope-runtime-design.md)，不会改变其中 `agent.ctx` 的静态含义。

## 验证

服务测试锁定可选与必需读取、同步与跨 `await` 传播、并发与嵌套边界、显式清空、throw 或 rejection 后的恢复、准确返回值身份、排空顺序及已 dispose 引用错误。AgentLoop 集成测试覆盖重叠的真实驱动、嵌套父子创建、无 Agent 的直接工具执行、提供方或根 Context teardown 期间的取消、服务重启，以及 Agent dispose 后保留的引用。

测试替身能力传输层在内部推导 `X-Harness-Session-Id`，并断言工具 schema 与记录的参数都不包含身份字段。组合测试和生成目录确保默认 bundle、SDK 主干、Python 运行时闭包及直接 AgentLoop harness 都装载提供方；缺少提供方时 AgentLoop 保持未激活。

## 考虑过的替代方案

**在每个函数中传递 Agent。** 公开、worker、进程、持久化和协议边界继续显式传递，但要求每个进程内私有辅助函数都携带 Agent 只会增加管道代码，不会提高可信度。ALS 仅限于这些显式边界内部的异步调用链。

**让 `ctx.agent` 变成动态值。** `ctx.agent` 已经表示与 Agent 作用域 Cordis 上下文静态关联的 Agent。改变根上下文的含义会混合注册作用域与执行作用域，并让并发行为变得意外。

**保存完整的可变运行时帧。** Agent、会话、inbox、取消、轮次、步骤、工具执行和持久化已经有各自的真源。重复保存会产生陈旧快照和另一套生命周期。包装对象为另行论证的陈旧安全标签保留扩展空间，而不会把存储简化成裸 Agent。

**包含步骤级 `AbortSignal`、cwd、沙箱或授权。** 它们的生命周期与权限不匹配驱动边界，而且现有 seam 已经显式传递这些值。新增控制能力需要独立决策和嵌套生命周期契约。

**使用进程级 `currentAgent`。** 并发 Agent 和 subagent 会在异步 continuation 间相互覆盖，因此可变全局值只在 Harness 不具备的串行保证下才正确。

**从模型可见参数推导身份。** 不能信任模型或用户输入来选择会话、租户或沙箱路由。

**给每个能力 seam 增加路由身份。** 这会把宿主关注点扩散到提供方无关 API。宿主感知实现拥有其传输请求头，而公开边界继续显式传递身份。

## 后果

深层基础设施可以获得一个可信的进程内发起 Agent，而无需加宽现有工具和能力请求。并发及嵌套驱动会自动隔离，缺少提供方时 AgentLoop 保持未激活，HMR 或根 Context dispose 会在禁用 ALS 前达到静止状态。

该依赖不会出现在函数签名中，并且携带一个存活能力对象。消费方必须将其限制在横切基础设施中，把隐式存在视为既不证明存活、也不授予权限，并保留显式取消和归属检查。ALS 还有常驻传播成本，也无法跨越 worker、进程、HTTP 或持久化队列边界。

该帧有意省略轮次、步骤、signal、cwd、沙箱和授权。若真实消费方无法使用现有显式字段，必须另行论证扩展；陈旧字段最多只能误标遥测数据，绝不能授予控制权。
