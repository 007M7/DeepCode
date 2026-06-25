# @deepseek-ai/dsh-subagent-inprocess

The shared **in-process subagent run driver**. A pure library (no provider, no registration) that the in-process backends — [spawn](../subagent-spawn/README.md) (a fresh child) and [fork](../subagent-fork/README.md) (a child seeded with a prefix of the parent's log) — both build on. The backends are thin shells that differ ONLY in the session seed they pass; everything downstream lives here, so neither backend depends on the other.

## What it exports

### `startInProcessRun(ctx, request, options): SubagentRun`

Runs a child as a child [`Agent`](../../core/agent) on the same cordis context (`ctx.agents`):

1. computes child depth = `depthOf(parent) + 1`; if `request.maxDepth` is set and exceeded, throws `SubagentDepthError` (the `depthLimit` capability);
2. creates a child via `ctx.agents.create` with a fresh `AgentId`/`SessionId`, the parent's `cwd` + `parentSession` lineage, the optional `options.seed` (fork's completed-turn prefix; omitted for a fresh child), and `agentOptions` (the child inherits the **parent's model** by default — a child with no model can't run — overridable via `request.agentOptions.model`; the system prompt is NOT inherited);
3. drives the one-shot: `child.send(prompt)` then `await child.whenIdle()` (ordering matters — `send` enqueues synchronously, so `whenIdle` observes the queued work and resolves on the child's `running → idle` transition, never before the turn starts);
4. reads the result, scoped to the child's OWN events (everything at or after `seedLength`, so a seeded child that produced no message of its own never returns the seeded parent's last message): the last `assistant/message` content (deep-cloned — the log is frozen) and the last `turn/end.reason` mapped to a `SubagentStopReason`.

`dispose()` delegates to `AgentHandle.dispose()` (stop loop → await quiescence → remove session); `cancel()` cancels the child's in-flight turn. A cancel landing before any `turn/end` (the pre-turn window) still settles `aborted`, honoring the cancel contract rather than the generic no-turn `error`.

### `InProcessRunOptions`

`{ providerName: string; seed?: SessionEvent[] }` — the per-backend inputs: the provider name (for error context) and the optional child-session seed.

### `depthOf(agent): number`

Delegation depth rides on a merge-extensible `AgentOptions.subagentDepth` field (0 for a top-level agent, parent + 1 for a child), so a nested spawn reads its parent's depth from `parent.options.subagentDepth`. `depthOf` reads it (absent ⇒ 0).

### `SubagentDepthError`

Thrown by `startInProcessRun` when a spawn would exceed the request's `maxDepth` cap; carries `attemptedDepth` and `maxDepth`.
