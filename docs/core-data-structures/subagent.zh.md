# Subagent

[English](subagent.md) | 中文

subagent seam：一个 agent（智能体）将工作委派给子 agent。与 [bash](bash.md) 一样，它是**一项可选能力**，不属于 agent loop（智能体循环）主干，因此其词汇定义在此而非 [core.md](core.md) 中。但它在一个维度上与其他所有 seam 不同：**同一上下文中可共存多个提供方实现**，按名称注册（`ctx.subagents`），而 bash 只允许一个执行器。注册表的形状参照 [LLM（大语言模型）适配器注册表](llm-streaming.md)，而非单服务的 bash 执行器。

接口：[dsh-subagent](../../packages/subagent/subagent)（`ctx.subagents` + 下文词汇）。实现为三个兄弟包（package）：`dsh-subagent-spawn`、`-fork`、`-acp`；面向模型的消费方包括 [dsh-tool-subagent](../../packages/subagent/tool-subagent)（按提供方委派）和 [dsh-tool-subagent-control](../../packages/subagent/tool-subagent-control)（可选的全局 `send_message`）。同一个 `ctx.subagents` 服务通过由 Task 支撑的内部管理器负责可继续子 agent 编排。设计理由见 [subagent Agent Note（agent 决策记录）](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md)、[可继续后台 subagent Agent Note](../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.md)和[服务合并 Agent Note](../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.md)。

源码：[`packages/subagent/subagent/src/types.ts`](../../packages/subagent/subagent/src/types.ts)、[`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts)和 [`packages/subagent/subagent/src/continuation.ts`](../../packages/subagent/subagent/src/continuation.ts)

## 两类能力，两种发现方式

提供方通过一个静态描述符公布其**启动时**特性，服务在 run 存在之前即行检查；如果请求依赖提供方不具备的特性，会被大声拒绝（`SubagentError('UNSUPPORTED_CAPABILITY')`），绝不会被接受后静默忽略。**运行时**特性则是可选方法；方法存在即为能力，TypeScript 的类型收窄即为发现机制：提供确认语义的在线 steering（中途引导）是 [`SubagentRun.steer`](#a-live-run-subagentrun)，从持久化存储恢复是 [`SubagentProvider.resume`](#the-provider-seam-subagentprovider)。

```ts type-equiv
/**
 * Which START-TIME features a provider supports. Checked by the service before delegating to
 * {@link SubagentProvider.start}: a request that needs a capability the chosen provider lacks
 * is rejected with a typed error rather than accepted-then-ignored (the "fail loud, no silent
 * degradation" rule). These static flags cover features needed before a run exists; runtime
 * capabilities are optional methods whose presence is the capability — confirmed live steering
 * is {@link SubagentRun.steer} and persisted cold resume is {@link SubagentProvider.resume}. Each
 * flag corresponds one-to-one to a {@link SubagentStartRequest} option: `depthLimit` to
 * `maxDepth`; the other names match.
 */
interface SubagentCapabilities {
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}
```

## 启动请求

工具层根据模型输入和自身配置构建此请求；服务在 `start` 之前针对指定提供方进行校验。必填的 `parent` 提供会话 cwd、谱系与委派深度。可选的 output schema、depth、工具过滤器和 persona 需要对应的能力 flag 匹配。不支持的 schema 在启动时即失败；进程内后端将 filter 和 persona 的作用域限定在子 agent 创建阶段，并通过强制 capture 工具实现所支持的 object-rooted schema。

```ts type-equiv
/**
 * What a caller asks for when starting a subagent. The tool layer builds this
 * from the model's `{ description, prompt }` plus its own config; the service
 * validates {@link SubagentCapabilities} against the named provider and
 * resolves a {@link SubagentProviderStartRequest} for dispatch.
 */
interface SubagentStartRequest {
  /** Content delivered as the child's user message. */
  readonly prompt: ContentBlock[]
  /**
   * The spawning agent. In-process providers derive workspace, lineage, and
   * delegation depth from its durable session state. ACP reads only its cwd,
   * and only when no deployment `cwd` override is configured.
   */
  readonly parent: Agent
  /**
   * Cancellation signal from the spawning context (the tool's `exec.signal`).
   * This is the canonical cancellation channel both before and after startup:
   * a provider rejects `start()` after cleaning partial resources when it
   * fires before publication, and cancels a published child when it fires
   * afterward.
   */
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptions
  /**
   * Object-rooted JSON Schema within `assertObjectJsonSchema`'s enforced subset. Start rejects
   * unsupported schemas or providers without the capability. Data must be plain host-realm JSON;
   * a successful child returns the matching value as {@link SubagentResult.structured}.
   */
  readonly outputSchema?: ObjectJsonSchema
  /**
   * Optional absolute delegation-depth cap for the child being started: its
   * computed depth must be less than or equal to this non-negative safe
   * integer. Requires {@link SubagentCapabilities.depthLimit}; rejected at
   * start otherwise.
   */
  readonly maxDepth?: number
  /**
   * Optional child tool scoping. Requires {@link SubagentCapabilities.toolFilter};
   * rejected at start otherwise. In-process backends apply it as a scoped
   * `tools.restrict()` in the child's creation window: the named tools vanish
   * from the child's prompt AND refuse to execute (one visibility), with loud
   * unknown-name validation.
   */
  readonly toolFilter?: ToolRestriction
  /**
   * Optional per-child persona. Requires {@link SubagentCapabilities.persona};
   * rejected at start otherwise. In-process backends register it as a scoped
   * `deployment:persona` section on the child, SHADOWING the deployment's
   * persona for this child alone — same template semantics as the deployment
   * persona (strict `{{…}}` interpolation against the registered variables).
   */
  readonly persona?: string
}
```

`signal` 是就绪前后唯一的取消通道。[subagent 组合控制 Agent Note](../../.agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md)规定 persona、live 全局工具过滤、绝对深度以及「可见性而非权限」的设计理由。

提供方会接收单独的已解析请求类型。`SubagentService.start()` 的参数类型不包含继续执行状态；只有 `startContinuable()` 才会提供由服务分配的标识和描述符。

```ts type-equiv
/**
 * Provider-facing start request after the service resolves optional
 * continuation state. Ordinary callers use {@link SubagentStartRequest}; only
 * the Task-backed continuation path can attach a stable child identity and
 * durable descriptor.
 */
interface SubagentProviderStartRequest extends SubagentStartRequest {
  /**
   * Continuable-child state resolved by `ctx.subagents` before provider dispatch.
   * The provider MUST publish exactly `sessionId` as the child identity
   * instead of allocating one internally, and MUST append the snapshotted,
   * model-hidden `subagent/descriptor` before the initial prompt is admitted.
   * Requires {@link SubagentProvider.resume} (the
   * continuation capability); the service rejects the request otherwise.
   */
  readonly continuation?: SubagentContinuation | undefined
}
```

## 可继续子 agent 与提供方恢复

**可继续后台 subagent** 是一份持久化子 agent 会话，由一系列由 Task 支撑的激活组成。`SubagentService.startContinuable()` 会分配稳定的子 agent id、对版本化的 `subagent/descriptor` payload 建立快照，并通过面向提供方的启动请求传入二者；提供方会准确发布该 id，并在初始 prompt 获准前追加描述符。`SubagentService.followup()` 沿用 `Agent` 的意图动词：它会引导实时激活，或在加载并授权已停止的子 agent 后，仅在内部向提供方分发已解析的恢复请求。只有 `ctx.tasks` 和 `ctx.agents` 存在时，内部管理器才会负责描述符查找与 Task 关联；每项继续执行操作都要求持久化，而加载提供方注册表不要求持久化。`startContinuable()` 返回两个标识，`followup()` 则报告内容是对现有 Task 执行了 `steered`，还是 `started` 一个新 Task。每个发送方都通过一个选项对象提供 `MessageSource` 和取消信号；若在在线投递等待准入期间中止该信号，则会取消共享激活，并在其完全停稳后拒绝调用。可选的面向模型工具使用 `CoordinatorMessageSource` 及其工具执行信号，人工适配器则使用 `{ kind: 'user' }` 及其交互信号。

```ts type-equiv
/** Attribution for a model coordinator's follow-up to one of its children. */
interface CoordinatorMessageSource {
  readonly kind: 'coordinator'
  /** Session id of the agent whose tool call produced the follow-up. */
  readonly senderSessionId: SessionId
}
```

```ts type-equiv
/**
 * Options for following up with one continuable child.
 */
interface SubagentFollowupOptions {
  /** Durable attribution retained on either live or resumed delivery. */
  readonly source: MessageSource
  /** Caller cancellation for a live-delivery admission wait. */
  readonly signal: AbortSignal
}
```

```ts type-equiv
/**
 * How a continuable follow-up was routed:
 * `steered` joined the running activation's existing Task without creating a
 * Task of its own; `started` created a fresh Task that cold-resumes the
 * durable child with the content. Failure is an exception, never a result —
 * undelivered content throws.
 */
type SubagentFollowupResult =
  | { readonly route: 'steered'; readonly taskId: TaskId }
  | { readonly route: 'started'; readonly taskId: TaskId }
```

```ts type-equiv
/**
 * The resolved continuable-child identity and durable composition record the
 * service attaches before provider dispatch.
 */
interface SubagentContinuation {
  /** Service-allocated stable child session id, published verbatim. */
  readonly sessionId: SessionId
  /** Snapshotted descriptor persisted in the child log for cold resume. */
  readonly descriptor: SubagentDescriptorData
}
```

```ts type-equiv
/**
 * Provider-facing request for reconstructing a persisted continuable child.
 * The continuation manager loads the child log, folds and authorizes its
 * descriptor, then privately dispatches this resolved request to
 * {@link SubagentProvider.resume}. The provider reconstructs the declared
 * composition under the live parent's scope and drives one turn with `prompt`.
 */
interface SubagentProviderResumeRequest {
  /** The persisted child session id to resume. */
  readonly sessionId: SessionId
  /** The follow-up message that starts the resumed activation's turn. */
  readonly prompt: ContentBlock[]
  /** Attribution retained when the follow-up becomes the resumed turn's user-role message. */
  readonly source: MessageSource
  /**
   * The live parent agent — the direct parent recorded in the persisted child
   * header. In-process backends reconstruct the child under this agent's
   * currently loaded scope.
   */
  readonly parent: Agent
  /**
   * Activation-owned cancellation signal, created before descriptor lookup.
   * Same pre/post-publication contract as {@link SubagentStartRequest.signal}:
   * an abort before publication rejects after rollback quiescence, and an
   * abort afterward cancels the published child turn.
   */
  readonly signal: AbortSignal
  /** The folded durable descriptor whose composition the provider reconstructs. */
  readonly descriptor: SubagentDescriptorData
}
```

描述符（[descriptor.ts](../../packages/subagent/subagent/src/descriptor.ts) 中的 `SubagentDescriptorData`）会对显式字段建立快照，包括提供方名称、已解析的子 agent `agentOptions.provider`/`model`，以及可选的 `persona`/`toolFilter`；它绝不会对可通过合并扩展的 `AgentOptions` 对象建立快照，因此无关的扩展值不会破坏继续执行，后续新增组合配置输入则必须明确更改版本。描述符省略 `subagentDepth`（从持久化存储恢复时，以持久化 header 中的 `delegationDepth` 为单调下界）和 `outputSchema`（单次激活的结果契约，而非持久化组合配置）。`subagent/descriptor` 事件只进入日志：不含 `surfaceOp`，绝不进入模型历史，并由仅追加日志跨压缩保留。

## 终态结果：`SubagentResult`

一次 run 的最终产出，由 `SubagentRun.result` resolve。`structured` 仅在请求了 `outputSchema` 且成功满足时才存在；请求 schema 不保证一定能得到它，当子 agent 失败或结束时未产出有效 capture 时，提供方可能返回 `stopReason: 'error'`。非 `completed` 的 `stopReason` 意味着 `output` 可能不完整——消费方将其映射为 `isError` 的工具结果，而非将部分输出报告为成功。

```ts type-equiv
/**
 * The terminal outcome of a subagent run, resolved by {@link SubagentRun.result}.
 */
interface SubagentResult {
  /** The child's final assistant output (the last assistant message's content). */
  readonly output: ContentBlock[]
  /**
   * The structured result after a requested `outputSchema` was successfully
   * satisfied. Requesting a schema does not guarantee presence: a provider can
   * end with `stopReason: 'error'` when the child fails or finishes without a
   * valid capture. Shape is validated against the request schema by the
   * provider; `unknown` here because the seam is schema-agnostic.
   */
  readonly structured?: unknown
  /** Why the run ended. A non-`completed` reason means `output` may be partial. */
  readonly stopReason: SubagentStopReason
}
```

`SubagentStopReason` 是一个[可合并扩展的派生联合类型](core.md#the-map--derived-union-pattern)——后端可以添加变体，因此消费方应对已知 case 分支处理，将未知的终态原因视为失败：

```ts type-equiv
/**
 * Why a subagent run ended. Merge-extensible (a backend may add variants);
 * consumers branch on the known cases and fall through `default`. The known
 * cases mirror the harness turn-end vocabulary so the tool layer can map a
 * non-`completed` result to an `isError` tool result.
 */
interface SubagentStopReasonMap {
  /** The child finished its turn normally. */
  completed: 'completed'
  /** Cancelled through the request signal or disposal. */
  aborted: 'aborted'
  /** Model or transport failure. */
  error: 'error'
  /** The child hit its token ceiling before finishing. */
  'max-tokens': 'max-tokens'
  /** The child declined the task. */
  refusal: 'refusal'
}
```

<a id="a-live-run-subagentrun"></a>

## 活跃 run：`SubagentRun`

`SubagentRun` 是消费方持有的、指向一个就绪子 agent 的句柄；它表示一次可 dispose（资源释放）的激活，绝不是持久化子 agent handle。消费方 await `result` 并始终 dispose 该 run，直至其完全停稳。子 agent 失败时以非 completed 的 stop reason resolve；只有不可表示的基础设施故障才会 reject。可继续结果为 completed 还表示提供方已确认本次激活的最终状态具备持久性；必需检查点失败则会 reject。可选且提供确认语义的 `steer` 方法通过自身的存在公布在线投递功能，并且只有在请求快照准入该消息后才会兑现。从持久化存储恢复属于提供方级操作：`SubagentProvider.resume` 会根据子 agent 的持久化会话重建一个新 run，因为进程内 run 在 dispose 或进程重启后就不再存在。

```ts type-equiv
/**
 * Child handle returned only after readiness. Consumers await {@link result} and must always
 * {@link dispose} to cancel remaining work and reach quiescence. Optional methods are runtime
 * capability discovery; narrow their presence before calling.
 */
interface SubagentRun {
  /**
   * Parent-scoped run id. For a local run, this MUST equal the published child
   * session id, whose `parentSession` records `request.parent.session.id`; a
   * remote provider mints an id unique in the parent namespace.
   */
  readonly id: SessionId
  /**
   * The exact published in-process child, or `undefined` for a remote run.
   * When present, its id is {@link id}; the provider retains no ownership
   * implication beyond the run's ordinary {@link dispose} contract.
   */
  readonly localAgent: Agent | undefined
  /**
   * Resolves with the child's terminal {@link SubagentResult} when the run
   * settles. Does NOT reject on a child-level failure — a model/transport
   * failure resolves with `stopReason: 'error'` so the consumer maps it to an
   * `isError` tool result. For a continuable activation, a completed result
   * also means the provider confirmed the activation's final state durable.
   * Rejects on an infrastructure fault the seam cannot represent as a stop
   * reason, including a failed required durability checkpoint.
   */
  readonly result: Promise<SubagentResult>
  /**
   * Cancel remaining work, reach child quiescence, and release resources.
   * Idempotent.
   */
  dispose(): Promise<void>
  /**
   * OPTIONAL (confirmed live-steering capability): submit additional content
   * to the active child and fulfill only after a committed request snapshot
   * admits it. Rejects when terminal policy, cancellation, disposal, or a lost
   * settlement race prevents admission; it never falls through to a queued
   * untracked turn or cold resume. A run represents one disposable activation,
   * so resuming a settled child goes through {@link SubagentProvider.resume}.
   * `source` is retained on the admitted steering message without changing its
   * user role in model history.
   */
  steer?(content: ContentBlock[], source: MessageSource): Promise<void>
}
```

本地 run 必须在 `start()` fulfill 前发布一个普通子 agent/会话，将该子会话 id 作为 `SubagentRun.id` 返回，以 `localAgent` 暴露确切子 agent，并在子 agent 的 `parentSession` header 中记录 `request.parent.session.id`。运行时所有权可以把子 agent 放在 parent、提供方或 root 作用域下。远程提供方则返回 parent 作用域的生命周期 id 与 `localAgent: undefined`。

## 提供方 seam：`SubagentProvider`

每个提供方是一个具名的子 agent 传输层，多个提供方可以共存。服务在 `start()` 之前校验请求的启动时能力。`inheritsParentContext` 仅描述对话种子注入（`fork`：true；`spawn` 和 `acp`：false），使消费方能生成准确的面向模型的措辞，而不暗示继承了工具、服务或权限。

```ts type-equiv
/**
 * One registered transport for running child agents. Providers are trusted
 * same-process implementations; callers treat descriptors and returned values
 * as borrowed immutable data.
 */
interface SubagentProvider {
  /** Unique registry name (e.g. `spawn`, `fork`, `acp`). */
  readonly name: string
  /** The start-time features this provider supports (see {@link SubagentCapabilities}). */
  readonly capabilities: SubagentCapabilities
  /**
   * Whether the child sees the parent's completed-turn prefix. This is descriptive, not a
   * service-validated start capability: the model-facing tool derives truthful wording from it.
   * It says nothing about tool registration, injected services, or authority inheritance.
   */
  readonly inheritsParentContext: boolean
  /**
   * Establish a child and return its handle only after publication. The
   * service has already validated that every requested start-time capability
   * is supported, so an implementation may assume e.g. `request.maxDepth` is
   * honorable when present. If setup fails or `request.signal` aborts before
   * fulfillment, the provider owns and cleans all partial resources before this
   * promise rejects. Ownership transfers to the caller only on fulfillment.
   */
  start(request: SubagentProviderStartRequest): Promise<SubagentRun>
  /**
   * OPTIONAL (continuation capability): reconstruct a persisted continuable
   * child from its own transcript and declared descriptor, drive one
   * follow-up turn, and return a fresh run. Method presence is the capability
   * — the service rejects continuable starts and cold-resume dispatch on
   * providers without it. Same publication contract as {@link start}: if
   * reconstruction fails or `request.signal` aborts before fulfillment, the
   * provider rolls its creation transaction back to quiescence before
   * rejecting; after fulfillment the same signal cancels the published run.
   */
  resume?(request: SubagentProviderResumeRequest): Promise<SubagentRun>
}
```

提供方的 `start()` 仅在 run 就绪时 fulfill；提供方的 `resume()` 采用相同的发布与生命周期观察契约，但只有继续执行管理器会分发它。服务铸造唯一 `runId`，从提供方的确切 `localAgent` 快照 `local`，观察结果，emit `subagent/start`，并返回同一个 run；rejection 意味着提供方已清理，且不会 emit 生命周期事件对。配对的 `subagent/end` 携带相同标识与最终输出或基础设施失败。两个事件都仅用于观察，每个 listener 异常都会被独立隔离。

## 进程内后端：深度与种子

spawn 和 fork 后端通过 `parent.ctx` 创建一个普通 agent，将取消信号传入核心创建流程，并通过 `AgentHandle` 进行 dispose。移除提供方会阻止新的 start，但不会撤销已接受的 run。每个子 agent 获得一个新的扁平作用域，而非继承父级注册。深度与 fork 种子注入复用既有的 agent 和会话词汇：

- **委派深度**由持久 `SessionHeader.delegationDepth` 与可合并扩展的运行时字段 `AgentOptions.subagentDepth` 共同表示；缺失表示顶层深度为零，存在的较大值具有权威性。两个字段都归该 seam 所有——循环既不设置也不读取它们——因此进程内子 agent 会持久保存 parent 深度 + 1，恢复无法降低深度，而且每次 start 都会拒绝超出安全整数域、或高于已定义绝对 `request.maxDepth` 上限的派生深度。
- **Fork 种子注入**使用 `CreateAgentOptions.seed`（一个 `SessionEvent[]` 前缀，经由 `AgentLoop.createAgent` → `ctx.sessions.prepare({ seed })` 传递，与 `resume` 使用的原语相同）。fork 后端传入父级日志的一段*平衡的已完成轮次前缀*——父级事件直到并包括其最后一个 `turn/end`——因此种子从 0 连续，[invariants](../../packages/support/invariants) 回放可以接受它（进行中的、未平衡的轮次被排除在外）。
