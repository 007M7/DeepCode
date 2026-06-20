# bash/ — bash capability family

The canonical three-package capability seam (see [capability seams](../../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md)): an abstract executor interface, a concrete local implementation, and the model-facing tool that consumes it. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `bash/` | Abstract bash executor seam (interface + vocabulary) | `ctx.bash` |
| `bash-local/` | Local-subprocess `BashExecutor` implementation | (registers `ctx.bash`) |
| `tool-bash/` | Model-facing `bash`/`bash_output`/`bash_kill` tool schemas | (registers on `ctx.tools`) |

The interface lives at `bash/bash/`. A sandboxed executor would replace `bash-local` without touching the interface or the tool — the split is what makes that possible.
