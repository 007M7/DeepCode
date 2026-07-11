# @deepseek-ai/dsh-tool-bash

The model-facing `bash` tool registered over the `ctx.bash` executor seam. Foreground execution stays behind that seam; a background process handle is registered with the generic `ctx.tasks` runtime and controlled through `task_output`, `task_list`, and `task_kill` from `@deepseek-ai/dsh-tool-tasks`.

Requires a loaded executor implementation (e.g. `@deepseek-ai/dsh-bash-local`); the plugin stays pending until `ctx.bash` exists (`inject: ['tools', 'bash', 'systemPrompt']`).

The plugin also contributes the `tool:bash` prompt section (order 105): check the `[exit code: N]` marker on every result and investigate failures before moving on.

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

When `run_in_background` is true, this plugin preflights `ctx.tasks.start()` before spawning, registers the calling agent as owner, and adapts the returned `BashProcess` handle into generic cancel/done/incremental-output hooks. The task runtime owns ids, cross-session isolation, completion notices, waiting, and disposal cleanup; this plugin only maps bash exit/sandbox facts into task output and outcome detail. `enableRunInBackground: false` removes the parameter and rejects a forced background call at execution time.

## UI presentation

The tool owns its `presentCall`/`presentResult` render intent. A foreground call is a terminal card carrying command, description, cwd, raw output, and parsed exit status. A background start is a generic execute card because it returns only a task id; the generic `task_*` tools own their own cards. These presenters are pure and replay-safe.

## The tool builds its request from named args only

The `BashExecRequest` seam carries optional `stdin` and `env`, used by trusted in-process plugins. This tool does **not** expose or forward them: it builds requests from named command/workdir/timeout/signal/sandbox fields only. This is not a trust boundary; the local executor's ambient credential scrub is the security control.

## Permissions and escalation

Commands run with the executor's full authority unless a sandboxing executor ([`dsh-bash-sandbox`](../bash-sandbox/)) confines them — the deny-only sandbox reports denials as result facts, rendered here as the denial marker; per-call allow/deny/ask policy is the `tools/pre-execute` waterfall (see docs/architecture.md).

On top of a denial sits the escalation gate ([the sandbox RFC § Escalation](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md)): an escalating call (`sandbox_permissions` + `justification`) resolves [`ctx.approval`](../../ui/user-approval/README.md) BEFORE anything executes — `allowed-once` stamps the granted mode onto the bash request as the seam-level `sandboxMode` override (that one call runs, classifies, and reports under the wider mode; its neighbors keep the session's effective mode), while `rejected`/`cancelled`/`unavailable` and the no-service / no-agent paths each fail closed with their own error text and execute nothing. The seam is consumed opportunistically (`ctx.get('approval')`, the dsh-tools ask-routing pattern); the grant is consumed by the very call that asked, and nothing is stored. The static description teaches — and a denied result itself prompts, via the escalation-available marker appended exactly when the fields are advertised — the SAME-TURN flow: on a denial a wider mode would cure, retry the exact command once with `sandbox_permissions` (the narrowest mode that suffices) + `justification` immediately, without detouring through chat (the approval prompt IS the user's consent); never speculatively — an escalation is grounded in a real denial (up-front only when the session already denied the same access), a prompt-stated approvals-disabled policy turns the exception off entirely, and a rejected escalation is final for that command.

## Per-session mode switching

Under a sandboxing executor this plugin makes the session's standing mode override ([the sandbox RFC § Per-session mode switching](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md); the `bash/sandbox-mode` fold owned by [`dsh-bash`](../bash/README.md)) real at EXECUTION: every call is stamped `escalation grant > session override > undefined` onto `BashExecRequest.sandboxMode`; without either, the executor's `resolve()` applies its configured default. Nothing is stamped under a non-sandboxing executor (nothing would honor it) or for an agent-less caller (no session to fold). The prompt deliberately does NOT state the mode and a switch is not narrated: a standing declaration teaches the model to refuse preemptively, while the denial marker already names the mode the command ran under exactly when the boundary is hit — behavior, not belief, carries the state.
