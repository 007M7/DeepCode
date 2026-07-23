# Subagent

English | [中文](subagent.zh.md)

The subagent seam — an agent delegating work to a child agent. Like [bash](bash.md) it is **one optional capability**, not part of the agent-loop spine, so its vocabulary lives here rather than in [core.md](core.md). But it differs from every other seam on one axis: **multiple provider implementations coexist** in one context, registered by name (`ctx.subagents`), where bash allows only one executor. The registry shape mirrors the [LLM adapter registry](llm-streaming.md), not the single-service bash executor.

Interface: [dsh-subagent](../../packages/subagent/subagent) (`ctx.subagents` + the vocabulary below). Implementations are sibling packages (`dsh-subagent-spawn`, `-fork`, `-acp`); the model-facing consumers are [dsh-tool-subagent](../../packages/subagent/tool-subagent) (per-provider delegation) and [dsh-tool-subagent-control](../../packages/subagent/tool-subagent-control) (the global `send_message`). Continuable-child orchestration lives on `ctx.subagentControl` in [dsh-subagent-control](../../packages/subagent/subagent-control). The proposals and rationale: [the subagent Agent Note](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md) and [the continuable background subagents Agent Note](../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.md).

Source: [`packages/subagent/subagent/src/types.ts`](../../packages/subagent/subagent/src/types.ts)

## Two kinds of capability, discovered two ways

A provider advertises its **start-time** features on a static descriptor the service checks BEFORE a run exists; a request that needs one the provider lacks is rejected loud (`SubagentError('UNSUPPORTED_CAPABILITY')`), never accepted-then-ignored. **Runtime** features are instead optional methods whose presence IS the capability, with TS narrowing as the discovery mechanism: strict live steering is [`SubagentRun.steer`](#a-live-run-subagentrun) and persisted cold resume is [`SubagentProvider.resume`](#the-provider-seam-subagentprovider).

```ts type-equiv
/**
 * Which START-TIME features a provider supports. Checked by the service before delegating to
 * {@link SubagentProvider.start}: a request that needs a capability the chosen provider lacks
 * is rejected with a typed error rather than accepted-then-ignored (the "fail loud, no silent
 * degradation" rule). These static flags cover features needed before a run exists; runtime
 * capabilities are optional methods whose presence is the capability — strict live steering
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
  /**
   * Continuable-child intent, resolved by the control service before start.
   * The provider MUST publish exactly `sessionId` as the child identity
   * instead of allocating one internally, and MUST append the snapshotted
   * `descriptor` as the child's turn-enclosed `subagent/descriptor` event
   * before its first request. Requires {@link SubagentProvider.resume} (the
   * continuation capability); the service rejects the request otherwise.
   */
  readonly continuation?: SubagentContinuation
}
```

`signal` is the single cancellation channel before and after readiness. The [subagent composition-controls Agent Note](../../.agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md) owns the persona, live global-tool filter, absolute-depth, and visibility-not-authority rationale.

## Continuable children: `SubagentContinuation` and `SubagentResumeRequest`

A **continuable background subagent** is a durable child session with a series of Task-backed activations. `ctx.subagentControl` (`SubagentControlService` in [dsh-subagent-control](../../packages/subagent/subagent-control)) allocates the stable child id, snapshots the versioned `subagent/descriptor` payload, and passes both through the resolved start request; the provider publishes exactly that id and appends the descriptor inside the child's first turn. On follow-up, the control service loads the persisted child, authorizes the recorded `parentSession` as the direct parent, folds the descriptor, and dispatches a fully resolved resume request through `SubagentService.resume()` to `SubagentProvider.resume()`. The seam stays Task- and persistence-agnostic — descriptor lookup and Task association live only in the control service. `startContinuable()` returns a `ContinuableStart` (both identities), and `sendMessage()` returns a `SendMessageResult` reporting whether the message `steered` the running activation's existing Task or `started` a fresh one.

```ts type-equiv
/**
 * The resolved continuable-child identity and durable composition record a
 * control-service caller attaches to a start request.
 */
interface SubagentContinuation {
  /** Control-allocated stable child session id, published verbatim. */
  readonly sessionId: SessionId
  /** Snapshotted descriptor persisted in the child log for cold resume. */
  readonly descriptor: SubagentDescriptorData
}
```

```ts type-equiv
/**
 * What a caller asks for when resuming a persisted continuable child. The
 * control service loads the child log, folds and authorizes its descriptor,
 * and passes this fully resolved request to
 * {@link SubagentService.resume}, which dispatches to
 * {@link SubagentProvider.resume}. The provider reconstructs the declared
 * composition under the live parent's scope and drives one turn with `prompt`.
 */
interface SubagentResumeRequest {
  /** The persisted child session id to resume. */
  readonly sessionId: SessionId
  /** The follow-up message that starts the resumed activation's turn. */
  readonly prompt: ContentBlock[]
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

The descriptor (`SubagentDescriptorData` in [descriptor.ts](../../packages/subagent/subagent/src/descriptor.ts)) snapshots explicit fields — provider name, resolved child `agentOptions.provider`/`model`, optional `persona`/`toolFilter` — never the merge-extensible `AgentOptions` object, so an unrelated extension value cannot break continuation and a later composition input is a deliberate version change. It omits `subagentDepth` (cold resume trusts the persisted header's `delegationDepth` as the monotone floor) and `outputSchema` (an activation's result contract, not durable composition). The `subagent/descriptor` event is log-only: no `surfaceOp`, never in model history, and retained across compaction by the append-only log.

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

## A live run: `SubagentRun`

`SubagentRun` is the consumer-owned handle for a ready child — one disposable activation, never a durable child handle. Consumers await `result` and always dispose the run to reach quiescence. Child failures resolve with a non-completed stop reason; only unrepresentable infrastructure faults reject. The optional strict `steer` method advertises live delivery by presence; cold resume deliberately does NOT live here (a disposed run cannot be reconstructed after restart) — it is `SubagentProvider.resume`.

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
   * Cancel remaining work, reach child quiescence, and release resources.
   * Idempotent.
   */
  dispose(): Promise<void>
  /**
   * OPTIONAL (strict live-steering capability): deliver additional content to
   * the actively running child turn. STRICT means delivery joins the observed
   * turn or fails — the implementation must synchronously verify, with no
   * asynchronous boundary before delivery, that the child is running and its
   * turn can still record the message, and must not fall back to a queue path
   * that could start a new, untracked turn or silently drop the message after
   * this run has settled. Throws when delivery cannot join the turn. A run
   * represents one disposable activation, so it has no cold-resume operation;
   * resuming a settled child goes through {@link SubagentProvider.resume}.
   */
  steer?(content: ContentBlock[]): void
}
```

A local run MUST publish an ordinary child agent/session before `start()` fulfills, return that child session id as `SubagentRun.id`, expose the exact child as `localAgent`, and record `request.parent.session.id` in the child's `parentSession` header. Runtime ownership may place the child under the parent, provider, or root scope. A remote provider instead returns a parent-scoped lifecycle id and `localAgent: undefined`.

## The provider seam: `SubagentProvider`

Each provider is a named child-agent transport, and multiple providers may coexist. The service validates requested start-time capabilities before `start()`. `inheritsParentContext` describes only conversation seeding (`fork`: true; `spawn` and `acp`: false), allowing consumers to generate accurate model-facing wording without implying inherited tools, services, or authority.

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
  start(request: SubagentStartRequest): Promise<SubagentRun>
  /**
   * OPTIONAL (continuation capability): reconstruct a persisted continuable
   * child from its own transcript and declared descriptor, drive one
   * follow-up turn, and return a fresh run. Method presence is the capability
   * — the service rejects `resume` dispatch and continuable starts on
   * providers without it. Same publication contract as {@link start}: if
   * reconstruction fails or `request.signal` aborts before fulfillment, the
   * provider rolls its creation transaction back to quiescence before
   * rejecting; after fulfillment the same signal cancels the published run.
   */
  resume?(request: SubagentResumeRequest): Promise<SubagentRun>
}
```

`start()` fulfills only with a ready run; `resume()` shares the same publication and lifecycle-observation contract. The service mints a unique `runId`, snapshots `local` from the provider's exact `localAgent`, observes the result, emits `subagent/start`, and returns the same run; rejection implies provider cleanup and emits no lifecycle pair. The paired `subagent/end` carries the same identity and the final output or infrastructure failure. Both events are observe-only and contain listener exceptions.

## In-process backends: depth and seed

The spawn and fork backends create an ordinary agent through `parent.ctx`, pass cancellation into core creation, and dispose through `AgentHandle`. Provider removal blocks new starts without revoking accepted runs. Each child gets a new flat scope rather than inheriting parent registrations. Depth and fork seeding reuse existing agent and session vocabulary:

- **Delegation depth** is durable `SessionHeader.delegationDepth` plus the merge-extensible runtime field `AgentOptions.subagentDepth`; absence means top-level depth zero, and the greater present value is authoritative. The seam owns both fields — the loop neither sets nor reads them — so an in-process child persists parent depth + 1, resume cannot lower it, and every start rejects a derived depth outside the safe-integer domain or above a defined absolute `request.maxDepth` cap.
- **Fork seeding** uses `CreateAgentOptions.seed` (a `SessionEvent[]` prefix threaded through `AgentLoop.createAgent` → `ctx.sessions.prepare({ seed })`, the same primitive `resume` uses). The fork backend passes a *balanced completed-turn prefix* of the parent's log — the parent's events up to and including its last `turn/end` — so the seed is contiguous-from-0 and the [invariants](../../packages/support/invariants) replay accepts it (the in-flight, unbalanced turn is excluded).
