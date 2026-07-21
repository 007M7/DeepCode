# Subagent

The subagent seam — an agent delegating work to a child agent. Like [bash](bash.md) it is **one optional capability**, not part of the agent-loop spine, so its vocabulary lives here rather than in [core.md](core.md). But it differs from every other seam on one axis: **multiple provider implementations coexist** in one context, registered by name (`ctx.subagents`), where bash allows only one executor. The registry shape mirrors the [LLM adapter registry](llm-streaming.md), not the single-service bash executor.

Interface: [dsh-subagent](../../packages/subagent/subagent) (`ctx.subagents` + the vocabulary below). Implementations are sibling packages (`dsh-subagent-spawn`, `-fork`, `-acp`); the model-facing consumer is [dsh-tool-subagent](../../packages/subagent/tool-subagent). The proposal and rationale: [the subagent Agent Note](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md).

Source: [`packages/subagent/subagent/src/types.ts`](../../packages/subagent/subagent/src/types.ts)

## Two kinds of capability, discovered two ways

A provider advertises its **start-time** features on a static descriptor the service checks BEFORE a run exists; a request that needs one the provider lacks is rejected loud (`SubagentError('UNSUPPORTED_CAPABILITY')`), never accepted-then-ignored. **Runtime** features (steering, resume) are instead optional methods on [`SubagentRun`](#a-live-run-subagentrun) — the method's presence IS the capability, and TS narrowing is the discovery mechanism.

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

## The start request

The tool layer builds this request from the model input and its own config; the service validates it against the named provider before `start`. Required `parent` supplies the session cwd, lineage, and delegation depth. Optional output schema, depth, tool filter, and persona require matching capability flags. Unsupported schemas fail at start; in-process backends scope filters and personas to child creation and implement the supported object-rooted schema with a forced capture tool.

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

`signal` is the single cancellation channel before and after readiness. The [subagent composition-controls Agent Note](../../.agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md) owns the persona, live global-tool filter, absolute-depth, and visibility-not-authority rationale.

## The terminal result: `SubagentResult`

The outcome of a run, resolved by `SubagentRun.result`. `structured` is present only after a requested `outputSchema` was successfully satisfied; requesting a schema does not guarantee it, and a provider may return `stopReason: 'error'` when the child fails or finishes without a valid capture. A non-`completed` `stopReason` means `output` may be partial — the consumer maps it to an `isError` tool result rather than reporting partial output as success.

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

`SubagentStopReason` is a [merge-extensible derived union](core.md#the-map--derived-union-pattern) — a backend may add variants, so consumers branch on the known cases and treat an unknown terminal reason as a failure:

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

## A live run: `SubagentRun`

`SubagentRun` is the consumer-owned handle for a ready child. Consumers await `result` and always dispose the run to reach quiescence. Child failures resolve with a non-completed stop reason; only unrepresentable infrastructure faults reject. Optional `sendMessage` and `resume` methods advertise their runtime capabilities by presence.

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

A local run MUST publish an ordinary child agent/session before `start()` fulfills, return that child session id as `SubagentRun.id`, expose the exact child as `localAgent`, and record `request.parent.session.id` in the child's `parentSession` header. Runtime ownership may place the child under the parent, provider, or root scope. A remote provider instead returns a parent-scoped lifecycle id and `localAgent: undefined`.

## The provider seam: `SubagentProvider`

Each provider is a named child-agent transport, and multiple providers may coexist. The service validates requested start-time capabilities before `start()`. `inheritsParentContext` describes only conversation seeding (`fork`: true; `spawn` and `acp`: false), allowing consumers to generate accurate model-facing wording without implying inherited tools, services, or authority.

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

`start()` fulfills only with a ready run. The service mints a unique `runId`, snapshots `local` from the provider's exact `localAgent`, observes the result, emits `subagent/start`, and returns the same run; rejection implies provider cleanup and emits no lifecycle pair. The paired `subagent/end` carries the same identity and the final output or infrastructure failure. Both events are observe-only and contain listener exceptions.

## In-process backends: depth and seed

The spawn and fork backends create an ordinary agent through `parent.ctx`, pass cancellation into core creation, and dispose through `AgentHandle`. Provider removal blocks new starts without revoking accepted runs. Each child gets a new flat scope rather than inheriting parent registrations. Depth and fork seeding reuse existing agent and session vocabulary:

- **Delegation depth** is durable `SessionHeader.delegationDepth` plus the merge-extensible runtime field `AgentOptions.subagentDepth`; absence means top-level depth zero, and the greater present value is authoritative. The seam owns both fields — the loop neither sets nor reads them — so an in-process child persists parent depth + 1, resume cannot lower it, and every start rejects a derived depth outside the safe-integer domain or above a defined absolute `request.maxDepth` cap.
- **Fork seeding** uses `CreateAgentOptions.seed` (a `SessionEvent[]` prefix threaded through `AgentLoop.createAgent` → `ctx.sessions.prepare({ seed })`, the same primitive `resume` uses). The fork backend passes a *balanced completed-turn prefix* of the parent's log — the parent's events up to and including its last `turn/end` — so the seed is contiguous-from-0 and the [invariants](../../packages/support/invariants) replay accepts it (the in-flight, unbalanced turn is excluded).
