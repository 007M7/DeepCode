# compact/ — compaction capability family

A three-package capability seam (see [capability seams](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)): an abstract compaction interface, a backend that summarizes, and the model-facing tool that consumes it. The interface and a first backend (`compact-basic/`) exist; the consumer tool is deferred. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `compact/` | Abstract compaction seam (interface + `compact/*` events + `CompactionResult`) | `ctx.compact` |
| `compact-basic/` | A backend: `ctx.tokenMeter` pressure + token-budget retention + `llm.stream()` summarization | (registers `ctx.compact`) |
| `tool-compact/` (deferred) | Model-facing `/compact` tool over `ctx.compact` | (registers on `ctx.tools`) |

The interface lives at `compact/compact/`, the backend at `compact/compact-basic/`. Unlike the bash seam, it depends on `dsh-session` and `dsh-llm` — its verbs are defined over a `Session` and its output is the `ContentBlock` vocabulary, so the contract cannot be expressed without naming them. That deviation from the "interface depends only on cordis" guidance is intentional and recorded in the [compaction capability-seam Agent Note](../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md). Token measurement is a reusable LLM-family service rather than a `CompactService` method; a template- or model-backed compactor can replace `compact-basic` without changing the meter or callers.
