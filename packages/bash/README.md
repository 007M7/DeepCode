# bash/ — bash capability family

The canonical three-package capability seam (see [capability seams](../../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md)): an abstract executor interface, concrete implementations, and the model-facing tool that consumes it. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `bash/` | Abstract bash executor seam (interface + vocabulary; sandbox result facts carry the [`sandbox/`](../sandbox/README.md) seam's mode/enforcement vocabulary) | `ctx.bash` |
| `bash-local/` | Local-subprocess `BashExecutor` implementation | (registers `ctx.bash`) |
| `bash-sandbox/` | Sandbox-consuming `BashExecutor` (wraps every command argv via `ctx.sandbox`, stamps denial/enforcement facts; extends `bash-local`'s mechanics) | (registers `ctx.bash`) |
| `tool-bash/` | Model-facing `bash`/`bash_output`/`bash_kill` tool schemas | (registers on `ctx.tools`) |

The interface lives at `bash/bash/`. `bash-sandbox` replacing `bash-local` without touching the interface or the tool is the split doing exactly what it exists for — a leaf `cordis.yml` picks one executor entry, plus a `ctx.sandbox` provider entry for the confined one (see [the acp-agent example's default composition](../../examples/acp-agent/)).
