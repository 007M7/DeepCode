# @deepseek-ai/dsh-tasks

The process-local background task registry (`ctx.tasks`). It gives long-running producers shared ids, owner isolation, reads, cancellation, waiting, notices, and cleanup. Producer plugins extend `TaskKindMap` with their opaque id namespace.

## Service API

- `start(spec): TaskId` validates the control surface, spec, and exact live owner before calling the producer's `run()` once. A starter throw leaves nothing registered; successful return commits without another failable step.
- `get(id, caller?)` and `list(caller?)` return non-consuming snapshots. Listing includes only caller-owned and unowned tasks.
- `read(id, caller?)` consumes the single cursor for stream tasks and reads terminal output idempotently for final-output tasks.
- `kill(id, caller?, reason?)` invokes producer cancellation before changing status. A cancellation throw leaves the task running; success changes it to `stopping` and marks terminal delivery reported.
- `wait(id, timeoutMs, caller?, signal?)` returns a terminal snapshot or the live snapshot at timeout. Aborting stops only the wait; settlement wins once it has committed terminal delivery to that waiter.
- `onTaskDone(listener)` observes each terminal record with the exact owner. Listener throws and rejections are contained; listener work is not awaited.
- `attachSurface(name)` declares a control surface for its effect lifetime. `start()` fails before producer execution when none is attached.

Owned access compares the task's `SessionId` with the caller's. Ids such as `bash-1` are predictable, so this fence is the boundary. Unowned tasks are open to callers and last until service disposal.

## Lifecycle

Tasks belong to their owner and backend, not the producer tool fiber, so producer and surface reloads do not stop them. The first task for an owner attaches one awaited effect to the exact `Agent` scope. Owner disposal cancels that object's tasks, awaits producer quiescence, and removes their snapshots; reused agent or session ids cannot redirect an old cleanup.

Service disposal closes listeners, cancels all live tasks, awaits their records, and detaches effects from surviving owner scopes. If teardown cancellation throws, the service force-fails the record and warns that work may be orphaned instead of deadlocking. A cancellation that returns but never settles `done` remains indistinguishable from a slow stop and can stall teardown.

See the [task type catalog](../../../docs/core-data-structures/tasks.md) and [runtime Agent Note](../../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md).

## Model Experience

Indirectly, through producer plugins and [`dsh-tool-tasks`](../tool-tasks/README.md), which render task ids, output, status, cancellation, and completion notices.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Tasks are process-local** — durable or cross-restart execution needs a separate lifecycle.
- **The service and implementation are not split** — a second backend must define the lifecycle that shapes that boundary.
- **Stream output has one consuming cursor** — independent observers need a cursor or snapshot API.
- **Foreground work cannot be promoted** — producers choose foreground or background before starting.
- **A silently ineffective cancel can stall teardown** — only an explicit throw can be force-failed safely.
