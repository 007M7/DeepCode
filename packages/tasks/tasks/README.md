# @deepseek-ai/dsh-tasks

The background task registry (`ctx.tasks`): a runtime-global, CONCRETE service (no interface/implementation split — one sensible in-process implementation exists; a durable job backend would own that extraction) that gives every long-running tool the same ids, isolation, and lifecycle.

## Service API

- `register(registration): TaskId` — a producer hands over running work: `kind` (also the id prefix), `label`, optional `owner: Agent`, `cancel(reason?)`, `done: Promise<TaskOutcome>` (settles at QUIESCENCE, never rejects), optional `readOutput()` (stream kinds; absence = final-output-only). Throws while no control surface is attached — the loud fence against a deployment exposing `run_in_background` with no way to collect or stop the work — and is ATOMIC: a failed registration mutates nothing (no stored task, no counter bump, no owner-cleanup bookkeeping), so producers can reliably cancel their just-started work and rethrow.
- `get(id, caller?)` / `list(caller?)` — non-consuming snapshots; `list` returns only caller-owned plus unowned tasks (a global listing would leak foreign labels).
- `read(id, caller?): TaskRead` — stream kinds consume the per-task cursor (v1's single intended reader is the owning model — a non-consuming multi-reader surface would be a cursor/snapshot API extension, not a `read` change); final kinds read the terminal output idempotently.
- `kill(id, caller?, reason?)` — `'requested'` (live task: producer `cancel` runs first — a throw fails the kill loud and leaves the task untouched — then `stopping`) or `'already-terminal'`. Every successful kill marks the task `reported` (the killer saw the end → completion notice suppressed).
- `wait(id, timeoutMs, caller?, signal?)` — resolves with the terminal snapshot (marked `reported`), or the live snapshot at timeout; an aborted signal rejects the WAIT only.
- `onTaskDone(listener)` — exactly once per task with the terminal snapshot; effect-scoped, per-listener containment, silent after service disposal.
- `attachSurface(name)` — declares a control surface exists (the model tools, or a deployment's custom surface); effect-scoped.

Every read/kill/wait/get compares the task's owner session (`owner.session.header.id`) with the caller's and rejects a foreign one — ids are predictable (`bash-1`), so the fence, not id secrecy, is the isolation boundary.

## Lifecycle

- Registrations are NOT effect-scoped to the registering fiber: tasks belong to their owning agent + producing backend, so producer/surface HMR reloads never touch them.
- An owned task attaches (once per owner) an awaited cleanup via `ctx.agents.onCleanup`: on the owner's disposal the registry cancels its live tasks, awaits each `done`, and drops the snapshots — `AgentHandle.dispose()` resolves only after quiescence.
- Service disposal closes the listener registry first (late teardown kills stay silent), cancels every live task with containment, and awaits settlement.

## Non-goals (v1)

Durable/cross-restart tasks, non-consuming observation cursors, and foreground→background promotion are deliberate deferrals — see the [runtime RFC](../../../docs/rfc/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md) § Alternatives.
