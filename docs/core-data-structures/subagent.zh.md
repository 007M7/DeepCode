# Subagent

[English](subagent.md) | 中文

subagent seam：一个 agent（智能体）将工作委派给子 agent。与 [bash](bash.md) 一样，它是**一项可选能力**，不属于 agent loop（智能体循环）主干，因此其词汇定义在此而非 [core.md](core.md) 中。但它在一个维度上与其他所有 seam 不同：**同一上下文中可共存多个提供方实现**，按名称注册（`ctx.subagents`），而 bash 只允许一个执行器。注册表的形状参照 [LLM（大语言模型）适配器注册表](llm-streaming.md)，而非单服务的 bash 执行器。

接口：[dsh-subagent](../../packages/subagent/subagent)（`ctx.subagents` + 下文词汇）。实现为三个兄弟包（package）：`dsh-subagent-spawn`、`-fork`、`-acp`；面向模型的消费方是 [dsh-tool-subagent](../../packages/subagent/tool-subagent)。提案与设计理由见 [subagent Agent Note（agent 决策记录）](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md)。

源码：[`packages/subagent/subagent/src/types.ts`](../../packages/subagent/subagent/src/types.ts)

## 两类能力，两种发现方式

提供方通过一个静态描述符公布其**启动时**特性，服务在 run 存在之前即行检查；如果请求依赖提供方不具备的特性，会被大声拒绝（`SubagentError('UNSUPPORTED_CAPABILITY')`），绝不会被接受后静默忽略。**运行时**特性（steering（中途引导）、恢复）则是 [`SubagentRun`](#a-live-run-subagentrun) 上的可选方法——方法的存在即为能力，TypeScript 的类型收窄即为发现机制。

```ts type-equiv
/**
 * Which START-TIME features a provider supports. Checked by the service before delegating to
 * {@link SubagentProvider.start}: a request that needs a capability the chosen provider lacks
 * is rejected with a typed error rather than accepted-then-ignored (the "fail loud, no silent
 * degradation" rule). These static flags cover features needed before a run exists; runtime
 * capabilities such as steering and resume are optional {@link SubagentRun} methods whose presence
 * is the capability.
 */
interface SubagentCapabilities {
  /** Honor {@link SubagentStartRequest.outputSchema} (structured final output). */
  readonly outputSchema: boolean
  /** Enforce {@link SubagentStartRequest.maxDepth} (recursion cap). */
  readonly depthLimit: boolean
  /** Enforce {@link SubagentStartRequest.toolFilter} (child tool scoping). */
  readonly toolFilter: boolean
  /** Honor {@link SubagentStartRequest.persona} (a per-child persona). */
  readonly persona: boolean
}
```

## 启动请求

工具层根据模型输入和自身配置构建此请求；服务在 `start` 之前针对指定提供方进行校验。必填的 `parent` 提供会话 cwd、谱系与委派深度。可选的 output schema、depth、工具过滤器和 persona 需要对应的能力 flag 匹配。不支持的 schema 在启动时即失败；进程内后端将 filter 和 persona 的作用域限定在子 agent 创建阶段，并通过强制 capture 工具实现所支持的 object-rooted schema。

```ts type-equiv
/**
 * What a caller asks for when starting a subagent. The tool layer builds this
 * from the model's `{ description, prompt }` plus its own config; the service
 * validates {@link SubagentCapabilities} against the named provider, then
 * passes it to {@link SubagentProvider.start}.
 */
interface SubagentStartRequest {
  /** The task/prompt for the child agent (a user message in the child session). */
  readonly prompt: ContentBlock[]
  /**
   * The spawning ("parent") agent — the one whose tool call started this
   * subagent. REQUIRED: in-process backends read `parent.session.header` for
   * the working directory, the `parentSession` lineage to stamp on the child,
   * and the parent's delegation depth. The out-of-process backend (ACP) reads
   * exactly one field — the session header's cwd, the child's workspace when
   * no deployment `cwd` override is configured; nothing else crosses the
   * process boundary.
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
  /** Per-child agent options (model and plugin-defined extension fields). */
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
  /** The run was cancelled by its request signal or by disposal. */
  aborted: 'aborted'
  /** The child failed (model error, transport error). */
  error: 'error'
  /** The child hit its token ceiling before finishing. */
  'max-tokens': 'max-tokens'
  /** The child declined the task. */
  refusal: 'refusal'
}
```

<a id="a-live-run-subagentrun"></a>

## 活跃 run：`SubagentRun`

`SubagentRun` 是消费方持有的、指向一个就绪子 agent 的句柄。消费方 await `result` 并始终 dispose（资源释放）该 run，直至其完全停稳。子 agent 失败时以非 completed 的 stop reason resolve；只有不可表示的基础设施故障才会 reject。可选的 `sendMessage` 和 `resume` 方法通过自身的存在来公布运行时能力。

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
   * `isError` tool result. Rejects only on an infrastructure fault the seam
   * cannot represent as a stop reason.
   */
  readonly result: Promise<SubagentResult>
  /**
   * Cancel remaining work, reach child quiescence, and release the run's
   * resources (in-process: dispose the owned agent and remove its session;
   * ACP: kill and reap the subprocess). Idempotent.
   */
  dispose(): Promise<void>
  /**
   * OPTIONAL (steering capability): send additional content to the running
   * child between steps. Present only on providers that support live steering.
   */
  sendMessage?(content: ContentBlock[]): void
  /**
   * OPTIONAL (resume capability): send a follow-up task to a settled child,
   * continuing its session, and return a fresh run for the continuation.
   */
  resume?(content: ContentBlock[]): Promise<SubagentRun>
}
```

本地 run 必须在 `start()` fulfill 前发布一个普通子 agent/会话，将该子会话 id 作为 `SubagentRun.id` 返回，以 `localAgent` 暴露确切子 agent，并在子 agent 的 `parentSession` header 中记录 `request.parent.session.id`。运行时所有权可以把子 agent 放在 parent、提供方或 root 作用域下。远程提供方则返回 parent 作用域的生命周期 id 与 `localAgent: undefined`。

## 提供方 seam：`SubagentProvider`

每个提供方是一个具名的子 agent 传输层，多个提供方可以共存。服务在 `start()` 之前校验请求的启动时能力。`inheritsParentContext` 仅描述对话种子注入（`fork`：true；`spawn` 和 `acp`：false），使消费方能生成准确的面向模型的措辞，而不暗示继承了工具、服务或权限。

```ts type-equiv
/**
 * A subagent backend: one transport for running a child agent (in-process
 * spawn/fork, ACP to another process, …). Implementations register under a
 * unique name via {@link SubagentService.registerProvider}; multiple providers
 * coexist in one context (unlike the single-implementation bash seam). The
 * Providers are trusted same-process implementations; callers treat their
 * descriptors and returned values as borrowed immutable data.
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
  start(request: SubagentStartRequest): Promise<SubagentRun>
}
```

`start()` 仅在 run 就绪时 fulfill。服务铸造唯一 `runId`，从提供方的确切 `localAgent` 快照 `local`，观察结果，emit `subagent/start`，并返回同一个 run；rejection 意味着提供方已清理，且不会 emit 生命周期事件对。配对的 `subagent/end` 携带相同标识与最终输出或基础设施失败。两个事件都仅用于观察，每个 listener 异常都会被独立隔离。

## 进程内后端：深度与种子

spawn 和 fork 后端通过 `parent.ctx` 创建一个普通 agent，将取消信号传入核心创建流程，并通过 `AgentHandle` 进行 dispose。移除提供方会阻止新的 start，但不会撤销已接受的 run。每个子 agent 获得一个新的扁平作用域，而非继承父级注册。深度与 fork 种子注入复用既有的 agent 和会话词汇：

- **委派深度**由持久 `SessionHeader.delegationDepth` 与可合并扩展的运行时字段 `AgentOptions.subagentDepth` 共同表示；缺失表示顶层深度为零，存在的较大值具有权威性。两个字段都归该 seam 所有——循环既不设置也不读取它们——因此进程内子 agent 会持久保存 parent 深度 + 1，恢复无法降低深度，而且每次 start 都会拒绝超出安全整数域、或高于已定义绝对 `request.maxDepth` 上限的派生深度。
- **Fork 种子注入**使用 `CreateAgentOptions.seed`（一个 `SessionEvent[]` 前缀，经由 `AgentLoop.createAgent` → `ctx.sessions.prepare({ seed })` 传递，与 `resume` 使用的原语相同）。fork 后端传入父级日志的一段*平衡的已完成轮次前缀*——父级事件直到并包括其最后一个 `turn/end`——因此种子从 0 连续，[invariants](../../packages/support/invariants) 回放可以接受它（进行中的、未平衡的轮次被排除在外）。
