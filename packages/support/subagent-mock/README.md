# @deepseek-ai/dsh-subagent-mock

A scripted `SubagentProvider` for testing the [subagent seam](../../subagent/subagent/README.md) without a model or a real child agent — the subagent analog of [`dsh-llm-replay`](../llm-replay/README.md).

It lets a test drive `ctx.subagents` and the model-facing `dsh-tool-subagent` through the real Cordis loader/export path, exercising provider registration, async start, start-time capability validation, required-signal cancellation, `result`, `dispose`, and structured output deterministically and keylessly.

## Usage

Load it as a plugin (functional shape: `name`/`inject`/`Config`/`apply`, no default). Config (all optional):

| Key | Default | Meaning |
|---|---|---|
| `name` | `mock` | Registry name to register the provider under. |
| `reply` | `mock subagent reply` | The scripted child's final answer text. |
| `stopReason` | `completed` | The stop reason `result` settles with. |
| `capabilities` | all `true` | Which start-time capabilities (`outputSchema`, `depthLimit`, `toolFilter`, and `persona`) the provider advertises. |
| `inheritsParentContext` | `false` | Conversation-history descriptor: `false` means fresh, while `true` exercises seeded/fork wording. It says nothing about tool, service, scope, or authority inheritance. |
| `structured` | `{ reply }` | Structured value surfaced when a request carries an `outputSchema` and the capability is on. |

Aborting the required request signal or disposing before `result` settles flips the stop reason to `aborted`, so both holder-facing cancellation paths are observable.

## Model Experience

Indirectly, through `dsh-tool-subagent`, which renders this test provider's configured reply or stop-reason error into the parent test history.

## Known Limitations and Deferred Work

- **Scripted provider only** — it does not run a model, create a child agent, or exercise real prompt/tool-loop behavior.
- **One synthetic outcome per run** — it models no multi-turn, streaming, steering, resume, or subprocess transport behavior.
