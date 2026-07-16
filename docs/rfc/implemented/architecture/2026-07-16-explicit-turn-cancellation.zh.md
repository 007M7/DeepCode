# RFC：显式的 turn 取消能力

Status: implemented

[English](2026-07-16-explicit-turn-cancellation.md) | 中文

## 问题

取消是一种生命周期短于 Agent 驱动的控制能力。自由文本字符串无法对调用方进行穷尽区分，步骤级 controller 也无法中断 prompt 提交、prompt 组装、continuation 或 turn 终止策略。持久化 `Error`、`AbortSignal.reason` 或后端私有对象还会把不稳定的运行时细节暴露给持久化 replay。

[Agent 执行上下文决策](2026-07-15-agent-execution-context.md)有意让 AsyncLocalStorage 帧保持为 `{ agent }`。若把 turn、步骤或 signal 状态加入这个与驱动同生命周期的帧，陈旧的异步后代就会看似仍对后续 turn 拥有权限。因此，取消需要一个 turn 归属方和显式传播，不能引入另一套环境上下文或公开 turn 包装类型。

## 决策

Agent 拥有仅用于运行时的 `AgentCancelCause` union：`{ kind: 'user' } | { kind: 'parent' }`；`agent.cancel()` 默认使用 `user`。规范化边界只接受恰好包含一个受支持 `kind` 的普通对象或 null-prototype 对象，并返回供当前 turn signal 使用的分离且冻结值。即使 Agent 处于 idle，字符串、额外字段或 symbol 字段、未知 kind、数组、class 实例、`Error` 和 `AbortSignal` 也会被同步拒绝。

被中断的 live turn 以粗粒度的持久化结果 `{ kind: 'aborted' }` 结束。终态事件记录 turn 发生了什么，运行时 signal 则标识谁请求了取消；回放不会重复保存 `user` 或 `parent`。未来若有审计需求，应使用独立的控制请求事件，让请求与最终结果保持为两项事实。持久化事件不包含 stack、signal、错误对象、自由文本取消原因或后端私有细节。

AgentLoop 为每个预期 turn 私有地拥有一个 `TurnCancellation`。它在通知 `agent/status = running` 前安装 holder，使其中唯一的 `AbortController` 持续覆盖 prompt 处理、prompt 组装、每个步骤、模型与工具执行、continuation、`agent/turn-stop`、`turn/end` 和持久化 flush，随后清除 holder。所有参与的方法、事件和请求值都会收到同一个显式 signal；下一 turn 会收到全新 signal。

对于 turn 被认领前取消的 queued work，驱动只保留一个不带 cause 的 pre-run marker。它会清除 `cancel()` 调用时已存在的 queued 和 steering work，但不会为未来 prompt 预设取消。若 `running` listener 同步取消旧工作并发送 replacement，驱动会丢弃已 aborted 的 holder，并为 replacement 创建全新 holder。同一 active holder 上的重复取消遵循 first-wins，后续调用仍可清除新进入队列的 pending work。

显式事件签名保留 positional 形态，并把 `signal` 放在 waterfall 最后一个参数 `next` 之前。Prompt 提交、请求配置、步骤结果处理、continuation 和终止停止加入已有的 pre-step、session prefix、模型生成、工具执行、审批以及 subagent 或 workflow 请求显式 signal seam。`SystemPrompt.assemble()` 在 `AssembleContext` 中携带 `signal?: AbortSignal`，因为该对象是显式请求值。Listener 可以配合该 signal 取消，但不得保留它来控制另一 turn。

`ctx.agentExecution` 仍只提供身份。环境中的 Agent 并不代表存活、当前 turn 或取消权限，`agentInterruptReasonOf(signal)` 也只读取其显式参数。并发 Agent 会同时隔离各自的 ALS 身份和 turn signal；子 Agent 会遮蔽父 Agent 身份，而父请求 signal 仍通过 subagent seam 传递。

Agent dispose 会在 active holder 上请求仅用于运行时的 `{ kind: 'disposed' }` 中断。若取消已经先成为 controller reason，该 reason 无法改写，因此终态分类会先检查生命周期状态：disposed 优先，之后受支持的 `user` 或 `parent` cause 形成粗粒度 aborted 结果，其他异常保留现有 error 路径。ACP 取消映射为 `user`；进程内 spawn 和 fork 的传播映射为 `parent`。远程 ACP subagent 保持现有 wire protocol。

取消仍然是协作式的。Loop 会在 await 边界前后检查中断，但不会用 `Promise.race` 放弃进程内 listener、adapter 或工具 Promise。忽略 signal 的工作必须真正结算，`whenIdle()`、handle dispose 和 scope teardown 才会报告静止状态。

## 验证

契约测试验证严格的运行时 cause 校验、冻结分离、默认与 first-wins 行为、粗粒度 Session JSON 往返、ACP `user`、进程内 subagent `parent` 以及 dispose 优先级。Loop 测试让协作式 listener 在 prompt 提交、system-prompt 组装、session prefix、pre-step、请求、模型 stream、步骤结果、工具执行、continuation 和终止停止处等待 signal；并断言同一 turn 使用一个 signal，不同 turn 使用全新 signal。

执行上下文测试断言所有 hook 仍只观察到 `{ agent }`，并发 Agent 保持独立的身份与 signal，嵌套子 Agent 创建只遮蔽身份。竞态测试覆盖 idle 取消、pre-run 取消、从 `running` listener 提交 replacement、重复取消以及 cancel 与 dispose 竞争下的静止状态。

## 考虑过的替代方案

**把 signal 存入 ALS。** ALS 会在整个驱动生命周期内跟随异步后代，而取消权限在一个 turn 结束时就已终止。泄漏的回调可能观察到陈旧 signal，或者迫使实现替换可变帧，因此身份帧保持 `{ agent }`，控制能力继续显式传递。

**持久化自由文本 reason。** 字符串允许拼写漂移、阻碍穷尽 switch，还会鼓励消费方解析展示文本。运行时使用封闭的 discriminated union，终态记录只需要稳定的 aborted 结果。

**在 `turn/end` 中持久化类型化调用方 cause。** 当前没有任何生产环境中的 replay、UI、ACP、telemetry 或 workflow 消费方区分 `user` 与 `parent`。把请求来源复制到终态结果会混淆两项事实，还会在没有消费方的情况下引入 Session 特有校验；未来的审计接口可以记录独立的取消请求事件。

**现在就定义推测性的 `superseded`、`timeout` 和 `shutdown` 变体。** 当前没有 Agent 取消生产方实现这些语义。`shutdown` 已经属于生命周期 dispose；timeout 或 supersession 只有在拥有明确归属策略和唯一终态含义时才应进入 union。

**公开 turn 或步骤 context 包装类型。** 现有 positional seam 已经标识 Agent、turn 和步骤。包装类型会加宽所有 API、重复归属，并诱导调用方把捕获的对象当成持久权限。

**在宽限期后放弃不协作的工作。** 同进程工作仍在运行时就返回 idle 会破坏 teardown 与资源归属保证。硬终止需要 worker 或进程隔离边界，不属于该控制 seam。

## 后果

取消拥有一个运行时归属方、每个 turn 一个 signal，以及一套类型化的运行时调用方词汇。Session 保留其消费方实际使用的粗粒度 `aborted` 结果，与运行时对象保持隔离，也不再需要取消专用的规范化逻辑。协作式取消覆盖每个异步 turn seam，包括第一个步骤之前和最后一个步骤之后的工作。

显式 signal 会给多个公开事件增加参数，并要求插件有意识地转发取消。这是有意设计：权限在调用边界可见，生命周期与 turn 匹配，陈旧的环境异步后代无法获得控制能力。不协作的进程内工作可能延迟取消，但所报告的静止状态仍然真实。
