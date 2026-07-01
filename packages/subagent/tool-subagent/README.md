# @deepseek-ai/dsh-tool-subagent

The model-facing `subagent` tool: delegate a self-contained task to a child agent and return its final output. Pure schema + lifecycle shaping over the [`ctx.subagents`](../subagent/README.md) provider registry — an in-process, ACP, or future A2A backend swaps in without changing what the model sees.

## Provider selection is config, not model-facing

This plugin binds to **exactly one** provider (`Config.provider`). The model sees only `{ description, prompt }` — there is no provider/type parameter in the schema. To expose more than one transport, load the plugin more than once, each bound to a different provider **and a distinct `toolName`** (the tool registry rejects a duplicate name, so a second load that kept the default `subagent` name would throw). Keeping selection in config (not the schema) is the deliberate split: the *service* holds a multi-provider registry; the *tool* picks one.

| Config key | Meaning |
|---|---|
| `provider` (required) | The `ctx.subagents` provider name to start runs on (`spawn`, `fork`, `acp`, …). |
| `toolName` | The model-facing tool name to register (default `subagent`). Set a distinct value per load when exposing multiple providers, e.g. `subagent` + `subagent_acp`. |
| `agentOptions` | Default per-child `{ model?, systemPrompt? }` applied to every spawned child. |

## Lifecycle (synchronous collect)

`execute` starts a run on the configured provider and **awaits `run.result` inside a `try/finally` that always `dispose()`s the run** — the owned child agent/session is torn down on every path (success, error, abort), never leaked. The tool's abort signal (`exec.signal`) is bridged to `run.cancel()`. A non-`completed` stop reason (aborted/error/max-tokens/refusal) maps to an `isError` tool result rather than returning partial output as success.

Background / poll collection is deferred (see the [RFC](../../../docs/rfc/implemented/feature/2026-06-21-subagent-capability-seam.md)); this cut blocks the parent turn until the child finishes.
