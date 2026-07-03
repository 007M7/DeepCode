# fs/ - filesystem capability family

The filesystem stack: a provider seam (text IO + atomic mutation with an optional version guard), a local implementation, a policy gate plugin (observed-state + read-before-edit + version-guarded write/edit), and the model-facing file tools + executor. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `fs/` | Provider seam: text IO + atomic mutation primitives (optional version guard); owns the `fs/*` policy events | `ctx.fs` |
| `fs-local/` | Local-filesystem `FileSystem` implementation | (registers `ctx.fs`) |
| `fs-policy/` | Policy gate plugin: observed-state + read-before-edit + version-guarded write/edit, via the `fs/*` event gate | (no service — `fs/*` listeners) |
| `tool-fs/` | Model-facing `read`/`write`/`edit` tools AND the executor (reads via `ctx.fs`, owns read windowing, dispatches `fs/*`) | (registers on `ctx.tools`) |

The interface lives at `fs/fs/`. A sandboxed, remote, or project-scoped filesystem backend can replace `fs-local` without touching the seam, the policy gate, or the model-facing tool schemas. The policy (`fs-policy/`) is a plugin that participates only through the `fs/*` event gate, not a service the tool injects — so dropping it gracefully loses the policy and leaves the unconstrained bare provider rather than breaking the tool. A deployment that loads `tool-fs/` is expected to also load it.
