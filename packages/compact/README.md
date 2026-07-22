# compact/ — compaction capability family

A compaction capability family (see [capability seams](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)): an abstract interface, a summarizing backend, a model-free tool-result pruning companion, and a deferred model-facing consumer. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `compact/` | Abstract compaction seam (interface + `compact/*` events + `CompactionResult`) | `ctx.compact` |
| `compact-basic/` | A backend: `ctx.tokenMeter` pressure + token-budget retention + `llm.stream()` summarization | (registers `ctx.compact`) |
| `compact-tool-result-prune/` | Optional model-free head/middle/tail rewriting before summary compaction | `ctx.toolResultPrune` |
| `tool-compact/` (deferred) | Model-facing `/compact` tool over `ctx.compact` | (registers on `ctx.tools`) |

The interface lives at `compact/compact/`, the backend at `compact/compact-basic/`, and deterministic pruning at `compact/compact-tool-result-prune/`. Unlike the bash seam, the interface depends on `dsh-session` and `dsh-llm` because its verbs are defined over a `Session` and its output uses `ContentBlock`. That deviation is recorded in the [compaction capability-seam Agent Note](../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md). Token measurement remains a reusable LLM-family service; a template- or model-backed compactor can replace `compact-basic` without changing the meter, pruner, or callers.
