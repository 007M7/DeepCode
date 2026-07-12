# Subagent

The subagent seam — an agent delegating work to a child agent. Like [bash](bash.md) it is **one optional capability**, not part of the agent-loop spine, so its vocabulary lives here rather than in [core.md](core.md). But it differs from every other seam on one axis: **multiple provider implementations coexist** in one context, registered by name (`ctx.subagents`), where bash allows only one executor. The registry shape mirrors the [LLM adapter registry](llm-streaming.md), not the single-service bash executor.

Interface: [dsh-subagent](../../packages/subagent/subagent) (`ctx.subagents` + the vocabulary below). Implementations are sibling packages (`dsh-subagent-spawn`, `-fork`, `-acp`); the model-facing consumer is [dsh-tool-subagent](../../packages/subagent/tool-subagent). The proposal and rationale: [the subagent RFC](../rfc/implemented/feature/2026-06-21-subagent-capability-seam.md).

Source: [`packages/subagent/subagent/src/types.ts`](../../packages/subagent/subagent/src/types.ts)

## Two kinds of capability, discovered two ways

A provider advertises its **start-time** features on a static descriptor the service checks BEFORE a run exists; a request that needs one the provider lacks is rejected loud (`SubagentError('UNSUPPORTED_CAPABILITY')`), never accepted-then-ignored. **Runtime** features (steering, resume) are instead optional methods on [`SubagentRun`](#a-live-run-subagentrun) — the method's presence IS the capability, and TS narrowing is the discovery mechanism.

```ts type-equiv
interface SubagentCapabilities {
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}
```

## The start request

What a caller asks for when starting a subagent. The tool layer builds this from the model's `{ description, prompt }` plus its own config; the service validates the start-time capabilities against the named provider, then passes it to `provider.start`. `parent` is REQUIRED — in-process backends read `parent.session.header` for the working directory, the `parentSession` lineage, and the delegation depth. The four optional fields (`outputSchema`, `maxDepth`, `toolFilter`, `persona`) each gate on the matching `SubagentCapabilities` flag — in-process backends realize `toolFilter` as a scoped `tools.restrict()` and `persona` as a scoped shadowing `deployment:persona` section, both composed in the child's creation window. `outputSchema` is an object-rooted JSON Schema within the subset `assertSupportedOutputSchema` (dsh-tools) enforces — a schema outside it is rejected loud at start; the in-process backends realize it with a forced `structured_output` capture tool (see the [driver README](../../packages/subagent/subagent-inprocess/README.md)).

```ts type-equiv
interface SubagentStartRequest {
  readonly prompt: ContentBlock[]
  readonly parent: Agent
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptions
  readonly outputSchema?: StructuredOutputSchema
  readonly maxDepth?: number
  readonly toolFilter?: ToolRestriction
  readonly persona?: string
}
```

`signal` is the single cancellation channel before and after readiness. The [subagent composition-controls RFC](../rfc/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md) owns the persona, live global-tool filter, absolute-depth, and visibility-not-authority rationale.

## The terminal result: `SubagentResult`

The outcome of a run, resolved by `SubagentRun.result`. `structured` is present only after a requested `outputSchema` was successfully satisfied; requesting a schema does not guarantee it, and a provider may return `stopReason: 'error'` when the child fails or finishes without a valid capture. A non-`completed` `stopReason` means `output` may be partial — the consumer maps it to an `isError` tool result rather than reporting partial output as success.

```ts type-equiv
interface SubagentResult {
  readonly output: ContentBlock[]
  readonly structured?: unknown
  readonly stopReason: SubagentStopReason
}
```

`SubagentStopReason` is a [merge-extensible derived union](core.md#the-map--derived-union-pattern) — a backend may add variants, so consumers branch on the known cases and treat an unknown terminal reason as a failure:

```ts type-equiv
interface SubagentStopReasonMap {
  completed: 'completed'
  aborted: 'aborted'
  error: 'error'
  'max-tokens': 'max-tokens'
  refusal: 'refusal'
}
```

## A live run: `SubagentRun`

The handle the consumer holds after a provider has established a ready child. The consumer awaits `result` and MUST `dispose` on every path to cancel remaining work and reach child quiescence. `result` does NOT reject on a child-level failure — a model/transport failure resolves with `stopReason: 'error'` — so the consumer maps a non-`completed` reason to an `isError` result; it rejects only on an infrastructure fault the seam cannot represent. `sendMessage` and `resume` are OPTIONAL: a provider that supports the runtime capability defines the method; one that doesn't omits it.

```ts type-equiv
interface SubagentRun {
  readonly id: AgentId
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
  sendMessage?(content: ContentBlock[]): void
  resume?(content: ContentBlock[]): Promise<SubagentRun>
}
```

## The provider seam: `SubagentProvider`

One transport for running a child agent. Implementations register under a unique name via `SubagentService.registerProvider`; multiple coexist in one context. The service validates every requested start-time capability before calling `start`, so an implementation may assume e.g. `request.maxDepth` is honorable when present. `inheritsParentContext` is a DESCRIPTIVE fact beside the capabilities (nothing validates against it): whether a child sees the parent conversation (`fork`: true, `spawn`/`acp`: false) — the model-facing consumer derives truthful tool wording from it. It describes conversation history only, not tool registrations, injected services, or authority inheritance.

```ts type-equiv
interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  start(request: SubagentStartRequest): Promise<SubagentRun>
}
```

`SubagentProvider.start()` and `ctx.subagents.start()` are the publication boundary: their promises fulfill only with a ready run. The service attaches result observation, emits `subagent/start`, and returns the same holder-owned run; a rejected start has already cleaned provider-owned partial resources and emits neither lifecycle event. For an in-process provider, a start listener can resolve the live child with `ctx.agents.get(info.id)`; a remote provider need not publish into the local registry. `subagent/end` carries `lastAssistantMessage` (the child's final `output`) on the settle path and reports `error` on infrastructure rejection. Both lifecycle events are observe-only emits with per-listener exception containment.

## In-process backends: depth and seed

The two in-process backends ([dsh-subagent-spawn](../../packages/subagent/subagent-spawn) fresh, [dsh-subagent-fork](../../packages/subagent/subagent-fork) seeded) run the child as an ordinary `Agent` in the same application. The provider creates it directly through `parent.ctx`, passes the required signal into the core creation transaction, and delegates quiescent disposal to the returned `AgentHandle`. Provider removal prevents new starts but does not revoke an accepted run. The child receives a flat new scope rather than inheriting the parent's registrations. Two pieces of vocabulary ride on the existing agent/session types rather than new core types:

- **Delegation depth** is a merge-extensible `AgentOptions.subagentDepth` field (`0` for a top-level agent, parent + 1 for a child). Only `undefined` means top level; every stored present value must be a non-negative safe integer. The seam owns it — the loop neither sets nor reads it — so a nested spawn validates its parent's stored depth, rejects a derived child depth outside the safe-integer domain, and applies a defined absolute `request.maxDepth` cap to that child.
- **Fork seeding** uses `CreateAgentOptions.seed` (a `SessionEvent[]` prefix threaded through `AgentLoop.createAgent` → `ctx.sessions.prepare({ seed })`, the same primitive `resume` uses). The fork backend passes a *balanced completed-turn prefix* of the parent's log — the parent's events up to and including its last `turn/end` — so the seed is contiguous-from-0 and the [invariants](../../packages/support/invariants) replay accepts it (the in-flight, unbalanced turn is excluded).
