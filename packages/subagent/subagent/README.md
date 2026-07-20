# @deepseek-ai/dsh-subagent

The subagent seam lets one agent delegate work to a child through a named provider. Callers use one service API (`ctx.subagents`); providers decide whether the child runs in this process, in another process, or through a future transport.

## Package roles

The family separates the stable interface from implementations and model-facing tools:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-subagent` | Provider registry, request/result types, and lifecycle events. |
| `@deepseek-ai/dsh-subagent-spawn` | Fresh in-process child. |
| `@deepseek-ai/dsh-subagent-fork` | In-process child seeded with completed parent turns. |
| `@deepseek-ai/dsh-subagent-acp` | Fresh out-of-process ACP child. |
| `@deepseek-ai/dsh-tool-subagent` | Model-facing tool over one configured provider. |

Multiple providers may coexist under different names. This lets a deployment expose, for example, a cheap in-process child and an isolated ACP child without changing the service contract.

## Service API

`SubagentService` has four main operations:

| Member | Meaning |
|---|---|
| `registerProvider(provider)` | Register one trusted same-process implementation by name. Registration is effect-scoped; removing it prevents new starts but does not revoke runs already returned to callers. Duplicate names fail loud. |
| `getProvider(name)` | Return the provider, or `undefined` when absent. |
| `list()` | Return provider names in insertion order. |
| `start(name, request)` | Validate requested capabilities and semantic values, then await the provider until a real child is ready. Fulfillment returns a holder-owned `SubagentRun`; rejection means the provider has already cleaned every partial startup resource. |

`SubagentStartRequest.signal` is required and is the canonical cancellation channel. An abort before publication makes `start()` reject after rollback; an abort after publication cancels the live child. The request may also select a model, require structured output, cap delegation depth, restrict child tools, or set a child persona.

Same-process requests, descriptors, results, and event payloads are trusted typed values borrowed as immutable. The service does not clone or freeze them; serialization and hostile-input validation belong at actual process, worker, persistence, and model boundaries.

## Capabilities

Start-time features are advertised in `provider.capabilities` because the service must reject an unsupported request before child creation:

- `outputSchema` — enforce a structured final result.
- `depthLimit` — enforce `maxDepth`.
- `toolFilter` — apply the requested child tool restriction.
- `persona` — apply a per-child persona.

Runtime features are optional methods on `SubagentRun`: `sendMessage?` steers a live child, while `resume?` asynchronously creates a continuation run. Method presence is the capability check.

`inheritsParentContext` is descriptive rather than enforceable. It says only whether the child sees completed parent conversation history (`fork` does; `spawn` and ACP do not), not whether it inherits tools, services, or authority.

## Ownership and lifecycle

`provider.start(request): Promise<SubagentRun>` is the ownership-transfer boundary. Before fulfillment, the provider owns setup and must cancel, roll back, and quiesce partial resources on every failure. After fulfillment, the caller owns the run and must call `dispose()` on every path.

`SubagentRun.result` resolves to `{ output, structured?, stopReason }`. Child-level failures resolve with a non-`completed` reason; only an infrastructure fault that the seam cannot represent may reject. `dispose()` is idempotent, cancels remaining work, and waits for the child resources to quiesce.

A local run publishes an ordinary child agent/session before `start()` fulfills, returns that shared session id as `SubagentRun.id`, exposes the exact child as `SubagentRun.localAgent`, and records `request.parent.session.id` in the child's `parentSession` header. Remote providers instead mint a parent-scoped lifecycle id and return `localAgent: undefined`.

The service emits `subagent/start` only after `start()` has fulfilled. It attaches the result observer before that synchronous notification, so even an already-settled child still produces `subagent/start` before `subagent/end`. The pair shares a service-minted `runId`; its `local` flag is snapshotted from the provider's exact `localAgent`, so observers never infer run identity or locality from reusable provider/session names.

Run events are scoped to the delegating parent. Every listener is independently contained: a synchronous throw or rejected returned promise is logged without starving peer listeners or changing the run.

Provider additions and removals also emit `subagent/provider-added` and `subagent/provider-removed`. Consumers such as the model-facing tool use those events because Cordis may load sibling plugins concurrently; configuration order does not prove registration order.

## Collection model

The model-facing tool collects synchronously by default: it awaits the child result and disposes the run before returning. Background delegation does not change this seam; the consumer registers startup and the eventual run with the generic `ctx.tasks` runtime, then collection and cancellation use the shared task tools. See the [background subagent tasks Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-background-subagent-tasks.md), the [capability-seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md), and `src/types.ts` for the complete contracts.

## Model Experience

Indirectly, through `dsh-tool-subagent`, which renders provider-specific schemas and foreground or generic-background results while child working context remains child-only.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Runtime steering and continuation are seam-only capabilities** — `sendMessage` and `resume` have no model-facing consumer in the current tool.
- **Lifecycle events are observe-only** — a run-affecting `subagent/end` continuation or decision surface waits for a concrete consumer.
