# @deepseek-ai/dsh-tool-subagent

The `subagent` tool lets the model delegate one self-contained task and collect the child's final output. It is a thin consumer of `ctx.subagents`; changing the configured provider changes the transport without changing the model-facing execution contract.

## Provider selection

This plugin binds to **exactly one** provider (`Config.provider`). The model sees only `{ description, prompt, run_in_background? }` — there is no provider/type parameter in the schema. To expose more than one transport, load the plugin more than once, each bound to a different provider **and a distinct `toolName`** (the tool registry rejects a duplicate name, so a second load that kept the default `subagent` name would throw). Keeping selection in config (not the schema) is the deliberate split: the *service* holds a multi-provider registry; the *tool* picks one.

The description is derived from `provider.inheritsParentContext`: spawn and ACP tell the model to provide a standalone prompt, while fork says the child already sees completed conversation turns. The plugin follows `subagent/provider-added` and `subagent/provider-removed`, so concurrent Cordis plugin loading does not create a registration-order dependency.

## Lifecycle

Foreground `execute` passes the tool execution's abort signal when present, otherwise supplies an inert signal to satisfy the required `SubagentStartRequest.signal`. It awaits `ctx.subagents.start(...)`, then awaits `run.result` inside a `try/finally` that always calls `run.dispose()`. The selected signal therefore covers startup and live execution, while disposal guarantees quiescence on success, failure, and abort.

A non-`completed` stop reason becomes an `isError` tool result; partial child output is never reported as success. With `run_in_background`, an independent task-owned signal covers both asynchronous startup and the ready child, while collection moves to the generic task tools.

## Config

| Key | Meaning |
|---|---|
| `provider` (required) | The `ctx.subagents` provider name to start runs on (`spawn`, `fork`, `acp`, …). |
| `toolName` | The model-facing tool name to register (default `subagent`). Set a distinct value per load when exposing multiple providers, e.g. `subagent` + `subagent_acp`. |
| `enableRunInBackground` | Expose `run_in_background` in this instance's schema (default `true`). Disabled, the parameter is absent entirely AND a caller that forces the key anyway is refused at execution time (the arg validator allows undeclared keys) — delegation through this instance stays strictly synchronous. |
| `agentOptions` | Default child agent options, currently including `model`. |
| `persona` | Per-child persona; requires provider `persona` capability. |
| `toolFilter` | Per-child global-tool restriction; requires provider `toolFilter` capability. |
| `maxDepth` | Absolute delegation-depth cap; requires provider `depthLimit` capability. |

## Foreground lifecycle (synchronous collect)

`execute` awaits a ready run from the configured provider and then **awaits `run.result` inside a `try/finally` that always `dispose()`s the run** — the owned child agent/session is torn down on every path (success, error, abort), never leaked. The required request signal is the canonical cancellation path across startup and live execution. A non-`completed` stop reason (aborted/error/max-tokens/refusal) maps to an `isError` tool result rather than returning partial output as success.

## Background delegation (a generic task)

`run_in_background: true` refuses an already-aborted `exec.signal`, synchronously registers `{ kind: 'subagent', label: description, owner: parent, cancel, done }` with `ctx.tasks`, and returns `started background subagent task <id>`. The starter immediately calls async `ctx.subagents.start()` with an independent `AbortController`; `task_kill` and owner-scope teardown abort that signal whether startup is still pending or the child is ready. The task is final-output-only, and `done` settles only after startup rollback or `run.dispose()` reaches quiescence. Mapping: `runOutcome` turns `completed` into final output, `aborted` into `killed`, and other terminal reasons into `failed`; `settleRun` contains infrastructure and disposal failures. A missing task runtime fails loud. See the [background subagent tasks RFC](../../../docs/rfc/implemented/feature/2026-07-08-background-subagent-tasks.md).

`toolFilter` changes the child's visible global tool layer; it is not a parent-derived authority ceiling. See the [agent-scope security non-goal](../../../docs/rfc/implemented/architecture/2026-07-08-agent-scope-contexts.md#security-and-authority-are-non-goals).

## Model Experience

### Tool schemas

**What the model sees**: While the configured provider exists, the model sees the generated default [`subagent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent) under this instance's configured `toolName`. Fresh-context and inherited-context providers change the tool and `prompt` descriptions; `enableRunInBackground: true` adds `run_in_background` and its generic-task guidance.

**Token effect**: Fixed schema cost per parent request while mounted; each additional provider instance contributes one independently named schema.

### Foreground result

**What the model sees**: The parent tool call retains the task description and prompt. Success contains only the child's data-dependent final text; non-completed stop reasons and infrastructure failures become `Error: <message>`. Intermediate child steps never enter the parent.

**Token effect**: The prompt and final result remain in parent history until compaction; child working context is paid only in the child.

### Background task result

**What the model sees**: Start returns exactly `started background subagent task <id>`. The generic task control surface owns later status, final output, cancellation responses, and completion notices; the child still contributes only its final text on successful collection.

**Token effect**: The start acknowledgement is small and retained. Final output and generic task status enter parent history only when collected or injected by `dsh-tool-tasks`.

## Known Limitations and Deferred Work

- **Background runs expose final output only** — intermediate child steps remain in the child session and cannot be streamed through `task_output`.
- **Duplicate `toolName` across waiting loads is detected late** (`TODO(subagent-dup-toolname)`) — two instances waiting on providers collide only when a provider arrives; config-time detection needs a cross-fiber registry of intended names.
- **Child policy is fixed per tool registration** — model, persona, tool filter, and depth cap come from plugin config; another policy requires another distinctly named tool.
