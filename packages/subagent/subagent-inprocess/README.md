# @deepseek-ai/dsh-subagent-inprocess

The shared **in-process subagent run driver**. A pure library (no provider, no registration) that the in-process backends — [spawn](../subagent-spawn/README.md) (a fresh child) and [fork](../subagent-fork/README.md) (a child seeded with a prefix of the parent's log) — both build on. The backends are thin shells that differ ONLY in the session seed they pass; everything downstream lives here, so neither backend depends on the other.

## What it exports

### `startInProcessRun(ctx, request, options): SubagentRun`

Runs a child as a child [`Agent`](../../core/agent) on the same cordis context (`ctx.agents`):

1. computes child depth = `depthOf(parent) + 1`; if `request.maxDepth` is set and exceeded, throws `SubagentDepthError` (the `depthLimit` capability); a `request.outputSchema` is asserted against the supported subset (`assertSupportedOutputSchema` from [dsh-tools](../../core/tools/README.md)) and then snapshotted with `structuredClone` before any child exists — assertion first so a hostile value fails as `OutputSchemaError` (never a raw clone error), the snapshot so a post-`start()` caller mutation cannot drift the enforced schema;
2. creates a child via `ctx.agents.create` with a fresh `AgentId`/`SessionId`, the parent's `cwd` + `parentSession` lineage, the optional `options.seed` (fork's completed-turn prefix; omitted for a fresh child), and `agentOptions` (the child inherits the **parent's model** by default — a child with no model can't run — overridable via `request.agentOptions.model`; the deployment persona needs no inheritance — it is a context-wide prompt section);
3. drives the one-shot: `child.send(prompt)` then `await child.whenIdle()` (ordering matters — `send` enqueues synchronously, so `whenIdle` observes the queued work and resolves on the child's `running → idle` transition, never before the turn starts); there is deliberately NO re-prompt for a structured child that finished cleanly without calling `structured_output` — the shortfall maps to an `error` result for the parent;
4. reads the result, scoped to the child's OWN events (everything at or after `seedLength`, so a seeded child that produced no message of its own never returns the seeded parent's last message): the last `assistant/message` content (deep-cloned — the log is frozen) and the last `turn/end.reason` mapped to a `SubagentStopReason`. A structured run surfaces the captured value as `result.structured`; a structured child that finished cleanly WITHOUT ever capturing settles `error` (a clean finish without the demanded result is a failure, not a success with a missing field).

`dispose()` delegates to `AgentHandle.dispose()` (stop loop → await quiescence → remove session); `cancel()` cancels the child's in-flight turn. A cancel landing before any `turn/end` (the pre-turn window) still settles `aborted`, honoring the cancel contract rather than the generic no-turn `error`.

### `InProcessRunOptions`

`{ providerName: string; seed?: SessionEvent[] }` — the per-backend inputs: the provider name (for error context) and the optional child-session seed.

### Structured output (package-internal runtime)

`attachStructuredRuntime(childCtx, schema)` registers the run's whole enforcement surface as SCOPED registrations on the child's `agent.ctx` — riding the child's fiber (a backend hot-reload mid-run cannot unregister anything; a disposed child leaves no residue) and visible to that child alone (two concurrent structured runs never interact; no placeholder schema, no strip-for-everyone-else, no refcounted global state):

- the `structured_output` capture tool with the run's REAL schema as its registered `parameters`, validating each call (`validateStructuredValue`) — violations become an `INVALID_ARGS` isError the model retries in-turn; a valid call STAGES the value in a `WeakMap` keyed by that call's `ToolExecution` object;
- the calling instruction as an ordinary order-190 scoped prompt section (the demand travels with the tool, as prompt state of exactly one agent);
- a scoped `system-prompt/assemble` re-assert (`prepend: true`) that post-processes its downstream chain, replacing conflicting entries with the child's capture tool and instruction — the loop logs the rendered assembly as the step's `request/header`, so the demand is reconstructable log state;
- a scoped `tools/post-execute` COMMIT (`prepend: true`): the staged value becomes the run's result when that same execution's downstream post-execute decision accepts it. Execution-object identity prevents an orphaned stage from matching a later call even when an adapter reuses the call id;
- a scoped `tools/pre-execute` deny for any call arriving after the capture — terminal means terminal WITHIN the step;
- a scoped `agent/turn-continuation` veto (`prepend: true`) stopping the child's turn once its output is captured, so a successful capture doesn't buy a wasted extra model step.

### `depthOf(agent): number`

Delegation depth rides on a merge-extensible `AgentOptions.subagentDepth` field (0 for a top-level agent, parent + 1 for a child), so a nested spawn reads its parent's depth from `parent.options.subagentDepth`. `depthOf` reads it (absent ⇒ 0).

### `SubagentDepthError`

Thrown by `startInProcessRun` when a spawn would exceed the request's `maxDepth` cap; carries `attemptedDepth` and `maxDepth`.
