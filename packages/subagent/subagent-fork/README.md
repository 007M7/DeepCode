# @deepseek-ai/dsh-subagent-fork

The fork provider creates an in-process child seeded with the parent's completed conversation turns. It shares all run mechanics with spawn; the session seed is the only behavioral difference.

## Seed boundary

The parent's current tool-calling turn is still open when a subagent starts: its log contains the assistant tool call but not the matching tool result or `turn/end`. Copying that raw log would give the child an invalid, unbalanced session.

Fork therefore uses `completedTurnPrefix(parent.session.events)`: the contiguous prefix ending at the last `turn/end`. The child sees all completed parent turns and none of the in-flight turn. If the parent has not completed a turn yet, the seed is empty and the child behaves like a fresh spawn.

The seed transfers conversation history only. The child still receives a fresh flat registration scope; it does not inherit the parent's tool restrictions or authority.

## Start and capabilities

`start(request)` passes the completed-turn seed to [`startInProcessRun`](../subagent-inprocess/README.md) and awaits child publication. The shared driver owns cancellation, depth, customization, result reading, and disposal.

Fork advertises `{ outputSchema: true, depthLimit: true, toolFilter: true, persona: true }`, identical to spawn.

## Config

| Key | Meaning |
|---|---|
| `providerName` | Registry name on `ctx.subagents` (default `fork`). |
