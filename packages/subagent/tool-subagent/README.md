# @deepseek-ai/dsh-tool-subagent

Model-facing delegation tool over the [`ctx.subagents`](../subagent/README.md) provider registry. The selected provider may be in-process or out-of-process without changing the model's `{ description, prompt }` request shape.

## Provider binding

Each plugin load binds one `Config.provider`. To expose multiple providers, load the plugin under distinct `toolName` values. The tool description is derived from `provider.inheritsParentContext`, telling the model whether the child already sees completed parent turns.

The tool follows provider availability through `subagent/provider-added` and `subagent/provider-removed`; it has no Loader-order dependency and disappears while its provider is absent.

| Config key | Meaning |
|---|---|
| `provider` (required) | Provider name on `ctx.subagents`. |
| `toolName` | Model-facing name (default `subagent`). |
| `agentOptions` | Default child options (`model?`). |
| `persona` | Child persona; requires provider support. |
| `toolFilter` | Child global-tool restriction; requires provider support. |
| `maxDepth` | Delegation-depth cap; requires provider support. |

## Execution

`execute` starts a run, bridges the tool abort signal to `run.cancel()`, awaits `run.result`, and always disposes the run. Non-completed stop reasons return error tool results rather than successful partial output. Collection is synchronous; background polling remains deferred in the [subagent seam RFC](../../../docs/rfc/implemented/feature/2026-06-21-subagent-capability-seam.md).
