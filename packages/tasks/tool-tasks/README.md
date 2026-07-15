# @deepseek-ai/dsh-tool-tasks

The model-facing background task control surface over `ctx.tasks`: three kind-agnostic tools, the completion-notice injection, and the prompt section that teaches the background habit. Loading this plugin calls `ctx.tasks.attachSurface('tool-tasks')`, which is what arms producers' `ctx.tasks.start()`.

## Tools

- `task_output(task_id, wait?, timeout_ms?)` — non-blocking read by default (stream kinds: the consuming delta since the previous read; final kinds: the final answer once terminal); every response ends with a `[status: …]` line (generic status + producer detail, e.g. `[status: completed, exit code: 0]`). `wait: true` blocks until settlement, bounded by `waitTimeoutMs`/`maxWaitTimeoutMs` config; a timed-out wait returns `[status: running]` and leaves the task alive.
- `task_list()` — the caller's tasks, `<id> [<kind>] <status> — <label>` per line.
- `task_kill(task_id, reason?)` — requests cancellation and returns immediately; the logged `reason` is forwarded to the producer. An already-terminal task is described via a non-consuming snapshot (never eats a pending delta).

ACP render intent: all three are `generic` cards (`read`/`read`/`execute`) — a task read is not a terminal.

## Completion notices

On `onTaskDone`, injects `background task <id> (<kind>: <label>) finished [status: …]. Read its output with task_output.` through the exact owner `Agent` captured at task start (`agent.inject()` — durable context for the next request, not a wake-up). It never re-resolves a reusable agent/session id to a replacement. Suppressed when the snapshot is `reported` (the model already killed it, or a read/wait returned the end) — never a redundant "finished"; the disposed-owner race is contained.

## Config

| key | default | meaning |
|---|---|---|
| `waitTimeoutMs` | `30000` | wait duration when `task_output` sets `wait` without `timeout_ms` |
| `maxWaitTimeoutMs` | `600000` | hard cap; larger model-supplied `timeout_ms` values are clamped |

A config whose default exceeds the cap fails loud at load.

## Model Experience

### System prompt

**What the model sees**: Every request in this plugin's registration scope contains the background-task guidance below. Agent-scoped tool filtering can hide the control schemas without removing this independently registered section.

**Token effect**: Small fixed input cost per request while the plugin is active.

#### Background-task guidance

```markdown
Track every background task id you start. You are notified in-session when a task finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running task's work. Before giving a final answer, collect every still-relevant task with task_output (set wait: true only when you are genuinely blocked on it), and task_kill tasks that stopped mattering.
```

### Tool schemas

**What the model sees**: The model sees the generated [`task_output`, `task_list`, and `task_kill` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-tasks) while this control surface is visible.

**Token effect**: Fixed schema cost on each request where the tools are visible.

### Task results and notices

**What the model sees**: Reads return a producer-owned output delta or `(no new output)`, followed by `[status: <status>]` with optional producer detail. Listing returns `(no background tasks)` or one `<id> [<kind>] <status> — <label>` line per visible task. Kill returns `requested cancellation of task <id>` or `task <id> had already finished [status: ...]`. An unreported owned completion injects exactly `background task <id> (<kind>: <label>) finished [status: ...]. Read its output with task_output.`

**Token effect**: Results and completion notices are retained in the parent session until compaction; stream reads consume their cursor and do not repeat prior output.

## Known Limitations and Deferred Work

- **Completion notices do not wake idle agents** — they become durable context for the next request; callers needing an immediate result must use `task_output`.
- **Stream reads are single-consumer** — this control surface exposes the task runtime's one consuming cursor rather than independent observers.
- **Unowned tasks have no session fence** — deployments exposing background starts outside an agent must provide their own caller policy or avoid ownerless tasks.
