# tasks/ — background task capability family

The shared background-task runtime: ONE home for task ids, owner isolation, polling, cancellation, wait, and completion notification, so bash, subagents, and every future long-running tool expose the same model-facing habit instead of cloning a private task protocol each. Rationale and the full design: [the background-task-runtime RFC](../../docs/rfc/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md).

| Package | ctx key | Role |
|---|---|---|
| [`tasks`](tasks/README.md) (`@deepseek-ai/dsh-tasks`) | `ctx.tasks` | The registry service: branded `<kind>-N` ids, owner-fenced read/kill/wait/list, settlement bookkeeping, the awaited owner-cleanup path, and the `attachSurface` misconfiguration fence |
| [`tool-tasks`](tool-tasks/README.md) (`@deepseek-ai/dsh-tool-tasks`) | — | The model-facing control surface: `task_output`, `task_list`, `task_kill`, the completion-notice injection, and the background-habit prompt section |

The split is the state/surface boundary: the registry holds task state (an HMR reload of any tool plugin never orphans or kills a running task), while the tool surface is stateless presentation. Producers (`dsh-tool-bash`, `dsh-tool-subagent`) hand their work to `ctx.tasks.start` (preflight, then the producer's starter, then an atomic commit) and keep their own execution concerns; whether a producer exposes `run_in_background` is that producer's own `enableRunInBackground` config, never rewritten by this family.
