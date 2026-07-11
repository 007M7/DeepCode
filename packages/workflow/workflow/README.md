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
- `workflow/agent-start`(info, agent) / `workflow/agent-end`(info, agent + outcome) — ready-child lifecycle correlated by `seq`; the [generated event contract](../../../docs/cordis-catalog/events.md#workflowagent-start--emit) defines publication and pairing.

## Model Experience

| Context surface | What the model sees | Token effect |
|---|---|---|
| None directly | The service seam and `workflow/*` observer events register no prompt, schema, or message. `dsh-tool-workflow` renders the parent-facing contract and final value; an engine decides which child prompts run. | Zero direct tokens. Parent result and child contexts affect tokens only through the consumer and implementation. |

## Known Limitations and Deferred Work

- **Foreground collection only** — the caller owns one live run and awaits it; background start/poll, spill handles, and detached collection are deferred.
- **No journaling or resume** — scripts, child progress, and intermediate values are not checkpointed, so a process restart cannot continue a run.
- **No saved or nested workflows** — the seam starts caller-supplied scripts only, and a workflow script receives no `workflow()` hook for recursive orchestration.
- **No token-budget vocabulary** — engines cap concurrency/items/agents, but neither the request nor result accounts for model tokens across children.
- **Runs are holder-owned, not service-tracked** — unloading the engine does not discover independent live handles; every consumer must dispose the run it started.

See the [dynamic-workflows RFC](../../../docs/rfc/implemented/feature/2026-07-05-dynamic-workflows.md) for the deferred workflow surface.
