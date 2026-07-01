# compact/ — compaction capability family

A three-package capability seam (see [capability seams](../../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md)): an abstract compaction interface, a backend that summarizes, and the model-facing tool that consumes it. The interface and a first backend (`compact-basic/`) exist; the consumer tool is deferred. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `compact/` | Abstract compaction seam (interface + `compact/*` events + `CompactionResult`) | `ctx.compact` |
| `compact-basic/` | A backend: char/4 estimation + token-budget retention + `llm.stream()` summarization | (registers `ctx.compact`) |
| `tool-compact/` (deferred) | Model-facing `/compact` tool over `ctx.compact` | (registers on `ctx.tools`) |

The interface lives at `compact/compact/`, the backend at `compact/compact-basic/`. Unlike the bash seam, it depends on `dsh-session` and `dsh-llm` — its verbs are defined over a `Session` and its output is the `ContentBlock` vocabulary, so the contract cannot be expressed without naming them. That deviation from the "interface depends only on cordis" guidance is intentional and recorded in the [compaction capability-seam RFC](../../docs/rfc/implemented/feature/2026-06-18-compaction-capability-seam.md). A tokenizer- or template-based backend would replace `compact-basic` without touching the interface or the tool.
