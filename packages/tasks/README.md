# tasks/ — background task capability family

The shared home for background-task ids, owner isolation, reads, cancellation, waiting, and completion notices. Bash, subagents, and future long-running tools use one model-facing protocol. See the [background-task runtime Agent Note](../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md).

| Package | ctx key | Role |
|---|---|---|
| [`tasks`](tasks/README.md) (`@deepseek-ai/dsh-tasks`) | `ctx.tasks` | The registry service: branded `<kind>-N` ids, owner-fenced read/kill/wait/list, settlement bookkeeping, the awaited owner-cleanup path, and the `attachSurface` misconfiguration fence |
| [`tool-tasks`](tool-tasks/README.md) (`@deepseek-ai/dsh-tool-tasks`) | — | The model-facing control surface: `task_output`, `task_list`, `task_kill`, the completion-notice injection, and the background-habit prompt section |

The registry owns state across producer or surface reloads; the tool package owns presentation. Producers register execution hooks through `ctx.tasks.start` and own whether their config exposes `run_in_background`.
