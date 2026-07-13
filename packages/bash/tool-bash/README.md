# @deepseek-ai/dsh-tool-bash

The model-facing bash tools — `bash`, `bash_output`, `bash_kill` — registered over the `ctx.bash` executor seam (`@deepseek-ai/dsh-bash`). Pure schema + text shaping; every process concern lives behind the seam, so sandboxed or remote executor implementations swap in without changing what the model sees.

Requires a loaded executor implementation (e.g. `@deepseek-ai/dsh-bash-local`); the plugin stays pending until `ctx.bash` exists (`inject: ['tools', 'bash', 'systemPrompt']`).

The plugin also contributes the `tool:bash` prompt section (order 105) — the cross-call habit the per-tool descriptions cannot carry: check the `[exit code: N]` marker on every result and investigate failures before moving on. Under a sandboxing executor it additionally contributes the per-agent `env:bash-sandbox` section (order 110) stating each session's EFFECTIVE mode, and the pre-step narrator — see [Per-session mode](#per-session-mode-switching-and-visibility).

## Tools

### `bash`

| Arg | Type | Notes |
|---|---|---|
| `command` | string (required) | Run via `bash -c`. No state persists between calls — use `workdir`, not `cd`. |
| `description` | string (required) | One-line, active-voice summary of the command (5-10 words), for UI/log display only — no effect on execution. |
| `timeoutMs` | number | Timeout override in milliseconds. The executor applies its configured default and cap. |
| `workdir` | string | Working directory for this call. Defaults to the calling agent's session cwd (`session.header.cwd`) so each session runs in its own workspace; a relative `workdir` is resolved against that session cwd. |
| `run_in_background` | boolean | Return a task id immediately; no timeout applies. |
| `sandbox_permissions` | string enum | ADVERTISED ONLY when the mounted executor sandboxes (`ctx.bash.sandboxMode` reports a confining default): the wider mode a denied command needs, from the closed target vocabulary `workspace-write`/`danger-full-access` (never cut down to the executor's default — the effective mode is per-session; strict widening is checked at execution against it, and a non-widening request fails without prompting anyone). |
| `justification` | string | Required together with `sandbox_permissions` (each without the other is a validation error): one sentence for the user explaining why this exact command needs the wider access. |

`command`, `workdir`, and `timeoutMs` are resolved against the executor's config defaults via `ctx.bash.resolve()` before execution, so the executor seam (`BashExecSpec`) receives explicit `workdir`/`timeoutMs` values. The workdir default is applied in the tool layer (from the calling agent's `session.header.cwd`) BEFORE `resolve()` — the per-session cwd must come from `exec.agent`, since N sessions share one executor; only when no session cwd is available does the executor fall back to its own config / `process.cwd()`.

Result text contains stdout, an optional `[stderr]` section, then applicable sandbox-denial, timeout, signal, exit-code, and truncation markers. Timeout is reported independently of final exit status; nonzero exit remains a model-interpreted result rather than `isError`. Truncation links a safe complete spill file or reports it unavailable. Only infrastructure failures such as spawn errors and aborts produce `isError`.

### `bash_output`

`task_id` → output produced **since the previous `bash_output` call** plus a status line (`running` / `completed, exit code: N` / `killed`). A settled task classified as a sandbox denial carries the same `[sandbox: file access denied under <mode> mode]` marker on every read that sees it (denials are only classifiable once the whole stderr has been collected). Reads that lost data to buffer bounds say so and point at the full-output spill file when one is safely available, otherwise `(unavailable)`.

### `bash_kill`

`task_id` → ask the executor to kill the background task. The concrete executor decides how to signal or stop the process; killing an already-finished task is a reported no-op, and unknown ids are errors.

### Task ownership (cross-session isolation)

The executor stores the spawning session id as the task's owner. `bash_output` and `bash_kill` reject a caller with a different session id; agent-less tasks remain unowned, while agent-less calls cannot access owned tasks. Storing ownership on the task prevents predictable global ids from crossing ACP sessions and preserves the fence across tool-plugin reloads. Completion notices remain effect-scoped and may be missed during a reload gap.

## UI presentation

UI presentation is tool-owned through `presentCall` and `presentResult`. Foreground `bash` uses a terminal card whose title is the command, optional description is separate, and cwd follows `workdir` or the session; its result carries raw output and exit or signal data. Background runs, spawn failures, `bash_output`, and `bash_kill` use generic cards. Presenters are pure and replay-safe, and malformed older arguments fall back to generic rendering. See [`dsh-tools`](../../core/tools/) and [`dsh-acp`](../../ui/acp/) for card semantics.

## Background completion notices

When a task finishes, the plugin resolves its owner token to a live agent and injects a durable completion notice. If the owner no longer exists, the notice is dropped. Injection affects the next request but does not wake an idle agent, so the model must poll with `bash_output` when it needs completion promptly.

## The tool builds its request from named args only

The seam supports trusted-plugin `stdin` and `env`, but the model-facing tool does not. It builds requests only from its declared arguments, signal, and owner; extra model keys are ignored. Shell syntax already provides equivalent command-level behavior, while the local executor's credential scrub protects ambient secrets. See the [stdin/env RFC](../../../docs/rfc/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md).

## Permissions and escalation

Commands run with the executor's full authority unless a sandboxing executor ([`dsh-bash-sandbox`](../bash-sandbox/)) confines them — the deny-only sandbox reports denials as result facts, rendered here as the denial marker; per-call allow/deny/ask policy is the `tools/pre-execute` waterfall (see docs/architecture.md).

Escalating bash calls resolve `ctx.approval` before execution. `allowed-once` applies the requested mode only to that call; rejection, cancellation, unavailability, or missing approval context executes nothing and returns a distinct error. On a real denial, the model may retry the same command once in the same turn with the narrowest sufficient mode and justification; the approval prompt itself is the consent step. Escalation is never speculative, and a disabled or rejected approval is final. The [sandbox RFC](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md) owns the rationale.

## Per-session mode switching

For sandboxing executors, each call resolves mode as one-shot escalation, then session override, then executor default. Non-sandboxing and agent-less calls carry no session override. The prompt does not announce the standing mode; denial results report the effective mode when the boundary matters. See the [sandbox switching contract](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md).
