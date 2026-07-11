# @deepseek-ai/dsh-subagent-inprocess

The shared **in-process subagent run driver**. A library with no provider or import-time registration that the in-process backends — [spawn](../subagent-spawn/README.md) (a fresh child) and [fork](../subagent-fork/README.md) (a child seeded with a prefix of the parent's log) — both build on. Each accepted run installs one provider-owned cleanup effect. The backends are thin shells that differ ONLY in the session seed they pass; everything downstream lives here, so neither backend depends on the other.

## What it exports

### `startInProcessRun(ctx, request, options): SubagentRun`

Runs a child as a child [`Agent`](../../core/agent) on the same cordis context (`ctx.agents`):

1. snapshots the accepted request before asynchronous owner setup: the parent and signal remain identity capabilities but are never reread from the caller-owned record; tool filter, seed, agent options, output schema, and prompt are detached. It computes child depth = `depthOf(parent) + 1` and rejects `request.maxDepth` overflow with `SubagentDepthError`; `outputSchema` is asserted before cloning so a hostile value fails as `OutputSchemaError`, while the prompt passes the session log's lossless-JSON check before and after cloning;
2. first installs provider ownership, then attaches the request abort listener and creates one run-owner Cordis fiber under `parent.ctx`; an already-unloading provider therefore leaves no child or orphaned listener. Async child creation goes through that fiber's `ctx.agents` service with fresh IDs, lineage/seed, inherited model, and an unpublished setup transaction for persona, tool restriction, and structured output. Parent teardown, provider teardown, and manual `run.dispose()` all dispose this exact node, preventing publication after it becomes inactive and awaiting the same quiescence boundary. `startInProcessRun` still returns its `SubagentRun` immediately: `run.started` resolves only after `ctx.agents.create()` has published the child (and rejects if publication never happens), while cancellation during creation is recorded and applied when a child exists;
3. drives the one-shot: `child.send(prompt)` then `await child.whenIdle()` (ordering matters — `send` enqueues synchronously, so `whenIdle` observes the queued work and resolves on the child's `running → idle` transition, never before the turn starts); there is deliberately NO re-prompt for a structured child that finished cleanly without calling `structured_output` — the shortfall maps to an `error` result for the parent;
4. reads the result, scoped to the child's OWN events (everything at or after `seedLength`, so a seeded child that produced no message of its own never returns the seeded parent's last message): the last `assistant/message` content (deep-cloned — the log is frozen) and the last `turn/end.reason` mapped to a `SubagentStopReason`. A structured run surfaces the captured value as `result.structured`; a structured child that finished cleanly WITHOUT ever capturing settles `error` (a clean finish without the demanded result is a failure, not a success with a missing field).

`SubagentService` waits for `run.started` before emitting `subagent/start`, so a synchronous start observer can resolve the published child with `ctx.agents.get(run.id)`; the result driver awaits the same boundary before sending the prompt. An attempt that never publishes rejects readiness and emits no false start/end pair; its result reports a deliberate cancel/dispose as `aborted` and propagates an infrastructure fault. `dispose()` awaits creation or rollback and then delegates to `AgentHandle.dispose()` (stop and drain → remove agent → detach session → unwind scope); `cancel()` records its request even before publication and cancels the child immediately once available. A cancel landing before any `turn/end` still settles `aborted`, honoring the cancel contract rather than the generic no-turn `error`.

### `InProcessRunOptions`

`{ seed?: SessionEvent[] }` — the optional child-session seed: absent for spawn, or the parent's balanced completed-turn prefix for fork.

### Structured output (package-internal runtime)

`attachStructuredRuntime(childCtx, schema)` registers the run's whole enforcement surface as SCOPED registrations on the child's `agent.ctx` — riding the child's fiber (a backend hot-reload mid-run cannot unregister anything; a disposed child leaves no residue) and visible to that child alone (two concurrent structured runs never interact; no placeholder schema, no strip-for-everyone-else, no refcounted global state):

- the `structured_output` capture tool with the run's REAL schema as its registered `parameters`, validating each call (`validateStructuredValue`) — violations become an `INVALID_ARGS` isError the model retries in-turn; a valid call STAGES the value in a `WeakMap` keyed by that call's `ToolExecution` object;
- the calling instruction as an ordinary order-190 scoped prompt section (the demand travels with the tool, as prompt state of exactly one agent);
- a scoped `systemPrompt.protect()` registration making the capture instruction and schema canonical after the complete assembly waterfall. Canonical absence is protected too: pure Code Mode removes `structured_output` from the wire and declares it through the SDK. The tool registry separately owns and protects its `tools:sdk` section and reserved `run_code` transport; protection guarantees those named contributions, while unrelated listener-added schemas remain the listener's responsibility. The loop logs the finalized assembly as the step's `request/header`, so the demand remains reconstructable;
- a scoped `tools/result` observer as the commit point: it promotes a staged value only when that same execution's immutable, JSON-safe authoritative result after the complete pre-execute → guards → execute → post-execute pipeline succeeds. For a Code Mode SDK sub-dispatch, the child's opaque `parent` token matches the enclosing `run_code` execution's registry-assigned `token`, so promotion waits for that outer final result without exposing its live object; a runtime failure or post-policy block discards the value. Execution-object identity prevents call-id reuse or another execution from reaching the stage;
- a scoped monotonic `tools.guard()` denial for every call arriving after capture. Guards run after the extensible pre-execute waterfall and cannot return allow, so terminal means terminal within the step regardless of listener order;
- a scoped `agent/turn-stop` terminal policy stopping the child's turn once its output is captured. It runs after ordinary continuation and steering folding, and its terminal state survives turn close and flush, so later listeners cannot leak steering into another step or turn; ordinary queued prompts remain intact.

### `depthOf(agent): number`

Delegation depth rides on a merge-extensible `AgentOptions.subagentDepth` field (0 for a top-level agent, parent + 1 for a child), so a nested spawn reads its parent's depth from `parent.options.subagentDepth`. `depthOf` reads it (absent ⇒ 0).

### `SubagentDepthError`

Thrown by `startInProcessRun` when a spawn would exceed the request's `maxDepth` cap; carries `attemptedDepth` and `maxDepth`.

## Known Limitations and Deferred Work

- **Runs expose no `sendMessage`/`resume`** — the optional runtime capabilities are absent on in-process runs; the consumer collects synchronously.
- **Structured capture accepts the `defineTool` schema subset only** — unsupported JSON Schema constructs fail before the child is created; a provider needing a broader schema vocabulary requires a different runtime.
