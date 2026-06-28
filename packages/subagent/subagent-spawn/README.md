# @deepseek-ai/dsh-subagent-spawn

The in-process **spawn** subagent backend: a [`SubagentProvider`](../subagent/README.md) that runs each child as a **fresh** child [`Agent`](../../core/agent) on the same cordis context (`ctx.agents`) — its own session, its own (or the parent's) model, zero inherited conversation. The cheapest transport, reusing the agent factory's quiescent [`AgentHandle`](../../core/agent) teardown.

The run mechanics live in the shared [`@deepseek-ai/dsh-subagent-inprocess`](../subagent-inprocess/README.md) driver (`startInProcessRun`); this backend just passes **no seed** (a fresh child). The [fork](../subagent-fork/README.md) backend is an independent peer over the same driver — neither knows about the other.

## What it does

`start(request)` delegates to `startInProcessRun(ctx, request, { providerName })` with no seed: a fresh child agent with the parent's `cwd`/`parentSession` lineage and (by default) the parent's model. See the [driver README](../subagent-inprocess/README.md) for the full lifecycle (depth check, one-shot drive, result read, dispose).

## Capabilities

`{ outputSchema: false, depthLimit: true, toolFilter: false }`. It constructs the child, so it enforces a recursion cap; structured output and tool-scoping are deferred (the service rejects a request needing either before `start` runs).

## Config

| Key | Meaning |
|---|---|
| `providerName` | Registry name on `ctx.subagents` (default `spawn`). |
