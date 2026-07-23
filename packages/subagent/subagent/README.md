# @deepseek-ai/dsh-subagent

English | [中文](README.zh.md)

The subagent seam lets one agent delegate work to a child through a named provider. Callers use one service API (`ctx.subagents`); providers decide whether the child runs in this process, in another process, or through a future transport.

## Package roles

The family separates the stable interface from implementations and model-facing tools:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-subagent` | Provider registry, request/result/descriptor types, and lifecycle events. |
| `@deepseek-ai/dsh-subagent-spawn` | Fresh in-process child, with cold resume. |
| `@deepseek-ai/dsh-subagent-fork` | In-process child seeded with completed parent turns, with cold resume. |
| `@deepseek-ai/dsh-subagent-acp` | Fresh out-of-process ACP child (one-shot). |
| `@deepseek-ai/dsh-subagent-control` | Continuable-child orchestration: durable ids, descriptors, Task-backed activation. |
| `@deepseek-ai/dsh-tool-subagent` | Model-facing delegation tool over one configured provider. |
| `@deepseek-ai/dsh-tool-subagent-control` | The globally named `send_message` follow-up tool. |

Multiple providers may coexist under different names. This lets a deployment expose, for example, a cheap in-process child and an isolated ACP child without changing the service contract.

## Service API

`SubagentService` has five main operations:

| Member | Meaning |
|---|---|
| `registerProvider(provider)` | Register one trusted same-process implementation by name. Registration is effect-scoped; removing it prevents new starts but does not revoke runs already returned to callers. Duplicate names fail loud. |
| `getProvider(name)` | Return the provider, or `undefined` when absent. |
| `list()` | Return provider names in insertion order. |
| `start(name, request)` | Validate requested capabilities and semantic values, then await the provider until a real child is ready. Fulfillment returns a holder-owned `SubagentRun`; rejection means the provider has already cleaned every partial startup resource. |
| `resume(name, request)` | Capability-checked dispatch to `provider.resume?()` with the same run lifecycle observation as `start`. The caller (the control service) has already loaded the child, folded its descriptor, and authorized the parent; this seam stays collection-, Task-, and persistence-agnostic. |

`SubagentStartRequest.signal` is required and is the canonical cancellation channel. An abort before publication makes `start()` reject after rollback; an abort after publication cancels the live child. The request may also select a model, require structured output, cap delegation depth, restrict child tools, set a child persona, or carry a resolved `continuation` (the control-allocated stable child id plus its durable descriptor), which requires the provider's `resume` capability.

Same-process requests, descriptors, results, and event payloads are trusted typed values borrowed as immutable. The service does not clone or freeze them; serialization and hostile-input validation belong at actual process, worker, persistence, and model boundaries.

## Capabilities

Start-time features are advertised in `provider.capabilities` because the service must reject an unsupported request before child creation:

- `outputSchema` — enforce a structured final result.
- `depthLimit` — enforce `maxDepth`.
- `toolFilter` — apply the requested child tool restriction.
- `persona` — apply a per-child persona.

Runtime features are optional methods whose presence is the capability check: `SubagentRun.steer?` delivers strictly to the actively running child turn (it throws rather than queueing when the child is not running), and `SubagentProvider.resume?` reconstructs a persisted continuable child. A run represents one disposable activation, so it deliberately has no cold-resume operation — a disposed run cannot be reconstructed after restart.

## The durable descriptor

The seam owns the versioned `subagent/descriptor` session event vocabulary (`src/descriptor.ts`): `snapshotSubagentDescriptor()` validates and detaches the declared composition before any Task exists, and `foldSubagentDescriptor()` recovers it from a loaded child log. The payload records the provider name, resolved child `agentOptions.provider`/`model`, and optional `persona`/`toolFilter` — explicit fields, never the merge-extensible `AgentOptions` object, so an unrelated extension value cannot break continuation. It omits `subagentDepth` (the persisted header's `delegationDepth` is the monotone floor) and `outputSchema` (an activation's result contract). The event is log-only: no `surfaceOp`, absent from model history, and retained by the append-only log across compaction.

## Delegation depth

The seam owns the depth vocabulary shared by implementations and consumers: the `AgentOptions.subagentDepth` declaration, `assertSubagentMaxDepth`, and `delegationDepthOf(agent)`. The persisted `SessionHeader.delegationDepth` is authoritative and monotone — runtime options may deepen the count but never lower it, so a resumed child cannot be re-counted as top-level.

`inheritsParentContext` is descriptive rather than enforceable. It says only whether the child sees completed parent conversation history (`fork` does; `spawn` and ACP do not), not whether it inherits tools, services, or authority.

## Ownership and lifecycle

`provider.start(request): Promise<SubagentRun>` is the ownership-transfer boundary. Before fulfillment, the provider owns setup and must cancel, roll back, and quiesce partial resources on every failure. After fulfillment, the caller owns the run and must call `dispose()` on every path. `provider.resume?(request)` shares the same contract for a resumed activation.

`SubagentRun.result` resolves to `{ output, structured?, stopReason }`. Child-level failures resolve with a non-`completed` reason; only an infrastructure fault that the seam cannot represent may reject. `dispose()` is idempotent, cancels remaining work, and waits for the child resources to quiesce.

A local run publishes an ordinary child agent/session before `start()` fulfills, returns that shared session id as `SubagentRun.id`, exposes the exact child as `SubagentRun.localAgent`, and records `request.parent.session.id` in the child's `parentSession` header. A continuable start publishes exactly the control-allocated `continuation.sessionId`. Remote providers instead mint a parent-scoped lifecycle id and return `localAgent: undefined`.

The service emits `subagent/start` only after `start()` or `resume()` has fulfilled. It attaches the result observer before that synchronous notification, so even an already-settled child still produces `subagent/start` before `subagent/end`. The pair shares a service-minted `runId`; its `local` flag is snapshotted from the provider's exact `localAgent`, so observers never infer run identity or locality from reusable provider/session names.

Run events are scoped to the delegating parent. Every listener is independently contained: a synchronous throw or rejected returned promise is logged without starving peer listeners or changing the run.

Provider additions and removals also emit `subagent/provider-added` and `subagent/provider-removed`. Consumers such as the model-facing tool use those events because Cordis may load sibling plugins concurrently; configuration order does not prove registration order.

## Collection model

The model-facing tool collects synchronously by default: it awaits the child result and disposes the run before returning. Background delegation does not change this seam; `@deepseek-ai/dsh-subagent-control` registers each activation with the generic `ctx.tasks` runtime, then collection and cancellation use the shared task tools. See the [background subagent tasks Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-background-subagent-tasks.md), the [continuable background subagents Agent Note](../../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.md), the [capability-seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md), and `src/types.ts` for the complete contracts.

## Model Experience

Indirectly, through `dsh-tool-subagent` and `dsh-tool-subagent-control`, which render provider-specific schemas and foreground, background, or follow-up results while child working context remains child-only.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **ACP children remain one-shot** — `AcpProvider.resume` requires persisting the remote session id in provider-specific descriptor data and a per-child continuation advertisement, since ACP `loadSession` support is negotiated per child rather than established by the provider method's presence.
- **Lifecycle events are observe-only** — a run-affecting `subagent/end` continuation or decision surface waits for a concrete consumer.
