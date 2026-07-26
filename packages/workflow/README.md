# workflow/ — dynamic-workflow capability family

English | [中文](README.zh.md)

The workflow seam: a model-written JavaScript orchestration script that fans out subagents at scale (phases, structured per-agent results, concurrency caps), modeled on Claude Code's dynamic workflows. A capability seam (see [capability seams](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)) in the bash shape: ONE engine implementation per context registers as `ctx.workflows`; the model-facing tool consumes it.

| Package | Role | ctx key |
|---|---|---|
| `workflow/` | Abstract workflow seam: service base class + run vocabulary + `workflow/*` events | `ctx.workflows` |
| `workflow-workerthread/` | `node:worker_threads` engine: one worker per run; the script's vm context lives inside the worker, `agent()` bridges to `ctx.subagents` over the message port | (provides `ctx.workflows`) |
| `tool-workflow/` | Model-facing `workflow` tool over `ctx.workflows` | (registers on `ctx.tools`) |
| `tool-ralph/` | Fixed fresh-agent Ralph policy over `ctx.workflows` and a fresh structured-output subagent provider | (registers on `ctx.tools`) |

The interface lives at `workflow/workflow/`. The engine's `agent()` hook rides the [subagent seam](../subagent/README.md) (any registered provider; the shipped examples use `spawn`), and `agent({ schema })` rides the structured-output support the in-process backends implement. The worker thread isolates the SCRIPT — the host never blocks on it, and a cancelled run's post-grace termination is real — but it is NOT a security boundary; an isolated-vm/separate-process engine (actual sandboxing) swaps in behind the same interface if that ever matters.

The general script engine's decisions and deferred work live in the [dynamic-workflows Agent Note](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md). The separate [Ralph consumer](../../.agents/notes/implemented/feature/2026-07-19-fresh-agent-ralph-workflow-tool.md) fixes the script and fresh-provider policy rather than adding another engine or an agent-loop mode.
