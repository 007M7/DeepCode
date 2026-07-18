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

The tool layer builds this request from the model input and its own config; the service validates it against the named provider before `start`. Required `parent` supplies the session cwd, lineage, and delegation depth. Optional output schema, depth, tool filter, and persona require matching capability flags. Unsupported schemas fail at start; in-process backends scope filters and personas to child creation and implement the supported object-rooted schema with a forced capture tool.

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

`SubagentRun` is the consumer-owned handle for a ready child. Consumers await `result` and always dispose the run to reach quiescence. Child failures resolve with a non-completed stop reason; only unrepresentable infrastructure faults reject. Optional `sendMessage` and `resume` methods advertise their runtime capabilities by presence.

```ts type-equiv
interface SubagentRun {
  readonly id: SessionId
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
  sendMessage?(content: ContentBlock[]): void
  resume?(content: ContentBlock[]): Promise<SubagentRun>
}
```

## The provider seam: `SubagentProvider`

Each provider is a named child-agent transport, and multiple providers may coexist. The service validates requested start-time capabilities before `start()`. `inheritsParentContext` describes only conversation seeding (`fork`: true; `spawn` and `acp`: false), allowing consumers to generate accurate model-facing wording without implying inherited tools, services, or authority.

```ts type-equiv
interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  start(request: SubagentStartRequest): Promise<SubagentRun>
}
```

`start()` fulfills only with a ready run. The service observes its result, emits `subagent/start`, and returns the same run; rejection implies provider cleanup and emits no lifecycle pair. In-process children are discoverable through `ctx.agents`, while remote children need not be. `subagent/end` reports final output or infrastructure failure. Both events are observe-only and contain listener exceptions.

## In-process backends: depth and seed

The spawn and fork backends create an ordinary agent through `parent.ctx`, pass cancellation into core creation, and dispose through `AgentHandle`. Provider removal blocks new starts without revoking accepted runs. Each child gets a new flat scope rather than inheriting parent registrations. Depth and fork seeding reuse existing agent and session vocabulary:

- **Delegation depth** is a merge-extensible `AgentOptions.subagentDepth` field (`0` for a top-level agent, parent + 1 for a child). Only `undefined` means top level; every stored present value must be a non-negative safe integer. The seam owns it — the loop neither sets nor reads it — so a nested spawn validates its parent's stored depth, rejects a derived child depth outside the safe-integer domain, and applies a defined absolute `request.maxDepth` cap to that child.
- **Fork seeding** uses `CreateAgentOptions.seed` (a `SessionEvent[]` prefix threaded through `AgentLoop.createAgent` → `ctx.sessions.prepare({ seed })`, the same primitive `resume` uses). The fork backend passes a *balanced completed-turn prefix* of the parent's log — the parent's events up to and including its last `turn/end` — so the seed is contiguous-from-0 and the [invariants](../../packages/support/invariants) replay accepts it (the in-flight, unbalanced turn is excluded).
