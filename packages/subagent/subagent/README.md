# @deepseek-ai/dsh-subagent

English | [中文](README.zh.md)

The subagent seam lets one agent delegate work to a child through a named provider. Callers use one service API (`ctx.subagents`); providers decide whether the child runs in this process, in another process, or through a future transport.

## Package roles

The family separates the stable interface from implementations and model-facing tools:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-subagent` | Provider registry, request/result/descriptor types, lifecycle events, and continuable-child orchestration. |
| `@deepseek-ai/dsh-subagent-spawn` | Fresh in-process child; supports continuable children. |
| `@deepseek-ai/dsh-subagent-fork` | In-process child seeded with completed parent turns; supports continuable children. |
| `@deepseek-ai/dsh-subagent-acp` | Fresh out-of-process ACP child (one-shot). |
| `@deepseek-ai/dsh-tool-subagent` | Model-facing delegation tool over one configured provider. |
| `@deepseek-ai/dsh-tool-subagent-control` | The globally named `send_message` follow-up tool. |

Multiple providers may coexist under different names. This lets a deployment expose, for example, a cheap in-process child and an isolated ACP child without changing the service contract.

## Service API

`SubagentService` has these operations:

| Member | Meaning |
|---|---|
| `registerProvider(provider)` | Register one trusted same-process implementation by name. Registration is effect-scoped; removing it prevents new starts but does not revoke runs already returned to callers. Duplicate names fail loud. |
| `getProvider(name)` | Return the provider, or `undefined` when absent. |
| `list()` | Return provider names in insertion order. |
| `start(name, request)` | Validate an ordinary caller request, then await the provider until a real one-shot child is ready. Fulfillment returns a holder-owned `SubagentRun`; rejection means the provider has already cleaned every partial startup resource. Continuable children never enter through this operation. |
| `startContinuable(spec)` | Establish one durable continuable child and deliver its initial prompt. Resolves with `{ childId, messageId }` when the child's inbox accepts that prompt, without waiting for the turn to start or for the message to reach the Session log; any earlier failure rejects with no ids and rolls the child back entirely. Requires `ctx.agents`, session persistence, and a provider with the `prepareContinuable` capability. |
| `followup(parent, childId, content, { source, signal })` | Deliver one later message from the exact live direct parent as the child's next FIFO turn, matching `Agent.followup()` terminology, and return the accepted `MessageId`. A resident child's inbox accepts it directly (waking a waiting Activation); an absent one cold-resumes from its persisted Session. Requires `ctx.agents`; cold resume also requires session persistence. |
| `drainContinuableDescendants(parents)` | Close admission below exact live host-owned parent Agents, stop only their visible continuable descendants, await materializations admitted below those roots through publication or rollback, then release the selected forests child-first. The cutoff lasts until each exact parent leaves the registry; unrelated parent forests and manager-wide admission remain live. |
| `listChildren(parentSessionId, signal?)` | List direct continuable children and per-child diagnostics in stable trace order without loading or resuming them. Requires session query; it does not require `ctx.agents` or the continuation manager. |

`SubagentStartRequest.signal` is required and is the canonical cancellation channel for a one-shot `start`. An abort before publication makes `start()` reject after rollback; an abort after publication cancels the live child. The request may also select a model, require structured output, cap delegation depth, restrict child tools, or set a child persona. For a continuable start or follow-up, the caller signal owns lookup, materialization, and admission only until inbox acceptance; afterward the manager owns the Activation independently, so later caller cancellation neither cancels the accepted turn nor disposes the child.

Follow-up authority comes from the exact live direct parent recorded in the child's durable header. Cold resume checks that authority before reconstruction and again in the final no-await inbox-admission span, so a parent unregistered or replaced during materialization cannot authorize delivery. The `source` on a follow-up is durable provenance retained on the delivered message and grants no authority.

Same-process requests, descriptors, results, and event payloads are trusted typed values borrowed as immutable. The service does not clone or freeze them; serialization and hostile-input validation belong at actual process, worker, persistence, and model boundaries.

## Capabilities

Start-time features are advertised in `provider.capabilities` because the service must reject an unsupported one-shot request before child creation:

- `outputSchema` — enforce a structured final result.
- `depthLimit` — enforce `maxDepth`.
- `toolFilter` — apply the requested child tool restriction.
- `persona` — apply a per-child persona.

Continuable creation is the optional `SubagentProvider.prepareContinuable?()` method: its presence is the capability check, so the service rejects a configured continuable start on a provider without it, while a provider that has it may still serve ordinary one-shot delegations. The method returns only a detached `ContinuableCreateSpec` (`{ seed? }`) — data, never a capability: it carries no Agent, `AgentHandle`, prompt delivery, result, disposal, or resume operation, because the continuation manager owns identity reservation, composition, Agent creation, prompt delivery, cold resume, ownership, and disposal after preparation. A one-shot `SubagentRun` represents one disposable foreground delegation with one result and no cold-resume operation.

## The durable descriptor

The seam owns the versioned `subagent/descriptor` session event vocabulary (`src/descriptor.ts`): `snapshotSubagentDescriptor()` validates and detaches the declared composition before the child session exists, and `foldSubagentDescriptor()` validates the complete current-version payload before recovering it from a loaded child log. Malformed current-version payloads fail before materialization; unsupported versions make the child non-resumable. The payload records the provider name, resolved child `agentOptions.provider`/`model`, and optional `persona`/`toolFilter` — explicit fields, never the merge-extensible `AgentOptions` object, so an unrelated extension value cannot break continuation. It omits `subagentDepth` (the persisted header's `delegationDepth` is the monotone floor) and `outputSchema` (never captured for a continuable child). The event is log-only: no `surfaceOp`, absent from model history, and retained by the append-only log across compaction.

## Delegation depth

The seam owns the depth vocabulary shared by implementations and consumers: the `AgentOptions.subagentDepth` declaration, `assertSubagentMaxDepth`, and `delegationDepthOf(agent)`. The persisted `SessionHeader.delegationDepth` is authoritative and monotone — runtime options may deepen the count but never lower it, so a resumed child cannot be re-counted as top-level.

`inheritsParentContext` is descriptive rather than enforceable. It says only whether the child sees completed parent conversation history (`fork` does; `spawn` and ACP do not), not whether it inherits tools, services, or authority.

## One-shot ownership and lifecycle

`provider.start(request): Promise<SubagentRun>` is the ownership-transfer boundary and the only Task-backed background path. Before fulfillment, the provider owns setup and must cancel, roll back, and quiesce partial resources on every failure. After fulfillment, the caller owns the run and must call `dispose()` on every path.

`SubagentRun.result` resolves to `{ output, structured?, stopReason }`. Child-level failures resolve with a non-`completed` reason; only an infrastructure fault that the seam cannot represent may reject. `dispose()` is idempotent, cancels remaining work, and waits for the child resources to quiesce.

A local run publishes an ordinary child agent/session before `start()` fulfills, returns that shared session id as `SubagentRun.id`, exposes the exact child as `SubagentRun.localAgent`, and records `request.parent.session.id` in the child's `parentSession` header. Remote providers instead mint a parent-scoped lifecycle id and return `localAgent: undefined`.

## Continuable children and Activations

A continuable child has one durable Session and at most one process-local **Activation** — one residency epoch for a reconstructed child Agent, not a request, result, cancellation, or Task boundary. The Agent inbox is the only turn queue, so the continuation manager owns residency while the Agent loop owns all turn ordering and execution. No continuable path creates a Task or an intermediate result-bearing wrapper.

The manager derives three internal residency conditions from Agent quiescence and the owned-child set rather than maintaining a second state machine: running (an active admission, open turn, or waking inbox work), waiting (quiescent but still owning at least one undisposed child), and settled (quiescent with every owned child disposed, so the manager disposes the `AgentHandle` and removes the Activation). Every continuation message uses `Agent.followup()` and becomes one FIFO turn with no steering of the current turn. Routing depends only on residency: running enqueues, waiting wakes the same Agent, and an absent Activation cold-resumes a new one.

The manager reserves the child identity, resolves the durable descriptor, calls `ctx.agents.create()` (or `ctx.agents.resume()` for cold resume) through a private activation-owner scope, installs the returned `AgentHandle` in the Activation, establishes any continuable-parent ownership, and then submits the prompt. Cold resume never dispatches through a provider because the persisted Session already holds the initial prefix and the folded descriptor is the whole reconstruction input.

A continuation-managed parent Activation records each child Session id in an `ownedChildren` set before the child can run and disposes only after every owned child Activation completes `AgentHandle` disposal (child-first). Teardown propagates Agent cancellation top-down before awaiting slow descendants, while handle release remains child-first. Top-level and other non-continuation Agents have no Activation and stay outside this waiting graph. Final settlement treats only `ctx.sessions.flush(child.session) === true` as durability confirmation; `false` or rejection reports `DURABILITY_FAILED` and still disposes the handle and releases ownership, because retaining a failed child would permanently pin its ancestors in `waiting`.

## Lifecycle events

The service emits a `subagent/start`/`subagent/end` pair for each one-shot run and each resident continuable Activation epoch, so continuable children are observable with the same vocabulary as one-shot runs without exposing whether the manager materialized, woke, or cold-resumed them. For a one-shot start it attaches the result observer before the synchronous `subagent/start`, so even an already-settled child still produces `subagent/start` before `subagent/end`; a continuable epoch that fails before residency emits neither edge. The pair shares a service-minted `runId`; the `local` flag is snapshotted from the provider's exact `localAgent` (always true for a continuable child), so observers never infer run identity or locality from reusable provider/session names. The `provider` field is lifecycle provenance rather than a live-registry claim: an accepted one-shot run may become ready after provider removal, and a cold-resumed epoch retains its descriptor's initial provider name without requiring that provider to be registered.

Run events are scoped to the delegating parent. Every listener is independently contained: a synchronous throw or rejected returned promise is logged without starving peer listeners or changing the run.

Provider additions and removals also emit `subagent/provider-added` and `subagent/provider-removed`. Consumers such as the model-facing tool use those events because Cordis may load sibling plugins concurrently; configuration order does not prove registration order.

## Collection model

The model-facing tool collects synchronously by default: it awaits the child result and disposes the run before returning. One-shot background delegation registers a plain Task in the tool, whose generic status, collection, and cancellation tools own later interaction. Continuable background delegation calls `ctx.subagents.startContinuable()` and returns only the durable child id; the child owns its own turns from inbox acceptance, so there is no Task, no result promise, and no public subagent cancellation — a caller sends later work with the `send_message` follow-up tool, and the durable child Session remains the source of the child's detailed output. The continuation manager exists only while `ctx.agents` is available, and session persistence is resolved per continuation operation. Independently, `listChildren()` resolves session query and dynamically imports its optional runtime only when called, then interprets a read-only live-preferred scan without consulting the continuation manager, Agent registrations, Activations, or providers. It forwards the caller's signal to cancellable trace and exact-read operations, checks cancellation around the remaining event-list read, and reports every observed abort as `SubagentError` code `CANCELLED`. See the [background subagent tasks Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-background-subagent-tasks.md), the [continuable background subagents Agent Note](../../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.md), the [durable catalog Agent Note](../../../.agents/notes/implemented/feature/2026-07-22-durable-subagent-catalog-and-list-agents.md), the [merged-service Agent Note](../../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.md), the [capability-seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md), and `src/types.ts` for the complete contracts.

## Model Experience

Indirectly, through `dsh-tool-subagent` and `dsh-tool-subagent-control`, which render provider-specific schemas and foreground, background, or follow-up results while child working context remains child-only.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **ACP children remain one-shot** — an ACP `prepareContinuable` requires persisting the remote session id in provider-specific descriptor data and a per-child continuation advertisement, since ACP `loadSession` support is negotiated per child rather than established by the method's presence. Remote providers also require a separate Activation ownership contract with equivalent authenticated control and child-first quiescence before they support continuable children.
- **No report delivery** — the MVP exposes no `report` tool, child-to-parent content delivery, or automatic parent wakeup; a completed child turn leaves its output in the durable child Session until a caller inspects that transcript or submits another authorized turn.
- **No host-user continuation** — `followup()` requires the exact live direct parent. A future host adapter needs a concrete authenticated interaction before the seam gains a separate user capability.
- **No subagent steering** — every continuation message opens a later FIFO turn, so a parent cannot redirect a turn already underway; the manager stores no current-turn controller state.
- **Process-local residency** — the Activation inbox and ownership graph do not coordinate two harness processes; concurrent access to one persistence store still requires a durable mailbox and cross-process lease protocol.
- **No replay of accepted-but-unlogged messages** — only messages written to the child Session log are reconstructable with their admitted provenance. A crash may lose an accepted initial prompt or follow-up that never reached the log; a later authorized message can cold-resume the child, but the lost message is not replayed automatically.
