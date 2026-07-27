# tasks/ — background task capability family

English | [中文](README.zh.md)

The shared home for background-task ids, owner isolation, reads, cancellation, waiting, and completion notices. Bash, subagents, and future long-running tools use one model-facing protocol. See the [background-task runtime Agent Note](../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md) and the [task-registry seam Agent Note](../../.agents/notes/implemented/architecture/2026-07-26-task-registry-seam.md).

| Package | ctx key | Role |
|---|---|---|
| [`tasks`](tasks/README.md) (`@deepseek-ai/dsh-tasks`) | `ctx.tasks` | The registry seam: branded `<kind>-N` ids, the owner-fenced read/kill/wait/list contract, snapshot vocabulary, the `attachSurface` misconfiguration fence, and the snapshot invariant companion |
| [`tasks-local`](tasks-local/README.md) (`@deepseek-ai/dsh-tasks-local`) | — | The process-local registry implementation: in-memory records, first-wins settlement bookkeeping, and the awaited owner-cleanup and teardown paths |
| [`tool-tasks`](tool-tasks/README.md) (`@deepseek-ai/dsh-tool-tasks`) | — | The model-facing control surface: `task_output`, `task_list`, `task_kill`, the completion-notice injection, and the background-habit prompt section |

The registry owns state across producer or surface reloads; the tool package owns presentation. Producers register execution hooks through `ctx.tasks.start` and own whether their config exposes `run_in_background`.
