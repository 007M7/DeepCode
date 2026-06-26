# fs/ - filesystem capability family

The filesystem stack: a provider seam (text IO + guarded mutation), a local implementation, a policy layer (read windowing + write/edit freshness), and the model-facing file tools. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `fs/` | Provider seam: text IO + guarded mutation primitives | `ctx.fs` |
| `fs-local/` | Local-filesystem `FileSystem` implementation | (registers `ctx.fs`) |
| `file-context/` | Policy layer: observed-state, read windowing, write/edit freshness | `ctx.fileContext` |
| `tool-fs/` | Model-facing `read`/`write`/`edit` tool schemas | (registers on `ctx.tools`) |

The interface lives at `fs/fs/`. A sandboxed, remote, or project-scoped filesystem backend can replace `fs-local` without touching the seam, the policy layer, or the model-facing tool schemas. The policy layer (`file-context/`) is a concrete service, not a swappable seam — it owns the model-facing observation policy that does not belong on a provider backend.
