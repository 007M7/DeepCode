# @deepseek-ai/dsh-subagent-fork

The in-process **fork** subagent backend: a [`SubagentProvider`](../subagent/README.md) that runs each child as a child [`Agent`](../../core/agent) **seeded with a prefix of the parent's session log** — so the child inherits the parent's conversation context instead of starting fresh. Shares the run driver (`startInProcessRun`) with [`dsh-subagent-spawn`](../subagent-spawn/README.md); the only difference is the seed.

## The seed boundary (the crux)

At the moment a subagent tool's `execute` runs, the parent's CURRENT turn is open and unbalanced: the log holds the `assistant/message` carrying this spawn's tool-call and the dangling `tool/call` with no `tool/result` yet. Seeding that raw prefix would give the child an open turn that the session constructor and the dev-mode [invariants](../../support/invariants) replay **reject**.

So the fork seeds only the **balanced completed-turn prefix** — the parent's log up to and including its last `turn/end`, excluding the in-flight turn entirely (`completedTurnPrefix`). Because the live log keeps `seq === index`, the slice is contiguous-from-0 and a valid seed. A parent on its very first (not-yet-complete) turn forks an *empty* seed — i.e. effectively a fresh child.

The seam this rides on: `CreateAgentOptions.seed` (added on `dsh-agent`, threaded through `AgentLoop.createAgent` → `ctx.sessions.prepare({ seed })`), the same primitive `resume` uses.

## Capabilities

`{ outputSchema: true, depthLimit: true, toolFilter: false }` — identical to spawn (the depth/model/structured-output behavior is the shared driver's).

## Config

| Key | Meaning |
|---|---|
| `providerName` | Registry name on `ctx.subagents` (default `fork`). |

See [`dsh-subagent-spawn`](../subagent-spawn/README.md) for the run lifecycle, model inheritance, and depth tracking — all shared.
