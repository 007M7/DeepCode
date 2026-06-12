# @deepseek-ai/dsh-tool-bash

The model-facing bash tools — `bash`, `bash_output`, `bash_kill` — registered
over the `ctx.bash` executor seam (`@deepseek-ai/dsh-bash`). Pure schema +
text shaping; every process concern lives behind the seam, so sandboxed or
remote executor implementations swap in without changing what the model sees.

Requires a loaded executor implementation (e.g.
`@deepseek-ai/dsh-bash-local`); the plugin stays pending until `ctx.bash`
exists (`inject: ['tools', 'bash']`).

## Tools

### `bash`

| Arg | Type | Notes |
|---|---|---|
| `command` | string (required) | Run via `bash -c`. No state persists between calls — use `workdir`, not `cd`. |
| `description` | string (required) | One-line, active-voice summary of the command (5-10 words), for UI/log display only — no effect on execution. |
| `timeoutMs` | number | Default/max from executor config (120s/600s for bash-local). |
| `workdir` | string | Working directory for this call. |
| `run_in_background` | boolean | Return a task id immediately; no timeout applies. |

`command`, `workdir`, and `timeoutMs` are resolved against the executor's
config defaults via `ctx.bash.resolve()` before execution, so the executor
seam (`BashExecSpec`) receives explicit `workdir`/`timeoutMs` values.

Result text: stdout, then a `[stderr]` section, then status markers —
`[timed out after Nms]` whenever the executor's timer fired (reported
independently of how the process ended, so a command that traps SIGTERM and
exits 0 still shows it), `[killed by signal: …]` for a signal death,
`[exit code: N]` for a non-zero exit (reported, **not** `isError`: the model
decides how to react), and `[output truncated; full output: <path>]` when the
tail was kept. Only infrastructure failures (spawn errors, aborts) surface as
`isError` results.

### `bash_output`

`task_id` → output produced **since the previous `bash_output` call** plus a
status line (`running` / `completed, exit code: N` / `killed`). Reads that
lost data to buffer bounds say so and point at the full-output spill file.

### `bash_kill`

`task_id` → SIGTERM→SIGKILL on the task's process group. Killing an
already-finished task is a reported no-op; unknown ids are errors.

## Background completion notices

When a background task finishes, a short notice is injected into the owning
agent's session (`agent.inject()`, source `{kind: 'plugin', plugin:
'tool-bash'}`). Injection is **durable context for the next model request,
not a wake-up** — an idle agent stays idle until something sends a message.
That's why the tool descriptions tell the model to poll with `bash_output`.

## Permissions

`TODO(permissions)`: commands run with the executor's full authority. The
permission/sandbox seam is the `tools/execute` waterfall (veto or ask) plus
sandboxing `BashExecutor` implementations — see docs/architecture.md.
`@cordisjs/plugin-capability` (a named-permission service with a session
`test()`) is a candidate building block for that work.
