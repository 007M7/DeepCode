# @deepseek-ai/dsh-tool-subagent

The model-facing delegation tool over one configured `ctx.subagents` provider. Changing the provider changes transport without changing the execution contract.

## Provider selection and lifecycle

Each plugin instance binds one `provider` to one `toolName`; the model receives no provider selector. Load another distinctly named instance to expose another transport. The tool registers only while its provider exists, avoiding sibling load-order and provider-reload dependencies. Its description follows `provider.inheritsParentContext`: fresh children require standalone prompts, while forked children already see completed parent turns.

A foreground call passes the execution signal through startup and execution, awaits `run.result`, and always awaits `run.dispose()` before returning. Only `completed` returns the canonical `{ kind: 'foreground', runId, output: JsonValue[] }`, rendered as the same final text; abort, refusal, token limit, and other failures become errored tool results without partial output.

With `run_in_background: true`, the tool registers the parent-owned task before starting the provider and returns canonical `{ kind: 'background', taskId }`, rendered as `started background subagent task <id>`. A task-owned signal covers pending startup and the child after the starting call returns. `task_kill` and owner disposal abort it. Settlement awaits startup rollback or child disposal, then maps completed final text, abort to `killed`, and other failures to `failed`. The task has no incremental read; generic task tools own later status, collection, cancellation, and notices. See the [background subagent Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-background-subagent-tasks.md).

`toolFilter` changes the child's global tool layer but is not a parent-derived authority ceiling. See the [agent-scope security non-goal](../../../.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md#security-and-authority-are-non-goals).

## Config

| Key | Meaning |
|---|---|
| `provider` (required) | Provider name (`spawn`, `fork`, `acp`, ...). |
| `toolName` | Model-facing name, default `subagent`; distinct for every loaded instance. |
| `enableRunInBackground` | Exposes background mode, default `true`; disabling also rejects forced background calls. |
| `agentOptions` | Default child options, currently including `model`. |
| `persona` | Per-child persona; requires provider `persona` capability. |
| `toolFilter` | Per-child global-tool restriction; requires `toolFilter` capability. |
| `maxDepth` | Absolute delegation-depth cap, default `3` (`0` forbids delegation); a numeric cap requires the `depthLimit` capability and fails the mount without it. `'provider-managed'` sends no cap for an out-of-process provider whose budget belongs to the child harness. The tool stays visible at the cap; each attempted start checks the calling agent's current depth and returns an errored tool result when rejected. |

## Concurrency

Foreground and background calls are exclusive. Children may share the parent's workspace or external resources, and a unary classifier cannot prove that sibling delegations have disjoint effects. See the [parallel tool-call Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md).

## Model Experience

### Tool schema

#### What the model sees

The generated default [`subagent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent) under this instance's configured name while its provider exists. Provider context inheritance changes the tool and prompt descriptions; enabled background mode adds `run_in_background`.

#### Token effect

Fixed schema cost per parent request; each provider instance adds one schema.

#### KV Cache effect

Prefix-stable while provider instances, names, descriptions, and schemas are unchanged. Provider registration lifecycle may invalidate parent reuse from the first changed tool definition.

### Foreground result

#### What the model sees

The call retains the description and prompt. Success contains only the child's final text; other outcomes become `Error: <message>`. Intermediate child steps stay out of the parent.

#### Token effect

The prompt and result remain in parent history until compaction; child working context remains in the child.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Background task result

#### What the model sees

Start returns exactly `started background subagent task <id>`. The generic task surface provides later status, final output, cancellation responses, and notices.

#### Token effect

The acknowledgement is retained; final output enters parent history only when collected or injected.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Background runs expose final output only** — intermediate child steps stay in the child session.
- **Duplicate names across waiting instances are detected late** (`TODO(subagent-dup-toolname)`) — preventing provider-registration rollback requires a registry of intended names.
- **Child policy is fixed per instance** — another model, persona, tool filter, or depth cap requires another distinctly named tool.
