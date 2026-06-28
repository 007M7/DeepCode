# Subagent

The subagent seam — an agent delegating work to a child agent. Like [bash](bash.md) it is **one optional capability**, not part of the agent-loop spine, so its vocabulary lives here rather than in [core.md](core.md). But it differs from every other seam on one axis: **multiple provider implementations coexist** in one context, registered by name (`ctx.subagents`), where bash allows only one executor. The registry shape mirrors the [LLM adapter registry](llm-streaming.md), not the single-service bash executor.

Interface: [dsh-subagent](../../packages/subagent/subagent) (`ctx.subagents` + the vocabulary below). Implementations are sibling packages (`dsh-subagent-spawn`, `-fork`, `-acp`); the model-facing consumer is [dsh-tool-subagent](../../packages/subagent/tool-subagent). The proposal and rationale: [the subagent RFC](../rfc/implemented/feature/2026-06-21-subagent-capability-seam.md).

Source: [`packages/subagent/subagent/src/types.ts`](../../packages/subagent/subagent/src/types.ts)

## Two kinds of capability, discovered two ways

A provider advertises its **start-time** features on a static descriptor the service checks BEFORE a run exists; a request that needs one the provider lacks is rejected loud (`SubagentError('UNSUPPORTED_CAPABILITY')`), never accepted-then-ignored. **Runtime** features (steering, resume) are instead optional methods on [`SubagentRun`](#a-live-run-subagentrun) — the method's presence IS the capability, and TS narrowing is the discovery mechanism.

```ts type-equiv
interface SubagentCapabilities {
  outputSchema: boolean
  depthLimit: boolean
  toolFilter: boolean
}
```

## The start request

What a caller asks for when starting a subagent. The tool layer builds this from the model's `{ description, prompt }` plus its own config; the service validates the start-time capabilities against the named provider, then passes it to `provider.start`. `parent` is REQUIRED — in-process backends read `parent.session.header` for the working directory, the `parentSession` lineage, and the delegation depth. The three optional fields (`outputSchema`, `maxDepth`, `toolFilter`) each gate on the matching `SubagentCapabilities` flag.

```ts type-equiv
interface SubagentStartRequest {
  prompt: ContentBlock[]
  parent: Agent
  signal?: AbortSignal
  agentOptions?: AgentOptions
  outputSchema?: SchemaSpec
  maxDepth?: number
  toolFilter?: { allow?: string[]; deny?: string[] }
}
```

## The terminal result: `SubagentResult`

The outcome of a run, resolved by `SubagentRun.result`. `structured` is present iff the request carried an `outputSchema` AND the provider honored it. A non-`completed` `stopReason` means `output` may be partial — the consumer maps it to an `isError` tool result rather than reporting partial output as success.

```ts type-equiv
interface SubagentResult {
  output: ContentBlock[]
  structured?: unknown
  stopReason: SubagentStopReason
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

The handle the consumer holds while a child executes. The consumer awaits `result`, may `cancel` mid-flight, and MUST `dispose` on every path to reach child quiescence (no leaked idle child / session). `result` does NOT reject on a child-level failure — a model/transport failure resolves with `stopReason: 'error'` — so the consumer maps a non-`completed` reason to an `isError` result; it rejects only on an infrastructure fault the seam cannot represent. `sendMessage` and `resume` are OPTIONAL: a provider that supports the runtime capability defines the method; one that doesn't omits it.

```ts type-equiv
interface SubagentRun {
  readonly id: AgentId
  readonly result: Promise<SubagentResult>
  cancel(reason?: string): void
  dispose(): Promise<void>
  sendMessage?(content: ContentBlock[]): void
  resume?(content: ContentBlock[]): SubagentRun
}
```

## The provider seam: `SubagentProvider`

One transport for running a child agent. Implementations register under a unique name via `SubagentService.registerProvider`; multiple coexist in one context. The service validates every requested start-time capability before calling `start`, so an implementation may assume e.g. `request.maxDepth` is honorable when present.

```ts type-equiv
interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  start(request: SubagentStartRequest): SubagentRun
}
```

The service (`ctx.subagents`) emits `subagent/start` when a run begins and `subagent/end` when it settles (see the [events catalog](../cordis-catalog/events-and-services.md)). Both emits contain a thrown listener **per listener** (logged, never propagated): one bad subscriber can neither strand a live run, surface as an unhandled rejection on the detached settle hook, nor starve the listeners registered after it.

## In-process backends: depth and seed

The two in-process backends ([dsh-subagent-spawn](../../packages/subagent/subagent-spawn) fresh, [dsh-subagent-fork](../../packages/subagent/subagent-fork) seeded) run the child as a child `Agent` on the same context via `ctx.agents.create`. Two pieces of vocabulary ride on the existing agent/session types rather than new core types:

- **Delegation depth** is a merge-extensible `AgentOptions.subagentDepth` field (`0` for a top-level agent, parent + 1 for a child). The seam owns it — the loop neither sets nor reads it — so a nested spawn reads its parent's depth from `parent.options.subagentDepth` and the `depthLimit` capability caps the tree by refusing a child whose depth would exceed `request.maxDepth`.
- **Fork seeding** uses `CreateAgentOptions.seed` (a `SessionEvent[]` prefix threaded through `AgentLoop.createAgent` → `ctx.sessions.prepare({ seed })`, the same primitive `resume` uses). The fork backend passes a *balanced completed-turn prefix* of the parent's log — the parent's events up to and including its last `turn/end` — so the seed is contiguous-from-0 and the [invariants](../../packages/support/invariants) replay accepts it (the in-flight, unbalanced turn is excluded).
