# workspace/ — the workspace entity

English | [中文](README.zh.md)

The workspace family owns the persistent workspace concept: a directory the user works in, with a title and the ordered list of sessions that belong to it. Design record: [domain KV storage Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md).

| Package | Role | ctx key |
|---|---|---|
| `workspace/` | `WorkspaceRegistry` service over the storage domain form: realpath-unique paths, session-ownership accounting, entity cache | `ctx.workspace` |

Ownership truth lives in the workspace record's `sessionIds` (ordered), never derived from session cwd; `attachSession` verifies the session header's cwd resolves to the workspace path, so one session structurally belongs to at most one workspace. Deleting a Workspace removes only this registry record and account: directories, user files, and session logs remain, and the Sessions become Ungrouped ([decision](../../.agents/notes/implemented/feature/2026-07-27-workspace-registration-deletion.md)).
