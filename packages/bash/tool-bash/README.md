# @deepseek-ai/dsh-tool-bash

The model-facing `bash` tool, registered over the `ctx.bash` executor seam (`@deepseek-ai/dsh-bash`). Pure schema + text shaping; every process concern lives behind the seam, so sandboxed or remote executor implementations swap in without changing what the model sees. Background runs are generic tasks: the tool registers the started process with `ctx.tasks` (`@deepseek-ai/dsh-tasks`), and the model collects/stops them through the shared `task_output`/`task_list`/`task_kill` tools (`@deepseek-ai/dsh-tool-tasks`) — this package registers no companion tools of its own.

Requires a loaded executor implementation (e.g. `@deepseek-ai/dsh-bash-local`); the plugin stays pending until `ctx.bash` exists (`inject: ['tools', 'bash', 'systemPrompt']`). The `ctx.tasks` runtime is looked up at call time: a background call without it fails loud (`background tasks unavailable: load @deepseek-ai/dsh-tasks and @deepseek-ai/dsh-tool-tasks`).

The plugin also contributes the `tool:bash` prompt section (order 105) — the cross-call habit the per-tool descriptions cannot carry: check the `[exit code: N]` marker on every result and investigate failures before moving on.

## Config

| key | default | meaning |
|---|---|---|
| `enableRunInBackground` | `true` | Expose `run_in_background` in the schema. Disabled, the parameter is absent entirely (schema and capability never disagree), the description says background execution is unavailable, and a caller that forces the key anyway is refused at execution time (the arg validator allows undeclared keys, so the schema omission alone is not enforcement). |

## The `bash` tool

| Arg | Type | Notes |
|---|---|---|
| `command` | string (required) | Run via `bash -c`. No state persists between calls — use `workdir`, not `cd`. |
| `description` | string (required) | One-line, active-voice summary of the command (5-10 words), for UI/log display only — no effect on execution. |
| `timeoutMs` | number | Timeout override in milliseconds. The executor applies its configured default and cap. |
| `workdir` | string | Working directory for this call. Defaults to the calling agent's session cwd (`session.header.cwd`) so each session runs in its own workspace; a relative `workdir` is resolved against that session cwd. |
| `run_in_background` | boolean | Return a task id immediately; no timeout applies. Present only when `enableRunInBackground` allows. |

`command`, `workdir`, and `timeoutMs` are resolved against the executor's config defaults via `ctx.bash.resolve()` before execution, so the executor seam (`BashExecSpec`) receives explicit `workdir`/`timeoutMs` values. The workdir default is applied in the tool layer (from the calling agent's `session.header.cwd`) BEFORE `resolve()` — the per-session cwd must come from `exec.agent`, since N sessions share one executor; only when no session cwd is available does the executor fall back to its own config / `process.cwd()`.

Foreground result text: stdout, then a `[stderr]` section, then status markers — `[timed out after Nms]` whenever the executor's timer fired (reported independently of how the process ended, so a command that traps SIGTERM and exits 0 still shows it), `[killed by signal: …]` for a signal death, `[exit code: N]` for a non-zero exit (reported, **not** `isError`: the model decides how to react), and `[output truncated; full output: <path>]` when the tail was kept and a safe spill file is available. If the executor knows output was dropped but cannot safely advertise a complete spill file, the path is reported as `(unavailable)`. Only infrastructure failures (spawn errors, aborts) surface as `isError` results.

## Background runs as tasks

A `run_in_background` call refuses an already-aborted `exec.signal`, starts the process through the seam, registers `{ kind: 'bash', label: command, owner: exec.agent, cancel, done, readOutput }` with `ctx.tasks`, and returns `started background task <id>`. The tool-call signal is deliberately NOT wired to the process after that — the parent step may end while the command runs; cancellation belongs to `task_kill` and the runtime's owner-disposal cleanup. The producer mapping is exported for tests: `processOutcome` (a killed process → `killed` with the signal as detail; everything else → `completed` with `exit code: N` — a nonzero exit is reported, not failed) and `renderProcessRead` (the incremental delta, plus a `[some output was dropped from memory; full output: …]` notice with spill paths on lossy reads). Ownership, isolation, listing, polling, waiting, kill semantics, and completion notices are all the task runtime's — see [`packages/tasks`](../../tasks/README.md).

## UI presentation

These tools own how their calls render in a UI (an editor's tool-call card) via the `dsh-tools` `presentCall`/`presentResult` seam, each returning a `card`-tagged render intent — a UI never special-cases tool names. A FOREGROUND `bash` run declares a **terminal card**: `presentCall` returns `{ card: 'terminal', title, description?, cwd? }` — the **title** is the exact `command` ("ls -la src"), the model-written `description` rides along (rendered ABOVE the card), and `cwd` comes from the model `workdir` when given (absolute as-is, relative for the UI bridge to resolve against the session cwd; else left for the bridge to fill from the session cwd) — and `presentResult` returns `{ card: 'terminal', title?, output?, exitCode?, signal? }` carrying the raw output plus the parsed `exitCode`/`signal`, so a capable client (Zed) renders a terminal card with an exit-status pill. The result carries the raw `output`; the bridge DERIVES the ` ```console ` fenced fallback for a no-terminal-capability UI (the tool no longer encodes the fences itself), so the model-facing result text stays unfenced. A `run_in_background` call is NOT a terminal (it returns a task id immediately and never streams a terminal — its output is read via `task_output`) and instead returns a **generic card** (`{ card: 'generic', title, kind: 'execute', rawInput: command, content: [description] }`); an `isError` result (spawn failure / abort) likewise returns a `generic` result view with no exit pill (there is no real process exit). These methods are pure/display-only (they also run on `session/load` replay), and a malformed/older logged arg shape falls back to a generic presentation rather than throwing. See `packages/core/tools` ("Tool-owned UI presentation") and `packages/ui/acp` ("Terminal card" / "Tool-call presentation").

## The tool builds its request from named args only

The `BashExecRequest` seam carries optional `stdin` and `env`, used by the hooks bridges to feed a hook command its JSON payload and `CLAUDE_*` env. This tool does **not** expose them as parameters: its request is built from `command`/`workdir`/`timeoutMs`/`signal` only, so a model that includes `env` or `stdin` keys in its tool arguments has them ignored. This is not a trust boundary — a model already has equivalent power through shell syntax (`FOO=bar cmd`, a heredoc), and the real defense against leaking the harness's ambient secrets is `dsh-bash-local`'s credential scrub, which works regardless. A regression guard drives the real tool with those extra args and asserts the resulting request carries neither field — its job is to catch a future refactor that blindly spreads `...args` into the request (which would silently forward model input into the post-scrub `env` merge), not to defend a wall. See [the bash-stdin-env RFC](../../../docs/rfc/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md).

## Permissions

`TODO(permissions)`: commands run with the executor's full authority. The permission/sandbox seam is the `tools/pre-execute` waterfall (deny or ask) plus sandboxing `BashExecutor` implementations — see docs/architecture.md. `@cordisjs/plugin-capability` (a named-permission service with a session `test()`) is a candidate building block for that work.
