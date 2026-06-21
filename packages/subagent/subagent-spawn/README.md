# @deepseek-ai/dsh-subagent-spawn

The in-process **spawn** subagent backend: a [`SubagentProvider`](../subagent/README.md) that runs each child as a **fresh** child [`Agent`](../../core/agent) on the same cordis context (`ctx.agents`) — its own session, its own (or the parent's) model, zero inherited conversation. The cheapest transport, reusing the agent factory's quiescent [`AgentHandle`](../../core/agent) teardown.

It also exports the **shared in-process run driver** (`startInProcessRun`) that the [fork](../subagent-fork/README.md) backend builds on — spawn and fork differ only in the session seed.

## What it does

`start(request)` →
1. computes child depth = `depthOf(parent) + 1`; if `request.maxDepth` is set and exceeded, throws `SubagentDepthError` (the `depthLimit` capability);
2. creates a child via `ctx.agents.create` with a fresh `AgentId`/`SessionId`, the parent's `cwd` + `parentSession` lineage, and `agentOptions` (the child inherits the **parent's model** by default — a child with no model can't run — overridable via `request.agentOptions.model`; the system prompt is NOT inherited);
3. drives the one-shot: `child.send(prompt)` then `await child.whenIdle()` (ordering matters — `send` enqueues synchronously, so `whenIdle` observes the queued work and resolves on the child's `running → idle` transition, never before the turn starts);
4. reads the result: the last `assistant/message` content (deep-cloned — the log is frozen) and the last `turn/end.reason` mapped to a `SubagentStopReason`.

`dispose()` delegates to `AgentHandle.dispose()` (stop loop → await quiescence → remove session); `cancel()` cancels the child's in-flight turn.

## Capabilities

`{ outputSchema: false, depthLimit: true, toolFilter: false }`. It constructs the child, so it enforces a recursion cap; structured output and tool-scoping are deferred (the service rejects a request needing either before `start` runs).

## Config

| Key | Meaning |
|---|---|
| `providerName` | Registry name on `ctx.subagents` (default `spawn`). |

## Depth tracking

Delegation depth rides on a merge-extensible `AgentOptions.subagentDepth` field (0 for a top-level agent, parent + 1 for a child), so a nested spawn reads its parent's depth from `parent.options.subagentDepth`. Read it with the exported `depthOf(agent)`.
