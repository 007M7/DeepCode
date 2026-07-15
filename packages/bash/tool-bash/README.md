# @deepseek-ai/dsh-tool-bash

The model-facing bash tools — `bash`, `bash_output`, `bash_kill` — registered over the `ctx.bash` executor seam (`@deepseek-ai/dsh-bash`). This package owns schema and text shaping while process concerns stay behind the seam. Executor facts can change rendered results, and a sandboxing executor activates the escalation fields, without moving those presentation rules into the backend.

Requires a loaded executor implementation (e.g. `@deepseek-ai/dsh-bash-local`); the plugin stays pending until `ctx.bash` exists (`inject: ['tools', 'bash', 'systemPrompt']`).

The package root exposes only the Cordis plugin contract (`name`, `inject`, `apply`); result rendering remains an implementation detail covered by same-package tests.

The plugin also contributes the `tool:bash` prompt section (order 105) — the cross-call habit the per-tool descriptions cannot carry: check the `[exit code: N]` marker on every result and investigate failures before moving on. A sandboxing executor changes the `bash` schema and result markers but adds no mode statement or switch notice; see [Per-session mode](#per-session-mode-switching).

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

UI presentation is tool-owned through `presentCall` and `presentResult`. Foreground `bash` uses a terminal card whose title is the exact command and whose optional description is separate; cwd follows an explicit `workdir`—resolved by the bridge against the session when relative—or the session cwd. Its result carries raw output plus exit or signal data, and clients without terminal support receive a bridge-derived fenced console fallback. Background runs, spawn failures, `bash_output`, and `bash_kill` use generic cards. Presenters are pure and replay-safe; malformed older arguments fall back to generic rendering. See [`dsh-tools`](../../core/tools/) and [`dsh-acp`](../../ui/acp/) for card semantics.

## Background completion notices

When a task finishes, the plugin resolves its owner token to a live agent and injects a durable completion notice. If the owner no longer exists, the notice is dropped. Injection affects the next request but does not wake an idle agent, so the model must poll with `bash_output` when it needs completion promptly.

## The tool builds its request from named args only

The seam supports trusted-plugin `stdin` and `env`, but the model-facing tool does not. It builds requests only from its declared arguments, signal, and owner; extra model keys are ignored. Shell syntax already provides equivalent command-level behavior, while the local executor's credential scrub protects ambient secrets. See the [stdin/env RFC](../../../docs/rfc/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md).

## Permissions and escalation

Commands run with the executor's full authority unless a sandboxing executor ([`dsh-bash-sandbox`](../bash-sandbox/)) confines them — the deny-only sandbox reports denials as result facts, rendered here as the denial marker; per-call allow/deny/ask policy is the `tools/pre-execute` waterfall (see docs/architecture.md).

Escalating bash calls resolve `ctx.approval` before execution. `allowed-once` applies the requested mode only to that call; rejection, cancellation, unavailability, or missing approval context executes nothing and returns a distinct error. On a real denial, the model may retry the same command once in the same turn with the narrowest sufficient mode and justification; the approval prompt itself is the consent step. Escalation is never speculative, and a disabled or rejected approval is final. The [sandbox RFC](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md) owns the rationale.

## Per-session mode switching

For sandboxing executors, each call resolves mode as one-shot escalation, then session override, then executor default. Non-sandboxing and agent-less calls carry no session override. Neither the prompt nor a switch notice announces the standing mode; denial results report the effective mode when the boundary matters. See the [`dsh-bash` fold](../bash/README.md) and [sandbox switching contract](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md).

## Model Experience

### System prompt

**What the model sees**: Every request in this plugin's registration scope contains the bash guidance below. A sandboxing executor adds no mode statement or switch notice. Scoped tool restrictions can hide the schemas without removing this independently registered section.

**Token effect**: Small fixed input cost per request while the plugin is active, unchanged by sandbox mode or mode switches.

#### Bash guidance

```markdown
Check the [exit code: N] marker on every bash result; investigate failures before moving on.
```

### Tool schemas

**What the model sees**: The model sees the generated [`bash`, `bash_output`, and `bash_kill` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-bash). `sandbox_permissions` and `justification` augment `bash` only when the mounted executor advertises sandboxing. Agent-scoped tool restrictions can remove the definitions for that agent.

**Token effect**: Fixed schema cost on every request where the tools are visible; sandbox support adds the escalation fields and its conditional description paragraph.

### Foreground result

**What the model sees**: The renderer emits the data-dependent stdout tail, then optional `[stderr]` and the stderr tail. With no output it emits exactly `(no output)`. Conditional lines are exactly `[output truncated; full output: <path-or-(unavailable)>]`, `[sandbox: file access denied under <mode> mode]`, `[timed out after <timeoutMs>ms]`, `[killed by signal: <signal>]`, and `[exit code: <exitCode>]`; the sandbox escalation and runner-failure lines are quoted in [`dsh-bash-sandbox`](../bash-sandbox/README.md).

**Token effect**: Zero result tokens before a call. Output is bounded per stream, while each emitted line remains in history until compaction.

### Background task context and results

**What the model sees**: Start returns exactly `started background task <taskId>`. Completion injects exactly `background bash task <taskId> finished <status>. Read its output with bash_output.` Reads return only the data-dependent delta or `(no new output)`, optionally `[some output was dropped from memory; full output: <paths-or-(unavailable)>]`, then exactly one of `[status: running]`, `[status: killed]`, `[status: killed by <signal>]`, or `[status: completed, exit code: <exitCode>]`. Kill returns `killed background task <taskId>` or `task <taskId> had already finished`.

**Token effect**: Start and status text is small; deltas are data-dependent. The completion notice and every tool result are retained until compaction, but polling does not repeat already-delivered output.

### Tool errors

**What the model sees**: Validation and policy failures are normalized as `Error: <message>`. This package's stable messages are `invalid command: expected a non-empty string`, `invalid description: expected a non-empty string`, `invalid timeoutMs: expected a positive number, got <value>`, `invalid escalation: sandbox_permissions requires a justification`, `invalid escalation: justification is only valid together with sandbox_permissions`, `invalid justification: expected a non-empty sentence`, `invalid task_id: expected a string, got <value>`, `task <taskId> belongs to another session`, `sandbox_permissions is not available in this composition (no sandboxing executor to escalate)`, `sandbox escalation to "<mode>" is not strictly wider than this call's current "<mode>" mode`, the approval-availability/rejection/cancellation variants, and `command aborted`.

**Token effect**: Only the failing call adds these retained tokens; a rejected escalation does not add command output because the command does not run.

## Known Limitations and Deferred Work

- **Replay exit pills parse from result text** — output whose final line happens to be exactly `[exit code: N]` / `[killed by signal: …]` shows a wrong pill on session replay; a display-only known residual.
- **The bash tools opt out of `timeout-policy` budgets** — `bash` keeps the executor-owned `BASH_TIMEOUT` path and `bash_output`/`bash_kill` declare no budget, per [the tool-call timeout-policy RFC](../../../docs/rfc/implemented/architecture/2026-07-07-tool-call-timeout-policy.md).
- **Completion notices do not wake an idle agent** — they become durable context for the next request; a caller needing progress now must poll `bash_output` or send another message.
- **Tasks started outside an agent have no ownership fence** — their predictable ids are readable and killable by any caller; only agent-started tasks carry a session owner token.
