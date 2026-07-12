# @deepseek-ai/dsh-subagent-spawn

The spawn provider creates a fresh child `Agent` in the current process. The child has its own session, sees no parent conversation history, and reuses the host's agent factory and LLM/tool services.

## Behavior

`start(request)` delegates to [`startInProcessRun`](../subagent-inprocess/README.md) with no seed and awaits publication before returning. The child receives parent working-directory/session lineage and inherits the parent model unless overridden, but starts with an empty conversation.

The shared driver owns depth checking, persona and tool-filter setup, structured output, required-signal cancellation, one-shot execution, result reading, and quiescent disposal. A startup rejection leaves no published child; provider unload after fulfillment does not revoke the holder-owned run.

## Capabilities

Spawn advertises `{ outputSchema: true, depthLimit: true, toolFilter: true, persona: true }` because it controls the child's creation window and can enforce all four features.

## Config

| Key | Meaning |
|---|---|
| `providerName` | Registry name on `ctx.subagents` (default `spawn`). |
