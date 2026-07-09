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

The mechanism behind `outputSchema` for in-process children — acquired per structured RUN inside `startInProcessRun` (nothing is registered on a context that never runs a structured child; only the model-facing constants `STRUCTURED_OUTPUT_TOOL`/`STRUCTURED_OUTPUT_INSTRUCTION` are exported). One globally registered `structured_output` capture tool (its registered parameters are a placeholder) plus four listeners:

- a `system-prompt/assemble` waterfall listener registered `prepend: true` that post-processes `await next()` — **final-assembly enforcement**: the assembly the loop renders never carries `structured_output` for an agent without a structured run, and for one that has it always carries the run's OWN schema (as the tool's `parameters`) plus the calling instruction as a trailing prompt section (the demand travels with the tool — `AgentOptions` has no per-agent prompt field to carry it). The loop logs the rendered assembly as the step's `request/header`, so the injection is reconstructable log state, never a wire-only mutation. Per-agent shaping lives here because the tool registry and prompt assembly are context-global while schemas differ per concurrent child (FIXME in the module doc: per-agent/per-session scoping would dissolve this); cooperative mutate-then-`next()` would not survive a downstream listener returning a replacement assembly.
- a `tools/post-execute` listener (`prepend: true` = outermost, so `await next()` yields the composed final decision) that COMMITS the capture: the tool body only stages the validated value, and it becomes the run's result only when the final decision accepts the call — a downstream block (a PostToolUse hook) turns the logged result into `isError`, and the run must not report `structured` success for a call the model and session log saw fail.
- a `tools/pre-execute` deny for any call arriving after the agent's capture — terminal means terminal WITHIN the step: a response listing `structured_output` before further tool calls cannot run side effects after the final answer was accepted.
- an `agent/turn-continuation` listener (also `prepend: true` — an earlier-registered force-continue listener returning without `next()` must not decide the turn before the veto runs) that stops a child's turn once its output is captured, so a successful capture doesn't buy a wasted extra model step.

The capture tool validates each call against the run's schema (`validateStructuredValue`) — violations become an `INVALID_ARGS` isError result the model retries in-turn; a valid call stages the value for the post-execute commit.

Lifetime is refcounted by live structured runs: each acquires at start and releases at settle, so the registrations exist exactly while at least one structured child is live, a backend hot-reload mid-run cannot unregister the capture tool under a live child, and the last settle disposes everything. `release()` is idempotent per acquisition.

### `depthOf(agent): number`

Delegation depth rides on a merge-extensible `AgentOptions.subagentDepth` field (0 for a top-level agent, parent + 1 for a child), so a nested spawn reads its parent's depth from `parent.options.subagentDepth`. `depthOf` reads it (absent ⇒ 0).

### `SubagentDepthError`

Thrown by `startInProcessRun` when a spawn would exceed the request's `maxDepth` cap; carries `attemptedDepth` and `maxDepth`.
