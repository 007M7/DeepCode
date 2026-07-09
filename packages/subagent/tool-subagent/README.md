# @deepseek-ai/dsh-tool-subagent

The model-facing `subagent` tool: delegate a self-contained task to a child agent and return its final output. Pure schema + lifecycle shaping over the [`ctx.subagents`](../subagent/README.md) provider registry — an in-process, ACP, or future A2A backend swaps in without changing what the model sees.

## Provider selection is config, not model-facing

This plugin binds to **exactly one** provider (`Config.provider`). The model sees only `{ description, prompt, run_in_background? }` — there is no provider/type parameter in the schema. To expose more than one transport, load the plugin more than once, each bound to a different provider **and a distinct `toolName`** (the tool registry rejects a duplicate name, so a second load that kept the default `subagent` name would throw). Keeping selection in config (not the schema) is the deliberate split: the *service* holds a multi-provider registry; the *tool* picks one.

## The description states the provider's context contract

The tool description and the `prompt` parameter description are DERIVED from the bound provider's `inheritsParentContext` (`providerWording`): a fresh-context provider (spawn, ACP) gets the standalone-prompt wording ("it does not see this conversation"), an inheriting provider (fork) tells the model the child already sees the conversation's completed turns and its prompt should state only what is new. Because the description is fixed at tool registration, the tool **mirrors the provider's lifecycle** (`subagent/provider-added`/`-removed`): it registers when the bound provider is (or becomes) available and unregisters when the provider goes away — no load-order requirement (the cordis Loader starts sibling entries concurrently, so "listed first" never guaranteed "registered first"), and an HMR reload of the backend re-derives the wording from the fresh provider. While the provider is absent the tool simply does not exist (a `ctx.logger` note records the wait; a typo'd provider name shows up as a tool that never materializes).

| Config key | Meaning |
|---|---|
| `provider` (required) | The `ctx.subagents` provider name to start runs on (`spawn`, `fork`, `acp`, …). |
| `toolName` | The model-facing tool name to register (default `subagent`). Set a distinct value per load when exposing multiple providers, e.g. `subagent` + `subagent_acp`. |
| `enableRunInBackground` | Expose `run_in_background` in this instance's schema (default `true`). Disabled, the parameter is absent entirely — delegation through this instance stays strictly synchronous. |
| `agentOptions` | Default per-child `{ model? }` applied to every spawned child. (No per-child persona: the deployment persona is a context-wide section every agent shares.) |

## Foreground lifecycle (synchronous collect)

`execute` starts a run on the configured provider and **awaits `run.result` inside a `try/finally` that always `dispose()`s the run** — the owned child agent/session is torn down on every path (success, error, abort), never leaked. The tool's abort signal (`exec.signal`) is bridged to `run.cancel()`. A non-`completed` stop reason (aborted/error/max-tokens/refusal) maps to an `isError` tool result rather than returning partial output as success.

## Background delegation (a generic task)

`run_in_background: true` refuses an already-aborted `exec.signal`, starts the run, registers `{ kind: 'subagent', label: description, owner: parent, cancel, done }` with `ctx.tasks` (`@deepseek-ai/dsh-tasks`), and returns `started background subagent task <id>` — the parent keeps working and collects/stops the child through the generic `task_output`/`task_list`/`task_kill` tools (`@deepseek-ai/dsh-tool-tasks`). The tool-call signal is deliberately NOT wired to the run after the id is returned; cancellation belongs to `task_kill` (its logged `reason` is forwarded to `run.cancel`) and the runtime's owner-disposal cleanup. The task is final-output-only (no incremental transcript — the child session remains the detailed trace), and its `done` settles only after `run.dispose()` (child quiescence), so owner disposal cannot resolve before the child is actually gone. Mapping (exported for tests): `runOutcome` — `completed` carries the final text as the task output; `aborted` → `killed`; `error`/`max-tokens`/`refusal`/unknown → `failed` with the reason as status-line detail — and `settleRun`, which disposes on both result paths and contains an infrastructure rejection as `failed`. A missing `ctx.tasks` fails the call loud (`background tasks unavailable: load @deepseek-ai/dsh-tasks and @deepseek-ai/dsh-tool-tasks`). See the [background subagent tasks RFC](../../../docs/rfc/implemented/feature/2026-07-08-background-subagent-tasks.md).
