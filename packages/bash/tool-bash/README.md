# @deepseek-ai/dsh-tool-bash

The model-facing bash tools — `bash`, `bash_output`, `bash_kill` — registered over the `ctx.bash` executor seam (`@deepseek-ai/dsh-bash`). This package owns schema and text shaping while process concerns stay behind the seam. Executor facts can change rendered results, and a sandboxing executor activates the escalation fields, without moving those presentation rules into the backend.

Requires a loaded executor implementation (e.g. `@deepseek-ai/dsh-bash-local`); the plugin stays pending until `ctx.bash` exists (`inject: ['tools', 'bash', 'systemPrompt']`).

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

Result text: stdout, then a `[stderr]` section, then status markers — `[sandbox: file access denied under <mode> mode]` when a sandboxing executor classified the failure as a policy denial (reported first so `[exit code: N]` stays the last line; the static description tells the model a denial is policy, not a command bug, and forbids retrying around it), `[timed out after Nms]` whenever the executor's timer fired (reported independently of how the process ended, so a command that traps SIGTERM and exits 0 still shows it), `[killed by signal: …]` for a signal death, `[exit code: N]` for a non-zero exit (reported, **not** `isError`: the model decides how to react), and `[output truncated; full output: <path>]` when the tail was kept and a safe spill file is available. If the executor knows output was dropped but cannot safely advertise a complete spill file, the path is reported as `(unavailable)`. Only infrastructure failures (spawn errors, aborts) surface as `isError` results.

### `bash_output`

`task_id` → output produced **since the previous `bash_output` call** plus a status line (`running` / `completed, exit code: N` / `killed`). A settled task classified as a sandbox denial carries the same `[sandbox: file access denied under <mode> mode]` marker on every read that sees it (denials are only classifiable once the whole stderr has been collected). Reads that lost data to buffer bounds say so and point at the full-output spill file when one is safely available, otherwise `(unavailable)`.

### `bash_kill`

`task_id` → ask the executor to kill the background task. The concrete executor decides how to signal or stop the process; killing an already-finished task is a reported no-op, and unknown ids are errors.

### Task ownership (cross-session isolation)

The owning agent's session token (`session.header.id`) is stamped onto the task at spawn — passed to the executor via `resolve({ …, owner })` and stored ON THE TASK inside the executor (the `dsh-bash` `ownerOf(id)` seam), **not** in a plugin-local map. `bash_output`/`bash_kill` compare `ctx.bash.ownerOf(id)` to the caller's token (`session.header.id`) with `!== undefined` semantics and reject a task owned by a *different* session with `task <id> belongs to another session` (a task started with no agent — a non-loop caller — has no owner token and is open to anyone; a call with no `exec.agent` cannot access an owned task). Task ids are global and predictable, so under multi-session ACP this token check is the fence that stops one session's agent from reading or killing another session's background task. Because ownership lives on the task in the executor (disposed with the `dsh-bash` fiber), it **survives an independent `tool-bash` HMR reload** — closing the old plugin-local-map gap where a reload orphaned pre-reload tasks. (The `onTaskDone` listener is still effect-scoped to this plugin's `apply`, so a completion landing during the reload gap still drops its one notice — the pre-existing reload-gap drop — but the ownership fence itself is HMR-proof.)

## UI presentation

These tools own how their calls render in a UI (an editor's tool-call card) via the `dsh-tools` `presentCall`/`presentResult` seam, each returning a `card`-tagged render intent — a UI never special-cases tool names. A FOREGROUND `bash` run declares a **terminal card**: `presentCall` returns `{ card: 'terminal', title, description?, cwd? }` — the **title** is the exact `command` ("ls -la src"), the model-written `description` rides along (rendered ABOVE the card), and `cwd` comes from the model `workdir` when given (absolute as-is, relative for the UI bridge to resolve against the session cwd; else left for the bridge to fill from the session cwd) — and `presentResult` returns `{ card: 'terminal', title?, output?, exitCode?, signal? }` carrying the raw output plus the parsed `exitCode`/`signal`, so a capable client (Zed) renders a terminal card with an exit-status pill. The result carries the raw `output`; the bridge DERIVES the ` ```console ` fenced fallback for a no-terminal-capability UI while the tool keeps model-facing result text unfenced. A `run_in_background` call is NOT a terminal (it returns a task id immediately and never streams a terminal — poll with `bash_output`) and instead returns a **generic card** (`{ card: 'generic', title, kind: 'execute', rawInput: command, content: [description] }`); an `isError` result (spawn failure / abort) likewise returns a `generic` result view with no exit pill (there is no real process exit). `bash_output`/`bash_kill` return a `generic` card with a task-scoped title ("Read output from background task bash-3" / "Kill background task bash-3") and the task id as rawInput. These methods are pure/display-only (they also run on `session/load` replay), and a malformed/older logged arg shape falls back to a generic presentation rather than throwing. See `packages/core/tools` ("Tool-owned UI presentation") and `packages/ui/acp` ("Terminal card" / "Tool-call presentation").

## Background completion notices

When a background task finishes, a short notice is injected into the owning agent's session (`agent.inject()`, source `{kind: 'plugin', plugin: 'tool-bash'}`). The owning agent is found by its session token: the listener reads `ctx.bash.ownerOf(task.id)` and scans `ctx.get('agents')?.list()` for an agent whose `session.header.id` matches (read via `ctx.get` — `onTaskDone` runs on the bash fiber, a foreign fiber, so the `ctx.agents` proxy would throw). If no live agent carries that token — e.g. the owning session disconnected and its agent was disposed while the task ran on — the notice is dropped cleanly. Injection is **durable context for the next model request, not a wake-up** — an idle agent stays idle until something sends a message. That's why the tool descriptions tell the model to poll with `bash_output`.

## The tool builds its request from named args only

The `BashExecRequest` seam carries optional `stdin` and `env`, used by the hooks bridges to feed a hook command its JSON payload and `CLAUDE_*` env. This tool does **not** expose them as parameters: its request is built from `command`/`workdir`/`timeoutMs`/`signal`/`owner` only, so a model that includes `env` or `stdin` keys in its tool arguments has them ignored. This is not a trust boundary — a model already has equivalent power through shell syntax (`FOO=bar cmd`, a heredoc), and the real defense against leaking the harness's ambient secrets is `dsh-bash-local`'s credential scrub, which works regardless. A regression guard drives the real tool with those extra args and asserts the resulting request carries neither field — its job is to catch a future refactor that blindly spreads `...args` into the request (which would silently forward model input into the post-scrub `env` merge), not to defend a wall. See [the bash-stdin-env RFC](../../../docs/rfc/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md).

## Permissions and escalation

Commands run with the executor's full authority unless a sandboxing executor ([`dsh-bash-sandbox`](../bash-sandbox/)) confines them — the deny-only sandbox reports denials as result facts, rendered here as the denial marker; per-call allow/deny/ask policy is the `tools/pre-execute` waterfall (see docs/architecture.md).

On top of a denial sits the escalation gate ([the sandbox RFC § Escalation](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md)): an escalating call (`sandbox_permissions` + `justification`) resolves [`ctx.approval`](../../ui/user-approval/README.md) BEFORE anything executes — `allowed-once` stamps the granted mode onto the bash request as the seam-level `sandboxMode` override (that one call runs, classifies, and reports under the wider mode; its neighbors keep the session's effective mode), while `rejected`/`cancelled`/`unavailable` and the no-service / no-agent paths each fail closed with their own error text and execute nothing. The seam is consumed opportunistically (`ctx.get('approval')`, the dsh-tools ask-routing pattern); the grant is consumed by the very call that asked, and nothing is stored. The static description teaches — and a denied result itself prompts, via the escalation-available marker appended exactly when the fields are advertised — the SAME-TURN flow: on a denial a wider mode would cure, retry the exact command once with `sandbox_permissions` (the narrowest mode that suffices) + `justification` immediately, without detouring through chat (the approval prompt IS the user's consent); never speculatively — an escalation is grounded in a real denial (up-front only when the session already denied the same access), a prompt-stated approvals-disabled policy turns the exception off entirely, and a rejected escalation is final for that command.

## Per-session mode switching

Under a sandboxing executor this plugin makes the session's standing mode override ([the sandbox RFC § Per-session mode switching](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md); the `bash/sandbox-mode` fold owned by [`dsh-bash`](../bash/README.md)) real at EXECUTION: every call is stamped `escalation grant > session override > undefined` onto `BashExecRequest.sandboxMode`; without either, the executor's `resolve()` applies its configured default. Nothing is stamped under a non-sandboxing executor (nothing would honor it) or for an agent-less caller (no session to fold). The prompt deliberately does NOT state the mode and a switch is not narrated: a standing declaration teaches the model to refuse preemptively, while the denial marker already names the mode the command ran under exactly when the boundary is hit — behavior, not belief, carries the state.

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
