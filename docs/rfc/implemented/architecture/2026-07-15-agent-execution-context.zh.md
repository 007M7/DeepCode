# RFC: 基于 AsyncLocalStorage 的 Agent 执行上下文

Status: implemented

[English](2026-07-15-agent-execution-context.md) | 中文

## 问题

Harness 中存在两种有用但不同的上下文概念。Cordis `Context` 负责选择服务、注册归属和生命周期；`agent.ctx` 是一个存活 Agent 所拥有的扁平注册作用域。Agent 与会话身份描述的则是异步操作主体。若把根 `ctx.agent` 改成「当前正在运行的 Agent」，就会混淆这两种含义，并在单进程并发驱动多个 Agent 时失效。

进程内深层基础设施有时需要在显式传递的循环、工具及请求参数之下获取可信的发起 Agent，例如宿主感知传输层、追踪辅助函数、日志器或网关客户端。要求每个私有辅助函数都转发 `agent` 会造成重复，而进程级可变槽会在跨 `await` 时发生并发错误。模型可见参数也不适用，因为模型不得选择可信的会话或路由请求头。该载体属于必需的控制基础设施，而非模型可见的可选上下文。

## 决策

`@deepseek-ai/dsh-agent-execution` 使用 Node `AsyncLocalStorage` 提供必需的 `ctx.agentExecution` 服务。命名的 `AgentExecution` 帧仅包含同一个 Agent 对象；[核心数据目录](../../../core-data-structures/core.md#agent-execution-context)是帧与服务字面类型定义的真源。

`current()` 用于可选读取，`require()` 抛出 `no agent execution context is active`，`run()` 保留操作返回的同步值或 Promise 本身。`run(undefined, operation)` 会建立清空边界，供不得继承 Agent 的工作使用。会话仍通过 `execution.agent.session` 推导；轮次、步骤、工具调用、`signal`、模型、`cwd`、沙箱和授权继续由现有归属方管理。

`AgentLoop` 注入该服务，并用 `agentExecution.run({ agent }, ...)` 包裹每个具体驱动的完整 `runLoop` 生命周期。因此，并发驱动使用彼此独立的存储，子驱动会遮蔽父驱动，子边界结束后父存储得到恢复。创建、持久化加载和尚未发布的 `setup(agentCtx)` 位于子驱动边界之外：由父 Agent 发起的创建使用父身份，而 `agentCtx.agent` 显式标识子 Agent。

隐式身份不会取代显式契约。`ToolExecution.agent`、`AssembleContext.agent`、`GenerateOptions.sessionId`、任务归属、父子请求、`ctx.agent`、`agentCtx.agent`、审批与 hook 主体、`cwd` 选择、取消、worker 和进程消息、持久化记录及协议身份都保持显式传递。远程边界会把所需身份写入类型化请求，因为 ALS 只在进程内有效。

提供方使用有序复合 effect。teardown 会先拒绝新边界，再移除服务并等待 AgentLoop 等注入方排空，随后等待活动的返回 Promise 边界，最后调用 `AsyncLocalStorage.disable()`。排空期间，进行中代码可通过保留的服务引用继续调用 `current()` 和 `require()`；dispose 后，保留引用会抛出 `agent execution service is disposed`。根 Context dispose 可能并发启动同级 fiber 的 teardown，因此除 Cordis 依赖顺序外还必须统计活动边界。

`run()` 不负责管理脱离返回链的工作：提供方排空只跟踪 `operation` 返回的 Promise。边界内创建的异步资源会继承其存储，直到自身结束或 ALS 被禁用；所属 seam 必须显式停止未纳入返回 Promise 的工作。Agent 所有前台工作会把完整生命周期纳入返回值，并保留显式取消契约。无关的定时器、队列和部署基础设施在 `run(undefined, operation)` 下启动；队列、worker、进程和协议边界必须序列化身份，不能期待 ALS 传播。

宿主感知的传输层可以从 `ctx.agentExecution.require().agent.session.id` 推导由部署方拥有的 `X-Harness-Session-Id` 等请求头；模型可见 schema 和参数中不包含该请求头。本决策不让现有生产 MCP 或 Web 传输层采用此请求头。测试替身传输层用于证明可信边界，而不会把宿主路由策略分配给现有的提供方无关 seam。

本决策扩展 [Agent 注册作用域契约](2026-07-08-agent-scope-contexts.md)及其[运行时设计](2026-07-12-agent-scope-runtime-design.md)，不会改变其中 `agent.ctx` 的静态含义。

## 验证

服务测试锁定可选与必需读取、同步值和跨 realm Promise 的引用身份、并发、嵌套及清空边界、同步抛错或 Promise 拒绝后的恢复、排空顺序及保留引用的错误。AgentLoop 集成测试锁定并发与嵌套驱动、无 Agent 调用、缺少提供方时的激活行为、服务重启，以及提供方或根 Context 的销毁流程。组合、模块图、构建及运行时闭包检查确保默认组合包、SDK 主干、Python 运行时闭包及直接 AgentLoop harness 都装载提供方。

只有测试替身形式的宿主感知传输层消费隐式身份；它在内部推导 `X-Harness-Session-Id`，并验证工具 schema 与记录参数都不包含身份字段。服务有意不排空 `operation` 返回的 Promise 之外的异步工作；这类工作仍由所属方的显式停止契约管理。

## 考虑过的替代方案

**在每个函数中传递 Agent。** 公开、worker、进程、持久化和协议边界继续显式传递，但要求每个进程内私有辅助函数都携带 Agent 只会造成重复转发，不会提高可信度。ALS 仅限于这些显式边界内部的异步调用链。

**让 `ctx.agent` 变成动态值。** `ctx.agent` 已经表示与 Agent 作用域 Cordis 上下文静态关联的 Agent。改变根上下文的含义会混合注册作用域与执行作用域，并让并发行为变得意外。

**保存完整的可变运行时帧。** Agent、会话、inbox、取消、轮次、步骤、工具执行和持久化已经有各自的真源。重复保存会产生陈旧快照和另一套生命周期。命名帧能够明确标识执行上下文边界，而不重复保存归属方状态。

**包含步骤级 `AbortSignal`、`cwd`、沙箱或授权。** 它们的生命周期及权限范围与驱动边界不一致，而且现有 seam 已经显式传递这些值。新增控制能力需要独立决策和嵌套生命周期契约。

**使用进程级 `currentAgent`。** 并发 Agent 和 subagent 会在异步延续执行之间相互覆盖，因此可变全局值只在 Harness 不具备的串行保证下才正确。

**从模型可见参数推导身份。** 不能信任模型或用户输入来选择会话、租户或沙箱路由。

**给每个能力 seam 增加路由身份。** 这会把宿主关注点扩散到提供方无关 API。宿主感知实现拥有其传输请求头，而公开边界继续显式传递身份。

## 后果

深层基础设施可以获得一个可信的进程内发起 Agent，而无需加宽现有工具和能力请求。并发及嵌套驱动会自动隔离，缺少提供方时 AgentLoop 保持未激活，HMR 或根 Context dispose 会在禁用 ALS 前完成排空。

该依赖不会出现在函数签名中，并且携带一个具有控制能力的 Agent 对象。消费方必须将其限制在横切基础设施中，把隐式存在视为既不证明存活、也不授予权限，并保留显式取消和归属检查。ALS 还有常驻传播成本，也无法跨越 worker、进程、HTTP 或持久化队列边界。

该销毁设计有意依赖 Node 的 [Stability 1（实验性）](https://nodejs.org/api/async_context.html#asynclocalstoragedisable) API `AsyncLocalStorage.disable()`。Node 要求在 ALS 实例可被垃圾回收前调用 `disable()`，这对 HMR 替换提供方所拥有的实例尤为重要；服务状态守卫会阻止 dispose 后通过后续 `run()` 重新进入该实例。

该帧有意省略轮次、步骤、`signal`、`cwd`、沙箱和授权。若真实消费方无法使用现有显式字段，必须另行论证扩展；陈旧字段最多只能误标遥测数据，绝不能授予控制权。
