# RFC：基于 AsyncLocalStorage 的 agent（智能体）执行上下文

Status: proposed

[English](2026-07-15-agent-execution-context.md) | 中文

## 问题

harness 中存在两种有用但含义不同的上下文：

- Cordis `Context` 是依赖组合和生命周期对象。部署上下文暴露共享服务，`agent.ctx` 则暴露某个存活 Agent 所拥有的扁平注册层。
- Agent、会话、轮次、步骤和工具身份是执行主体。agent loop（智能体循环）通过事件、提示词组装、LLM（大语言模型）请求和 `ToolExecution` 显式传递这些信息。

这两类概念不能混为一谈。尤其是，`agent.ctx.agent` 是 Agent 作用域组合上下文上的静态关联。普通根上下文会有意返回 `undefined`；不能把它改成“当前恰好正在运行的 Agent”，因为一个 Node 进程可能并发运行多个 Agent。

这给深层基础设施留下了一个实际缺口。能力传输层、skill（技能）提供方、追踪辅助函数、日志记录器或网关客户端，可能需要知道当前异步操作由哪个 Agent 发起。让每一层中间辅助函数都继续传递 `agent` 会产生大量样板代码，而从进程级可变全局槽推导身份，会在两个 Agent 并发后立即出错。模型可见的工具参数也不是合适的载体：模型不能选择可信的会话或沙箱路由请求头。

当单个 Harness 运行时为多租户宿主平台复用多个会话时，这个缺口会变得尤其重要。对外能力请求必须自动携带当前 Harness 会话 ID，以便宿主平台解析正确的租户和沙箱归属。模型侧的 skill 和工具不应理解宿主平台特有的路由，但所选能力实现仍需要在传输边界获得可信的当前 Agent。

## 提案

新增一套由 Node `AsyncLocalStorage` 支撑的窄粒度 Agent 执行上下文能力。它允许代码在当前异步执行链内访问关联的 Agent，但不会取代 Cordis 上下文、显式协议字段或持久化会话状态。

第一版只保存 Agent：

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

`Session` 通过 `execution.agent.session` 推导，不在存储中重复保存。轮次、步骤、工具调用、模型、cwd 和沙箱身份不进入第一版，因为它们已经有各自的真源，而且目前没有已确认的隐式上下文消费方需要这些信息。单字段包装是有意为之：后续的执行帧扩展可以在不改动 `run()` 调用方的前提下扩展 `AgentExecution`，因此实现不得把存储简化成裸 `Agent`。

`AgentExecution` 有意保留准确的存活 `Agent`，而不是 ID 快照。这是第一版存储中唯一获准的能力对象，因为它正是由驱动建立边界的执行主体，而且现有作用域辅助函数依赖这个准确对象。隐式存在不代表仍然存活或已经获得授权：消费方执行生命周期敏感工作前，仍须遵循 Agent 生命周期和显式能力契约。

API 必须始终建立 ALS 边界，即使传入的 execution 是 `undefined` 也不例外。这样可以显式清除无关分离任务继承到的上下文。一个同类实现曾观察到未清空的隐式值穿过已调度工作泄漏进后续轮次；显式 undefined 边界可以防止这类泄漏。

### 包与服务位置

在 `packages/core/agent-execution/` 新建 `@deepseek-ai/dsh-agent-execution`。该包拥有 Node 专用的 ALS 实现，并通过必载的 `ctx.agentExecution` 服务扩展 Cordis。它属于 `core/`，因为这是每个具体 Agent loop 和隐式身份消费方所依赖的稳定 Agent 控制主干。

公开键名在此定为 `ctx.agentExecution`，服务键、接口名和包名共用同一个词根。它表示某个 Agent 所拥有的异步调用链，而不是单个轮次、步骤或工具调用；名字也直接说明存储的内容。`ctx.execution` 含义过宽；带 runtime 字样的名字会与 `packages/code-runtime/` 以及指整个进程的 “Harness 运行时” 冲突；修改 `ctx.agent` 被排除，因为它已经表示 `agent.ctx` 与 Agent 之间的静态关联。

该包通过 Cordis 暴露服务，而不是使用可变模块全局槽：

- Agent Loop 可以显式注入该服务；
- 测试可以为每个 Harness 上下文挂载隔离的服务；
- 服务 dispose（资源释放）时可以在依赖它的 Agent 驱动静止后禁用其 ALS 实例；
- 依赖关系在 Cordis 配置和生成目录中保持可见。

该服务随标准 agent 组合包强制加载，`dsh-agent-loop` 在 `inject` 中声明它：缺少该服务的 agent 组合按快速失败规则在加载时报错，而不是等到第一个深层消费方读取时才发现隐式身份缺失。配置测试锁定这一策略。该能力只依赖稳定的 Node `AsyncLocalStorage`，支持范围 `node ^22.19 || >=24` 全部可原生使用且无需 polyfill。Node 24 及以上使用基于 `AsyncContextFrame` 的实现，Node 22 使用此前的实现；本 RFC 为保证该不变量接受常驻传播成本，不作零开销承诺。

服务关闭是有顺序的，不提供透明的进行中延续。Agent Loop 必须先停止接受新驱动并取消或等待所有进行中的驱动收敛，随后 Cordis 才 dispose 服务并调用 `disable()`。HMR（热模块替换）会重建依赖该服务的子树，不承诺让进行中的轮次跨服务替换继续执行。如果旧调用方保留了已 dispose 的服务引用，`current()` 和 `require()` 都会抛出稳定的 “service disposed” 错误，而不是返回模糊的 `undefined`。

### 生命周期边界

在每个具体 Agent 驱动的 `runLoop` 整个生命周期外围绑定执行上下文：

```text
agentExecution.run({ agent }, () => runLoop(ctx, agent, handle))
```

这样，由该驱动发起的每项操作都能获得同一个可信 Agent：

- 提示词拦截和提示词组装；
- LLM 适配器调用；
- 工具策略和工具主体；
- 能力提供方和传输层；
- 这些操作所等待的同步和异步辅助函数。

并发驱动会获得彼此独立的 ALS 存储。子 Agent 自己的驱动会用该子 Agent 建立新边界，因此即使子 Agent 是在父 Agent 的工具调用中创建的，其操作也不会错误继承父 Agent。嵌套边界返回后，ALS 会自动恢复父 Agent。

Agent 创建阶段有意置于这个动态边界之外。创建过程已经接收 `agentCtx`，其中 `agentCtx.agent` 就是正确的、尚未发布的 Agent。发布流程和生命周期归属继续使用现有的显式 Agent 与作用域载体。由此产生一条明确契约，而非偶然行为：当子 Agent 的创建发生在父 Agent 的工具调用内时，子 Agent 的创建流程和持久化加载运行在**父 Agent** 的隐式身份之下，因为子驱动尚未启动。这个窗口内触达的传输层按父会话路由——对可信路由而言这是正确的，因为创建工作由父 Agent 发起并归它所有。创建代码需要子身份时使用显式的 `agentCtx.agent`，绝不读隐式存储。

### 显式主体仍是真源

隐式身份只是深层基础设施的便利能力，不会取代现有契约：

- `AgentEventDispatch` 继续携带显式 Agent 主体和作用域。
- `AssembleContext.agent` 保持显式传递。
- `ToolExecution.agent` 保持显式传递，并继续选择作用域内的工具和策略视图。
- `GenerateOptions.sessionId` 在 LLM 边界上保持显式传递。
- subagent 请求和生命周期事件继续携带显式的父子身份。
- 会话事件仍然是回放和恢复的持久化真源。

代码跨越公开服务、进程、worker、持久化或协议边界时，必须把边界所需身份写入其类型化请求。远程进程无法访问父进程的 ALS 存储。

### 可信传输层用途

能力传输层可以在构造对外请求时读取 `ctx.agentExecution.require().agent.session.id`，并添加由部署方控制的可信身份，例如 `X-Harness-Session-Id` 请求头。该身份不出现在模型可见的参数中，模型也不能覆盖它。传输层仍须执行自身的能力和生命周期授权；隐式 Agent 只提供发起方身份，不授予调用权限。

bash seam 现有的 `OwnerToken` 是最接近的显式身份先例，它也说明了为什么显式方案补不上这个缺口：`BashExecSpec.owner` 是一个后台任务隔离键，由 `dsh-tool-bash` 从会话 id 转换而来，前台 `run()` 有意忽略它，而文件系统 seam 没有对应物——其提供方方法完全不携带身份参数。给每个能力 seam 都加一个路由身份参数，会把宿主平台的关注点塞进本应与部署无关的 seam 词汇；隐式身份让传输层实现自己拥有路由逻辑，而不必加宽任何 seam。

宿主平台继续负责把 Harness 运行时会话 ID 解析成产品会话和沙箱归属方。Harness 不需要理解宿主平台的沙箱标识、沙箱提供方或持久化模型。

模型侧 skill 和工具插件不应自行添加宿主平台特有的请求头。它们调用能力服务；所选提供方负责远程执行和身份传播。这样可以保持模型行为与后端路由之间的职责分离。

### 分离异步工作

Node ALS 会被 `run()` 内创建的异步资源继承，即使调用方没有等待它们。这对 Agent 所拥有的后台操作很有用，但也可能让无关任务保留陈旧轮次的上下文。

身份继承不取代取消归属。在 Agent 边界内启动的工作要么是**前台**的——继承 `{ agent }`，并通过其执行 seam 单独接收显式取消信号；要么是**分离**的——在 `run(undefined, operation)` 下启动，并拥有独立生命周期和显式停止操作。调用方必须让这两个选择保持一致。实现必须记录并测试以下规则：

- 逻辑上归 Agent 所有的工作是前台工作：可以继承 `{ agent }`，通过现有显式 seam 接收取消，并且必须遵守该 Agent 的 dispose 契约。
- 与该 Agent 无关的长生命周期部署基础设施、定时器和工作队列是分离工作：必须在 `run(undefined, operation)` 下启动，由自己的归属方停止，绝不因某个轮次结束而被隐式终止。
- 把数据入队并留待后续处理的代码必须将所需身份序列化到队列项中；不能期待 ALS 跨越队列、进程或 worker 边界。
- 消费方不能把隐式 Agent 引用视为 Agent 仍然存活的证明。生命周期敏感的操作仍须检查 `agent.status`、显式 signal 或归属服务的契约。

`turn` 和 `step` 不进入第一版；如果未来出现真实的横切消费方（追踪、日志）无法使用现有显式字段，可以再将它们作为独立的不可变执行帧扩展引入。完整 `Agent` 是刻意允许的能力例外，因为它就是建立边界的执行主体。每个额外字段都必须是陈旧安全的标签，其陈旧副本最坏只能误标一条追踪记录；其他能力或控制通道需要独立 RFC。第一版不携带 `AbortSignal`；见「考虑过的替代方案」。

## 当前 Harness 依据

由于这份交接基于本地源码快照编写，目标分支可能已经前进，后续实现会话应在编辑前重新检查这些符号。

- `packages/core/agent/src/types.ts`：`Agent` 已经拥有 `session`、`status` 和 `ctx`。其中 `ctx` 的文档将它定义为注册作用域，而不是动态请求上下文。
- `packages/core/agent/src/index.ts`：Cordis `Context.agent` 作为 Agent 作用域的开发体验关联被安装，在普通上下文上默认返回 `undefined`。不要改变这一语义。
- `packages/core/agent-loop/src/agent.ts`：`ReactLoopAgent` 已经拥有 inbox、取消逻辑、每步骤 abort、状态和驱动生命周期。不要再创建一套并行的可变运行时状态对象。
- `packages/core/agent-loop/src/loop.ts`：`runLoop(ctx, agent, handle)` 正好是需要包裹的生命周期边界。它会将 Agent、轮次、步骤和 signal 显式传给更窄的操作。
- `packages/core/tools/src/index.ts`：`ToolExecutionInput.agent` 是显式字段，并用于选择作用域内的策略和工具解析。增加 ALS 后，它仍然保留在契约中。
- `packages/core/agent/src/dispatch.ts`：`agentEvents()` 有意把 Agent 主体与其作用域载体融合。隐式上下文不能取代这套正确性机制。
- `packages/core/README.md` 和现有 core 包：它们表明稳定的 Agent 控制契约位于 `core/`；`agent-execution` 是必载控制基础设施，而不是模型可见的可选上下文增强。

本提案扩展而非取代[关于 Agent 注册作用域的既有决策](../../implemented/architecture/2026-07-08-agent-scope-contexts.md)及其[运行时设计](../../implemented/architecture/2026-07-12-agent-scope-runtime-design.md)。

## Claude Code 参考实现

| Claude Code | Harness 中的对应设计 |
|---|---|
| AppState store | Cordis 部署服务及其拥有的实时状态 |
| QueryEngine | `ReactLoopAgent` 及其 loop 所拥有的运行时状态 |
| ToolUseContext | 能力边界上的显式 Agent、工具和请求参数 |
| AgentContext ALS | 本提案的窄粒度 `AgentExecution` 载体 |
| Transcript | 事件溯源 `Session` 与持久化后端 |

## 实现交接步骤

后续实现会话应按以下顺序开展工作：

1. 切换到预期目标分支，检查“当前 Harness 依据”中列出文件的当前版本。不要合并或复制编写本交接文档所在分支的修改。
2. 新增 `packages/core/agent-execution/`，包含包元数据、README、导出类型、Cordis 服务、模块扩展和聚焦测试。
3. 按照现有包门禁，把该包加入 TypeScript 项目引用、路径候选、运行时闭包或配置以及生成目录。优先使用仓库生成器，不要手工编辑生成文件。同时更新根 `AGENTS.md` 中 repository layout 的 `core/` 行、`packages/core/README.md` 中的包表，以及 `packages/README.md` 中的包组说明。
4. 让 Agent Loop 声明并消费该服务。在不改变公开 Agent、事件、工具、LLM 或会话签名的前提下，用 `{ agent }` 包裹每个 Agent 驱动的完整 `runLoop` 调用。
5. 增加集成测试：让同一进程中的两个 Agent 重叠执行，并在至少一次 `await` 后从异步工具执行内部观察到正确的隐式 Agent。
6. 增加嵌套 Agent 覆盖：证明子 Agent 能看到自己，且子边界结束后父上下文得到恢复。
7. 增加清除和失败覆盖：边界外返回 `undefined`，`require()` 清晰失败，`run(undefined, ...)` 屏蔽继承的 Agent，抛出异常或 rejected 操作不会污染后续无关工作。
8. 在集成测试中增加一个能力传输测试替身。保持模型侧 schema 不变，并断言可信会话请求头由内部生成。适配真实生产远程后端属于本 RFC 之外的后续工作。
9. 运行类型检查、定向测试、文档门禁、生成目录检查，最后运行仓库常规 CI 或 pre-push 门禁。

建议的聚焦测试矩阵：

| 场景 | 必须观察到的结果 |
|---|---|
| 驱动之外 | `current()` 为 `undefined` |
| 一个 Agent 跨越 await | 每个 continuation 都看到完全相同的 Agent |
| 两个并发 Agent | A 永远看不到 B，B 永远看不到 A |
| 嵌套子 Agent | 子 Agent 看到自己；随后恢复父 Agent |
| 子 Agent 创建窗口 | 父工具调用内的创建流程隐式看到父 Agent；`agentCtx.agent` 是子 Agent |
| 直接调用无 Agent 工具 | 显式工具行为仍然有效；隐式身份不存在 |
| 已清除的分离工作 | `run(undefined, ...)` 隐藏继承的 Agent |
| 失败和取消 | throw、rejection 和 abort 后上下文均得到恢复 |
| Agent dispose | 隐式引用不赋予 dispose 后的能力 |
| 服务重载 | Agent 驱动在 ALS disable 前收敛；保留的已 dispose 服务调用抛出文档约定的稳定错误 |
| 能力传输边界 | 会话身份由测试替身传输层写入类型化请求或请求头 |

## 考虑过的替代方案

**让每个函数都传递 Agent。** 对公开边界和承载权限的边界而言，这仍然是正确选择；但如果要求每个私有辅助函数都传递 Agent，就会产生大量样板代码，而隐式执行上下文正适合消除这些代码。本提案在边界处保留显式主体，只在单个可信异步进程内部使用 ALS。

**修改 `ctx.agent`，让它返回当前正在执行的 Agent。** 拒绝此方案，因为 `ctx.agent` 已经表示 Agent 作用域 Cordis 上下文的静态关联。让根上下文变成动态语义，会把注册作用域和执行作用域混合起来，在并发时产生意外行为，并破坏已经实现的 Agent 作用域 RFC。

**在 ALS 中存储完整的可变运行时对象。** 拒绝此方案，因为 Agent、会话、inbox、取消状态、轮次或步骤状态、工具执行和持久化日志已经有各自的真源。重复保存会产生陈旧快照、写入顺序问题，以及另一套需要清理的生命周期。

**在第一版 ALS 帧中携带步骤级 `AbortSignal`。** 本 RFC 拒绝此方案。signal 的生命周期是每步骤，而提议的 ALS 边界是每驱动，因此携带它需要嵌套的步骤和工具边界，还要明确规定分离工作、deadline 归属和恢复语义。现有执行 seam 已经显式传递取消。未来只有在出现具体横切消费方，并通过测试建立这些嵌套生命周期语义后，才可由独立 RFC 重新评估。

**使用一个进程级可变 `currentAgent`。** 拒绝此方案，因为并发 Agent 和 subagent 会在 await 边界间相互覆盖。它只有在所有工作严格串行时才正确，而多 Agent 执行明确不保证这一点。

**从模型可见的工具参数推导会话。** 拒绝此方案，因为模型可以修改这些参数。沙箱路由和授权需要可信的进程内身份，而不是用户或模型输入。

**把宿主平台的沙箱归属标识或提供方数据放入 Harness 上下文。** 拒绝此方案，因为沙箱归属是由 Harness 外部解析的宿主产品状态。Harness 在可信传输边界上传递自己的会话身份即可。

## 验收标准

- 一个 Node Harness 进程至少能并发执行两个 Agent，异步消费方始终观察到准确的发起 Agent。
- 在 Agent 驱动执行之外，隐式查询返回 `undefined`，且 `require()` 抛出稳定、可操作的错误。
- 嵌套 Agent 执行结束后会恢复父上下文。
- `agent.ctx`、`ctx.agent`、Agent 事件、提示词组装、`ToolExecution.agent`、LLM `sessionId` 和会话持久化保持现有语义。
- Agent、会话、轮次、步骤、沙箱和授权身份都不能由模型控制。
- 实现为无关分离任务提供显式 undefined 边界，并通过测试防止上下文泄漏，且不改变现有显式取消契约。
- 该服务随标准 agent 组合包加载，缺少它时 `dsh-agent-loop` 在加载阶段失败；配置测试锁定这一策略。
- dispose 或 HMR（热模块替换）会先让所有依赖的 Agent 驱动收敛，再禁用 ALS；已 dispose 服务上的保留调用会抛出文档约定的稳定错误，且已 dispose 的 Cordis 上下文不能继续访问活跃 ALS 状态。
- 一个能力传输测试替身能证明可信会话 ID 得到传播，同时不新增模型可见的 schema 字段。
- 包目录、依赖图、API 文档和相关架构文档得到重新生成或更新，仓库文档门禁通过。

## 风险

- 隐式上下文会从函数签名中隐藏依赖。将它限制在深层横切基础设施，并保留显式公开主体，可以控制这一成本。
- ALS 对分离 promise 和定时器的继承可能保留语义上陈旧的身份。实现必须提供显式 undefined 边界、文档和回归测试，而不能假设清理会自然发生。
- ALS 不会跨越 worker thread、子进程、Redis、HTTP 或持久化队列。每个此类边界都必须显式序列化所需身份。
- 隐式存储有意携带完整的存活 Agent 能力。被捕获的引用可能比 Agent 的发布状态活得更久，因此隐式存在本身绝不授权生命周期敏感工作，消费方仍须遵循 Agent 生命周期和取消契约。
- 强制加载给每个 agent 组合新增一个核心运行时依赖；本 RFC 接受这一成本，因为可选服务会让隐式身份依赖具体组合。支持范围内的 Node 版本仍存在可测量的传播成本，应另行基准测试。
- 过早加入轮次、步骤、signal、cwd 或工具细节会扩大继承范围和陈旧状态风险。第一版有意接受只提供 Agent 隐式身份的限制；未来任何额外的能力或控制字段都需要独立 RFC。
