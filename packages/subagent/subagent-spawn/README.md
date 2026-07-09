# @deepseek-ai/dsh-subagent-spawn

The in-process **spawn** subagent backend: a [`SubagentProvider`](../subagent/README.md) that runs each child as a **fresh** child [`Agent`](../../core/agent) on the same cordis context (`ctx.agents`) — its own session, its own (or the parent's) model, zero inherited conversation. The cheapest transport, reusing the agent factory's quiescent [`AgentHandle`](../../core/agent) teardown.

The run mechanics live in the shared [`@deepseek-ai/dsh-subagent-inprocess`](../subagent-inprocess/README.md) driver (`startInProcessRun`); this backend just passes **no seed** (a fresh child). The [fork](../subagent-fork/README.md) backend is an independent peer over the same driver — neither knows about the other.

## What it does

`start(request)` delegates to `startInProcessRun(ctx, request, {})` with no seed: a fresh child agent with the parent's `cwd`/`parentSession` lineage and (by default) the parent's model. The driver creates one run-owner fiber under `parent.ctx`; parent teardown, this provider's teardown, and manual disposal all converge there before child publication. Its `run.started` boundary resolves only after the fresh child is published, so `subagent/start` observers see a live registry entry. See the [driver README](../subagent-inprocess/README.md) for the full lifecycle (depth check, one-shot drive, result read, dispose).

## Capabilities

`{ outputSchema: true, depthLimit: true, toolFilter: true, persona: true }`. It constructs the child, so it enforces a recursion cap and composes the child's persona, global-tool restriction, and [structured runtime](../subagent-inprocess/README.md) inside the agent-creation setup window. At apply it registers this one named provider on `ctx.subagents`; per-run contributions belong to each child's scope.

## Config

| Key | Meaning |
|---|---|
| `providerName` | Registry name on `ctx.subagents` (default `spawn`). |

## Known Limitations and Deferred Work

- **Tool-scoping (`toolFilter`) is not supported** — the capability is declared `false`, so the service rejects a request needing it before `start` runs; scoping a child's tool set is deferred.
- **Runs expose no `sendMessage`/`resume`** — the optional runtime capabilities are absent on in-process runs; the consumer collects synchronously.
