# @deepseek-ai/dsh-subagent-mock

A scripted `SubagentProvider` for testing the [subagent seam](../../subagent/subagent/README.md) without a model or a real child agent — the subagent analog of [`dsh-llm-replay`](../llm-replay/README.md).

It lets a test drive `ctx.subagents` and the model-facing `dsh-tool-subagent` through the **real cordis Loader / export path**, exercising provider registration, start-time capability validation, the run lifecycle (`result` / `cancel` / `dispose`), and the structured-output branch — all deterministically and keylessly.

## Usage

Load it as a plugin (functional shape: `name`/`inject`/`Config`/`apply`, no default). Config (all optional):

| Key | Default | Meaning |
|---|---|---|
| `name` | `mock` | Registry name to register the provider under. |
| `reply` | `mock subagent reply` | The scripted child's final answer text. |
| `stopReason` | `completed` | The stop reason `result` settles with. |
| `capabilities` | all `true` | Which start-time capabilities (`outputSchema`/`depthLimit`/`toolFilter`) the provider advertises. |
| `structured` | `{ reply }` | Structured value surfaced when a request carries an `outputSchema` and the capability is on. |

A `cancel()` issued before `result` settles flips the stop reason to `aborted`, so the cancellation path is observable.
