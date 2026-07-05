# workflow/ — dynamic-workflow capability family

The workflow seam: a model-written JavaScript orchestration script that fans out subagents at scale (phases, structured per-agent results, concurrency caps), modeled on Claude Code's dynamic workflows. A capability seam (see [capability seams](../../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md)) in the bash shape: ONE engine implementation per context registers as `ctx.workflows`; the model-facing tool consumes it.

| Package | Role | ctx key |
|---|---|---|
| `workflow/` | Abstract workflow seam: service base class + run vocabulary + `workflow/*` events | `ctx.workflows` |
| `workflow-vm/` | In-process `node:vm` engine: parses the script, injects the hooks, drives `ctx.subagents` | (provides `ctx.workflows`) |
| `tool-workflow/` | Model-facing `workflow` tool over `ctx.workflows` | (registers on `ctx.tools`) |

The interface lives at `workflow/workflow/`. The engine's `agent()` hook rides the [subagent seam](../subagent/README.md) (any registered provider; the shipped examples use `spawn`), and `agent({ schema })` rides the structured-output support the in-process backends implement. The seam split exists for engine hardening: `node:vm` is in-process and cannot kill a pathological synchronous spin — a worker-thread or isolated-vm engine swaps in behind the same interface if that ever matters.

The proposal, decisions, and deferred work: [docs/rfc/implemented/feature/2026-07-05-dynamic-workflows.md](../../docs/rfc/implemented/feature/2026-07-05-dynamic-workflows.md).
