# fs/ - filesystem capability family

The filesystem capability seam: an abstract filesystem interface, a local implementation, and the model-facing file tools. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `fs/` | Abstract filesystem seam (interface + vocabulary + observed-file policy) | `ctx.fs` |
| `fs-local/` | Local-filesystem `FileSystem` implementation | (registers `ctx.fs`) |
| `tool-fs/` | Model-facing `read`/`write`/`edit` tool schemas | (registers on `ctx.tools`) |

The interface lives at `fs/fs/`. A sandboxed, remote, or project-scoped filesystem backend can replace `fs-local` without touching the interface or model-facing tool schemas.
