# @deepseek-ai/dsh-workflow

The **workflow seam** (`ctx.workflows`): an abstract service defining WHAT a workflow engine does — execute a model-written orchestration script that fans out subagents — without saying HOW. The bash-shaped third of the [workflow family](../README.md): implementations subclass `WorkflowService` and register as the `workflows` service (one per context); [`dsh-workflow-workerthread`](../workflow-workerthread/README.md) (one worker thread per run) is the implementation, and [`dsh-tool-workflow`](../tool-workflow/README.md) is the model-facing consumer.

## Service: `WorkflowService` (abstract)

`start(request: WorkflowStartRequest): WorkflowRun` — parse and execute a script. Throws synchronously (`SCRIPT_PARSE`/`META_INVALID`) for a script that cannot begin; once a run is returned, its `result` NEVER rejects — every failure resolves with `stopReason: 'error'` (or `'cancelled'`) — and once the run is cancelled, `result` settles within the implementation's bounded grace even if the script itself never settles (a consumer awaiting `result` must never be wedged past a cancellation). `dispose()` must reach quiescence within a bounded grace (cancel → wait for the script to settle and its children to finish disposing → abandon), never hanging its caller. Runs are HOLDER-owned: the engine does not track its live runs, so disposing the engine's fiber mid-run leaves each run to its holder's teardown.

The protected `emitWorkflowEvent` helper dispatches the `workflow/*` events with PER-LISTENER containment and PER-LISTENER payload snapshots (a throwing subscriber is logged, never propagated, and cannot starve later listeners; each subscriber gets its own clone of the payload, so mutating it corrupts neither the engine nor other listeners) — the same containment guarantee as the subagent seam's lifecycle emits.

## Vocabulary

- `WorkflowStartRequest` — `{ script, args?, parent: Agent, signal? }`. `parent` is REQUIRED: every child the script spawns is attributed to it. `args` must be plain host-realm JSON data.
- `WorkflowMeta` / `WorkflowPhase` — the workflow's identity block, carried as plain JSON data on the start request (Claude Code meta vocabulary: required `name`/`description`, optional `whenToUse`/`phases`) and shape-validated by the engine.
- `WorkflowRun` — `{ id, meta, result, cancel(reason?), dispose() }`; the consumer awaits `result` and MUST `dispose` on every path.
- `WorkflowResult` — `{ value, stopReason: 'completed'|'cancelled'|'error', error?, agentsStarted }`; `value` is the script's materialized return (plain JSON data; `null` for no return).
- `WorkflowError` — `HarnessError` with a `WorkflowErrorCode` and a `fatal` flag driving the combinator discipline: a fatal error (bad hook arguments, unsupported options/schemas, tripped caps, seam start failures, cancellation) always propagates through `parallel()`/`pipeline()` instead of dissolving into a per-item `null`. `isFatalWorkflowError(error)` is the catch-site predicate.

## Events

All observe-only emits carrying DATA SNAPSHOTS (`WorkflowRunInfo` = id + meta) — never the live `WorkflowRun`, so a listener cannot gain `cancel`/`dispose`; control stays with the `start()` caller:

- `workflow/start`(info) / `workflow/end`(info, resultInfo) — run lifecycle; `resultInfo` deliberately omits the value.
- `workflow/phase`(info, title) / `workflow/log`(info, message) — script narration.
- `workflow/agent-start`(info, agent) / `workflow/agent-end`(info, agent + outcome) — one pair per `agent()` call that STARTED a child run (a call rejected at validation or caps, refused at start, or cancelled while queued for a slot emits no pair), correlated by `seq`.

## Non-goals (this cut)

Background collection, journaling/resume, saved workflows, nested `workflow()`, token budgets — see the [RFC's deferred section](../../../docs/rfc/implemented/feature/2026-07-05-dynamic-workflows.md).
