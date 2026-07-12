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

## Model Experience

| Context surface | What the model sees | Token effect |
|---|---|---|
| Child-agent request | The fresh child receives the standalone task, inherits the parent model and workspace by default, and sees the globally composed prompt and tools after any configured child-scoped persona shadow and global-tool restriction. It receives zero parent conversation messages; the filter is visibility/composition, not an authority grant inherited from the parent. | The child pays for a new independent context and history; no parent-history tokens are duplicated. Persona or filtering changes only this child's repeated prompt/schema cost. |
| Parent tool result, indirectly | Through `dsh-tool-subagent`, the parent receives only the child's final output or stop-reason error. | Parent input grows by one data-dependent result retained until compaction. |

## Known Limitations and Deferred Work

- **Runs expose no `sendMessage`/`resume`** — the optional runtime capabilities are absent on in-process runs.
- **Fresh means no parent transcript** — the child inherits cwd, lineage, model, and explicitly configured persona/tool restrictions, but none of the parent's conversation; use the fork provider when completed-turn context is required.
