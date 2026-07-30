# Subagent

English | [中文](subagent.zh.md)

The subagent seam — an agent delegating work to a child agent. Like [bash](bash.md) it is **one optional capability**, not part of the agent-loop spine, so its vocabulary lives here rather than in [core.md](core.md). But it differs from every other seam on one axis: **multiple provider implementations coexist** in one context, registered by name (`ctx.subagents`), where bash allows only one executor. The registry shape mirrors the [LLM adapter registry](llm-streaming.md), not the single-service bash executor.

Interface: [dsh-subagent](../../packages/subagent/subagent) (`ctx.subagents` + the vocabulary below). Implementations are sibling packages (`dsh-subagent-spawn`, `-fork`, `-acp`); the model-facing consumers are [dsh-tool-subagent](../../packages/subagent/tool-subagent) (per-provider delegation) and [dsh-tool-subagent-control](../../packages/subagent/tool-subagent-control) (the optional global `send_message`). The same `ctx.subagents` service owns continuable-child orchestration through an internal activation manager. The rationale lives in [the subagent Agent Note](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md), [the continuable subagents Agent Note](../../.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.md), and [the merged-service Agent Note](../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.md).

Sources: [`packages/subagent/subagent/src/types.ts`](../../packages/subagent/subagent/src/types.ts), [`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts), and [`packages/subagent/subagent/src/continuation.ts`](../../packages/subagent/subagent/src/continuation.ts)

## Two kinds of capability, discovered two ways

A provider advertises its **start-time** features on a static descriptor the service checks BEFORE a one-shot run exists; a request that needs one the provider lacks is rejected loud (`SubagentError('UNSUPPORTED_CAPABILITY')`), never accepted-then-ignored. Those flags describe only the one-shot [`start()`](#the-provider-seam-subagentprovider) path, where the provider composes the child. **Continuable** children are composed by the continuation manager itself, so they are gated by one optional method whose presence IS the capability, with TS narrowing as the discovery mechanism: [`SubagentProvider.prepareContinuable`](#the-provider-seam-subagentprovider).

```ts type-equiv
/**
 * Which START-TIME features a provider supports. Checked by the service before delegating to
 * {@link SubagentProvider.start}: a request that needs a capability the chosen provider lacks
 * is rejected with a typed error rather than accepted-then-ignored (the "fail loud, no silent
 * degradation" rule). These flags describe the ONE-SHOT
 * {@link SubagentProvider.start} path, where the provider composes the child;
 * continuable children are composed by the continuation manager itself and are
 * gated by {@link SubagentProvider.prepareContinuable} instead. Each flag
 * corresponds one-to-one to a {@link SubagentStartRequest} option: `depthLimit`
 * to `maxDepth`; the other names match.
 */
interface SubagentCapabilities {
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}
```

## The one-shot start request

The tool layer builds this request from the model input and its own config; the service validates it against the named provider before `start`. Required `parent` supplies the session cwd, lineage, and delegation depth. Optional output schema, depth, tool filter, and persona require matching capability flags. Unsupported schemas fail at start; in-process backends scope filters and personas to child creation and implement the supported object-rooted schema with a forced capture tool.

```ts type-equiv
/**
 * What a caller asks for when starting a ONE-SHOT subagent. The tool layer
 * builds this from the model's `{ description, prompt }` plus its own config;
 * the service validates {@link SubagentCapabilities} against the named provider
 * before dispatching to {@link SubagentProvider.start}.
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

`signal` is the single cancellation channel before and after readiness. The [subagent composition-controls Agent Note](../../.agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md) owns the persona, live global-tool filter, absolute-depth, and visibility-not-authority rationale.

Providers receive exactly this request: one-shot delegation has no service-resolved continuation state, because a continuable child never reaches `SubagentProvider.start()`.

## Continuable children and activations

A **continuable background subagent** is one durable child Session with at most one process-local **Activation** — a residency epoch for a reconstructed child Agent. An Activation is not a request, result, cancellation, or Task boundary: it may execute many FIFO turns and stays resident while descendants it created are still running. The continuation manager owns activation admission, authority, the live ownership graph, cold resume, and child-first disposal; the Agent loop owns all turn ordering and execution. No continuable path creates a Task or an intermediate result-bearing wrapper.

```text
persisted Session
  -> optional live Activation
       -> one retained AgentHandle
       -> Agent inbox as the only turn FIFO
       -> zero or more owned child Activations
```

`SubagentService.startContinuable()` reserves the stable child id, snapshots the versioned `subagent/descriptor` payload, asks the named provider for its detached `ContinuableCreateSpec`, creates the child Agent through a private activation-owner scope, establishes any continuable-parent ownership, and submits the initial prompt. It resolves with `{ childId, messageId }` when inbox acceptance yields the message id — without waiting for the turn to start or for the message to enter the Session log. Every failure before that acceptance rejects with neither id, disposing any created handle and rolling back the Activation and parent ownership.

`SubagentService.followup()` is the sole continuation-message operation, and routing depends only on Activation residency:

| Activation state | Sender | `followup` |
|---|---|---|
| `running` | parent or user | enqueue in the same Activation |
| `waiting` | parent or user | wake the same Activation |
| no Activation | parent or user | cold-resume a new Activation |

`running` means the Agent has an active admission or turn, or waking inbox work; `waiting` means it is quiescent but still owns at least one child Activation that has not completed disposal; `settled` means quiescent with every owned child disposed, at which point the manager disposes the `AgentHandle` and removes the Activation. The manager derives these from Agent quiescence and the owned-child set rather than maintaining a second execution state machine, and `activationState()` reports the current value (`undefined` when no Activation is live).

The Agent inbox is the only queue. Every continuation message becomes one `Agent.followup()` FIFO turn, so parent and user messages share one observable order and a follow-up cannot redirect a turn already underway. Successful delivery returns the accepted `MessageId`; the existing `agent/inbox/enqueue`, `agent/inbox/dequeue`, and `agent/inbox/discard` events remain the message-lifecycle observations, and the continuation layer defines no subagent-specific delivery route.

Authority is supplied by a trusted host interaction or an exact live Agent tool context. The parent variant is admitted only when the authenticated Agent is the durable child's direct parent recorded in `SessionHeader.parentSession`; only a trusted host adapter can supply user authority. `MessageSource` and `senderSessionId` are durable provenance after admission and grant no authority — the optional model-facing tool uses `CoordinatorMessageSource`, while a host adapter uses `{ kind: 'user' }`. User authority may cold-resume a child without loading its historical parent.

For both operations the caller signal owns lookup, materialization, and admission only until inbox acceptance. Afterwards the manager owns the Activation independently: later caller cancellation neither cancels the accepted turn nor disposes the child, and the seam exposes no public subagent cancellation or steering operation.

Every Activation owns its `AgentHandle` and an `ownedChildren: Set<SessionId>`; because one Session has at most one live Activation, the child Session id identifies the live child without another runtime-incarnation reference. Starting a child or submitting parent-originated work registers the child in a continuation-managed parent's set before the child can run, and that parent cannot settle while the set is non-empty. A top-level or other non-continuation Agent has no Activation and stays outside the waiting graph. Child release happens only after the child Agent is quiescent, every child of that child is disposed, the final durability checkpoint settles, and the child's `AgentHandle` completes disposal.

Only `ctx.sessions.flush(session) === true` confirms durability; `false` or rejection reports `DURABILITY_FAILED`. Either way the manager still disposes the handle and releases ownership, because retaining a failed child would permanently pin its ancestors in `waiting` — the persisted child state may then be missing or stale on a later resume. `drainContinuable()` is the lifecycle-wide stop path: it closes admission synchronously, then disposes every live Activation forest child-first, awaiting every branch despite individual failures. Durable child Sessions survive that process-local teardown.

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
 * Who authorizes one continuable-subagent operation. Authority comes from a
 * trusted host interaction or an exact live Agent tool context; durable
 * {@link MessageSource} provenance never authorizes delivery.
 */
type SubagentAuthority =
  /** The exact live parent Agent whose tool context is making the call. */
  | { readonly kind: 'parent'; readonly agent: Agent }
  /** A trusted host adapter acting for the human user. */
  | { readonly kind: 'user' }
```

```ts type-equiv
/** Options for following up with one continuable child. */
interface SubagentFollowupOptions {
  /** Durable attribution retained on the delivered message; it grants no authority. */
  readonly source: MessageSource
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal: AbortSignal
}
```

```ts type-equiv
/** Identities returned once a continuable child accepted its initial prompt. */
interface ContinuableStart {
  /** The durable child session id, stable across activations. */
  readonly childId: SessionId
  /** The accepted initial prompt's inbox message id. */
  readonly messageId: MessageId
}
```

```ts type-equiv
/**
 * The public residency state of one continuable child, derived from Agent
 * quiescence and the owned-child set rather than a second state machine:
 * `running` — the Agent has an active admission or turn, or waking inbox work;
 * `waiting` — the Agent is quiescent but still owns undisposed children;
 * `settled` — quiescent with every owned child disposed, so the manager
 * disposes the `AgentHandle` and removes the Activation.
 */
type ActivationState = 'running' | 'waiting' | 'settled'
```

The provider participates only in preparing the initial creation spec, where `spawn` and `fork` differ. Its returned spec carries only detached provider-specific creation inputs — today the optional parent-history seed — and no Agent, `AgentHandle`, prompt delivery, result, disposal, or resume operation. Cold resume does not dispatch through a provider at all: the manager folds the generic descriptor, calls `ctx.agents.resume()` through the same activation-owner scope, and submits the waiting turn.

```ts type-equiv
/**
 * What the continuation manager asks a provider for while materializing one
 * continuable child's FIRST activation. The manager has already reserved the
 * durable child identity and owns every later operation, so this request
 * carries only what distinguishes a fresh child from one seeded with parent
 * history.
 */
interface ContinuableCreateRequest {
  /** The reserved durable child session id, for provider diagnostics. */
  readonly sessionId: SessionId
  /** The delegating parent agent whose history a seeding provider reads. */
  readonly parent: Agent
  /**
   * Caller cancellation, which owns preparation only until the manager accepts
   * the initial prompt into the child's inbox.
   */
  readonly signal: AbortSignal
}
```

```ts type-equiv
/**
 * A provider's detached contribution to one continuable child's creation. This
 * is DATA, never a capability: it carries no Agent, `AgentHandle`, prompt
 * delivery, result, disposal, or resume operation, because the continuation
 * manager owns the child's whole lifecycle after preparation.
 */
interface ContinuableCreateSpec {
  /**
   * Completed-turn prefix of the parent's log to seed the child session with,
   * or absent for a fresh child. Same durable contract as
   * `CreateAgentOptions.seed`: contiguous from seq 0, lossless JSON, balanced.
   */
  readonly seed?: readonly SessionEvent[]
}
```

The descriptor (`SubagentDescriptorData` in [descriptor.ts](../../packages/subagent/subagent/src/descriptor.ts)) snapshots explicit fields — provider name, resolved child `agentOptions.provider`/`model`, optional `persona`/`toolFilter` — never the merge-extensible `AgentOptions` object, so an unrelated extension value cannot break continuation and a later composition input is a deliberate version change. It omits `subagentDepth` (cold resume trusts the persisted header's `delegationDepth` as the monotone floor) and `outputSchema` (a one-shot result contract, not durable composition). The continuation manager appends the model-hidden `subagent/descriptor` event after any provider-supplied lineage and before the initial prompt is admitted; `header.seedLength` remains the fork-lineage boundary, so descriptor lookup reads the child's own suffix. The event is log-only: no `surfaceOp`, never in model history, and retained across compaction by the append-only log.

## The terminal result: `SubagentResult`

The outcome of a one-shot run, resolved by `SubagentRun.result`. `structured` is present only after a requested `outputSchema` was successfully satisfied; requesting a schema does not guarantee it, and a provider may return `stopReason: 'error'` when the child fails or finishes without a valid capture. A non-`completed` `stopReason` means `output` may be partial — the consumer maps it to an `isError` tool result rather than reporting partial output as success.

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

## A one-shot run: `SubagentRun`

`SubagentRun` is the consumer-owned handle for a ready one-shot child — one disposable foreground delegation with one result, never a durable child handle. Consumers await `result` and always dispose the run to reach quiescence. Child failures resolve with a non-completed stop reason; only unrepresentable infrastructure faults reject. A run has no steering and no resume: continuable conversations have no run at all, because the continuation manager holds their `AgentHandle` directly and orders every turn through the child's own inbox.

```ts type-equiv
/**
 * ONE-SHOT child handle returned only after readiness. Consumers await
 * {@link result} and must always {@link dispose} to cancel remaining work and
 * reach quiescence. A run is one disposable foreground delegation with one
 * result; continuable conversations have no run — the continuation manager
 * holds their `AgentHandle` directly and orders every turn through the child's
 * own inbox.
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
   * `isError` tool result. Rejects on an infrastructure fault the seam cannot
   * represent as a stop reason.
   */
  readonly result: Promise<SubagentResult>
  /**
   * Cancel remaining work, reach child quiescence, and release resources.
   * Idempotent.
   */
  dispose(): Promise<void>
}
```

A local one-shot run MUST publish an ordinary child agent/session before `start()` fulfills, return that child session id as `SubagentRun.id`, expose the exact child as `localAgent`, and record `request.parent.session.id` in the child's `parentSession` header. Runtime ownership may place the child under the parent, provider, or root scope. A remote provider instead returns a parent-scoped lifecycle id and `localAgent: undefined`.

## The provider seam: `SubagentProvider`

Each provider is a named child-agent transport, and multiple providers may coexist. The service validates requested start-time capabilities before `start()`, and rejects a continuable start on a provider without `prepareContinuable`. `inheritsParentContext` describes only conversation seeding (`fork`: true; `spawn` and `acp`: false), allowing consumers to generate accurate model-facing wording without implying inherited tools, services, or authority.

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
   * Establish a ONE-SHOT child and return its handle only after publication.
   * The service has already validated that every requested start-time
   * capability is supported, so an implementation may assume e.g.
   * `request.maxDepth` is honorable when present. If setup fails or
   * `request.signal` aborts before fulfillment, the provider owns and cleans
   * all partial resources before this promise rejects. Ownership transfers to
   * the caller only on fulfillment.
   */
  start(request: SubagentStartRequest): Promise<SubagentRun>
  /**
   * OPTIONAL (continuable-creation capability): contribute the detached
   * creation inputs that distinguish this provider's continuable children —
   * today only whether the child session is seeded with parent history. Method
   * presence IS the capability: the service rejects continuable starts on
   * providers without it, while a provider that has it may still serve
   * ordinary one-shot delegations.
   *
   * This is the provider's ONLY participation in a continuable child. The
   * continuation manager owns identity reservation, composition, Agent
   * creation, prompt delivery, cold resume, ownership, and disposal, so a
   * provider never sees the child's Agent, handle, turns, or teardown.
   */
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
}
```

Provider `start()` fulfills only with a ready run. The service mints a unique `runId`, snapshots `local` from the provider's exact `localAgent`, observes the result, emits `subagent/start`, and returns the same run; rejection implies provider cleanup and emits no lifecycle pair. Each continuable Activation emits the same observe-only pair for its residency epoch, so a cold resume is a new epoch with its own `runId`. The paired `subagent/end` carries the same identity and the final output or infrastructure failure. Both events are observe-only and contain listener exceptions.

## In-process backends: depth and seed

The spawn and fork backends create an ordinary one-shot agent through `parent.ctx`, pass cancellation into core creation, and dispose through `AgentHandle`; a continuable child is instead created by the continuation manager through its own activation-owner scope. Provider removal blocks new starts without revoking accepted runs. Each child gets a new flat scope rather than inheriting parent registrations. Depth and fork seeding reuse existing agent and session vocabulary:

- **Delegation depth** is durable `SessionHeader.delegationDepth` plus the merge-extensible runtime field `AgentOptions.subagentDepth`; absence means top-level depth zero, and the greater present value is authoritative. The seam owns both fields — the loop neither sets nor reads them — so an in-process child persists parent depth + 1, cold resume cannot lower it, and every start rejects a derived depth outside the safe-integer domain or above a defined absolute `request.maxDepth` cap.
- **Fork seeding** uses `CreateAgentOptions.seed` (a `SessionEvent[]` prefix threaded through `AgentLoop.createAgent` → `ctx.sessions.prepare({ seed })`, the same primitive `ctx.agents.resume()` uses). The fork backend passes a *balanced completed-turn prefix* of the parent's log — the parent's events up to and including its last `turn/end` — so the seed is contiguous-from-0 and the [invariants](../../packages/support/invariants) replay accepts it (the in-flight, unbalanced turn is excluded).
