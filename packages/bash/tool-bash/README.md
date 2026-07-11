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

Result text: stdout, then a `[stderr]` section, then status markers — `[sandbox: file access denied under <mode> mode]` when a sandboxing executor classified the failure as a policy denial (reported first so `[exit code: N]` stays the last line; the static description tells the model a denial is policy, not a command bug, and forbids retrying around it), `[timed out after Nms]` whenever the executor's timer fired (reported independently of how the process ended, so a command that traps SIGTERM and exits 0 still shows it), `[killed by signal: …]` for a signal death, `[exit code: N]` for a non-zero exit (reported, **not** `isError`: the model decides how to react), and `[output truncated; full output: <path>]` when the tail was kept and a safe spill file is available. If the executor knows output was dropped but cannot safely advertise a complete spill file, the path is reported as `(unavailable)`. Only infrastructure failures (spawn errors, aborts) surface as `isError` results.

### `bash_output`

`task_id` → output produced **since the previous `bash_output` call** plus a status line (`running` / `completed, exit code: N` / `killed`). A settled task classified as a sandbox denial carries the same `[sandbox: file access denied under <mode> mode]` marker on every read that sees it (denials are only classifiable once the whole stderr has been collected). Reads that lost data to buffer bounds say so and point at the full-output spill file when one is safely available, otherwise `(unavailable)`.

### `bash_kill`

`task_id` → ask the executor to kill the background task. The concrete executor decides how to signal or stop the process; killing an already-finished task is a reported no-op, and unknown ids are errors.

### Task ownership (cross-session isolation)

The owning agent's session token (`session.header.id`) is stamped onto the task at spawn — passed to the executor via `resolve({ …, owner })` and stored ON THE TASK inside the executor (the `dsh-bash` `ownerOf(id)` seam), **not** in a plugin-local map. `bash_output`/`bash_kill` compare `ctx.bash.ownerOf(id)` to the caller's token (`session.header.id`) with `!== undefined` semantics and reject a task owned by a *different* session with `task <id> belongs to another session` (a task started with no agent — a non-loop caller — has no owner token and is open to anyone; a call with no `exec.agent` cannot access an owned task). Task ids are global and predictable, so under multi-session ACP this token check is the fence that stops one session's agent from reading or killing another session's background task. Because ownership lives on the task in the executor (disposed with the `dsh-bash` fiber), it **survives an independent `tool-bash` HMR reload** — closing the old plugin-local-map gap where a reload orphaned pre-reload tasks. (The `onTaskDone` listener is still effect-scoped to this plugin's `apply`, so a completion landing during the reload gap still drops its one notice — the pre-existing reload-gap drop — but the ownership fence itself is HMR-proof.)

## UI presentation

UI presentation is tool-owned through `presentCall` and `presentResult`. Foreground `bash` uses a terminal card whose title is the command, optional description is separate, and cwd follows `workdir` or the session; its result carries raw output and exit or signal data. Background runs, spawn failures, `bash_output`, and `bash_kill` use generic cards. Presenters are pure and replay-safe, and malformed older arguments fall back to generic rendering. See [`dsh-tools`](../../core/tools/) and [`dsh-acp`](../../ui/acp/) for card semantics.

## Background completion notices

When a background task finishes, a short notice is injected into the owning agent's session (`agent.inject()`, source `{kind: 'plugin', plugin: 'tool-bash'}`). The owning agent is found by its session token: the listener reads `ctx.bash.ownerOf(task.id)` and scans `ctx.get('agents')?.list()` for an agent whose `session.header.id` matches (read via `ctx.get` — `onTaskDone` runs on the bash fiber, a foreign fiber, so the `ctx.agents` proxy would throw). If no live agent carries that token — e.g. the owning session disconnected and its agent was disposed while the task ran on — the notice is dropped cleanly. Injection is **durable context for the next model request, not a wake-up** — an idle agent stays idle until something sends a message. That's why the tool descriptions tell the model to poll with `bash_output`.

## The tool builds its request from named args only

The `BashExecRequest` seam carries optional `stdin` and `env`, used by the hooks bridges to feed a hook command its JSON payload and `CLAUDE_*` env. This tool does **not** expose them as parameters: its request is built from `command`/`workdir`/`timeoutMs`/`signal`/`owner` only, so a model that includes `env` or `stdin` keys in its tool arguments has them ignored. This is not a trust boundary — a model already has equivalent power through shell syntax (`FOO=bar cmd`, a heredoc), and the real defense against leaking the harness's ambient secrets is `dsh-bash-local`'s credential scrub, which works regardless. A regression guard drives the real tool with those extra args and asserts the resulting request carries neither field — its job is to catch a future refactor that blindly spreads `...args` into the request (which would silently forward model input into the post-scrub `env` merge), not to defend a wall. See [the bash-stdin-env RFC](../../../docs/rfc/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md).

## Permissions and escalation

Commands run with the executor's full authority unless a sandboxing executor ([`dsh-bash-sandbox`](../bash-sandbox/)) confines them — the deny-only sandbox reports denials as result facts, rendered here as the denial marker; per-call allow/deny/ask policy is the `tools/pre-execute` waterfall (see docs/architecture.md).

Escalating bash calls resolve `ctx.approval` before execution. `allowed-once` applies the requested mode only to that call; rejection, cancellation, unavailability, or missing approval context executes nothing and returns a distinct error. On a real denial, the model may retry the same command once in the same turn with the narrowest sufficient mode and justification; the approval prompt itself is the consent step. Escalation is never speculative, and a disabled or rejected approval is final. The [sandbox RFC](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md) owns the rationale.

## Per-session mode switching

Under a sandboxing executor this plugin makes the session's standing mode override ([the sandbox RFC § Per-session mode switching](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md); the `bash/sandbox-mode` fold owned by [`dsh-bash`](../bash/README.md)) real at EXECUTION: every call is stamped `escalation grant > session override > undefined` onto `BashExecRequest.sandboxMode`; without either, the executor's `resolve()` applies its configured default. Nothing is stamped under a non-sandboxing executor (nothing would honor it) or for an agent-less caller (no session to fold). The prompt deliberately does NOT state the mode and a switch is not narrated: a standing declaration teaches the model to refuse preemptively, while the denial marker already names the mode the command ran under exactly when the boundary is hit — behavior, not belief, carries the state.
