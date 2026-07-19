# @deepseek-ai/dsh-tool-tasks

The model-facing control surface for `ctx.tasks`: three kind-independent tools, completion notices, and one background-work prompt section. Loading the plugin attaches the surface required by `ctx.tasks.start()`.

## Tools

- `task_output(task_id, wait?, timeout_ms?)` reads without blocking by default. Stream tasks return only the next delta; final-output tasks return their result after settlement. Every response ends with `[status: ...]`. `wait: true` waits up to the configured cap and leaves a still-running task alive on timeout.
- `task_list()` returns caller-visible tasks as `<id> [<kind>] <status> — <label>`.
- `task_kill(task_id, reason?)` requests cancellation immediately and forwards the logged reason. Terminal tasks return a non-consuming snapshot.

All three use generic ACP cards: `read` for output and list, `execute` for kill.

## Completion notices

An unreported completion injects `background task <id> (<kind>: <label>) finished [status: ...]. Read its output with task_output.` into the exact owner's session. Injection is durable context for the next request, not a wake-up. A kill or terminal read/wait marks delivery reported and suppresses the redundant notice; owner-disposal races are contained.

## Config

| key | default | meaning |
|---|---|---|
| `waitTimeoutMs` | `30000` | wait used when `wait: true` omits `timeout_ms` |
| `maxWaitTimeoutMs` | `600000` | cap for model-supplied waits |

A default above the cap fails at load.

## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope contains this guidance. Agent-scoped tool filtering may hide the tools without removing the independently registered prompt section.

##### Background-task guidance

```markdown
Track every background task id you start. You are notified in-session when a task finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running task's work. Before giving a final answer, collect every still-relevant task with task_output (set wait: true only when you are genuinely blocked on it), and task_kill tasks that stopped mattering.
```

#### Token effect

Small fixed input cost per request while active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged. Activation or disposal may invalidate reuse from this prompt section.

### Tool schemas

#### What the model sees

The generated [`task_output`, `task_list`, and `task_kill` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-tasks) while this surface is visible.

#### Token effect

Fixed schema cost on each request where the tools are visible.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged. Registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### Results and notices

#### What the model sees

Reads return output or `(no new output)` followed by `[status: <status>]` and optional detail. An empty list returns `(no background tasks)`. Kill returns `requested cancellation of task <id>` or the existing terminal status. Unreported owned completion uses the notice above.

#### Token effect

Results and notices remain in parent history until compaction. Stream reads do not repeat consumed output.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Completion notices do not wake idle agents** — callers needing an immediate result must use `task_output`.
- **Stream reads are single-consumer** — independent observers need another runtime API.
- **Unowned tasks have no session fence** — external surfaces must supply caller policy or avoid them.
