# workspace/ — the workspace entity

The workspace family owns the persistent workspace concept: a directory the user works in, with a title and the ordered list of sessions that belong to it. Design record: [domain KV storage Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md).

| Package | Role | ctx key |
|---|---|---|
| `workspace/` | `WorkspaceRegistry` service over the storage domain form: realpath-unique paths, session-ownership accounting, entity cache | `ctx.workspace` |

Ownership truth lives in the workspace record's `sessionIds` (ordered), never derived from session cwd; `attachSession` verifies the session header's cwd resolves to the workspace path, so one session structurally belongs to at most one workspace. Deletion (workspace and session cascade) is deliberately absent this phase and ships with the session-side primitives.
