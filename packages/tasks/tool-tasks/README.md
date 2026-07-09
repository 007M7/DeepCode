# @deepseek-ai/dsh-tool-tasks

The model-facing background task control surface over `ctx.tasks`: three kind-agnostic tools, the completion-notice injection, and the prompt section that teaches the background habit. Loading this plugin calls `ctx.tasks.attachSurface('tool-tasks')`, which is what arms producers' `ctx.tasks.start()`.

## Tools

- `task_output(task_id, wait?, timeout_ms?)` — non-blocking read by default (stream kinds: the consuming delta since the previous read; final kinds: the final answer once terminal); every response ends with a `[status: …]` line (generic status + producer detail, e.g. `[status: completed, exit code: 0]`). `wait: true` blocks until settlement, bounded by `waitTimeoutMs`/`maxWaitTimeoutMs` config; a timed-out wait returns `[status: running]` and leaves the task alive.
- `task_list()` — the caller's tasks, `<id> [<kind>] <status> — <label>` per line.
- `task_kill(task_id, reason?)` — requests cancellation and returns immediately; the logged `reason` is forwarded to the producer. An already-terminal task is described via a non-consuming snapshot (never eats a pending delta).

ACP render intent: all three are `generic` cards (`read`/`read`/`execute`) — a task read is not a terminal.

## Completion notices

On `onTaskDone`, injects `background task <id> (<kind>: <label>) finished [status: …]. Read its output with task_output.` into the owning agent's session (`agent.inject()` — durable context for the next request, not a wake-up). Suppressed when the snapshot is `reported` (the model already killed it, or a read/wait returned the end) — never a redundant "finished". The disposed-owner race is contained; a missing agent registry drops the notice.

## Config

| key | default | meaning |
|---|---|---|
| `waitTimeoutMs` | `30000` | wait duration when `task_output` sets `wait` without `timeout_ms` |
| `maxWaitTimeoutMs` | `600000` | hard cap; larger model-supplied `timeout_ms` values are clamped |

A config whose default exceeds the cap fails loud at load.
