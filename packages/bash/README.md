# bash/ — bash capability family

English | [中文](README.zh.md)

The capability family spans the canonical executor seam, its implementations, the shared shell environment, and the model-facing tools. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `bash/` | Abstract bash executor seam (interface + vocabulary; sandbox result facts carry the [`sandbox/`](../sandbox/README.md) seam's mode/enforcement vocabulary, and the managed-env/output vocabulary is re-exported from the [`subprocess/`](../subprocess/README.md) seam) | `ctx.bash` |
| `bash-local/` | Local `BashExecutor` implementation over the [`subprocess/`](../subprocess/README.md) service (command defaulting, deadlines, terminal env, background-read merge) | (registers `ctx.bash`) |
| `bash-sandbox/` | Sandbox-consuming `BashExecutor` (wraps every command argv via `ctx.sandbox`, stamps denial/enforcement facts; extends `bash-local`'s mechanics) | (registers `ctx.bash`) |
| `pwsh-local/` | Local PowerShell `BashExecutor` implementation over the [`subprocess/`](../subprocess/README.md) service (executable resolution, UTF-8-pinned spawn, Windows termination semantics) | (registers `ctx.bash`) |
| `bash-env/` | Tool-independent managed `DSH_*` shell environment registry shared by the shell tools (built-in facts + effect-scoped contributors) | (registers `ctx.bashEnv`) |
| `tool-bash/` | Model-facing `bash` schema; background processes register with the generic [`tasks/`](../tasks/README.md) runtime | (registers on `ctx.tools`) |
| `tool-pwsh/` | Model-facing PowerShell-dialect `pwsh` schema (behavior mirrors `tool-bash` minus the sandbox surface); background processes register with the generic [`tasks/`](../tasks/README.md) runtime | (registers on `ctx.tools`) |

The interface lives at `bash/bash/`. `bash-sandbox` replacing `bash-local` without touching the interface or the tool is the split doing exactly what it exists for — a leaf `cordis.yml` picks one executor entry, plus a `ctx.sandbox` provider entry for the confined one (see [the acp-agent example's default composition](../../examples/acp-agent/)).
