# @deepseek-ai/dsh-tool-bash

The model-facing bash tools — `bash`, `bash_output`, `bash_kill` — registered over the `ctx.bash` executor seam (`@deepseek-ai/dsh-bash`). Pure schema + text shaping; every process concern lives behind the seam, so sandboxed or remote executor implementations swap in without changing what the model sees.

Requires a loaded executor implementation (e.g. `@deepseek-ai/dsh-bash-local`); the plugin stays pending until `ctx.bash` exists (`inject: ['tools', 'bash']`).

## Tools

### `bash`

| Arg | Type | Notes |
|---|---|---|
| `command` | string (required) | Run via `bash -c`. No state persists between calls — use `workdir`, not `cd`. |
| `description` | string (required) | One-line, active-voice summary of the command (5-10 words), for UI/log display only — no effect on execution. |
| `timeoutMs` | number | Timeout override in milliseconds. The executor applies its configured default and cap. |
| `workdir` | string | Working directory for this call. Defaults to the calling agent's session cwd (`session.header.cwd`) so each session runs in its own workspace; a relative `workdir` is resolved against that session cwd. |
| `run_in_background` | boolean | Return a task id immediately; no timeout applies. |

`command`, `workdir`, and `timeoutMs` are resolved against the executor's config defaults via `ctx.bash.resolve()` before execution, so the executor seam (`BashExecSpec`) receives explicit `workdir`/`timeoutMs` values. The workdir default is applied in the tool layer (from the calling agent's `session.header.cwd`) BEFORE `resolve()` — the per-session cwd must come from `exec.agent`, since N sessions share one executor; only when no session cwd is available does the executor fall back to its own config / `process.cwd()`.

Result text: stdout, then a `[stderr]` section, then status markers — `[timed out after Nms]` whenever the executor's timer fired (reported independently of how the process ended, so a command that traps SIGTERM and exits 0 still shows it), `[killed by signal: …]` for a signal death, `[exit code: N]` for a non-zero exit (reported, **not** `isError`: the model decides how to react), and `[output truncated; full output: <path>]` when the tail was kept and a safe spill file is available. If the executor knows output was dropped but cannot safely advertise a complete spill file, the path is reported as `(unavailable)`. Only infrastructure failures (spawn errors, aborts) surface as `isError` results.

### `bash_output`

`task_id` → output produced **since the previous `bash_output` call** plus a status line (`running` / `completed, exit code: N` / `killed`). Reads that lost data to buffer bounds say so and point at the full-output spill file when one is safely available, otherwise `(unavailable)`.

### `bash_kill`

`task_id` → ask the executor to kill the background task. The concrete executor decides how to signal or stop the process; killing an already-finished task is a reported no-op, and unknown ids are errors.

### Task ownership (cross-session isolation)

The owning agent's session token (`session.header.id`) is stamped onto the task at spawn — passed to the executor via `resolve({ …, owner })` and stored ON THE TASK inside the executor (the `dsh-bash` `ownerOf(id)` seam), **not** in a plugin-local map. `bash_output`/`bash_kill` compare `ctx.bash.ownerOf(id)` to the caller's token (`session.header.id`) with `!== undefined` semantics and reject a task owned by a *different* session with `task <id> belongs to another session` (a task started with no agent — a non-loop caller — has no owner token and is open to anyone; a call with no `exec.agent` cannot access an owned task). Task ids are global and predictable, so under multi-session ACP this token check is the fence that stops one session's agent from reading or killing another session's background task. Because ownership lives on the task in the executor (disposed with the `dsh-bash` fiber), it **survives an independent `tool-bash` HMR reload** — closing the old plugin-local-map gap where a reload orphaned pre-reload tasks. (The `onTaskDone` listener is still effect-scoped to this plugin's `apply`, so a completion landing during the reload gap still drops its one notice — the pre-existing reload-gap drop — but the ownership fence itself is HMR-proof.)

## UI presentation

These tools own how their calls render in a UI (an editor's tool-call card) via the `dsh-tools` `presentCall`/`presentResult` seam, each returning a `card`-tagged render intent — a UI never special-cases tool names. A FOREGROUND `bash` run declares a **terminal card**: `presentCall` returns `{ card: 'terminal', title, description?, cwd? }` — the **title** is the exact `command` ("ls -la src"), the model-written `description` rides along (rendered ABOVE the card), and `cwd` comes from the model `workdir` when given (absolute as-is, relative for the UI bridge to resolve against the session cwd; else left for the bridge to fill from the session cwd) — and `presentResult` returns `{ card: 'terminal', title?, output?, exitCode?, signal? }` carrying the raw output plus the parsed `exitCode`/`signal`, so a capable client (Zed) renders a terminal card with an exit-status pill. The result carries the raw `output`; the bridge DERIVES the ` ```console ` fenced fallback for a no-terminal-capability UI (the tool no longer encodes the fences itself), so the model-facing result text stays unfenced. A `run_in_background` call is NOT a terminal (it returns a task id immediately and never streams a terminal — poll with `bash_output`) and instead returns a **generic card** (`{ card: 'generic', title, kind: 'execute', rawInput: command, content: [description] }`); an `isError` result (spawn failure / abort) likewise returns a `generic` result view with no exit pill (there is no real process exit). `bash_output`/`bash_kill` return a `generic` card with a task-scoped title ("Read output from background task bash-3" / "Kill background task bash-3") and the task id as rawInput. These methods are pure/display-only (they also run on `session/load` replay), and a malformed/older logged arg shape falls back to a generic presentation rather than throwing. See `packages/core/tools` ("Tool-owned UI presentation") and `packages/ui/acp` ("Terminal card" / "Tool-call presentation").

## Background completion notices

When a background task finishes, a short notice is injected into the owning agent's session (`agent.inject()`, source `{kind: 'plugin', plugin: 'tool-bash'}`). The owning agent is found by its session token: the listener reads `ctx.bash.ownerOf(task.id)` and scans `ctx.get('agents')?.list()` for an agent whose `session.header.id` matches (read via `ctx.get` — `onTaskDone` runs on the bash fiber, a foreign fiber, so the `ctx.agents` proxy would throw). If no live agent carries that token — e.g. the owning session disconnected and its agent was disposed while the task ran on — the notice is dropped cleanly. Injection is **durable context for the next model request, not a wake-up** — an idle agent stays idle until something sends a message. That's why the tool descriptions tell the model to poll with `bash_output`.

## Permissions

`TODO(permissions)`: commands run with the executor's full authority. The permission/sandbox seam is the `tools/execute` waterfall (veto or ask) plus sandboxing `BashExecutor` implementations — see docs/architecture.md. `@cordisjs/plugin-capability` (a named-permission service with a session `test()`) is a candidate building block for that work.
