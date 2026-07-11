# @deepseek-ai/dsh-subagent-fork

In-process provider that starts a child [`Agent`](../../core/agent) from the parent's completed conversation prefix. It shares [`startInProcessRun`](../subagent-inprocess/README.md) with the [spawn provider](../subagent-spawn/README.md); the seed is the only backend difference.

## Seed boundary

The delegating tool runs inside an open parent turn whose tool call has no result yet. Forking that tail would create an invalid, unbalanced child log, so the provider copies only the prefix through the last `turn/end`. A first-turn fork therefore starts with an empty seed. `CreateAgentOptions.seed` carries the contiguous prefix into session preparation.

## Capabilities

`{ outputSchema: true, depthLimit: true, toolFilter: true, persona: true }`

## Config

| Key | Meaning |
|---|---|
| `providerName` | Registry name on `ctx.subagents` (default `fork`). |
