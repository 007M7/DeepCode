# bash/ — bash capability family

English | [中文](README.zh.md)

The canonical three-package capability seam (see [capability seams](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)): an abstract executor interface, concrete implementations, and the model-facing tool that consumes it. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `bash/` | Abstract bash executor seam (interface + vocabulary; sandbox result facts carry the [`sandbox/`](../sandbox/README.md) seam's mode/enforcement vocabulary, and the managed-env/output vocabulary is re-exported from the [`subprocess/`](../subprocess/README.md) seam) | `ctx.bash` |
| `bash-local/` | Local `BashExecutor` implementation over the [`subprocess/`](../subprocess/README.md) service (command defaulting, deadlines, terminal env, background-read merge) | (registers `ctx.bash`) |
| `bash-sandbox/` | Sandbox-consuming `BashExecutor` (wraps every command argv via `ctx.sandbox`, stamps denial/enforcement facts; extends `bash-local`'s mechanics) | (registers `ctx.bash`) |
| `tool-bash/` | Model-facing `bash` schema; background processes register with the generic [`tasks/`](../tasks/README.md) runtime | (registers on `ctx.tools`) |

The interface lives at `bash/bash/`. `bash-sandbox` replacing `bash-local` without touching the interface or the tool is the split doing exactly what it exists for — a leaf `cordis.yml` picks one executor entry, plus a `ctx.sandbox` provider entry for the confined one (see [the acp-agent example's default composition](../../examples/acp-agent/)).
