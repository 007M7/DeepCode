# Workflow

The workflow seam — an agent running a model-written orchestration SCRIPT that fans out subagents. Like [subagent](subagent.md) it is **one optional capability**, not part of the agent-loop spine, so its vocabulary lives here rather than in [core.md](core.md). Unlike the subagent registry it takes the bash shape: ONE engine implementation per context provides `ctx.workflows`; there is no named-provider registry (a second engine is a plugin swap, not a co-resident).

Interface: [dsh-workflow](../../packages/workflow/workflow) (`ctx.workflows` + the vocabulary below). The implementation is [dsh-workflow-workerthread](../../packages/workflow/workflow-workerthread) (a `node:worker_threads` engine — one worker per run, the script's vm context inside it); the model-facing consumer is [dsh-tool-workflow](../../packages/workflow/tool-workflow). The proposal and rationale: [the dynamic-workflows RFC](../rfc/implemented/feature/2026-07-05-dynamic-workflows.md).

Source: [`packages/workflow/workflow/src/types.ts`](../../packages/workflow/workflow/src/types.ts)

## The start request

What a caller asks for when starting a run. The tool layer builds this from the model's `{ script, meta, args }` call plus the calling agent; `meta` and `args` are plain JSON DATA (the engine shape-validates `meta` and rejects loud BEFORE anything runs — no script text is ever evaluated to obtain it). `parent` is REQUIRED — every child the script spawns is attributed to it (cwd, lineage, and depth flow through the [subagent seam](subagent.md)).

```ts type-equiv
interface WorkflowStartRequest {
  script: string
  meta: WorkflowMeta
  args?: unknown
  parent: Agent
  signal?: AbortSignal
}
```

## The workflow's identity: `WorkflowMeta`

The identity block carried as data on the start request (the tool's `meta` parameter; the field vocabulary matches the Claude Code dynamic-workflows meta block). `phases` is progress vocabulary only: `phase()` calls match titles for observers; no execution structure is implied.

```ts type-equiv
interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowPhase[]
}
```

## The terminal result: `WorkflowResult`

The outcome of one run, resolved by `WorkflowRun.result`. `value` is the script's materialized return value — plain host-realm JSON data (`null` when the script returned nothing) — meaningful only for `completed`. `stopReason` is a CLOSED union (engine-owned; consumers may exhaust it): `completed` | `cancelled` | `error`. A non-`completed` reason carries the failure in `error`, and the consumer maps it to an `isError` tool result rather than reporting partial output as success.

```ts type-equiv
interface WorkflowResult {
  value: unknown
  stopReason: WorkflowStopReason
  error?: string
  agentsStarted: number
}
```

## A live run: `WorkflowRun`

The handle the consumer holds while a script executes. The consumer awaits `result`, may `cancel` mid-flight, and MUST `dispose` on every path. `result` does NOT reject — a script failure resolves with `stopReason: 'error'` — and once the run is cancelled it SETTLES within the engine's bounded grace even if the script itself never settles (the engine force-settles `cancelled`; the worker-thread engine then terminates the script's worker), so a consumer awaiting `result` is never wedged past a cancellation. `dispose()` = cancel + that bounded settle + child quiescence; it never hangs on a stuck script.

```ts type-equiv
interface WorkflowRun {
  readonly id: WorkflowRunId
  readonly meta: WorkflowMeta
  readonly result: Promise<WorkflowResult>
  cancel(reason?: string): void
  dispose(): Promise<void>
}
```

## Failure discipline: `WorkflowError.fatal`

Hook misuse inside a script — bad arguments, unknown/deferred `agent()` options, a schema outside the [structured-output subset](../../packages/core/tools/README.md), a tripped cap, a seam start failure, cancellation — throws a `WorkflowError` with `fatal: true`. The `parallel()`/`pipeline()` combinators RE-THROW fatal errors instead of mapping the item to `null`: a typo'd option must kill the script loudly, never dissolve into something that reads as an ordinary child failure. The per-item `null` is reserved for child-run failures (a non-`completed` stop reason) and ordinary in-stage script errors.

## Events

The `workflow/*` events (`workflow/start`, `workflow/phase`, `workflow/log`, `workflow/agent-start`, `workflow/agent-end`, `workflow/end` — see the [events catalog](../cordis-catalog/events.md)) are **observe-only** emits carrying DATA SNAPSHOTS: every payload starts with `WorkflowRunInfo` (id + meta), never the live `WorkflowRun`, so a subscriber cannot gain `cancel`/`dispose`, and `workflow/end` deliberately omits the result value (a listener observing outcomes must not receive a mutable alias of the caller's result). Every emit is per-listener contained — a throwing subscriber is logged, never propagated, and cannot starve the listeners registered after it — and every listener receives its own payload clone, so mutating it corrupts neither the engine nor other listeners; the containment mirrors `subagent/start`/`subagent/end`.
