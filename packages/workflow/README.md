# workflow/ — dynamic-workflow capability family

The workflow seam: a model-written JavaScript orchestration script that fans out subagents at scale (phases, structured per-agent results, concurrency caps), modeled on Claude Code's dynamic workflows. A capability seam (see [capability seams](../../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md)) in the bash shape: ONE engine implementation per context registers as `ctx.workflows`; the model-facing tool consumes it.

| Package | Role | ctx key |
|---|---|---|
| `workflow/` | Abstract workflow seam: service base class + run vocabulary + `workflow/*` events | `ctx.workflows` |
| `workflow-workerthread/` | `node:worker_threads` engine: one worker per run; the script's vm context lives inside the worker, `agent()` bridges to `ctx.subagents` over the message port | (provides `ctx.workflows`) |
| `tool-workflow/` | Model-facing `workflow` tool over `ctx.workflows` | (registers on `ctx.tools`) |

The interface lives at `workflow/workflow/`. The engine's `agent()` hook rides the [subagent seam](../subagent/README.md) (any registered provider; the shipped examples use `spawn`), and `agent({ schema })` rides the structured-output support the in-process backends implement. The worker thread isolates the SCRIPT — the host never blocks on it, and a cancelled run's post-grace termination is real — but it is NOT a security boundary; an isolated-vm/separate-process engine (actual sandboxing) swaps in behind the same interface if that ever matters.

The proposal, decisions, and deferred work: [docs/rfc/implemented/feature/2026-07-05-dynamic-workflows.md](../../docs/rfc/implemented/feature/2026-07-05-dynamic-workflows.md).
