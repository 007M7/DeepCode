# @deepseek-ai/dsh-tasks

The background task registry (`ctx.tasks`): a runtime-global, CONCRETE service (no interface/implementation split — one sensible in-process implementation exists; a durable job backend would own that extraction) that gives every long-running tool the same ids, isolation, and lifecycle.

## Service API

- `start(spec): TaskId` — declare-then-execute: the producer hands identity (`kind` — also the id prefix — `label`, optional `owner: Agent`) plus `run()`, the starter that returns the work's `TaskHooks` (`cancel(reason?)`, `done: Promise<TaskOutcome>` settling at QUIESCENCE and never rejecting, optional `readOutput()` for stream kinds; absence = final-output-only). Every check that can fail — the control-surface fence (the loud guard against a deployment exposing `run_in_background` with no way to collect or stop the work), validation, the owner-cleanup attach — runs BEFORE `run()` starts the actual work, and nothing can fail after it returns: work started without a collectable id is structurally impossible, not a producer rollback obligation.
- `get(id, caller?)` / `list(caller?)` — non-consuming snapshots; `list` returns only caller-owned plus unowned tasks (a global listing would leak foreign labels).
- `read(id, caller?): TaskRead` — stream kinds consume the per-task cursor (v1's single intended reader is the owning model — a non-consuming multi-reader surface would be a cursor/snapshot API extension, not a `read` change); final kinds read the terminal output idempotently.
- `kill(id, caller?, reason?)` — `'requested'` (live task: producer `cancel` runs first — a throw fails the kill loud and leaves the task untouched — then `stopping`) or `'already-terminal'`. Every successful kill marks the task `reported` (the killer saw the end → completion notice suppressed).
- `wait(id, timeoutMs, caller?, signal?)` — resolves with the terminal snapshot (marked `reported`), or the live snapshot at timeout; an aborted signal rejects the WAIT only — unless the task already settled, in which case the wait still resolves and delivers the terminal snapshot (settlement suppressed the completion notice on this waiter's behalf, so rejecting would leave the finish both unreported and un-noticed). Timing is a [`dsh-timeout`](../../util/timeout/README.md) `deadline()` scoped to the `TASK_WAIT_TIMEOUT` code, so a nested foreign deadline never misreads as a wait timeout.
- `onTaskDone(listener)` — exactly once per terminal task record; effect-scoped, per-listener containment, silent after service disposal.
- `attachSurface(name)` — declares a control surface exists (the model tools, or a deployment's custom surface); effect-scoped.

Every read/kill/wait/get compares the task's owner session (`owner.session.header.id`) with the caller's and rejects a foreign one — ids are predictable (`bash-1`), so the fence, not id secrecy, is the isolation boundary.

## Lifecycle

- Registrations are NOT effect-scoped to the registering fiber: tasks belong to their owning agent + producing backend, so producer/surface HMR reloads never touch them.
- An owned task attaches (once per owner) an awaited cleanup via `ctx.agents.onCleanup`: on owner disposal the registry cancels live tasks, awaits contract-compliant producers to quiescence, and drops their snapshots. If a teardown cancel throws, it force-fails the record and logs that the underlying work may be orphaned rather than deadlocking `AgentHandle.dispose()`.
- Service disposal closes the listener registry first (late teardown settlements stay silent), then applies the same cancellation rule to every live task and awaits terminal records.
- A producer whose `cancel` returns but never causes `done` to settle remains indistinguishable from a slow stop and can stall teardown; solving that residual requires an explicit bounded-lifetime or forced-disposal design.

## Non-goals (v1)

Durable/cross-restart tasks, non-consuming observation cursors, and foreground→background promotion are deliberate deferrals — see the [runtime RFC](../../../docs/rfc/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md) § Alternatives.
