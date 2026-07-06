# @deepseek-ai/dsh-subagent-inprocess

The shared **in-process subagent run driver**. A pure library (no provider, no registration) that the in-process backends — [spawn](../subagent-spawn/README.md) (a fresh child) and [fork](../subagent-fork/README.md) (a child seeded with a prefix of the parent's log) — both build on. The backends are thin shells that differ ONLY in the session seed they pass; everything downstream lives here, so neither backend depends on the other.

## What it exports

### `startInProcessRun(ctx, request, options): SubagentRun`

Runs a child as a child [`Agent`](../../core/agent) on the same cordis context (`ctx.agents`):

1. computes child depth = `depthOf(parent) + 1`; if `request.maxDepth` is set and exceeded, throws `SubagentDepthError` (the `depthLimit` capability); a `request.outputSchema` is asserted against the supported subset (`assertSupportedOutputSchema` from [dsh-tools](../../core/tools/README.md)) before any child exists;
2. creates a child via `ctx.agents.create` with a fresh `AgentId`/`SessionId`, the parent's `cwd` + `parentSession` lineage, the optional `options.seed` (fork's completed-turn prefix; omitted for a fresh child), and `agentOptions` (the child inherits the **parent's model** by default — a child with no model can't run — overridable via `request.agentOptions.model`; the deployment persona needs no inheritance — it is a context-wide prompt section);
3. drives the one-shot: `child.send(prompt)` then `await child.whenIdle()` (ordering matters — `send` enqueues synchronously, so `whenIdle` observes the queued work and resolves on the child's `running → idle` transition, never before the turn starts); a structured child that finished a turn CLEANLY without calling `structured_output` is re-prompted (a nudge — a fresh turn) up to `options.structuredNudgeRetries` times;
4. reads the result, scoped to the child's OWN events (everything at or after `seedLength`, so a seeded child that produced no message of its own never returns the seeded parent's last message): the last `assistant/message` content (deep-cloned — the log is frozen) and the last `turn/end.reason` mapped to a `SubagentStopReason`. A structured run surfaces the captured value as `result.structured`; a structured child that finished cleanly WITHOUT ever capturing settles `error` (a clean finish without the demanded result is a failure, not a success with a missing field).

`dispose()` delegates to `AgentHandle.dispose()` (stop loop → await quiescence → remove session); `cancel()` cancels the child's in-flight turn. A cancel landing before any `turn/end` (the pre-turn window) still settles `aborted`, honoring the cancel contract rather than the generic no-turn `error`.

### `InProcessRunOptions`

`{ providerName: string; seed?: SessionEvent[]; structuredNudgeRetries: number }` — the per-backend inputs: the provider name (for error context), the optional child-session seed, and the structured-run nudge budget (REQUIRED, resolved from the backend's validated Config — the driver never fills it with a hidden default).

### Structured output: `acquireStructuredRuntime(ctx): StructuredAcquisition`

The mechanism behind `outputSchema` for in-process children. One globally registered `structured_output` capture tool (its registered parameters are a placeholder) plus two listeners, registered once per root context and shared by every holder:

- an `agent/request` waterfall listener registered `prepend: true` that post-processes `await next()` — **final-request enforcement**: the request that hits the wire never carries `structured_output` for an agent without a structured run, and for one that has it always carries the run's OWN schema (as the tool's `parameters`) plus the calling instruction appended to its `system` text (the demand travels with the tool — `AgentOptions` has no per-agent prompt field to carry it). Per-agent shaping lives here because the tool registry and prompt assembly are context-global while schemas differ per concurrent child; cooperative mutate-then-`next()` would not survive a downstream listener returning a replacement request.
- an `agent/turn-continuation` listener (also `prepend: true` — an earlier-registered force-continue listener returning without `next()` must not decide the turn before the veto runs) that stops a child's turn once its output is captured, so a successful capture doesn't buy a wasted extra model step.

The capture tool validates each call against the run's schema (`validateStructuredValue`) — violations become an `INVALID_ARGS` isError result the model retries in-turn; a valid call records the value.

Lifetime is refcounted with two kinds of holder: each backend acquires for its plugin lifetime (`apply`), and each structured RUN holds its own acquisition from start to settle — so unregistration can never precede a live run's settle, and the runtime disposes only when the last backend AND the last run are gone. `release()` is idempotent per acquisition.

### `depthOf(agent): number`

Delegation depth rides on a merge-extensible `AgentOptions.subagentDepth` field (0 for a top-level agent, parent + 1 for a child), so a nested spawn reads its parent's depth from `parent.options.subagentDepth`. `depthOf` reads it (absent ⇒ 0).

### `SubagentDepthError`

Thrown by `startInProcessRun` when a spawn would exceed the request's `maxDepth` cap; carries `attemptedDepth` and `maxDepth`.
